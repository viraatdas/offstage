#!/usr/bin/env node
/**
 * offstage — the CLI.
 *
 * Five commands, one job each:
 *
 * ```
 * offstage doctor                          # which lanes can run right now, and the fix for the rest
 * offstage route  -- npx playwright test    # where would this go? (nothing is executed)
 * offstage run    -- npx playwright test    # send it there, and hand back the normalized result
 * offstage probe  MyApp.xcodeproj           # is ad-hoc VM testing enough, or is a signing lane needed?
 * offstage session status                   # the macOS session lane: is the helper account ready?
 * ```
 *
 * This file is wiring only: argv parsing, output streams, exit codes. Every
 * decision lives in `./api.js` and every string in `./render.js`, so the MCP
 * server gets exactly the same behaviour without going through a terminal.
 *
 * ## `--json`
 *
 * Every command takes `--json`. The rule is the same everywhere: **the JSON
 * envelope goes to stdout, and everything written for a human goes to stderr.**
 * `offstage run --json -- npm test | jq .status` therefore works while the
 * progress line still reaches the terminal.
 *
 * ## Exit codes
 *
 * `run` exits with the contract's mapping — 0 passed, the command's own code
 * failed, 70 errored, 69 skipped — so CI can tell "your tests are red" from
 * "offstage could not run them". `doctor` and `route` are reports and exit 0.
 * `probe` exits 0 for any verdict it reached; the verdict is the output, not
 * the status. A malformed invocation exits 64, a missing path 66.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { Command, InvalidArgumentError } from 'commander';

import { LANES } from '../contract/index.js';
import type { Lane } from '../contract/index.js';
import { ProbeError } from '../probe/index.js';
import {
  OffstageSessionError,
  OffstageUsageError,
  doctor,
  probe,
  route,
  run,
  sessionApps,
  sessionUpdate,
  sessionInput,
  sessionOpen,
  sessionScreenshot,
  sessionSetup,
  sessionShare,
  sessionStatus,
} from './api.js';
import type { ApiDeps } from './api.js';
import {
  renderDoctor,
  renderProbe,
  renderRoute,
  renderRun,
  renderRunHeader,
  renderSessionApps,
  renderSessionInput,
  renderSessionScreenshot,
  renderSessionSetup,
  renderSessionShare,
  renderSessionStatus,
} from './render.js';

/** Where the CLI writes and how it stops. Replaced wholesale in tests. */
export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  cwd: () => string;
  env: NodeJS.ProcessEnv;
  /**
   * Is there a terminal on stdin? `offstage session setup` runs `sudo`, which
   * has to be able to prompt for a password; without a TTY it would hang or
   * fail with a message about no askpass, and neither is a useful answer.
   */
  isTty?: () => boolean;
  /** Injected into the API. Tests use it to avoid touching real substrates. */
  deps?: Partial<ApiDeps>;
}

export const processIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  cwd: () => process.cwd(),
  env: process.env,
  isTty: () => process.stdin.isTTY === true,
};

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('expected a positive whole number of milliseconds');
  }
  return parsed;
}

/** A coordinate in points. Negative is legal — a display can sit left of the main one. */
function parseCoordinate(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new InvalidArgumentError('expected a number of points');
  }
  return parsed;
}

function parseLane(value: string): Lane {
  if (!(LANES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`expected one of: ${LANES.join(', ')}`);
  }
  return value as Lane;
}

/**
 * Build the command tree. Exported so tests can drive it with
 * `program.parseAsync(argv, { from: 'user' })` and read the captured output,
 * without spawning a process or building `dist/`.
 *
 * The exit code is returned rather than applied; `main()` is what touches
 * `process.exitCode`.
 */
