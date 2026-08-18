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
import { vmLane } from '../lanes/vm/index.js';
import type { EntitlementsProbeReport } from '../probe/index.js';
import { probeEntitlements } from '../probe/index.js';
import type { ClassifyHints } from '../router/index.js';
import { classify } from '../router/index.js';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The caller asked for something impossible — a cwd that does not exist, an
 * empty command, a lane that is not one of the three. This is the only thing
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
}

const directoryExists = async (target: string): Promise<boolean> => {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
};

export const defaultDeps: ApiDeps = {
  lanes: { headless: headlessLane, container: containerLane, vm: vmLane },
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
  return command as string[];
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
  node: string;
  platform: string;
  arch: string;
  lanes: LaneHealth[];
  /** The lanes that could run something right now. */
  ready: Lane[];
}

let cachedVersion: string | undefined;

async function readVersion(): Promise<string> {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = await fs.readFile(path.resolve(here, '..', '..', 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedVersion = typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

/**
 * Ask every lane whether its substrate is usable right now, and collect the
 * fix for the ones that are not.
 *
 * This probes and never mutates: it does not start Colima, install Tart, or
 * pull an image. A lane whose `isAvailable()` throws — a contract violation —
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

  return {
    offstageVersion: await readVersion(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    lanes,
    ready: lanes.filter((health) => health.availability.available).map((health) => health.lane),
  };
}

/** The container lane exposes the probe behind its verdict; render it if present. */
async function laneDetail(runner: LaneRunner): Promise<string[]> {
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
 * ## The one refusal
 *
 * `--lane` is an override, not a bypass. Over-isolating is always allowed: ask
 * for `container` or `vm` on a command the router would have run in place and
 * you get it, with a diagnostic. But forcing `headless` on a command the router
 * routed *away* from headless is the one move that could put a window on the
 * user's real screen, so it is refused: nothing is executed, the result is
 * `errored`, and the diagnostics name the flag to drop. There is deliberately
 * no flag that makes offstage do it anyway.
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

  const refusal = refuseDowngrade({ lane, laneSource, decision });
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
