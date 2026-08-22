/**
 * offstage — the lane contract.
 *
 * Everything in offstage is a routing decision followed by a lane execution.
 * This module is the single place where "what a lane is" and "what a lane
 * returns" are defined. The router (`src/router/`), all four lanes
 * (`src/lanes/*`), the CLI (`src/cli/`) and the MCP server (`src/mcp/`) all
 * speak exactly these types — nothing else crosses a module boundary.
 *
 * ## Path conventions (normative — the schema enforces these)
 *
 * offstage runs a command on the host, inside a container, or inside a VM, and
 * the same envelope has to make sense in all three cases. So paths are split
 * into two kinds, and the kind is fixed per field:
 *
 * | Field                     | Kind                | Rule                                       |
 * | ------------------------- | ------------------- | ------------------------------------------ |
 * | `LaneRequest.cwd`         | absolute (host)     | the repository root the command runs against |
 * | `LaneRequest.artifactsDir`| absolute (host)     | run-scoped output dir the lane owns         |
 * | `LaneResult.artifactsDir` | absolute (host)     | echoes the request                          |
 * | `LaneResult.logPath`      | absolute (host)     | must be inside `artifactsDir`, or `null`    |
 * | `LaneResult.artifacts[].path` | absolute (host) | must be inside `artifactsDir`               |
 * | `LaneResult.failures[].file`  | repository-relative | POSIX separators, relative to `cwd`, never absolute |
 *
 * The reasoning, so lane authors do not have to guess:
 *
 * - **Artifacts are absolute host paths.** They are things the run *produced*.
 *   The container lane generates them inside a guest and copies them back out,
 *   so a guest-relative path would be a lie by the time anyone reads it.
 *   Absolute host paths are the only representation that stays true after the
 *   substrate is gone. Containment under `artifactsDir` is enforced so that a
 *   run directory is self-contained and safe to archive or delete.
 * - **Failure file paths are repository-relative.** They point at the user's
 *   *source*, which exists identically on the host and in the guest at
 *   different absolute prefixes. Repo-relative is the only form that a human,
 *   an editor, and an agent can all resolve, on any of the four lanes.
 *
 * Use the helpers in `./artifacts.js` (`artifactPath`, `toRepoRelative`) rather
 * than hand-rolling these; they produce values the schema accepts.
 *
 * NOTE for implementors: this project builds with `verbatimModuleSyntax`, so
 * import the types from here with `import type`, and keep the `.js` extension
 * on relative imports (NodeNext ESM):
 *
 * ```ts
 * import type { LaneResult, LaneRunner } from '../contract/index.js';
 * import { parseLaneResult } from '../contract/index.js';
 * ```
 */

import path from 'node:path';
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Lanes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The three isolation substrates offstage routes to.
 *
 * - `headless` — no isolation at all. The command already opens no window, so
 *   it runs in place. This is the cheapest lane and the default for web test
 *   commands; isolating an already-headless command buys nothing.
 * - `session` — a second, logged-in macOS user account running in the
 *   background. It has its own framebuffer, its own input stream and its own
 *   apps, so macOS-native GUI work (`open -a`, `xcodebuild test`, a headed
 *   browser on real Metal) runs there without touching the console user's
 *   screen. Session isolation, not machine isolation: same OS, same disk.
 *   See `native/sessiond/README.md`.
 * - `container` — a Linux container with an Xvfb virtual framebuffer, for web
 *   work that genuinely needs a headed browser and a real compositor.
 *
 * There is no lane for work that could change the machine itself (an
 * installer, a `.dmg`/`.pkg`, `hdiutil`): session isolation shares the disk
 * and the kernel with you, so it cannot honestly claim to contain that.
 * `RouteDecision.refuse` covers this case instead of a fourth lane.
 */
export const LANES = ['headless', 'session', 'container'] as const;

export type Lane = (typeof LANES)[number];

