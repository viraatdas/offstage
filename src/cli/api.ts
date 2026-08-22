/**
 * offstage — the programmatic API behind the CLI.
 *
 * This module is the single dispatch path: `src/cli/index.ts` renders it for a
 * terminal, and `src/mcp/core.ts` hands it to an agent. Neither of them decides
 * anything. Every routing rule, every safety refusal, and every write to
 * `.offstage/runs/<id>/result.json` happens exactly once, here.
 *
 * ```ts
 * import { doctor, route, run, probe } from './api.js';
 *
 * const outcome = await run({ cwd: repoRoot, command: ['npx', 'playwright', 'test'] });
 * console.log(outcome.result.status, outcome.resultPath);
 * ```
 *
 * The four functions return typed values and throw only for caller error
 * ({@link OffstageUsageError}). A run that fails, times out, or is refused
 * comes back as a valid `LaneResult`, never as an exception — the contract's
 * rule 2, hoisted one level up so the CLI and the MCP server can share it.
 */

import { spawn } from 'node:child_process';
import { type Dirent, readFileSync, readdirSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  Lane,
  LaneAvailability,
  LaneResult,
  LaneRunner,
  RouteDecision,
} from '../contract/index.js';
import {
  LANES,
  createLaneResult,
  describeValidationError,
  exitCodeForResult,
  safeParseLaneResult,
} from '../contract/index.js';
import { allocateRunDir, writeResult } from '../contract/artifacts.js';
import type { ContainerRuntimeProbe } from '../lanes/container/index.js';
import { containerLane, describeRuntimeProbe } from '../lanes/container/index.js';
import { headlessLane } from '../lanes/headless/index.js';
import type { SessionLane, SessionLaneOptions, SessionProbe } from '../lanes/session/index.js';
import { createSessionLane, describeSessionProbe, sessionLane } from '../lanes/session/index.js';
import type { EntitlementsProbeReport } from '../probe/index.js';
import { probeEntitlements } from '../probe/index.js';
import type { ClassifyHints } from '../router/index.js';
import { classify, tokenizeShellish } from '../router/index.js';
import type {
  CompileDaemonResult,
  DescribeSessionOptions,
  Exec,
  GuiSessionState,
  InputAction,
  SessionApp,
  SessionClient,
  SessionClientFactory,
  SessionDiscovery,
  SessionHello,
  SessionPermissions,
} from '../session/index.js';
import {
  DAEMON_BINARY_NAME,
  DAEMON_SOURCE_RELATIVE_DIR,
  installDirFor,
  DEFAULT_LABEL,
  DEFAULT_SOCKET_DIR,
  SESSION_CONFIG_RELATIVE_PATH,
  SessionRpcError,
  SessionUnreachableError,
  compileDaemon,
  createSessionClient,
  defaultExec,
  describeAclCommand,
  describeSession,
  exportCsreq,
  generateSessionPassword,
  parseInputActions,
  persistSessionConfig,
  readFileVaultStatus,
  renderInstallScript,
  renderLaunchAgentPlist,
  sessionUserFullName,
  shareAcl,
  shareAclCommands,
  shellQuote,
  unshareAcl,
} from '../session/index.js';
import { UpdateError, updateDaemon } from '../session/update.js';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The caller asked for something impossible — a cwd that does not exist, an
 * empty command, a lane that is not one of the four. This is the only thing
 * these functions throw, and it always means the *call* was wrong, never that
 * the run was bad.
 *
 * `exitCode` follows sysexits: 64 `EX_USAGE`, 66 `EX_NOINPUT`.
 */
export class OffstageUsageError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 64) {
    super(message);
    this.name = 'OffstageUsageError';
    this.exitCode = exitCode;
  }
}

/* -------------------------------------------------------------------------- */
/* Injection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Everything the API touches that is not pure. Tests replace pieces of it; the
 * CLI and the MCP server never pass it at all.
 */
export interface ApiDeps {
  lanes: Record<Lane, LaneRunner>;
  classify: typeof classify;
  probeEntitlements: typeof probeEntitlements;
  allocateRunDir: typeof allocateRunDir;
  writeResult: typeof writeResult;
  /** Ambient environment, read for routing hints and layered onto the run. */
  env: NodeJS.ProcessEnv;
  /** Directory existence check for `cwd` validation. */
  directoryExists: (target: string) => Promise<boolean>;
  /**
   * Seams for the session lane's own commands (`offstage session …`). Absent in
   * production; a test supplies only the keys it needs, and each is defaulted
   * individually rather than the object being replaced wholesale.
   */
  session?: SessionSeams;
}

const directoryExists = async (target: string): Promise<boolean> => {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
};

export const defaultDeps: ApiDeps = {
  lanes: { headless: headlessLane, session: sessionLane, container: containerLane },
  classify,
  probeEntitlements,
  allocateRunDir,
  writeResult,
  env: process.env,
  directoryExists,
};

