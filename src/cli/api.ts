/**
 * offstage: the programmatic API behind the CLI.
 *
 * Four verbs live here, and they are the whole product: `doctor` says which
 * lanes can run, `route` decides where a command belongs, `run` sends it there,
 * and `probe` reads a macOS app's entitlements. `src/cli/index.ts` renders them
 * for a terminal and `src/mcp/core.ts` hands them to an agent; neither decides
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
 * The session lane's own verbs are not here. Bringing that lane up lives in
 * `./session.ts` and driving it lives in `./session-control.ts`, because both
 * are about one lane's substrate rather than about routing a command. What they
 * share with this file is {@link ApiDeps}, whose seams they read through
 * {@link withDefaults}.
 *
 * The four functions return typed values and throw only for caller error
 * ({@link OffstageUsageError}). A run that fails, times out, or is refused
 * comes back as a valid `LaneResult`, never as an exception: the contract's
 * rule 2, hoisted one level up so the CLI and the MCP server can share it.
 */

import { type Dirent, readFileSync, readdirSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
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
import type { SessionProbe } from '../lanes/session/index.js';
import { describeSessionProbe, sessionLane } from '../lanes/session/index.js';
import type { EntitlementsProbeReport } from '../probe/index.js';
import { probeEntitlements } from '../probe/index.js';
import type { ClassifyHints } from '../router/index.js';
import { classify, tokenizeShellish } from '../router/index.js';
import { measurePipeCapacity, pipeWarning } from './pipecheck.js';
import type { SessionSeams } from './session.js';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The caller asked for something impossible: a cwd that does not exist, an
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

export function withDefaults(overrides?: Partial<ApiDeps>): ApiDeps {
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
  // named, so it classifies as headless: a wrong answer that reads as a
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
 * The router deliberately reads no environment variables: it takes `{cwd,
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
  /** Extra lines worth printing under the lane: the container runtime probe's steps. */
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
   * it claims: meaning the running code is not what the repository says.
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
 * the CLI and the server both, so the two cannot drift. They did once: the
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
    `whatever started this process: a long-lived MCP server keeps the build it launched with.`
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

/** `3 minutes`, `2 hours`, `4 days`: enough precision to tell "just now" from "forgot to rebuild". */
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
 * A lane whose `isAvailable()` throws, a contract violation,
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
  const warnings = install.staleBuild ? [install.staleBuild] : [];
  /* A degraded kernel passes every lane probe and still cannot run the work
     the lanes are for (the pipe-buffer condition that hangs local Xcode
     builds). Measured, not assumed, and silent when healthy. */
  const pipe = await measurePipeCapacity();
  const pipeLine = pipe.bytes === undefined ? undefined : pipeWarning(pipe.bytes);
  if (pipeLine !== undefined) warnings.push(pipeLine);

  return {
    offstageVersion: install.version,
    install,
    warnings,
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
   * Anything it throws is ignored: it is a notification, not a hook.
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
      '`offstage doctor` if that lane is unavailable. There is no flag that bypasses this: ' +
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
 * or a month: is ad-hoc signing enough to build and test this app, or does a
 * real Developer ID identity have to be wired in first?
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