export const LaneSchema = z.enum(LANES);

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The outcome of a lane execution.
 *
 * - `passed`  — the command ran to completion and reported success (exit 0).
 * - `failed`  — the command ran to completion and reported failure. This is a
 *   *result*, not an error: the tests ran and something was red.
 * - `errored` — the command could not be run or could not be trusted: spawn
 *   failure, timeout, substrate died mid-run, unparseable output. Nothing can
 *   be concluded about the user's code from an `errored` run.
 * - `skipped` — the lane deliberately did not run the command, typically
 *   because its substrate is unavailable. A `skipped` result must always carry
 *   the reason (and ideally the fix) in `diagnostics`.
 *
 * The `failed` / `errored` split matters: an agent may retry an `errored` run,
 * but retrying a `failed` run just wastes time.
 */
export const LANE_STATUSES = ['passed', 'failed', 'errored', 'skipped'] as const;

export type LaneStatus = (typeof LANE_STATUSES)[number];

export const LaneStatusSchema = z.enum(LANE_STATUSES);

/* -------------------------------------------------------------------------- */
/* Artifacts                                                                  */
/* -------------------------------------------------------------------------- */

/** Kinds of file a lane can leave behind in its run directory. */
export const ARTIFACT_KINDS = ['log', 'screenshot', 'video', 'xcresult', 'other'] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ArtifactKindSchema = z.enum(ARTIFACT_KINDS);

/**
 * A file produced by the run.
 *
 * `path` is an **absolute host path inside `LaneResult.artifactsDir`** — see
 * the path conventions table at the top of this file.
 */
export interface LaneArtifact {
  kind: ArtifactKind;
  path: string;
}

/* -------------------------------------------------------------------------- */
/* Failures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One failing test, extracted best-effort from the command's output.
 *
 * Lanes are not required to populate this — parsing every reporter format is a
 * losing game. An empty `failures` array alongside `status: 'failed'` is
 * legitimate; put the tail of the log in `diagnostics` when that happens.
 *
 * `file` is **repository-relative** (relative to `LaneRequest.cwd`, POSIX
 * separators, no leading `./`), so it resolves the same on the host and in a
 * guest. `line` is 1-based.
 */
export interface LaneFailure {
  test?: string;
  message: string;
  file?: string;
  line?: number;
}

/* -------------------------------------------------------------------------- */
/* Request                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What a lane is asked to do.
 *
 * `command` is an already-split argv (`['npx', 'playwright', 'test']`), never a
 * shell string: offstage does not run anything through a shell, on any lane.
 *
 * `env` is *additional* environment on top of the ambient one; a lane may drop
 * or override entries it needs to control (`DISPLAY`, for instance).
 *
 * `artifactsDir` is allocated by the caller — normally
 * `allocateRunDir()` from `./artifacts.js` — and is owned exclusively by this
 * run. The lane may create anything it likes underneath it and nothing outside.
 */
export interface LaneRequest {
  /** Absolute host path to the repository root the command runs against. */
  cwd: string;
  /** Argv of the command to run. Never shell-interpreted. Must be non-empty. */
  command: string[];
  /** Extra environment variables layered over the ambient environment. */
  env?: Record<string, string>;
  /** Wall-clock budget for the run. Exceeding it is `errored`, not `failed`. */
  timeoutMs?: number;
  /** Absolute host path to this run's output directory. Owned by the lane. */
  artifactsDir: string;
}

const absolutePath = (label: string) =>
  z
    .string()
    .min(1, `${label} must not be empty`)
    .refine((value) => path.isAbsolute(value), {
      message: `${label} must be an absolute path`,
    });

export const LaneRequestSchema: z.ZodType<LaneRequest> = z.object({
  cwd: absolutePath('cwd'),
  command: z.array(z.string()).min(1, 'command must have at least one element'),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  artifactsDir: absolutePath('artifactsDir'),
});