function withDefaults(overrides?: Partial<ApiDeps>): ApiDeps {
  return overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

/* -------------------------------------------------------------------------- */
/* Shared input handling                                                      */
/* -------------------------------------------------------------------------- */

export interface CommandInput {
  /** Repository root the command runs against. Relative paths resolve against `process.cwd()`. */
  cwd?: string;
  /** Already-split argv. Never shell-interpreted. */
  command: string[];
  /**
   * Explicit intent. `true` is offstage's own `--headed`: give me a real
   * browser window, in the container lane, on a virtual display.
   */
  headed?: boolean;
  /** Override the ambient environment used for hints and for the run. */
  env?: NodeJS.ProcessEnv;
}

async function resolveCwd(input: CommandInput | { cwd?: string }, deps: ApiDeps): Promise<string> {
  const resolved = path.resolve(input.cwd ?? process.cwd());
  if (!(await deps.directoryExists(resolved))) {
    throw new OffstageUsageError(`cwd does not exist or is not a directory: ${resolved}`, 66);
  }
  return resolved;
}

function resolveCommand(command: unknown): string[] {
  if (!Array.isArray(command) || command.length === 0) {
    throw new OffstageUsageError(
      'No command given. Pass the command after `--`, e.g. `offstage run -- npx playwright test`.',
    );
  }
  if (command.some((token) => typeof token !== 'string')) {
    throw new OffstageUsageError('Every command token must be a string.');
  }

  const tokens = command as string[];

  // `offstage route -- "npx playwright test --headed"` arrives as ONE argv
  // entry. Read literally, it is a program with a very odd name: no browser is
  // named, so it classifies as headless — a wrong answer that reads as a
  // confident one. `run` fails closed (ENOENT on a binary with spaces in its
  // name), but `route` would quietly mislead.
  //
  // A single argument containing whitespace is unambiguous: nobody has an
  // executable called `npx playwright test --headed`. Split it the same way the
  // router already splits a package script or an `sh -c` string.
  if (tokens.length === 1) {
    const only = tokens[0] as string;
    if (/\s/.test(only)) {
      const segments = tokenizeShellish(only);
      if (segments.length !== 1) {
        throw new OffstageUsageError(
          `"${only}" is a shell script, not a command: it has ${segments.length} segments joined by ` +
            'shell operators. offstage never runs anything through a shell. Pass the argv directly ' +
            '(`offstage run -- npx playwright test`), or run the shell explicitly ' +
            "(`offstage run -- sh -c '<script>'`), which offstage reads and routes on.",
        );
      }
      const split = segments[0] as string[];
      if (split.length > 1) return split;
    }
  }

  return tokens;
}

/**
 * Map the ambient environment onto router hints.
 *
 * The router deliberately reads no environment variables — it takes `{cwd,
 * command, hints}` and nothing else, so that a caller can always see what it
 * was told. That leaves one real signal living in the environment:
 * `PWDEBUG=1`, which forces Playwright headed no matter what argv or the
 * config say. Translating it here keeps the router honest and still gets the
 * run into the container lane.
 *
 * An explicit `headed` on the call always wins over the environment.
 */
export function hintsFromEnv(env: NodeJS.ProcessEnv, headed?: boolean): ClassifyHints {
  if (headed !== undefined) return { headed };
  const pwdebug = env.PWDEBUG;
  if (pwdebug !== undefined && pwdebug !== '' && pwdebug !== '0') return { headed: true };
  return {};
}

/* -------------------------------------------------------------------------- */
/* doctor                                                                     */
/* -------------------------------------------------------------------------- */

/** One lane's health, plus whatever detail its own probe can add. */
export interface LaneHealth {
  lane: Lane;
  availability: LaneAvailability;
  /** Extra lines worth printing under the lane — the container runtime probe's steps. */
  detail: string[];
}

export interface DoctorReport {
  offstageVersion: string;
  /**
   * Which copy of offstage produced this report.
   *
   * A version number alone cannot answer "is this the published package or my
   * checkout?", and that question has cost real debugging time: a long-lived
   * MCP process pinned to a stale local `dist/` reported one version while npm,
   * the npx cache and the plugin cache all held another. Naming the directory
   * makes the answer readable instead of reachable only through `ps`.
   */
  install: OffstageInstall;
  /** Problems with the installation itself, as opposed to a lane's substrate. */
  warnings: string[];
  node: string;
  platform: string;
  arch: string;
  lanes: LaneHealth[];
  /** The lanes that could run something right now. */
  ready: Lane[];
}

/** Where the running offstage lives, and what version that copy claims. */
export interface OffstageInstall {
  /** The version string from the `package.json` this build was read out of. */
  version: string;
  /**
   * Directory holding that `package.json`, or `''` when none was found.
   *
   * This is the whole point of the interface: two installs reporting `0.2.3`
   * are only the same code if they came from the same directory.
   */
  root: string;
  /**
   * True when `root` looks like a source checkout (it has a `src/`) rather than
   * an installed package. Only a checkout can carry a stale build.
   */
  fromSource: boolean;
  /**
   * Set when a checkout's compiled `dist/` predates the sources or the version
   * it claims — meaning the running code is not what the repository says.
   */
  staleBuild?: string;
}

let cachedInstall: OffstageInstall | undefined;

/**
 * Identify the copy of offstage that is currently executing.
 *
 * Walk up rather than assuming a depth: this module runs from
 * `dist/cli/api.js` when built, and from `bundle/offstage.mjs` when bundled
 * for the plugin. A fixed `../../` is right for exactly one of those.
 *
 * Synchronous because the MCP server must name itself while constructing the
 * server object, before anything can be awaited. It is the single source for
 * the CLI and the server both, so the two cannot drift — they did once: the
 * server introduced itself as 0.1.0 over the wire while doctor correctly
 * reported 0.2.1.
 */
export function offstageInstall(): OffstageInstall {
  if (cachedInstall !== undefined) return cachedInstall;

  const modulePath = fileURLToPath(import.meta.url);
  let dir = path.dirname(modulePath);
  for (let up = 0; up < 5; up += 1) {
    try {
      const raw = readFileSync(path.join(dir, 'package.json'), 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === 'string') {
        const root = dir;
        const fromSource = isDirectory(path.join(root, 'src'));
        cachedInstall = {
          version: parsed.version,
          root,
          fromSource,
          staleBuild: fromSource ? detectStaleBuild(root, modulePath, parsed.version) : undefined,
        };
        return cachedInstall;
      }
    } catch {
      // Not here; keep walking.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  cachedInstall = { version: 'unknown', root: '', fromSource: false };
  return cachedInstall;
}

/** This package's own version. Kept as its own name because it reads better at call sites. */
export function offstageVersion(): string {
  return offstageInstall().version;
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Catch the failure mode where a checkout's `dist/` is older than the `src/`
 * that produced it, so the process is honestly reporting a version that its
 * running code predates.
 *
 * Only meaningful for a source checkout, and only when we are actually running
 * the compiled output: under `tsx` the module *is* the source, so there is no
 * build to be stale. Returns a sentence for a human, or `undefined`.
 *
 * Exported for tests: this is a diagnostic, so it fails by going quiet, and a
 * quiet failure is exactly what a test has to catch.
 */
export function detectStaleBuild(root: string, modulePath: string, version: string): string | undefined {
  const built = modulePath.split(path.sep).includes('dist');
  if (!built) return undefined;

  let builtAt: number;
  try {
    builtAt = statSync(modulePath).mtimeMs;
  } catch {
    return undefined;
  }

  const inputs = newestMtime(path.join(root, 'src'), 0);
  const manifest = mtimeOf(path.join(root, 'package.json'));
  const newestInput = Math.max(inputs, manifest);
  if (newestInput - builtAt <= STALE_GRACE_MS) return undefined;

  const behind = formatAge(newestInput - builtAt);
  return (
    `this build is ${behind} older than its sources, so the running code is not what ` +
    `${root} currently says it is (it reports ${version}). Run \`npm run build\` and restart ` +
    `whatever started this process — a long-lived MCP server keeps the build it launched with.`
  );
}

/**
 * How far ahead of the build an input may be before it counts as stale.
 *
 * Timestamps are not precise enough to compare exactly: APFS records mtimes
 * below the millisecond while `utimes` writes whole ones, and a build tool that
 * rewrites `package.json` on its way out can land a hair after the output it
 * just produced. Sub-second differences are noise. A build that is genuinely
 * behind its sources is behind by minutes or hours, so nothing real is lost.
 */
const STALE_GRACE_MS = 2_000;

/** Newest mtime anywhere under `dir`, bounded so a deep tree cannot stall startup. */
function newestMtime(dir: string, depth: number): number {
  if (depth > 6) return 0;
  let newest = 0;
  const entries = readDirSafely(dir);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full, depth + 1));
    } else if (entry.isFile()) {
      newest = Math.max(newest, mtimeOf(full));
    }
  }
  return newest;
}