export function createProgram(io: CliIo): { program: Command; exitCode: () => number } {
  let exitCode = 0;
  const setExit = (code: number): void => {
    exitCode = code;
  };

  const program = new Command();
  program
    .name('offstage')
    .description('Keep UI, browser and macOS app work off your screen.')
    .option('--json', 'emit machine-readable JSON on stdout; human output goes to stderr', false)
    .enablePositionalOptions()
    .showHelpAfterError();

  /**
   * With `--json`, human lines go to stderr so stdout stays a clean document.
   * Without it, they are the output.
   */
  const emit = (json: boolean, value: unknown, human: string[]): void => {
    const write = json ? io.stderr : io.stdout;
    if (json) io.stdout(JSON.stringify(value, null, 2));
    for (const line of human) write(line);
  };

  const jsonFlag = (command: Command): boolean =>
    Boolean(command.opts().json ?? program.opts().json);

  program
    .command('doctor')
    .description('Report per-lane availability and the exact command that fixes each gap.')
    .option('--json', 'emit the report as JSON', false)
    .action(async function doctorAction(this: Command) {
      const report = await doctor(io.deps);
      emit(jsonFlag(this), report, renderDoctor(report));
    });

  program
    .command('route')
    .description('Say which lane a command would use, without executing anything.')
    .argument('<command...>', 'the command to classify, e.g. -- npx playwright test')
    .option('--cwd <dir>', 'repository root to classify against (default: current directory)')
    .option('--headed', 'classify as if you had asked for a headed run', false)
    .option('--json', 'emit the decision as JSON', false)
    .passThroughOptions()
    .action(async function routeAction(this: Command, command: string[]) {
      const options = this.opts();
      const decision = await route(
        {
          cwd: options.cwd ?? io.cwd(),
          command,
          env: io.env,
          ...(options.headed ? { headed: true } : {}),
        },
        io.deps,
      );
      emit(jsonFlag(this), decision, renderRoute(decision, command));
    });

  program
    .command('run')
    .description('Route a command to a lane, run it there, and write the normalized result.')
    .argument('<command...>', 'the command to run, e.g. -- npx playwright test')
    .option('--cwd <dir>', 'repository root to run against (default: current directory)')
    .option('--lane <lane>', `force a lane (${LANES.join(' | ')})`, parseLane)
    .option('--timeout <ms>', 'wall-clock budget in milliseconds', parsePositiveInt)
    .option('--headed', 'ask for a headed run; goes to the container lane, never your screen', false)
    .option('--json', 'emit the LaneResult envelope as JSON', false)
    .passThroughOptions()
    .action(async function runAction(this: Command, command: string[]) {
      const options = this.opts();
      const json = jsonFlag(this);
      const cwd = options.cwd ?? io.cwd();
      const outcome = await run(
        {
          cwd,
          command,
          env: io.env,
          ...(options.lane === undefined ? {} : { lane: options.lane as Lane }),
          ...(options.timeout === undefined ? {} : { timeoutMs: options.timeout as number }),
          ...(options.headed ? { headed: true } : {}),
          // Printed before dispatch: a ten-minute run should not be silent
          // about where it went. Always stderr — it is progress, not output.
          onDecision: (event) => {
            for (const line of renderRunHeader(event)) io.stderr(line);
          },
        },
        io.deps,
      );
      emit(json, outcome.result, renderRun(outcome, cwd));
      setExit(outcome.exitCode);
    });

  program
    .command('probe')
    .description('Report whether a macOS app can be tested with ad-hoc signing, or needs a signing lane.')
    .argument('<path>', 'an .xcodeproj, .xcworkspace, .app, .dmg, .entitlements file, or a directory')
    .option('--no-external-tools', 'read files only; never shell out to codesign/hdiutil/security')
    .option('--json', 'emit the full report as JSON', false)
    .action(async function probeAction(this: Command, target: string) {
      const options = this.opts();
      const report = await probe(
        { path: target, allowExternalTools: options.externalTools !== false },
        io.deps,
      );
      emit(jsonFlag(this), report, renderProbe(report));
    });

  /* ------------------------------ session ------------------------------- */

  const session = program
    .command('session')
    .description('Drive the macOS session lane: a second, logged-in account whose screen is not yours.')
    .enablePositionalOptions();

  session
    .command('status')
    .description('Report the helper account, its GUI session, the daemon and both TCC grants.')
    .option('--user <name>', 'helper account to inspect (default: the configured one)')
    .option('--json', 'emit the status as JSON', false)
    .action(async function statusAction(this: Command) {
      const options = this.opts();
      const status = await sessionStatus(
        options.user === undefined ? {} : { user: options.user as string },
        io.deps,
      );
      emit(jsonFlag(this), status, renderSessionStatus(status));
      // 0 / 69 so a script can gate on it: `offstage session status || exit`.
      setExit(status.available ? 0 : 69);
    });

  session
    .command('setup')
    .description('Compile offstage-sessiond, install it into the helper session, and ask for the TCC grants.')
    .option('--user <name>', 'helper account to install into (default: the configured one)')
    .option('--create', 'create the account when it does not exist yet', false)
    .option('--json', 'emit the setup report as JSON', false)
    .action(async function setupAction(this: Command) {
      const options = this.opts();
      const json = jsonFlag(this);
      // sudo needs a terminal to prompt on, and so does `sysadminctl -password -`.
      // Refusing here is better than a hang inside an MCP server or a CI job.
      if (!(io.isTty?.() ?? false)) {
        throw new OffstageUsageError(
          'offstage session setup needs a terminal: it runs one script as root with sudo, ' +
            'which has to be able to prompt you for a password. Run it in a terminal.',
        );
      }
      const result = await sessionSetup(
        {
          ...(options.user === undefined ? {} : { user: options.user as string }),
          ...(options.create ? { create: true } : {}),
          // The root script is printed before it runs. Always stderr under
          // --json, so stdout stays exactly one JSON document.
          io: (line) => (json ? io.stderr(line) : io.stdout(line)),
        },
        io.deps,
      );
      emit(json, result, renderSessionSetup(result));
      setExit(result.ok ? 0 : 69);
    });

  session
    .command('share')
    .description('Give the helper account read-only access to one directory tree.')
    .argument('<dir>', 'the tree the helper account must be able to read')
    .option('--user <name>', 'helper account to grant to (default: the configured one)')
    .option('--json', 'emit the applied ACLs as JSON', false)
    .action(async function shareAction(this: Command, dir: string) {
      const options = this.opts();
      const result = await sessionShare(
        { path: dir, ...(options.user === undefined ? {} : { user: options.user as string }) },
        io.deps,
      );
      emit(jsonFlag(this), result, renderSessionShare(result));
      setExit(result.ok ? 0 : 70);
    });

  session
    .command('screenshot')
    .description("Capture the helper session's display and write it as a PNG.")
    .option('--out <file>', 'where to write the PNG (default: .offstage/screenshots/<timestamp>.png)')
    .option('--max <pixels>', 'longest edge of the returned image', parsePositiveInt)
    .option('--user <name>', 'helper account (default: the configured one)')
    .option('--json', 'emit the capture metadata as JSON', false)
    .action(async function screenshotAction(this: Command) {
      const options = this.opts();
      const result = await sessionScreenshot(
        {
          cwd: io.cwd(),
          ...(options.out === undefined ? {} : { out: options.out as string }),
          ...(options.max === undefined ? {} : { maxDimension: options.max as number }),
          ...(options.user === undefined ? {} : { user: options.user as string }),
        },
        io.deps,
      );
      const { png: _png, ...envelope } = result;
      emit(jsonFlag(this), envelope, renderSessionScreenshot(result));
    });

  const runInput = async (command: Command, actions: unknown): Promise<void> => {
    const options = command.opts();
    const result = await sessionInput(
      { actions, ...(options.user === undefined ? {} : { user: options.user as string }) },
      io.deps,
    );
    emit(jsonFlag(command), result, renderSessionInput(result));
  };

  session
    .command('input')
    .description('Inject a JSON array of keyboard/mouse actions into the helper session.')
    .argument('<actions>', 'JSON array, e.g. \'[{"type":"click","x":640,"y":400}]\'')
    .option('--user <name>', 'helper account (default: the configured one)')
    .option('--json', 'emit the result as JSON', false)
    .action(async function inputAction(this: Command, actions: string) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(actions);
      } catch (error) {
        throw new OffstageUsageError(
          `The actions argument is not JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await runInput(this, parsed);
    });

  session
    .command('click')
    .description('Click at a point in the helper session (coordinates are points, not pixels).')
    .argument('<x>', 'x in points, from the left of the main display', parseCoordinate)
    .argument('<y>', 'y in points, from the top of the main display', parseCoordinate)
    .option('--button <button>', 'left | right | middle', 'left')
    .option('--count <n>', 'click count; 2 is a double-click', parsePositiveInt)
    .option('--user <name>', 'helper account (default: the configured one)')
    .option('--json', 'emit the result as JSON', false)
    .action(async function clickAction(this: Command, x: number, y: number) {
      const options = this.opts();
      await runInput(this, [
        {
          type: 'click',
          x,
          y,
          button: options.button as string,
          ...(options.count === undefined ? {} : { count: options.count as number }),
        },
      ]);
    });

  session
    .command('type')
    .description('Type a string into whatever has focus in the helper session.')
    .argument('<text>', 'the text to type')
    .option('--user <name>', 'helper account (default: the configured one)')
    .option('--json', 'emit the result as JSON', false)
    .action(async function typeAction(this: Command, text: string) {
      await runInput(this, [{ type: 'type', text }]);
    });

  session
    .command('key')
    .description('Send one key combination, e.g. cmd+shift+t.')
    .argument('<combo>', '[modifier+]*name — cmd, ctrl, alt/opt, shift, fn')
    .option('--user <name>', 'helper account (default: the configured one)')
    .option('--json', 'emit the result as JSON', false)
    .action(async function keyAction(this: Command, combo: string) {
      await runInput(this, [{ type: 'key', key: combo }]);
    });

  session
    .command('update')
    .description('Rebuild offstage-sessiond and install it into the helper session. Needs no password.')
    .option('--user <name>', 'helper account (default: the configured one)')
    .option('--json', 'emit the result as JSON', false)
    .action(async function updateAction(this: Command) {
      const options = this.opts();
      const result = await sessionUpdate(
        options.user === undefined ? {} : { user: options.user as string },
        io.deps,
      );
      emit(
        jsonFlag(this),
        result,
        [
          `\u2713 updated offstage-sessiond in the helper session`,
          `  ${result.installedTo}`,
          `  daemon ${result.previousPid} replaced by ${result.currentPid}`,
        ],
      );
    });

  session
    .command('apps')
    .description('List the apps running in the helper session.')
    .option('--user <name>', 'helper account (default: the configured one)')
    .option('--json', 'emit the app list as JSON', false)
    .action(async function appsAction(this: Command) {
      const options = this.opts();
      const apps = await sessionApps(
        options.user === undefined ? {} : { user: options.user as string },
        io.deps,
      );
      emit(jsonFlag(this), apps, renderSessionApps(apps));
    });

  session
    .command('open')
    .description('Open an app or a file in the helper session — sugar for `offstage run --lane session -- open …`.')
    .argument('<target>', 'an app name or a path, as `open` takes it')
    .argument('[args...]', 'further arguments for `open`')
    .option('--cwd <dir>', 'directory to run against (default: current directory)')
    .option('--json', 'emit the LaneResult envelope as JSON', false)
    .passThroughOptions()
    .action(async function openAction(this: Command, target: string, args: string[]) {
      const options = this.opts();
      const cwd = options.cwd ?? io.cwd();
      const outcome = await sessionOpen({ target, args, cwd }, io.deps);
      emit(jsonFlag(this), outcome.result, renderRun(outcome, cwd));
      setExit(outcome.exitCode);
    });

  // exitOverride() and the output configuration are per-command and are copied
  // at construction time, so they have to be applied after the tree is built —
  // otherwise a bad flag on a subcommand calls process.exit() directly and
  // writes past the injected streams.
  const configure = (command: Command): void => {
    command.exitOverride();
    command.configureOutput({
      writeOut: (str) => io.stdout(str.replace(/\n$/, '')),
      writeErr: (str) => io.stderr(str.replace(/\n$/, '')),
    });
    command.commands.forEach(configure);
  };
  configure(program);

  return { program, exitCode: () => exitCode };
}

/**
 * Turn anything thrown during a command into one stderr line and an exit code.
 *
 * A `ProbeError` and an `OffstageUsageError` carry their own code; anything
 * else is an offstage bug and exits 70 (`EX_SOFTWARE`), the same code an
 * untrustworthy run uses.
 */
export function describeFailure(error: unknown): { message: string; exitCode: number } {
  if (error instanceof OffstageUsageError) {
    return { message: error.message, exitCode: error.exitCode };
  }
  // The substrate is missing, not the invocation. Exit 69, the same code a
  // `skipped` run uses, and carry the lane's own repair instruction.
  if (error instanceof OffstageSessionError) {
    return {
      message: error.fix === undefined ? error.message : `${error.message}\n  fix: ${error.fix}`,
      exitCode: error.exitCode,
    };
  }
  if (error instanceof ProbeError) {
    return { message: error.message, exitCode: error.code === 'not-found' ? 66 : 64 };
  }
  if (error instanceof Error) return { message: error.message, exitCode: 70 };
  return { message: String(error), exitCode: 70 };
}

/** Parse and dispatch. Returns the process exit code; never calls `process.exit`. */
export async function main(argv: string[], io: CliIo = processIo): Promise<number> {
  const { program, exitCode } = createProgram(io);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode();
  } catch (error) {
    // Commander throws for --help and --version too; those are not failures.
    const code = (error as { code?: string }).code;
    if (code === 'commander.helpDisplayed' || code === 'commander.help' || code === 'commander.version') {
      return 0;
    }
    // Commander already wrote the message and the usage through io; every one
    // of its remaining errors means the invocation was wrong, which is 64.
    if (typeof code === 'string' && code.startsWith('commander.')) return 64;
    const failure = describeFailure(error);
    io.stderr(`offstage: ${failure.message}`);
    return failure.exitCode;
  }
}

/* c8 ignore start — the process entry point itself is exercised end to end, not by unit tests. */
/**
 * Whether this module was invoked as the program, rather than imported.
 *
 * `process.argv[1]` must be resolved through `realpath` before it is compared:
 * npm installs a bin as a **symlink** at `node_modules/.bin/offstage`, so argv
 * carries the symlink path while `import.meta.url` carries the real file. A
 * naive comparison of the two is false for every installed copy of offstage,
 * and the CLI then exits 0 having printed nothing at all — working perfectly
 * from a clone and silently doing nothing everywhere else.
 */
const isEntryPoint = ((): boolean => {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  process.exitCode = await main(process.argv.slice(2));
}
/* c8 ignore stop */