/* -------------------------------------------------------------------------- */
/* Result                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The one normalized envelope every lane returns.
 *
 * Nothing downstream of a lane — the CLI, the MCP server, the plugin, a human —
 * should ever have to know which substrate produced a result. If a lane needs
 * to say something substrate-specific, it says it in `diagnostics`.
 *
 * Lanes must return this even when they fail. Throwing out of `run()` is a bug;
 * return `status: 'errored'` with the reason in `diagnostics` instead.
 */
export interface LaneResult {
  /** Which lane actually executed the command. */
  lane: Lane;
  status: LaneStatus;
  /**
   * Process exit code, or `null` when there was no exit code to observe —
   * killed by signal, timed out, or never started (`skipped`).
   */
  exitCode: number | null;
  /** ISO-8601 UTC timestamp (`new Date().toISOString()`) of when the run began. */
  startedAt: string;
  /** Wall-clock duration in milliseconds. `0` for a run that never started. */
  durationMs: number;
  /** Absolute host path to this run's output directory. Echoes the request. */
  artifactsDir: string;
  /** Absolute host path to the combined stdout/stderr log, or `null`. */
  logPath: string | null;
  /** Files produced by the run. Absolute host paths under `artifactsDir`. */
  artifacts: LaneArtifact[];
  /** Best-effort structured failures parsed out of the output. May be empty. */
  failures: LaneFailure[];
  /**
   * Human-readable notes: why a lane was skipped, what the fix is, which
   * isolation was (or was not) applied, the tail of an unparseable log.
   * This is the only free-form channel in the envelope — use it generously.
   */
  diagnostics: string[];
}

/**
 * True when `child` is `parent` itself or lives underneath it.
 * Both arguments must already be absolute.
 */
export function isInside(parent: string, child: string): boolean {
  const from = path.resolve(parent);
  const to = path.resolve(child);
  if (from === to) return true;
  const rel = path.relative(from, to);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * ISO-8601 UTC, exactly what `Date.prototype.toISOString()` produces.
 * Checked by round-tripping rather than by regex so the two can never diverge.
 */
const isoTimestamp = z.string().refine(
  (value) => {
    const parsed = new Date(value);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
  },
  { message: 'startedAt must be an ISO-8601 UTC timestamp, e.g. 2026-08-17T18:02:45.123Z' },
);

/** Repository-relative POSIX path: not absolute, no `..` escape, no backslashes. */
const repoRelativePath = z
  .string()
  .min(1, 'file must not be empty')
  .refine((value) => !path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value), {
    message: 'failures[].file must be repository-relative, not absolute',
  })
  .refine((value) => !value.includes('\\'), {
    message: 'failures[].file must use POSIX separators',
  })
  .refine((value) => !value.split('/').includes('..'), {
    message: 'failures[].file must not escape the repository with ".."',
  });

export const LaneArtifactSchema: z.ZodType<LaneArtifact> = z.object({
  kind: ArtifactKindSchema,
  path: absolutePath('artifacts[].path'),
});

export const LaneFailureSchema: z.ZodType<LaneFailure> = z.object({
  test: z.string().optional(),
  message: z.string(),
  file: repoRelativePath.optional(),
  line: z.number().int().positive().optional(),
});

const laneResultShape = z.object({
  lane: LaneSchema,
  status: LaneStatusSchema,
  exitCode: z.number().int().nullable(),
  startedAt: isoTimestamp,
  durationMs: z.number().int().nonnegative(),
  artifactsDir: absolutePath('artifactsDir'),
  logPath: absolutePath('logPath').nullable(),
  artifacts: z.array(LaneArtifactSchema),
  failures: z.array(LaneFailureSchema),
  diagnostics: z.array(z.string()),
});

/**
 * The LaneResult schema, including the cross-field rules that keep a run
 * directory self-contained: `logPath` and every `artifacts[].path` must live
 * inside `artifactsDir`.
 */