/** `readdirSync` that yields nothing for a directory it cannot read. */
function readDirSafely(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function mtimeOf(target: string): number {
  try {
    return statSync(target).mtimeMs;
  } catch {
    return 0;
  }
}

/** `3 minutes`, `2 hours`, `4 days` — enough precision to tell "just now" from "forgot to rebuild". */
function formatAge(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Ask every lane whether its substrate is usable right now, and collect the
 * fix for the ones that are not.
 *
 * This probes and never mutates: it does not start Colima or pull an image.
 * A lane whose `isAvailable()` throws — a contract violation —
 * is reported as unavailable with the thrown message rather than taking the
 * whole report down.
 */
export async function doctor(deps?: Partial<ApiDeps>): Promise<DoctorReport> {
  const d = withDefaults(deps);

  const lanes = await Promise.all(
    LANES.map(async (lane): Promise<LaneHealth> => {
      const runner = d.lanes[lane];
      let availability: LaneAvailability;
      try {
        availability = await runner.isAvailable();
      } catch (error) {
        availability = {
          available: false,
          reason: `${lane}.isAvailable() threw, which a lane must never do: ${
            error instanceof Error ? error.message : String(error)
          }`,
        };
      }
      return { lane, availability, detail: await laneDetail(runner) };
    }),
  );

  const install = offstageInstall();

  return {
    offstageVersion: install.version,
    install,
    warnings: install.staleBuild ? [install.staleBuild] : [],
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    lanes,
    ready: lanes.filter((health) => health.availability.available).map((health) => health.lane),
  };
}

/**
 * A lane that knows more than its three-field verdict gets to say it.
 *
 * Two lanes do: the container lane exposes the runtime probe behind its
 * decision as `probe()`, and the session lane exposes the whole availability
 * ladder as `probeSession()`. Both are duck-typed rather than declared on
 * `LaneRunner`, because the contract is deliberately narrow and neither shape
 * belongs in it. A probe that throws costs its detail lines and nothing else.
 */
async function laneDetail(runner: LaneRunner): Promise<string[]> {
  const sessionProbe = (runner as { probeSession?: () => Promise<SessionProbe> }).probeSession;
  if (typeof sessionProbe === 'function') {
    try {
      return describeSessionProbe(await sessionProbe.call(runner));
    } catch {
      return [];
    }
  }

  const probeFn = (runner as { probe?: () => Promise<ContainerRuntimeProbe> }).probe;
  if (typeof probeFn !== 'function') return [];
  try {
    return describeRuntimeProbe(await probeFn.call(runner));
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* route                                                                      */
/* -------------------------------------------------------------------------- */

export interface RouteInput extends CommandInput {}

/**
 * Decide which lane would run `command`, without running anything.
 *
 * Side-effect free by construction: the router reads argv and a few small
 * files and never executes a line of the repository it classifies.
 */
export async function route(input: RouteInput, deps?: Partial<ApiDeps>): Promise<RouteDecision> {
  const d = withDefaults(deps);
  const cwd = await resolveCwd(input, d);
  const command = resolveCommand(input.command);
  return d.classify({ cwd, command, hints: hintsFromEnv(input.env ?? d.env, input.headed) });
}

/* -------------------------------------------------------------------------- */
/* run                                                                        */
/* -------------------------------------------------------------------------- */

export interface RunInput extends CommandInput {
  /** Force a lane instead of using the router's decision. */
  lane?: Lane;
  /** Wall-clock budget. Exceeding it is `errored`, not `failed`. */
  timeoutMs?: number;
  /**
   * Called with the router's verdict and the lane that will actually run, after
   * classification and before dispatch. The CLI uses it to print where the
   * command is going before a long run starts producing nothing on screen.
   * Anything it throws is ignored — it is a notification, not a hook.
   */
  onDecision?: (event: { decision: RouteDecision; lane: Lane; laneSource: 'router' | 'explicit' }) => void;
}

export interface RunOutcome {
  runId: string;
  /** Absolute host path to the run directory. */
  artifactsDir: string;
  /** `.offstage/runs/<id>`, for printing. */
  relativeDir: string;
  /** Absolute host path to `result.json`, or `null` if it could not be written. */
  resultPath: string | null;
  /** What the router concluded, whether or not it was followed. */
  decision: RouteDecision;
  /** The lane that actually ran (or refused). */
  lane: Lane;
  laneSource: 'router' | 'explicit';
  result: LaneResult;
  /** What the `offstage` process should exit with. */
  exitCode: number;
}

/**
 * Classify, dispatch, persist, and hand back the normalized envelope.
 *
 * ## The two refusals
 *
 * `--lane` is an override, not a bypass. Over-isolating is always allowed: ask
 * for `container` on a command the router would have run in place and you get
 * it, with a diagnostic. But forcing `headless` on a command the router routed
 * *away* from headless is one move that could put a window on the user's real
 * screen, so it is refused: nothing is executed, the result is `errored`, and
 * the diagnostics name the flag to drop.
 *
 * The other refusal has no flag to drop, because no override fixes it:
 * `decision.refuse` means the command could change the machine itself (an
 * installer, a `.dmg`/`.pkg`, `hdiutil`), and offstage has no lane, not even
 * `container` or `session`, that isolates a change like that. This refusal is
 * unconditional: it applies even to an explicit `--lane`, because "more
 * isolation" is not on offer here.
 */
export async function run(input: RunInput, deps?: Partial<ApiDeps>): Promise<RunOutcome> {
  const d = withDefaults(deps);
  const cwd = await resolveCwd(input, d);
  const command = resolveCommand(input.command);
  const env = input.env ?? d.env;

  if (input.lane !== undefined && !LANES.includes(input.lane)) {
    throw new OffstageUsageError(
      `Unknown lane "${input.lane}". Expected one of: ${LANES.join(', ')}.`,
    );
  }
  if (input.timeoutMs !== undefined && (!Number.isInteger(input.timeoutMs) || input.timeoutMs <= 0)) {
    throw new OffstageUsageError('--timeout must be a positive whole number of milliseconds.');
  }

  const decision = await d.classify({
    cwd,
    command,
    hints: hintsFromEnv(env, input.headed),
  });

  const lane = input.lane ?? decision.lane;
  const laneSource: RunOutcome['laneSource'] = input.lane === undefined ? 'router' : 'explicit';

  if (input.onDecision) {
    try {
      input.onDecision({ decision, lane, laneSource });
    } catch {
      // A notification callback must not be able to fail a run.
    }
  }

  const runDir = await d.allocateRunDir({ cwd });

  const preamble = [
    `Routed to ${decision.lane} (${decision.confidence} confidence): ${decision.reason}`,
    ...decision.signals.map((signal) => `Signal: ${signal}`),
  ];

  const refusal = refuseMachineChange(decision) ?? refuseDowngrade({ lane, laneSource, decision });
  if (refusal !== null) {
    return finish(d, {
      runDir,
      decision,
      lane,
      laneSource,
      result: createLaneResult({
        lane,
        status: 'errored',
        artifactsDir: runDir.artifactsDir,
        diagnostics: [...refusal, ...preamble],
      }),
    });
  }

  if (laneSource === 'explicit' && lane !== decision.lane) {
    preamble.unshift(
      `Lane forced to "${lane}" by the caller; the router would have chosen "${decision.lane}". ` +
        'Over-isolating is allowed, so offstage honoured the override.',
    );
  }

  const started = Date.now();
  let raw: unknown;
  try {
    raw = await d.lanes[lane].run({
      cwd,
      command,
      artifactsDir: runDir.artifactsDir,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
  } catch (error) {
    // A lane throwing out of run() violates the contract. Report it as errored
    // rather than crashing the CLI, and name the lane so the bug has an owner.
    return finish(d, {
      runDir,
      decision,
      lane,
      laneSource,
      result: createLaneResult({
        lane,
        status: 'errored',
        artifactsDir: runDir.artifactsDir,
        durationMs: Date.now() - started,
        diagnostics: [
          `The ${lane} lane threw out of run(), which the lane contract forbids: ${
            error instanceof Error ? error.message : String(error)
          }`,
          'Nothing can be concluded about your code from this run.',
          ...preamble,
        ],
      }),
    });
  }

  const parsed = safeParseLaneResult(raw);
  if (!parsed.success) {
    return finish(d, {
      runDir,
      decision,
      lane,
      laneSource,
      result: createLaneResult({
        lane,
        status: 'errored',
        artifactsDir: runDir.artifactsDir,
        durationMs: Date.now() - started,
        diagnostics: [
          `The ${lane} lane returned a result that violates the lane contract:`,
          ...describeValidationError(parsed.error).map((line) => `  ${line}`),
          ...preamble,
        ],
      }),
    });
  }

  return finish(d, {
    runDir,
    decision,
    lane,
    laneSource,
    result: { ...parsed.data, diagnostics: [...parsed.data.diagnostics, ...preamble] },
  });
}

/**
 * The unconditional gate. `decision.refuse` means the router found something
 * in the command that could change the machine itself, and offstage has no
 * lane that isolates a change like that, not even `container`, which the
 * caller might otherwise reach for. Unlike {@link refuseDowngrade}, this
 * check does not look at `laneSource`: a caller passing `--lane container`
 * cannot buy their way past it, because there is no lane on offer that would
 * make the command safe to run.
 */
function refuseMachineChange(decision: RouteDecision): string[] | null {
  if (decision.refuse === undefined) return null;

  return [
    `Refused: ${decision.refuse}`,
    'Nothing was executed, on any lane. There is no --lane override for this refusal: ' +
      'offstage has no substrate that isolates a change to the machine itself.',
  ];
}

/**
 * The safety gate. Returns the diagnostics for a refusal, or `null` when the
 * requested lane is safe to honour.
 */
function refuseDowngrade(args: {
  lane: Lane;
  laneSource: RunOutcome['laneSource'];
  decision: RouteDecision;
}): string[] | null {
  const { lane, laneSource, decision } = args;
  if (laneSource !== 'explicit' || lane !== 'headless' || decision.lane === 'headless') return null;

  return [
    'Refused: --lane headless would have run this command in place, on your real screen, ' +
      `but the router routed it to the ${decision.lane} lane. Nothing was executed.`,
    `Router's reason: ${decision.reason}`,
    `Fix: drop --lane headless and let offstage use the ${decision.lane} lane, or run ` +
      '`offstage doctor` if that lane is unavailable. There is no flag that bypasses this — ' +
      'a headed browser appearing on your desktop is the one outcome offstage exists to prevent.',
  ];
}

async function finish(
  deps: ApiDeps,
  args: {
    runDir: { runId: string; artifactsDir: string; relativeDir: string };
    decision: RouteDecision;
    lane: Lane;
    laneSource: RunOutcome['laneSource'];
    result: LaneResult;
  },
): Promise<RunOutcome> {
  let result = args.result;
  let resultPath: string | null = null;
  try {
    resultPath = await deps.writeResult(result);
  } catch (error) {
    // Persisting is best-effort: the caller already has the envelope in hand,
    // and losing the file must not change the verdict.
    result = {
      ...result,
      diagnostics: [
        ...result.diagnostics,
        `Could not write result.json into ${args.runDir.artifactsDir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }

  return {
    runId: args.runDir.runId,
    artifactsDir: args.runDir.artifactsDir,
    relativeDir: args.runDir.relativeDir,
    resultPath,
    decision: args.decision,
    lane: args.lane,
    laneSource: args.laneSource,
    result,
    exitCode: exitCodeForResult(result),
  };
}

/* -------------------------------------------------------------------------- */
/* probe                                                                      */
/* -------------------------------------------------------------------------- */

export interface ProbeInput {
  /** An .xcodeproj, .xcworkspace, .app, .dmg, .entitlements file, or a directory holding one. */
  path: string;
  /**
   * Whether the probe may shell out to `codesign`, `hdiutil` and `security`.
   * Off means a pure filesystem read: fewer sources, and `confidence: 'low'`
   * more often. Defaults to on.
   */
  allowExternalTools?: boolean;
}

/**
 * Answer the one question that decides whether macOS app testing is a weekend
 * or a month: can a disposable ad-hoc-signed VM run this, or does a signing
 * lane have to be built first?
 */
export async function probe(
  input: ProbeInput,
  deps?: Partial<ApiDeps>,
): Promise<EntitlementsProbeReport> {
  const d = withDefaults(deps);
  if (typeof input?.path !== 'string' || input.path.length === 0) {
    throw new OffstageUsageError('offstage probe needs a path to inspect.');
  }
  return d.probeEntitlements(path.resolve(input.path), {
    ...(input.allowExternalTools === undefined
      ? {}
      : { allowExternalTools: input.allowExternalTools }),
  });
}

/* -------------------------------------------------------------------------- */
/* session                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The session lane is there, but it cannot do this right now — no helper
 * account, no daemon, or a TCC grant the daemon does not have.
 *
 * Distinct from {@link OffstageUsageError} on purpose: the *call* was fine, the
 * substrate is not. It carries the same `fix` string the lane and the daemon
 * produce, so the CLI, an agent and a script all get the identical repair
 * instruction. Exit code 69 (`EX_UNAVAILABLE`), which is what a `skipped` run
 * exits with too.
 */
export class OffstageSessionError extends Error {
  readonly exitCode = 69;
  readonly fix: string | undefined;
  readonly code: string;

  constructor(message: string, options: { fix?: string; code?: string } = {}) {
    super(message);
    this.name = 'OffstageSessionError';
    this.fix = options.fix;
    this.code = options.code ?? 'session-unavailable';
  }
}

/**
 * Every impure thing the session functions touch. All optional: the CLI and the
 * MCP server pass none of it, and a test passes exactly the seams it needs
 * (they are merged over the defaults one key at a time, not wholesale).
 */
export interface SessionSeams {
  /** A pre-built lane. When absent, one is built from the seams below. */
  lane?: SessionLane;
  discover?: (options: DescribeSessionOptions) => Promise<SessionDiscovery>;
  createClient?: SessionClientFactory;
  /** Exec for `chmod +a`, `dscl` and the Swift compiler. */
  exec?: Exec;
  compileDaemon?: typeof compileDaemon;
  /**
   * Run the printed root script with the terminal attached, so `sudo` and
   * `sysadminctl -password -` can prompt. Resolves with its exit code.
   */
  runRootScript?: (scriptPath: string) => Promise<number | null>;
  sleep?: (ms: number) => Promise<void>;
  /** Directory holding `build.sh` and the daemon's Swift sources. */
  sourceDir?: string;
  socketDir?: string;
  now?: () => number;
  /** Caller's home, used to decide which ancestors `share` must open. */
  home?: string;
  /**
   * Where a generated account password is persisted (default: the real
   * `~/.config/offstage/session.json`, mode 0600). Tests record instead.
   */
  writeSessionConfig?: typeof persistSessionConfig;
}

const defaultRunRootScript = async (scriptPath: string): Promise<number | null> =>
  await new Promise((resolve) => {
    // stdio inherited on purpose: sudo has to be able to prompt for a password
    // on the user's own terminal, and `sysadminctl -password -` prompts too.
    const child = spawn('sudo', ['/bin/sh', scriptPath], { stdio: 'inherit' });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code));
  });

/**
 * Sleep between daemon polls. The timer must stay ref'd: an unref'd timer is
 * the only thing on the event loop between two `hello` attempts, so Node would
 * exit with an "unsettled top-level await" in the middle of `setup` — which is
 * exactly what happened on the first live run.
 */
export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The daemon's Swift sources inside whichever copy of offstage is running. */
export function daemonSourceDir(): string {
  const root = offstageInstall().root;
  return path.join(root === '' ? process.cwd() : root, DAEMON_SOURCE_RELATIVE_DIR);
}

function seamsOf(deps: ApiDeps): SessionSeams {
  return deps.session ?? {};
}

/**
 * The lane to ask. A caller-supplied one wins; otherwise the shared instance,
 * unless a specific account or seam was named, in which case a lane is built
 * for it. `probeSession()` is the only method used here — the lane owns the
 * availability ladder and nothing re-implements it.
 */
function sessionLaneFor(deps: ApiDeps, user?: string): SessionLane {
  const seams = seamsOf(deps);
  if (seams.lane !== undefined) return seams.lane;

  const options: SessionLaneOptions = {};
  if (user !== undefined) options.user = user;
  if (seams.socketDir !== undefined) options.socketDir = seams.socketDir;
  if (seams.discover !== undefined) options.discover = seams.discover;
  if (seams.createClient !== undefined) options.createClient = seams.createClient;
  if (seams.exec !== undefined) options.exec = seams.exec;
  if (seams.now !== undefined) options.now = seams.now;

  const shared = deps.lanes.session;
  const canUseShared =
    Object.keys(options).length === 0 && typeof (shared as { probeSession?: unknown }).probeSession === 'function';
  return canUseShared ? (shared as SessionLane) : createSessionLane(options);
}

/** Everything `offstage session status` reports, and what `--json` emits. */
export interface SessionStatus {
  available: boolean;
  reason: string | null;
  fix: string | null;
  user: string;
  fullName: string;
  uid: number | null;
  home: string | null;
  accountExists: boolean;
  guiSession: GuiSessionState;
  socketPath: string;
  socketPresent: boolean;
  daemon: SessionHello['daemon'] | null;
  display: SessionHello['display'] | null;
  permissions: SessionPermissions | null;
  /** Missing TCC grants and anything else worth saying even when available. */
  notes: string[];
  /** The probe rendered the way `offstage doctor` renders it. */
  detail: string[];
}

function statusFromProbe(probe: SessionProbe): SessionStatus {
  const { availability, discovery, hello, notes } = probe;
  return {
    available: availability.available,
    reason: availability.reason ?? null,
    fix: availability.fix ?? null,
    user: discovery.user,
    fullName: sessionUserFullName(discovery),
    uid: discovery.uid,
    home: discovery.home,
    accountExists: discovery.accountExists,
    guiSession: discovery.guiSession,
    socketPath: discovery.socketPath,
    socketPresent: discovery.socketPresent,
    daemon: hello?.daemon ?? null,
    display: hello?.display ?? null,
    permissions: hello?.permissions ?? null,
    notes,
    detail: describeSessionProbe(probe),
  };
}

/**
 * Report the helper account, its session, the socket, the daemon and both TCC
 * grants — plus the fix for whichever rung failed first.
 *
 * Reads only. It never starts anything, never prompts, and never touches the
 * console session.
 */
export async function sessionStatus(
  input: { user?: string } = {},
  deps?: Partial<ApiDeps>,
): Promise<SessionStatus> {
  const d = withDefaults(deps);
  return statusFromProbe(await sessionLaneFor(d, input.user).probeSession());
}

/** A client for the daemon, or the lane's own reason why there is not one. */
async function sessionConnect(
  deps: ApiDeps,
  user?: string,
): Promise<{ client: SessionClient; probe: SessionProbe }> {
  const probe = await sessionLaneFor(deps, user).probeSession();
  if (!probe.availability.available) {
    throw new OffstageSessionError(
      probe.availability.reason ?? 'The session lane is not available on this machine.',
      { fix: probe.availability.fix ?? undefined, code: 'session-unavailable' },
    );
  }
  const factory = seamsOf(deps).createClient ?? createSessionClient;
  return { client: factory({ socketPath: probe.discovery.socketPath }), probe };
}

/** Turn a daemon refusal into the one error shape the CLI and MCP both render. */
function asSessionError(error: unknown): never {
  if (error instanceof OffstageSessionError) throw error;
  if (error instanceof SessionRpcError) {
    throw new OffstageSessionError(error.message, {
      ...(error.fix === undefined ? {} : { fix: error.fix }),
      code: error.code,
    });
  }
  if (error instanceof SessionUnreachableError) {
    throw new OffstageSessionError(
      `The offstage session daemon did not answer on ${error.socketPath}: ${error.message}`,
      { fix: 'offstage session setup', code: 'unreachable' },
    );
  }
  throw error;
}

/* ---------------------------------- setup --------------------------------- */

export interface SessionSetupInput {
  /** Helper account. Defaults to the configured one (env → config → computeruse). */
  user?: string;
  /** Create the account when it does not exist yet, with a generated password. */
  create?: boolean;
  /**
   * Arm boot-time auto-login for the helper account. Opt-in: macOS refuses it
   * under FileVault, and it changes what appears at boot (the helper session
   * comes up first, then you switch back to your own account as usual).
   * Needs a password: a generated one when `create` is also set, `--password`
   * for an existing account, or an interactive prompt inside the root script.
   */
  autoLogin?: boolean;
  /** Password to use for the created account or the auto-login armament. */
  password?: string;
  /**
   * Where the script and the progress lines go. The root script is *printed
   * before it runs*, always: the user is about to type a password, and "trust
   * me" is not an acceptable thing for a tool to say at that moment.
   */
  io?: (line: string) => void;
}

/** One thing setup did, and whether it worked. */
export interface SessionSetupStep {
  step:
    | 'compile'
    | 'codesign'
    | 'account'
    | 'assistant'
    | 'install'
    | 'tcc'
    | 'wait'
    | 'permissions'
    | 'auto-login';
  ok: boolean;
  detail: string;
}

export interface SessionSetupResult {
  ok: boolean;
  user: string;
  uid: number | null;
  /** Exactly what was run as root, so `--json` carries it as well as the terminal. */
  script: string;
  scriptPath: string | null;
  steps: SessionSetupStep[];
  /** The status after the install, when the daemon came up. */
  status: SessionStatus | null;
  permissions: SessionPermissions | null;
  /** What the human still has to do, in order. Empty when nothing is left. */
  nextSteps: string[];
}

/** How long the daemon gets to bind its socket and answer `hello`. */
const SETUP_HELLO_TIMEOUT_MS = 15_000;
const SETUP_HELLO_POLL_MS = 500;

/**
 * Install `offstage-sessiond` into the helper account's GUI session.
 *
 * The only step that needs root is one shell script, and it is printed in full
 * before `sudo` is invoked on it. Everything before that (compiling the daemon,
 * rendering the plist) and everything after (waiting for `hello`, asking for
 * the TCC prompts) runs as you.
 *
 * Never throws for an environment problem: a machine with no Swift compiler, a
 * missing account, or a `sudo` the user cancelled all come back as
 * `ok: false` with the reason in `steps` and the repair in `nextSteps`.
 */
export async function sessionSetup(
  input: SessionSetupInput = {},
  deps?: Partial<ApiDeps>,
): Promise<SessionSetupResult> {
  const d = withDefaults(deps);
  const seams = seamsOf(d);
  const say = input.io ?? ((): void => {});
  const exec = seams.exec ?? defaultExec;
  const socketDir = seams.socketDir ?? DEFAULT_SOCKET_DIR;
  const discoverFn = seams.discover ?? describeSession;
  const steps: SessionSetupStep[] = [];

  const discoverOptions: DescribeSessionOptions = { socketDir };
  if (input.user !== undefined) discoverOptions.user = input.user;
  if (seams.exec !== undefined) discoverOptions.exec = seams.exec;
  let discovery = await discoverFn(discoverOptions);

  const bail = (nextSteps: string[]): SessionSetupResult => ({
    ok: false,
    user: discovery.user,
    uid: discovery.uid,
    script: '',
    scriptPath: null,
    steps,
    status: null,
    permissions: null,
    nextSteps,
  });

  if (discovery.platform !== 'darwin') {
    return bail([
      `The session lane is macOS-only; this host is ${discovery.platform}. Nothing was installed.`,
    ]);
  }

  /* The plist names a uid and a home, and launchd's domain is `gui/<uid>`, so
     both have to be known before the script is written — which means an account
     that does not exist yet has to be created with a uid we chose rather than
     one sysadminctl picked for us. */
  let createAccount = false;
  let uid = discovery.uid;
  let home = discovery.home;
  if (!discovery.accountExists) {
    if (input.create !== true) {
      return bail([
        `There is no "${discovery.user}" account on this Mac.`,
        `Create it: offstage session setup --create${input.user === undefined ? '' : ` --user ${input.user}`}`,
      ]);
    }
    createAccount = true;
    uid = await nextFreeUid(exec);
    home = `/Users/${discovery.user}`;
    if (uid === null) {
      return bail([
        'Could not read the existing uids from the directory service, so no free uid could be chosen for the new account.',
        'Create the account yourself in System Settings → Users & Groups, then run `offstage session setup` again.',
      ]);
    }
  }
  if (uid === null || home === null) {
    return bail([
      `The "${discovery.user}" account exists but the directory service reports no uid or home directory for it.`,
      `Check it with: dscl . -read /Users/${discovery.user} UniqueID NFSHomeDirectory`,
    ]);
  }

  /* A created account needs a real password from the start: an empty one gets
     no AuthenticationAuthority and cannot log in under FileVault. Generated
     unless the caller named one, and persisted so the human can look it up
     later — the helper account is only ever switched into on purpose. */
  let accountPassword: string | null = null;
  if (createAccount) {
    accountPassword = input.password ?? generateSessionPassword();
    say(`Password for the new "${discovery.user}" account: ${accountPassword}`);
  }

  /* Auto-login is armed with the same secret. An existing account without a
     named password falls back to sysadminctl's own interactive prompt inside
     the root script (`-password -`), which works because setup always runs
     attached to a terminal. */
  let autoLoginPassword: string | '-' | null = null;
  let fileVault: boolean | null = null;
  if (input.autoLogin === true) {
    autoLoginPassword = accountPassword ?? input.password ?? '-';
    const vault = await readFileVaultStatus(exec);
    fileVault = vault.active;
    if (fileVault === true) {
      say('Note: FileVault is on. macOS refuses auto-login while it is enabled;');
      say('the account will have to be logged in once by hand after each boot.');
    }
  }

  /* 1. Compile the daemon, as you, into a temp directory. */
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-session-setup-'));
  const binaryPath = path.join(workDir, DAEMON_BINARY_NAME);
  const sourceDir = seams.sourceDir ?? daemonSourceDir();
  say(`Compiling ${DAEMON_BINARY_NAME} from ${sourceDir}…`);
  const compile: CompileDaemonResult = await (seams.compileDaemon ?? compileDaemon)({
    sourceDir,
    outPath: binaryPath,
    ...(seams.exec === undefined ? {} : { exec: seams.exec }),
  });
  steps.push({
    step: 'compile',
    ok: compile.ok,
    detail: compile.ok
      ? `built ${binaryPath} via ${compile.via}`
      : (compile.reason ?? `${compile.command} exited ${compile.exitCode ?? 'without a code'}`),
  });
  if (!compile.ok) {
    const tail = (compile.stderr || compile.stdout).trim().split('\n').slice(-8);
    return bail([
      compile.reason ?? 'The offstage session daemon did not compile, so nothing was installed.',
      ...(compile.fix === undefined ? [] : [`Fix: ${compile.fix}`]),
      ...tail,
    ]);
  }

  /* 1b. Export the binary's Designated Requirement. This is what makes both
     TCC grants pre-seedable: the rows setup writes carry exactly the blob a
     human's toggle would have written, verified byte-for-byte against rows
     System Settings produced. */
  const csreq = await exportCsreq(binaryPath, exec);
  steps.push({
    step: 'codesign',
    ok: csreq.ok,
    detail: csreq.ok
      ? `designated requirement exported (${(csreq.hex?.length ?? 0) / 2} bytes)`
      : `could not export a code requirement: ${csreq.reason}`,
  });

  /* First-login suppression matters until the account has finished one login;
     after that its cfprefsd owns those preferences and root must leave them
     alone. */
  const suppressAssistant =
    createAccount ||
    !(discovery.guiSession.exists && discovery.guiSession.loginDone);

  /* 2. Render the LaunchAgent and the one script that needs root. */
  const plistPath = path.join(workDir, `${DEFAULT_LABEL}.plist`);
  await fs.writeFile(
    plistPath,
    renderLaunchAgentPlist({
      binaryPath: path.join(installDirFor(home), DAEMON_BINARY_NAME),
      uid,
      socketDir,
      home,
    }),
    'utf8',
  );

  const script = renderInstallScript({
    binarySource: binaryPath,
    plistSource: plistPath,
    user: discovery.user,
    uid,
    home,
    socketDir,
    ...(createAccount && accountPassword !== null
      ? { createAccount: { password: accountPassword } }
      : {}),
    ...(suppressAssistant ? { skipSetupAssistant: true } : {}),
    ...(csreq.hex !== undefined ? { tcc: { csreqHex: csreq.hex } } : {}),
    /* The user menu is what makes the one remaining manual step discoverable
       — and with auto-login armed it is how you get back to your own account. */
    enableFastUserSwitching: true,
    ...(autoLoginPassword !== null ? { autoLoginPassword } : {}),
  });
  const scriptPath = path.join(workDir, 'install.sh');
  await fs.writeFile(scriptPath, script, { mode: 0o700 });

  /* Record what the script is being asked to do, so `--json` carries the
     intent even though the work itself happens inside sudo. */
  if (createAccount) {
    steps.push({
      step: 'account',
      ok: true,
      detail: `create "${discovery.user}" (uid ${uid}) included in the root script`,
    });
  }
  if (suppressAssistant) {
    steps.push({
      step: 'assistant',
      ok: true,
      detail: 'first-login Setup Assistant suppression included in the root script',
    });
  }
  if (csreq.hex !== undefined) {
    steps.push({
      step: 'tcc',
      ok: true,
      detail:
        'pre-seed Screen Recording + Accessibility for the installed path (needs Full Disk Access on this terminal)',
    });
  } else {
    steps.push({
      step: 'tcc',
      ok: false,
      detail: `skipped: ${csreq.reason ?? 'no code requirement'}`,
    });
  }
  if (autoLoginPassword !== null) {
    steps.push({
      step: 'auto-login',
      ok: fileVault !== true,
      detail:
        fileVault === true
          ? 'requested but FileVault is on; sysadminctl will refuse and the script continues'
          : 'arm boot-time auto-login for the helper account',
    });
  }

  say('');
  say('This is the only step that needs root. It is printed here in full before it runs:');
  say('');
  for (const line of script.split('\n')) say(`    ${line}`);
  say('');
  say(`Running: sudo /bin/sh ${scriptPath}`);

  const exitCode = await (seams.runRootScript ?? defaultRunRootScript)(scriptPath);
  steps.push({
    step: 'install',
    ok: exitCode === 0,
    detail: exitCode === 0 ? 'the root script completed' : `sudo /bin/sh ${scriptPath} exited ${exitCode ?? 'without a code'}`,
  });

  /* The generated secret outlives this command only if it is written down.
     Non-fatal by design: a failed write must not undo a completed install. */
  if (accountPassword !== null && exitCode === 0) {
    try {
      await (seams.writeSessionConfig ?? persistSessionConfig)(discovery.user, accountPassword);
    } catch {
      say(`Note: could not persist the account password to ~/${SESSION_CONFIG_RELATIVE_PATH}.`);
    }
  }

  if (exitCode !== 0) {
    return {
      ...bail([
        'The install script did not complete, so the daemon was not bootstrapped.',
        `Re-run it yourself to see the failure: sudo /bin/sh ${scriptPath}`,
      ]),
      script,
      scriptPath,
      uid,
    };
  }

  /* 3. Wait for the daemon to bind and answer. launchd bootstraps
        asynchronously, so the socket is not there the instant sudo returns. */
  discovery = await discoverFn({ ...discoverOptions, user: discovery.user });
  const socketPath = discovery.socketPath;
  const clientFactory = seams.createClient ?? createSessionClient;
  const sleep = seams.sleep ?? defaultSleep;
  const now = seams.now ?? Date.now;
  const deadline = now() + SETUP_HELLO_TIMEOUT_MS;
  let hello: SessionHello | null = null;
  let lastError = '';
  say(`Waiting for the daemon on ${socketPath}…`);
  for (;;) {
    try {
      hello = await clientFactory({ socketPath }).hello();
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (now() >= deadline) break;
      await sleep(SETUP_HELLO_POLL_MS);
    }
  }
  steps.push({
    step: 'wait',
    ok: hello !== null,
    detail:
      hello === null
        ? `no answer on ${socketPath} within ${SETUP_HELLO_TIMEOUT_MS / 1000}s: ${lastError}`
        : `hello from pid ${hello.daemon.pid}, onConsole ${hello.session.onConsole}`,
  });

  if (hello === null) {
    return {
      ...bail([
        `The daemon did not answer on ${socketPath} within ${SETUP_HELLO_TIMEOUT_MS / 1000} seconds.`,
        !discovery.guiSession.exists || !discovery.guiSession.loginDone
          ? `The "${discovery.user}" account has no logged-in GUI session yet, and a LaunchAgent only starts inside one. Log ${discovery.user} in once with fast user switching (user menu → ${sessionUserFullName(discovery)}), then switch back and run \`offstage session status\`.`
          : `Check the daemon's log: ${path.join(home, 'Library', 'Logs', 'offstage-sessiond.log')}`,
      ]),
      script,
      scriptPath,
      uid,
    };
  }

  /* 4. Raise the TCC prompts. They appear inside the helper session, where the
        user sees them on their next switch — nothing pops up on this screen. */
  let permissions: SessionPermissions | null = null;
  try {
    permissions = await clientFactory({ socketPath }).requestPermissions();
    steps.push({
      step: 'permissions',
      ok: permissions.screenCapture && permissions.accessibility,
      detail: `Screen Recording ${permissions.screenCapture ? 'granted' : 'not granted'}, Accessibility ${
        permissions.accessibility ? 'granted' : 'not granted'
      }`,
    });
  } catch (error) {
    steps.push({
      step: 'permissions',
      ok: false,
      detail: `could not raise the permission prompts: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const status = statusFromProbe(await sessionLaneFor(d, discovery.user).probeSession());

  /* What is actually left for a human, given everything the script could do
     on its own. The TCC pre-seed removes the permission toggles entirely when
     it ran; auto-login turns "switch once after every boot" into "log into
     your own account like you always do". */
  const nextSteps: string[] = [];
  if (createAccount) {
    nextSteps.push(
      `The "${discovery.user}" account (uid ${uid}) was created. Its password: ${accountPassword ?? '(the one you supplied)'}. It is also stored at ~/${SESSION_CONFIG_RELATIVE_PATH}.`,
    );
  }
  if (!status.guiSession.loginDone) {
    if (input.autoLogin === true && fileVault !== true) {
      nextSteps.push(
        `Reboot once. ${sessionUserFullName(status)} will be logged in automatically; when its desktop appears, switch back to your own account from the user menu (top-right). From then on every boot brings the helper session up by itself.`,
      );
    } else {
      nextSteps.push(
        `Log ${discovery.user} in once with fast user switching (user menu → ${status.fullName}), then switch back; the session keeps running in the background.${
          input.autoLogin === true && fileVault === true
            ? ' Auto-login was requested but FileVault blocks it, so this switch is needed after each boot.'
            : ''
        }`,
      );
    }
  }
  const missing = [
    ...(permissions?.screenCapture === false ? ['Screen Recording'] : []),
    ...(permissions?.accessibility === false ? ['Accessibility'] : []),
  ];
  if (missing.length > 0) {
    nextSteps.push(
      csreq.ok
        ? `The grants were pre-seeded but the daemon reports ${missing.join(' and ')} missing. Switch to ${discovery.user}, approve them in System Settings → Privacy & Security for ${DAEMON_BINARY_NAME}, then switch back and run \`offstage session status\`.`
        : `Switch to the ${discovery.user} account once and allow ${missing.join(' and ')} for ${DAEMON_BINARY_NAME} in System Settings → Privacy & Security, then switch back.`,
    );
  } else if (permissions === null && !csreq.ok) {
    nextSteps.push(
      `Screen Recording and Accessibility still need a human switch: log into ${discovery.user}, approve both for ${DAEMON_BINARY_NAME} in System Settings → Privacy & Security, and switch back. (Pre-seeding them needs Full Disk Access on the terminal running setup.)`,
    );
  }
  nextSteps.push(
    'Give the helper account read access to a repository before running anything in it: offstage session share <dir>',
  );

  return {
    ok: true,
    user: discovery.user,
    uid,
    script,
    scriptPath,
    steps,
    status,
    permissions,
    nextSteps,
  };
}

/**
 * The lowest free uid at or above 502 — 501 is the first human account on a
 * Mac, and 502 is the conventional second one.
 *
 * Returns `null` when the directory service could not be read at all, which is
 * the one case where guessing would be wrong.
 */
async function nextFreeUid(exec: Exec): Promise<number | null> {
  const outcome = await exec('/usr/bin/dscl', ['.', '-list', '/Users', 'UniqueID']);
  if (outcome.exitCode !== 0) return null;
  const taken = new Set<number>();
  for (const line of outcome.stdout.split('\n')) {
    const value = Number(line.trim().split(/\s+/).pop());
    if (Number.isInteger(value)) taken.add(value);
  }
  if (taken.size === 0) return null;
  let candidate = 502;
  while (taken.has(candidate)) candidate += 1;
  return candidate;
}

/* ---------------------------------- share --------------------------------- */

export interface SessionShareResult {
  ok: boolean;
  user: string;
  target: string;
  /** The `chmod +a` commands, exactly as run. */
  commands: string[];
  failures: Array<{ command: string; stderr: string; exitCode: number | null }>;
}

/**
 * Give the helper account read access to one tree, and nothing else.
 *
 * Traverse-only (`search`) on each ancestor so the path is reachable, read on
 * the tree itself. It never grants write: a run's output goes to
 * `$OFFSTAGE_ARTIFACTS`, which the lane opens per run because it owns it.
 */
export async function sessionShare(
  input: { path: string; user?: string },
  deps?: Partial<ApiDeps>,
): Promise<SessionShareResult> {
  const d = withDefaults(deps);
  const seams = seamsOf(d);
  if (typeof input?.path !== 'string' || input.path.trim() === '') {
    throw new OffstageUsageError('offstage session share needs a directory to share.');
  }
  const target = path.resolve(input.path);
  if (!(await d.directoryExists(target)) && !(await fileExists(target))) {
    throw new OffstageUsageError(`No such file or directory: ${target}`, 66);
  }

  const discoverOptions: DescribeSessionOptions = {};
  if (input.user !== undefined) discoverOptions.user = input.user;
  if (seams.socketDir !== undefined) discoverOptions.socketDir = seams.socketDir;
  if (seams.exec !== undefined) discoverOptions.exec = seams.exec;
  const discovery = await (seams.discover ?? describeSession)(discoverOptions);

  const options = {
    target,
    user: discovery.user,
    home: seams.home ?? os.homedir(),
    ...(seams.exec === undefined ? {} : { exec: seams.exec }),
  };
  const result = await shareAcl(options);
  return {
    ok: result.ok,
    user: discovery.user,
    target,
    commands: result.commands,
    failures: result.failures,
  };
}

/** The `chmod +a` plan for a tree, without running it. Pure, for `--json` and docs. */
export function sessionSharePlan(input: { path: string; user: string; home?: string }): string[] {
  return shareAclCommands({
    target: path.resolve(input.path),
    user: input.user,
    home: input.home ?? os.homedir(),
  }).map(describeAclCommand);
}

/* --------------------------------- unshare -------------------------------- */

export interface SessionUnshareResult {
  ok: boolean;
  user: string;
  target: string;
  /** The `chmod -a` commands, exactly as run (absence-tolerant). */
  commands: string[];
  failures: Array<{ command: string; stderr: string; exitCode: number | null }>;
}

/**
 * Revoke exactly what {@link sessionShare} granted: the read ACL on the tree —
 * recursively, including entries children inherited while the grant stood —
 * and the traverse-only entries on its ancestors.
 *
 * The tree does not have to exist any more for this to be worth calling;
 * a `chmod` that finds nothing to remove is success, and anything else comes
 * back in `failures`.
 */
export async function sessionUnshare(
  input: { path: string; user?: string },
  deps?: Partial<ApiDeps>,
): Promise<SessionUnshareResult> {
  const d = withDefaults(deps);
  const seams = seamsOf(d);
  if (typeof input?.path !== 'string' || input.path.trim() === '') {
    throw new OffstageUsageError('offstage session unshare needs a directory to unshare.');
  }
  const target = path.resolve(input.path);

  const discoverOptions: DescribeSessionOptions = {};
  if (input.user !== undefined) discoverOptions.user = input.user;
  if (seams.socketDir !== undefined) discoverOptions.socketDir = seams.socketDir;
  if (seams.exec !== undefined) discoverOptions.exec = seams.exec;
  const discovery = await (seams.discover ?? describeSession)(discoverOptions);

  const result = await unshareAcl({
    target,
    user: discovery.user,
    home: seams.home ?? os.homedir(),
    ...(seams.exec === undefined ? {} : { exec: seams.exec }),
  });
  return {
    ok: result.ok,
    user: discovery.user,
    target,
    commands: result.commands,
    failures: result.failures,
  };
}

const fileExists = async (target: string): Promise<boolean> => {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
};

/* ------------------------------- screenshot ------------------------------- */

export interface SessionScreenshotInput {
  /** Longest edge of the returned image, in pixels. Omit for the full framebuffer. */
  maxDimension?: number;
  /**
   * Where to write the PNG. `undefined` writes to
   * `<cwd>/.offstage/screenshots/<timestamp>.png`; `null` writes nothing and
   * returns the bytes only, which is what the MCP tool wants.
   */
  out?: string | null;
  cwd?: string;
  user?: string;
}

export interface SessionScreenshotResult {
  /** Absolute path of the PNG on disk, or `null` when nothing was written. */
  path: string | null;
  /** The image's own pixel size — not the display's point size. */
  width: number;
  height: number;
  /** Backing scale of the captured display: pixels per point. */
  scale: number;
  png: Buffer;
}

/** Capture the helper session's screen. Never the console's — the daemon is in the other session. */
export async function sessionScreenshot(
  input: SessionScreenshotInput = {},
  deps?: Partial<ApiDeps>,
): Promise<SessionScreenshotResult> {
  const d = withDefaults(deps);
  if (
    input.maxDimension !== undefined &&
    (!Number.isInteger(input.maxDimension) || input.maxDimension <= 0)
  ) {
    throw new OffstageUsageError('--max must be a positive whole number of pixels.');
  }

  const { client } = await sessionConnect(d, input.user);
  let shot;
  try {
    shot = await client.screenshot(
      input.maxDimension === undefined ? {} : { maxDimension: input.maxDimension },
    );
  } catch (error) {
    return asSessionError(error);
  }

  let out: string | null = null;
  if (input.out !== null) {
    out =
      input.out ??
      path.join(
        path.resolve(input.cwd ?? process.cwd()),
        '.offstage',
        'screenshots',
        `${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
      );
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, shot.png);
  }

  return { path: out, width: shot.width, height: shot.height, scale: shot.scale, png: shot.png };
}

/* ---------------------------------- input --------------------------------- */

export interface SessionInputResult {
  performed: number;
  actions: InputAction[];
}

/**
 * Inject keyboard and mouse events into the helper session.
 *
 * Coordinates are **points** in the helper display's global space, origin at
 * its top-left — the same space `status.display` reports and the same space a
 * screenshot describes once divided by `scale`.
 */
export async function sessionInput(
  input: { actions: unknown; user?: string },
  deps?: Partial<ApiDeps>,
): Promise<SessionInputResult> {
  const d = withDefaults(deps);
  let actions: InputAction[];
  try {
    actions = parseInputActions(input?.actions);
  } catch (error) {
    throw new OffstageUsageError(
      `Those are not valid input actions: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (actions.length === 0) {
    throw new OffstageUsageError('offstage session input needs at least one action.');
  }

  const { client } = await sessionConnect(d, input.user);
  try {
    const { performed } = await client.input(actions);
    return { performed, actions };
  } catch (error) {
    return asSessionError(error);
  }
}

/* --------------------------------- update --------------------------------- */

export interface SessionUpdateResult {
  /** Where the new binary now lives, inside the helper account's home. */
  installedTo: string;
  previousPid: number;
  currentPid: number;
}

/**
 * Rebuild the daemon and install it, without asking for any privilege.
 *
 * Setup needs root once. Nothing after it does, and that is deliberate: an
 * admin prompt raised from a background task puts a dialog on the console that
 * captures the keyboard until it is answered. The binary lives in the helper
 * account's own home, so the daemon can replace it over its own socket.
 */
export async function sessionUpdate(
  input: { user?: string } = {},
  deps?: Partial<ApiDeps>,
): Promise<SessionUpdateResult> {
  const d = withDefaults(deps);
  const seams = seamsOf(d);
  const { client } = await sessionConnect(d, input.user);

  let home: string;
  try {
    home = (await client.hello()).user.home;
  } catch (error) {
    return asSessionError(error);
  }

  /* Staging has to be somewhere the HELPER account can read, and os.tmpdir()
     is not it: on macOS that resolves to a per-user /var/folders tree whose
     parent is mode 700, so another uid cannot traverse into it however the leaf
     is chmod'd. Verified the hard way, as `cp: Permission denied`. /tmp is the
     shared, world-traversable one. mkdtemp still gives an unpredictable name,
     and the directory is widened only to r-x. */
  const workDir = await fs.mkdtemp('/tmp/offstage-session-update-');
  await fs.chmod(workDir, 0o755);
  const binaryPath = path.join(workDir, DAEMON_BINARY_NAME);
  const sourceDir = seams.sourceDir ?? daemonSourceDir();

  const compile: CompileDaemonResult = await (seams.compileDaemon ?? compileDaemon)({
    sourceDir,
    outPath: binaryPath,
    ...(seams.exec === undefined ? {} : { exec: seams.exec }),
  });
  if (!compile.ok) {
    throw new OffstageSessionError(
      `Could not build ${DAEMON_BINARY_NAME} from ${sourceDir}: ${
        compile.reason ?? `${compile.command} exited ${compile.exitCode ?? 'without a code'}`
      }`,
      { code: 'session-build-failed' },
    );
  }
  await fs.chmod(binaryPath, 0o755);

  try {
    const result = await updateDaemon({ client, home, source: binaryPath });
    return {
      installedTo: result.installedTo,
      previousPid: result.previousPid,
      currentPid: result.currentPid,
    };
  } catch (error) {
    if (error instanceof UpdateError) {
      throw new OffstageSessionError(error.message, { code: 'session-update-failed' });
    }
    return asSessionError(error);
  }
}

/* ---------------------------------- apps ---------------------------------- */

/** The regular-activation-policy apps running in the helper session. */
export async function sessionApps(
  input: { user?: string } = {},
  deps?: Partial<ApiDeps>,
): Promise<SessionApp[]> {
  const d = withDefaults(deps);
  const { client } = await sessionConnect(d, input.user);
  try {
    return await client.apps();
  } catch (error) {
    return asSessionError(error);
  }
}

/* ---------------------------------- open ---------------------------------- */

/**
 * `open <target> [args…]`, in the helper session.
 *
 * Deliberately a thin call into {@link run} with `lane: 'session'` rather than
 * a fifth code path: it gets the run directory, the `result.json`, the
 * screenshot and the diagnostics for free, and an agent that reads one run
 * envelope can read this one.
 */
export async function sessionOpen(
  input: { target: string; args?: string[]; cwd?: string; timeoutMs?: number },
  deps?: Partial<ApiDeps>,
): Promise<RunOutcome> {
  if (typeof input?.target !== 'string' || input.target.trim() === '') {
    throw new OffstageUsageError('offstage session open needs an app name or a path to open.');
  }
  return await run(
    {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      command: ['open', input.target, ...(input.args ?? [])],
      lane: 'session',
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    },
    deps,
  );
}
