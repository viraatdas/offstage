/**
 * Run directories and result persistence.
 *
 * Every offstage execution gets its own directory under `.offstage/runs/<id>/`
 * in the repository being tested. The lane writes its logs, screenshots and
 * bundles there; the CLI writes `result.json` there when the lane returns. That
 * directory *is* the run — it is self-contained, safe to archive, and safe to
 * delete.
 *
 * Run ids sort lexicographically in chronological order, so `ls .offstage/runs`
 * is already sorted and "the last run" is the last line.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { LaneResult } from './index.js';
import { describeValidationError, parseLaneResult, safeParseLaneResult } from './index.js';

/** Directory offstage keeps its state in, relative to the repository root. */
export const OFFSTAGE_DIR = '.offstage';

/** Where run directories live, relative to the repository root. */
export const RUNS_DIR = path.posix.join(OFFSTAGE_DIR, 'runs');

/** Filename of the normalized envelope inside a run directory. */
export const RESULT_FILENAME = 'result.json';

/** A freshly allocated, already-created run directory. */
export interface RunDir {
  /** Sortable run identifier, e.g. `20260817T180245123Z-3f9a1c`. */
  runId: string;
  /** Absolute host path to the run directory. Pass this as `artifactsDir`. */
  artifactsDir: string;
  /** Absolute host path where `result.json` will be written. */
  resultPath: string;
  /** `.offstage/runs/<id>`, for printing. Repository-relative, POSIX separators. */
  relativeDir: string;
}

export interface AllocateRunDirOptions {
  /** Repository root the run belongs to. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Clock injection point, for deterministic tests. */
  now?: Date;
  /** Force a specific run id instead of generating one. */
  runId?: string;
}

/**
 * Build a sortable run id: a compact UTC timestamp plus six random hex
 * characters, because two runs can start in the same millisecond.
 *
 * `2026-08-17T18:02:45.123Z` → `20260817T180245123Z-3f9a1c`
 */
export function makeRunId(now: Date = new Date(), suffix?: string): string {
  const stamp = now.toISOString().replace(/[-:.]/g, '');
  const tail = suffix ?? randomBytes(3).toString('hex');
  return `${stamp}-${tail}`;
}

/**
 * Allocate — and create — a run directory under `<cwd>/.offstage/runs/<id>/`.
 *
 * The directory exists by the time this resolves, so a lane can write into it
 * immediately without its own `mkdir` dance.
 */
export async function allocateRunDir(options: AllocateRunDirOptions = {}): Promise<RunDir> {
  const root = path.resolve(options.cwd ?? process.cwd());
  const runId = options.runId ?? makeRunId(options.now ?? new Date());
  const artifactsDir = path.join(root, OFFSTAGE_DIR, 'runs', runId);
  await fs.mkdir(artifactsDir, { recursive: true });
  await ignoreSelf(path.join(root, OFFSTAGE_DIR));
  return {
    runId,
    artifactsDir,
    resultPath: path.join(artifactsDir, RESULT_FILENAME),
    relativeDir: path.posix.join(RUNS_DIR, runId),
  };
}

/**
 * Make `.offstage/` ignore itself, by writing a `.gitignore` containing `*`
 * the first time a run directory is created.
 *
 * The first thing offstage does for a new user is write logs and results into
 * their repository. Left alone, that shows up as untracked files in `git
 * status` and, sooner or later, in someone's commit. Telling users to add a
 * line to their own `.gitignore` puts the burden in the wrong place — a
 * self-ignoring directory needs nothing from them and touches no file they own.
 *
 * Best effort by design: a read-only or already-present file is not worth
 * failing a run over.
 */
async function ignoreSelf(offstageDir: string): Promise<void> {
  const marker = path.join(offstageDir, '.gitignore');
  try {
    await fs.writeFile(
      marker,
      "# Created by offstage. Everything in here is a run artifact, not source.\n*\n",
      { flag: 'wx' },
    );
  } catch {
    // Already there, or the directory is not writable. Neither changes the run.
  }
}

/**
 * Resolve a path inside a run directory, the way the contract wants it:
 * absolute, and guaranteed to stay inside `artifactsDir`.
 *
 * ```ts
 * const logPath = artifactPath(req.artifactsDir, 'command.log');
 * ```
 *
 * @throws {Error} if the segments escape the run directory.
 */
export function artifactPath(artifactsDir: string, ...segments: string[]): string {
  const base = path.resolve(artifactsDir);
  const resolved = path.resolve(base, ...segments);
  const rel = path.relative(base, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `artifactPath: ${segments.join('/')} escapes the run directory ${artifactsDir}. ` +
        'Every artifact must live inside artifactsDir.',
    );
  }
  return resolved;
}

/**
 * Turn any path into the repository-relative POSIX form that
 * `LaneResult.failures[].file` requires.
 *
 * Absolute paths are made relative to `cwd`; paths that are already relative
 * are normalized (`./src/a.ts` → `src/a.ts`). A path that lands outside the
 * repository cannot be expressed in this form at all, so `null` comes back and
 * the caller should omit `file` rather than invent one.
 */
export function toRepoRelative(cwd: string, filePath: string): string | null {
  const root = path.resolve(cwd);
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
  const rel = path.relative(root, absolute);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/**
 * Write the normalized envelope to `<artifactsDir>/result.json`.
 *
 * The result is validated first: an invalid envelope is a bug in the lane, and
 * it should surface at write time rather than when something downstream tries
 * to read it back.
 *
 * @returns the absolute path written.
 * @throws {z.ZodError} if `result` violates the contract.
 */
export async function writeResult(result: LaneResult): Promise<string> {
  const validated = parseLaneResult(result);
  const target = path.join(path.resolve(validated.artifactsDir), RESULT_FILENAME);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
  return target;
}

/**
 * Read and validate a `result.json`.
 *
 * Accepts either the run directory or the file itself, so both
 * `readResult('.offstage/runs/<id>')` and `readResult('.../result.json')` work.
 *
 * @throws {Error} if the file is missing, is not JSON, or does not satisfy the
 * contract — the message lists every violated rule.
 */
export async function readResult(target: string): Promise<LaneResult> {
  const file = target.endsWith(RESULT_FILENAME) ? target : path.join(target, RESULT_FILENAME);
  const raw = await fs.readFile(file, 'utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }

  const validated = safeParseLaneResult(parsed);
  if (!validated.success) {
    throw new Error(
      `${file} does not satisfy the offstage lane contract:\n  ${describeValidationError(
        validated.error,
      ).join('\n  ')}`,
    );
  }
  return validated.data;
}

/**
 * List run ids under `<cwd>/.offstage/runs`, oldest first — which, because run
 * ids are timestamp-prefixed, is just lexicographic order.
 *
 * Returns `[]` when nothing has ever been run here.
 */
export async function listRunIds(cwd: string = process.cwd()): Promise<string[]> {
  const dir = path.join(path.resolve(cwd), OFFSTAGE_DIR, 'runs');
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