export const LaneResultSchema: z.ZodType<LaneResult> = laneResultShape.superRefine((value, ctx) => {
  if (value.logPath !== null && !isInside(value.artifactsDir, value.logPath)) {
    ctx.addIssue({
      code: 'custom',
      path: ['logPath'],
      message: `logPath must be inside artifactsDir (${value.artifactsDir})`,
    });
  }
  value.artifacts.forEach((artifact, index) => {
    if (!isInside(value.artifactsDir, artifact.path)) {
      ctx.addIssue({
        code: 'custom',
        path: ['artifacts', index, 'path'],
        message: `artifact path must be inside artifactsDir (${value.artifactsDir})`,
      });
    }
  });
});

/* The schema and the hand-written interface must never drift apart. These two
   assignments fail to compile if they do — in either direction. */
type _SchemaMatchesInterface = z.infer<typeof laneResultShape> extends LaneResult ? true : never;
type _InterfaceMatchesSchema = LaneResult extends z.infer<typeof laneResultShape> ? true : never;
const _schemaMatchesInterface: _SchemaMatchesInterface = true;
const _interfaceMatchesSchema: _InterfaceMatchesSchema = true;
void _schemaMatchesInterface;
void _interfaceMatchesSchema;

/* -------------------------------------------------------------------------- */
/* Parsing helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Validate an unknown value — typically freshly-read `result.json` or a lane's
 * return value — as a {@link LaneResult}.
 *
 * @throws {z.ZodError} with every violated rule, when the value is not valid.
 */
export function parseLaneResult(value: unknown): LaneResult {
  return LaneResultSchema.parse(value);
}

/** Non-throwing {@link parseLaneResult}. */
export function safeParseLaneResult(
  value: unknown,
): { success: true; data: LaneResult } | { success: false; error: z.ZodError } {
  const result = LaneResultSchema.safeParse(value);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, error: result.error };
}

/** Type guard form of {@link parseLaneResult}. */
export function isLaneResult(value: unknown): value is LaneResult {
  return LaneResultSchema.safeParse(value).success;
}

/** Validate a {@link LaneRequest}. @throws {z.ZodError} */
export function parseLaneRequest(value: unknown): LaneRequest {
  return LaneRequestSchema.parse(value);
}

/**
 * Flatten a {@link parseLaneResult} failure into lines suitable for
 * `diagnostics` or a CLI error message.
 */
export function describeValidationError(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
}

/* -------------------------------------------------------------------------- */
/* Availability                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Whether a lane's substrate is usable right now.
 *
 * `reason` explains *why not* in human terms; `fix` is a literal command the
 * user can paste (`colima start`, `offstage session setup`). Both are omitted
 * when `available` is true.
 *
 * This is the value `offstage doctor` renders, so it is worth writing well.
 */
export interface LaneAvailability {
  available: boolean;
  reason?: string;
  fix?: string;
}

export const LaneAvailabilitySchema: z.ZodType<LaneAvailability> = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  fix: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/* The lane interface                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What every lane implements. Three rules, and they are the whole product:
 *
 * 1. **`isAvailable()` never throws and never mutates the world.** It probes;
 *    it does not start Colima or pull an image. An unusable substrate is
 *    `{ available: false, reason, fix }`, not an exception.
 * 2. **`run()` never throws.** Every failure mode — spawn error, timeout, dead
 *    substrate — comes back as a valid {@link LaneResult} with
 *    `status: 'errored'` and an explanation in `diagnostics`.
 * 3. **`run()` never falls back to the user's screen.** If the isolation this
 *    lane promises is not available, the lane returns `skipped` or `errored`
 *    and says how to fix it. Running headed work on the real display because
 *    the container would not start is the single worst thing offstage could do.
 */
export interface LaneRunner {
  readonly lane: Lane;
  isAvailable(): Promise<LaneAvailability>;
  run(req: LaneRequest): Promise<LaneResult>;
}

