#!/usr/bin/env node
/**
 * offstage — the CLI.
 *
 * Four commands, one job each:
 *
 * ```
 * offstage doctor                          # which lanes can run right now, and the fix for the rest
 * offstage route  -- npx playwright test    # where would this go? (nothing is executed)
 * offstage run    -- npx playwright test    # send it there, and hand back the normalized result
 * offstage probe  MyApp.xcodeproj           # is ad-hoc VM testing enough, or is a signing lane needed?
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

import { pathToFileURL } from 'node:url';

import { Command, InvalidArgumentError } from 'commander';

import { LANES } from '../contract/index.js';
import type { Lane } from '../contract/index.js';
import { ProbeError } from '../probe/index.js';
import { OffstageUsageError, doctor, probe, route, run } from './api.js';
import type { ApiDeps } from './api.js';
import { renderDoctor, renderProbe, renderRoute, renderRun, renderRunHeader } from './render.js';

/** Where the CLI writes and how it stops. Replaced wholesale in tests. */
export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  cwd: () => string;
  env: NodeJS.ProcessEnv;
  /** Injected into the API. Tests use it to avoid touching real substrates. */
  deps?: Partial<ApiDeps>;
}

export const processIo: CliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
  cwd: () => process.cwd(),
  env: process.env,
};

function parsePositiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError('expected a positive whole number of milliseconds');
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
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  process.exitCode = await main(process.argv.slice(2));
}
/* c8 ignore stop */