/* -------------------------------------------------------------------------- */
/* Routing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The router's verdict for a command. Produced by `classify()` in
 * `src/router/`, consumed by the CLI, the MCP server and `offstage doctor`.
 *
 * `reason` is written for a human or an agent to read aloud; `signals` are the
 * concrete observations behind it (`--headed present`, `playwright.config.ts
 * sets headless: false`, `xcodebuild in argv`).
 *
 * `refuse`, when set, means offstage will not run this command automatically
 * in *any* lane: it could change the machine (an installer, a `.dmg`/`.pkg`,
 * `hdiutil`) and offstage has no substrate that isolates that today. `lane`
 * still names the best of the three that the rest of the command argues for
 * (so `route` and `explain` have something to say), but `run()` refuses
 * unconditionally when `refuse` is set: there is no `--lane` override, because
 * no lane offers the isolation this needs. Undefined for every ordinary
 * decision.
 */
export interface RouteDecision {
  lane: Lane;
  reason: string;
  confidence: 'high' | 'low';
  signals: string[];
  refuse?: string;
}

export const RouteDecisionSchema: z.ZodType<RouteDecision> = z.object({
  lane: LaneSchema,
  reason: z.string().min(1),
  confidence: z.enum(['high', 'low']),
  signals: z.array(z.string()),
  refuse: z.string().min(1).optional(),
});

/* -------------------------------------------------------------------------- */
/* Result construction                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Process exit code → status, using the convention every lane shares:
 * 0 is `passed`, anything else is `failed`, and "no code at all" is `errored`
 * because a killed or never-started process tells you nothing about the code.
 */
export function statusFromExitCode(exitCode: number | null): LaneStatus {
  if (exitCode === null) return 'errored';
  return exitCode === 0 ? 'passed' : 'failed';
}

/**
 * Build a {@link LaneResult} with the boring fields defaulted, so lanes only
 * spell out what they actually observed. The returned value is validated, so a
 * lane that assembles a malformed envelope finds out at its own call site
 * rather than three modules downstream.
 *
 * @throws {z.ZodError} if the assembled result violates the contract.
 */
export function createLaneResult(
  init: Pick<LaneResult, 'lane' | 'status' | 'artifactsDir'> & Partial<LaneResult>,
): LaneResult {
  return parseLaneResult({
    exitCode: null,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    logPath: null,
    artifacts: [],
    failures: [],
    diagnostics: [],
    ...init,
  });
}

/**
 * The canonical `skipped` result: this lane's substrate is not usable, here is
 * why, here is the fix, and — importantly — nothing was run anywhere.
 */
export function skippedResult(
  lane: Lane,
  artifactsDir: string,
  availability: LaneAvailability,
): LaneResult {
  const diagnostics = [
    `Lane "${lane}" is unavailable, so nothing was executed. offstage does not fall back to your real screen.`,
  ];
  if (availability.reason) diagnostics.push(`Reason: ${availability.reason}`);
  if (availability.fix) diagnostics.push(`Fix: ${availability.fix}`);
  return createLaneResult({ lane, status: 'skipped', artifactsDir, diagnostics });
}

/**
 * Exit code for the `offstage` process itself, derived from a lane result.
 *
 * `passed` → 0, `failed` → the command's own code (or 1), `errored` → 70
 * (`EX_SOFTWARE`), `skipped` → 69 (`EX_UNAVAILABLE`). The two non-zero
 * non-test codes are distinct on purpose: CI can tell "your tests are red" from
 * "offstage could not run them".
 */
export function exitCodeForResult(result: LaneResult): number {
  switch (result.status) {
    case 'passed':
      return 0;
    case 'failed':
      return result.exitCode && result.exitCode !== 0 ? result.exitCode : 1;
    case 'errored':
      return 70;
    case 'skipped':
      return 69;
  }
}
