/**
 * Translating a `tart-runner` results directory into a `LaneResult`.
 *
 * The runner hands back a directory on the host — printed on its stdout as
 * `results: /path/to/<run-id>` — laid out like this:
 *
 * ```
 * <results-dir>/
 *   xcodebuild.log      # build / test runs   (or command.log for `run`)
 *   run-xcode.sh        # the guest helper, copied in as provenance
 *   guest-exit-status   # written inside the VM; the authoritative code
 *   exit-status         # written on the host after the VM is stopped
 *   Result.xcresult/    # present whenever xcodebuild produced one
 * ```
 *
 * Three things make this a translation rather than a copy:
 *
 * 1. **Paths are guest paths.** `run-xcode.sh` rsyncs the read-only source
 *    share to `$HOME/tart-runner/<run-id>/src` inside the VM and builds there,
 *    so every file in `xcodebuild.log` reads `/Users/admin/tart-runner/…/src/App/Foo.swift`.
 *    That path does not exist on the host and never will. The contract wants
 *    repository-relative failure paths precisely because of this, so the guest
 *    checkout prefix gets stripped — see {@link guestPathToRepoRelative}.
 * 2. **Artifacts must live under `artifactsDir`.** The runner writes into its
 *    own data home, which is outside this run's directory, so the contract's
 *    containment rule forces an ingest step rather than a pointer.
 * 3. **`xcrun` may not exist.** Structured failures come from
 *    `xcrun xcresulttool`, which needs Xcode on the host — and the entire point
 *    of this lane is that the host might not have a usable Xcode. Every
 *    `xcrun` call is guarded, and the parser degrades to log-only extraction
 *    with a diagnostic saying so, never an exception.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type { LaneArtifact, LaneFailure } from '../../contract/index.js';
import { artifactPath, toRepoRelative } from '../../contract/artifacts.js';

/* -------------------------------------------------------------------------- */
/* Names the runner uses                                                      */
/* -------------------------------------------------------------------------- */

/** Log file for `build` and `xcui-test` runs. */
export const XCODEBUILD_LOG = 'xcodebuild.log';

/** Log file for `run` (plain command) runs. */
export const COMMAND_LOG = 'command.log';

/** Exit code written by the host after the guest is stopped. */
export const EXIT_STATUS_FILE = 'exit-status';

/**
 * Exit code written by the guest helper into the shared artifacts dir.
 *
 * `tart exec` does not reliably propagate the guest command's status, which is
 * why the runner writes this file at all. When the two disagree, this one is
 * the truth about the user's command.
 */
export const GUEST_EXIT_STATUS_FILE = 'guest-exit-status';

/** The `.xcresult` bundle exported from the guest. */
export const XCRESULT_BUNDLE = 'Result.xcresult';

/* -------------------------------------------------------------------------- */
/* Reading the runner's stdout                                                */
/* -------------------------------------------------------------------------- */

/** What the runner announced on stdout. */
export interface RunnerAnnouncements {
  /** Absolute path from the `results: …` line, or `null` if it never printed. */
  resultsDir: string | null;
  /** Absolute path from the `xcresult: …` line, printed only when one exists. */
  xcresultPath: string | null;
}

/**
 * Pull the results directory out of the runner's output.
 *
 * The line is printed before the VM is even cloned, so it is present even for
 * runs that later blow up — which is exactly when it matters most. The last
 * match wins, so a log that somehow contains two runs resolves to the newest.
 */
export function parseRunnerStdout(stdout: string): RunnerAnnouncements {
  let resultsDir: string | null = null;
  let xcresultPath: string | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const results = /^\s*results:\s*(\S.*?)\s*$/.exec(line);
    if (results?.[1]) resultsDir = results[1];
    const xcresult = /^\s*xcresult:\s*(\S.*?)\s*$/.exec(line);
    if (xcresult?.[1]) xcresultPath = xcresult[1];
  }

  return { resultsDir, xcresultPath };
}

/* -------------------------------------------------------------------------- */
/* Exit status                                                                */
/* -------------------------------------------------------------------------- */

async function readIntFile(file: string): Promise<number | null> {
  try {
    const raw = (await fs.readFile(file, 'utf8')).trim();
    if (!/^-?\d+$/.test(raw)) return null;
    return Number.parseInt(raw, 10);
  } catch {
    return null;
  }
}

/**
 * The command's exit code, or `null` when neither status file survived.
 *
 * `guest-exit-status` is preferred: it is written by the helper *inside* the
 * VM and is the user's command's own code. `exit-status` is written by the host
 * afterwards and can carry the runner's own failure instead. A `null` here is
 * meaningful — it means the guest never got far enough to report, which the
 * contract calls `errored`, not `failed`.
 */
export async function readExitStatus(resultsDir: string): Promise<number | null> {
  const guest = await readIntFile(path.join(resultsDir, GUEST_EXIT_STATUS_FILE));
  if (guest !== null) return guest;
  return readIntFile(path.join(resultsDir, EXIT_STATUS_FILE));
}

/** Which log the runner wrote, as a bare filename, or `null` if neither exists. */
export async function findLogName(resultsDir: string): Promise<string | null> {
  for (const name of [XCODEBUILD_LOG, COMMAND_LOG]) {
    try {
      const stats = await fs.stat(path.join(resultsDir, name));
      if (stats.isFile()) return name;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Guest paths → repository-relative paths                                    */
/* -------------------------------------------------------------------------- */

/**
 * The guest checkout, as `run-xcode.sh` and `run-command.sh` create it:
 * `$HOME/tart-runner/<run-id>/src/`. Everything after that segment is exactly
 * the repository-relative path the contract asks for.
 */
const GUEST_CHECKOUT_RE = /^.*?\/tart-runner\/[^/]+\/src\//;

/**
 * Convert a path seen in guest output into a repository-relative one.
 *
 * Tries the guest checkout prefix first, then host-relative resolution for the
 * rare case where a path really is on this machine. Returns `null` rather than
 * guessing: the contract would rather have no `file` than a wrong one, and an
 * absolute path is rejected by the schema anyway.
 */
export function guestPathToRepoRelative(candidate: string, cwd: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  const stripped = trimmed.replace(GUEST_CHECKOUT_RE, '');
  if (stripped !== trimmed) {
    // It was a guest checkout path; what remains is already repo-relative.
    return stripped.length > 0 ? stripped.split(path.sep).join('/') : null;
  }

  // Not from the guest checkout. Only usable if it resolves inside the repo.
  if (path.isAbsolute(trimmed)) return toRepoRelative(cwd, trimmed);

  // A bare relative path (including a bare basename) cannot be trusted to be
  // repo-root-relative, but a path with separators very likely is.
  return trimmed.includes('/') ? toRepoRelative(cwd, trimmed) : null;
}

/* -------------------------------------------------------------------------- */
/* xcodebuild.log                                                             */
/* -------------------------------------------------------------------------- */

/**
 * XCTest assertion failures, which carry the test name:
 * `<path>:42: error: -[LoginTests testSignIn] : XCTAssertTrue failed - message`
 *
 * Swift Testing and newer XCTest emit `LoginTests.testSignIn()` instead of the
 * Objective-C selector form, so both are accepted.
 */
const TEST_FAILURE_RE =
  /^(?<file>\/[^\s:]+|[^\s:]+\.(?:swift|m|mm)):(?<line>\d+)(?::\d+)?:\s*error:\s*(?:-\[(?<objcTest>[^\]]+)\]|(?<swiftTest>[A-Za-z_][\w.]*\(\)))\s*:\s*(?<message>.*)$/;

/**
 * Compiler and linker diagnostics, which do not:
 * `<path>:12:5: error: cannot find 'bar' in scope`
 */
const COMPILE_ERROR_RE =
  /^(?<file>\/[^\s:]+|[^\s:]+\.[A-Za-z0-9]+):(?<line>\d+)(?::(?<column>\d+))?:\s*(?:fatal\s+)?error:\s*(?<message>.*)$/;

/** File-less errors worth surfacing: `error: Signing for "X" requires …`. */
const BARE_ERROR_RE = /^(?:(?<tool>ld|clang|swiftc|xcodebuild):\s*)?error:\s*(?<message>.+)$/;

/**
 * The linker announces itself without the word `error`, as in
 * `ld: symbol(s) not found for architecture arm64` — and that line is the root
 * cause, while the `clang: error: linker command failed` beneath it is only the
 * wrapper reporting a non-zero child.
 */
const LINKER_ERROR_RE = /^ld:\s+(?!warning:)(?<message>.+)$/;

/** xcodebuild's own verdict banners. */
const BANNER_RE = /^\*\*\s+(?<banner>[A-Z][A-Z ]+)\s+\*\*\s*$/;

/** How many distinct diagnostic lines to keep. Enough to act on, short enough to read. */
const MAX_DIAGNOSTICS = 20;

/** Lines of log tail to keep when nothing structured could be extracted. */
const TAIL_LINES = 25;

export interface LogParseResult {
  failures: LaneFailure[];
  diagnostics: string[];
  /** `** TEST FAILED **`, `** BUILD SUCCEEDED **`, … as printed. */
  banners: string[];
}

/**
 * Extract failures and diagnostics from an `xcodebuild.log` (or `command.log`).
 *
 * This is the degraded path — everything it finds is also derivable from the
 * `.xcresult` bundle, but the bundle needs `xcrun` and the log does not. It is
 * also the *only* source for build failures, which never produce test results
 * at all.
 */
export function parseXcodebuildLog(text: string, cwd: string): LogParseResult {
  const failures: LaneFailure[] = [];
  const diagnostics: string[] = [];
  const banners: string[] = [];
  const seenFailures = new Set<string>();
  const seenDiagnostics = new Set<string>();

  const pushDiagnostic = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || seenDiagnostics.has(trimmed)) return;
    seenDiagnostics.add(trimmed);
    if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(trimmed);
  };

  const pushFailure = (failure: LaneFailure) => {
    const key = `${failure.test ?? ''}|${failure.file ?? ''}|${failure.line ?? ''}|${failure.message}`;
    if (seenFailures.has(key)) return;
    seenFailures.add(key);
    failures.push(failure);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    const banner = BANNER_RE.exec(line)?.groups?.banner;
    if (banner) {
      banners.push(banner.trim());
      pushDiagnostic(line.trim());
      continue;
    }

    const testMatch = TEST_FAILURE_RE.exec(line);
    if (testMatch?.groups) {
      const { file, line: lineNo, objcTest, swiftTest, message } = testMatch.groups;
      // `-[LoginTests testSignIn]` → `LoginTests.testSignIn` reads better and
      // matches how xcresulttool names the same test.
      const test = objcTest ? objcTest.trim().replace(/\s+/, '.') : swiftTest?.trim();
      const relative = file ? guestPathToRepoRelative(file, cwd) : null;
      pushFailure({
        ...(test ? { test } : {}),
        message: (message ?? '').trim(),
        ...(relative ? { file: relative } : {}),
        ...(lineNo ? { line: Number.parseInt(lineNo, 10) } : {}),
      });
      pushDiagnostic(line.trim());
      continue;
    }

    const compileMatch = COMPILE_ERROR_RE.exec(line);
    if (compileMatch?.groups) {
      const { file, line: lineNo, message } = compileMatch.groups;
      const relative = file ? guestPathToRepoRelative(file, cwd) : null;
      pushFailure({
        message: (message ?? '').trim(),
        ...(relative ? { file: relative } : {}),
        ...(lineNo ? { line: Number.parseInt(lineNo, 10) } : {}),
      });
      pushDiagnostic(line.trim());
      continue;
    }

    const bareMatch = BARE_ERROR_RE.exec(line.trim());
    if (bareMatch?.groups?.message) {
      const tool = bareMatch.groups.tool;
      pushFailure({
        message: tool ? `${tool}: ${bareMatch.groups.message.trim()}` : bareMatch.groups.message.trim(),
      });
      pushDiagnostic(line.trim());
      continue;
    }

    const linkerMatch = LINKER_ERROR_RE.exec(line.trim());
    if (linkerMatch?.groups?.message) {
      pushFailure({ message: `ld: ${linkerMatch.groups.message.trim()}` });
      pushDiagnostic(line.trim());
      continue;
    }

    if (/^Testing failed:|^The following build commands failed:/.test(line.trim())) {
      pushDiagnostic(line.trim());
    }
  }

  return { failures, diagnostics, banners };
}

/** The last `TAIL_LINES` non-empty lines, for when nothing parsed. */
export function logTail(text: string, lines = TAIL_LINES): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-lines);
}

/* -------------------------------------------------------------------------- */
/* Result.xcresult                                                            */
/* -------------------------------------------------------------------------- */

/**
 * One node of `xcrun xcresulttool get test-results tests`.
 *
 * Mirrors the tool's published JSON Schema (version 0.1.0) — only the fields
 * this parser reads are named, and every one of them is optional in practice
 * because the schema marks just `nodeType` and `name` as required.
 */
interface TestNode {
  nodeType?: string;
  name?: string;
  nodeIdentifier?: string;
  nodeIdentifierURL?: string;
  result?: string;
  details?: string;
  children?: TestNode[];
}

/** `SmokeAppUITests.swift:24: XCTAssertEqual failed: …` → its three parts. */
const FAILURE_MESSAGE_RE = /^(?<file>[^\s:]+):(?<line>\d+):\s*(?<message>.*)$/;

/** `file:///path/File.swift#…StartingLineNumber=41…` from a source reference. */
const FILE_URL_LINE_RE = /StartingLineNumber=(\d+)/;

function isFailingResult(result: string | undefined): boolean {
  return result === 'Failed';
}

/**
 * Walk the `testNodes` tree and turn every failing Test Case into a
 * {@link LaneFailure}.
 *
 * The tree nests Test Plan → bundle → Test Suite → Test Case → Failure Message,
 * with optional Repetition / Test Case Run / Device layers in between depending
 * on the test plan. So rather than assuming a depth, this collects Test Cases
 * wherever they appear and gathers their descendant Failure Messages.
 */
export function parseXcresultTests(payload: unknown): LaneFailure[] {
  const root = payload as { testNodes?: TestNode[] } | null;
  if (!root || !Array.isArray(root.testNodes)) return [];

  const failures: LaneFailure[] = [];
  const seen = new Set<string>();

  /** Every `Failure Message` at or below `node`, with its source reference. */
  const collectMessages = (node: TestNode, into: TestNode[]): void => {
    for (const child of node.children ?? []) {
      if (child.nodeType === 'Failure Message') into.push(child);
      // Do not descend into a nested Test Case: its messages belong to it.
      if (child.nodeType !== 'Test Case') collectMessages(child, into);
    }
  };

  /** The first line number any `Source Code Reference` under `node` points at. */
  const findSourceLine = (node: TestNode): number | null => {
    for (const child of node.children ?? []) {
      if (child.nodeType === 'Source Code Reference') {
        const url = child.nodeIdentifierURL ?? child.name ?? '';
        const match = FILE_URL_LINE_RE.exec(url);
        if (match?.[1]) {
          // Xcode's URLs are 0-based; LaneFailure.line is 1-based.
          return Number.parseInt(match[1], 10) + 1;
        }
      }
      const nested = findSourceLine(child);
      if (nested !== null) return nested;
    }
    return null;
  };

  const visit = (node: TestNode, suite: string | null): void => {
    if (node.nodeType === 'Test Case') {
      const testName = node.nodeIdentifier ?? (suite ? `${suite}/${node.name}` : node.name);
      if (isFailingResult(node.result)) {
        const messages: TestNode[] = [];
        collectMessages(node, messages);

        if (messages.length === 0) {
          // A failing case with no message still deserves a row; the details
          // field or a bare "failed" is better than dropping it silently.
          const key = `${testName}|`;
          if (!seen.has(key)) {
            seen.add(key);
            failures.push({
              ...(testName ? { test: testName } : {}),
              message: node.details?.trim() || 'Test failed without a reported message.',
            });
          }
        }

        for (const message of messages) {
          const raw = (message.name ?? '').trim();
          const parsed = FAILURE_MESSAGE_RE.exec(raw);
          const text = parsed?.groups?.message?.trim() || raw || 'Test failed.';
          const key = `${testName}|${text}`;
          if (seen.has(key)) continue;
          seen.add(key);

          // The message names a bare file (`Foo.swift`), which is not reliably
          // repo-relative, so `file` is left out unless a Source Code Reference
          // gave a real one. The basename stays visible inside `message`.
          // Xcode attaches the Source Code Reference under the Failure Message
          // in most plans, but under the Test Case in some; try both before
          // giving up on a line number.
          const lineFromMessage = parsed?.groups?.line
            ? Number.parseInt(parsed.groups.line, 10)
            : null;
          const line = lineFromMessage ?? findSourceLine(message) ?? findSourceLine(node) ?? undefined;

          failures.push({
            ...(testName ? { test: testName } : {}),
            message: parsed?.groups?.file ? `${parsed.groups.file}: ${text}` : text,
            ...(line ? { line } : {}),
          });
        }
      }
      return;
    }

    const nextSuite = node.nodeType === 'Test Suite' ? (node.name ?? suite) : suite;
    for (const child of node.children ?? []) visit(child, nextSuite ?? null);
  };

  for (const node of root.testNodes) visit(node, null);
  return failures;
}

/**
 * Parse `xcrun xcresulttool get test-results summary`.
 *
 * Flatter and less precise than the tree — no line numbers — but it survives
 * result bundles the tree command chokes on, so it is the second attempt.
 */
export function parseXcresultSummary(payload: unknown): LaneFailure[] {
  const root = payload as {
    testFailures?: Array<{
      testName?: string;
      targetName?: string;
      failureText?: string;
      testIdentifierString?: string;
    }>;
  } | null;

  const entries = root?.testFailures;
  if (!Array.isArray(entries)) return [];

  return entries.map((entry) => {
    const test =
      entry.testIdentifierString ??
      (entry.targetName && entry.testName
        ? `${entry.targetName}/${entry.testName}`
        : (entry.testName ?? undefined));
    return {
      ...(test ? { test } : {}),
      message: entry.failureText?.trim() || 'Test failed.',
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Shelling out to xcrun, carefully                                           */
/* -------------------------------------------------------------------------- */

/** Result of running a command. Matches the subset of execa we use. */
export interface ExecOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Injection point so tests never spawn a process. */
export type Exec = (file: string, args: string[]) => Promise<ExecOutcome>;

/** Default {@link Exec}, backed by execa with rejection disabled. */
export const defaultExec: Exec = async (file, args) => {
  const { execa } = await import('execa');
  const result = await execa(file, args, {
    reject: false,
    timeout: 60_000,
    all: false,
    stripFinalNewline: true,
  });
  return {
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  };
};

/**
 * Is `xcresulttool` usable on this host?
 *
 * `xcrun --find` resolves the tool without running it, so this stays a probe.
 * Any failure — no Xcode, no command line tools, a broken `xcode-select` path —
 * is a `false`, never an exception: the caller's job is to degrade, not to die.
 */
export async function isXcresulttoolAvailable(exec: Exec = defaultExec): Promise<boolean> {
  try {
    const result = await exec('xcrun', ['--find', 'xcresulttool']);
    return result.exitCode === 0 && result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export interface XcresultExtraction {
  failures: LaneFailure[];
  diagnostics: string[];
}

/**
 * Extract structured failures from a `.xcresult` bundle.
 *
 * Tries the tree command first (it carries line numbers), then the summary
 * command. Every outcome that is not "here are the failures" comes back as a
 * diagnostic explaining what offstage could not do and why, so a log-only
 * result never looks like a clean one.
 */
export async function extractXcresultFailures(
  bundlePath: string,
  exec: Exec = defaultExec,
): Promise<XcresultExtraction> {
  const diagnostics: string[] = [];

  if (!(await isXcresulttoolAvailable(exec))) {
    return {
      failures: [],
      diagnostics: [
        'xcrun xcresulttool is not available on this host, so structured test failures could not ' +
          `be extracted from ${path.basename(bundlePath)}. Failures below come from the log only. ` +
          'Install Xcode (or run `xcode-select --switch /Applications/Xcode.app`) for richer output.',
      ],
    };
  }

  const attempts: Array<{ label: string; args: string[]; parse: (value: unknown) => LaneFailure[] }> =
    [
      {
        label: 'get test-results tests',
        args: ['xcresulttool', 'get', 'test-results', 'tests', '--path', bundlePath, '--compact'],
        parse: parseXcresultTests,
      },
      {
        label: 'get test-results summary',
        args: ['xcresulttool', 'get', 'test-results', 'summary', '--path', bundlePath, '--compact'],
        parse: parseXcresultSummary,
      },
    ];

  for (const attempt of attempts) {
    let outcome: ExecOutcome;
    try {
      outcome = await exec('xcrun', attempt.args);
    } catch (error) {
      diagnostics.push(
        `xcrun ${attempt.label} could not be spawned: ${(error as Error).message}`,
      );
      continue;
    }

    if (outcome.exitCode !== 0) {
      const detail = (outcome.stderr || outcome.stdout).trim().split('\n')[0] ?? '';
      diagnostics.push(
        `xcrun ${attempt.label} exited ${outcome.exitCode ?? 'null'}${detail ? `: ${detail}` : ''}`,
      );
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(outcome.stdout);
    } catch (error) {
      diagnostics.push(`xcrun ${attempt.label} returned unparseable JSON: ${(error as Error).message}`);
      continue;
    }

    const failures = attempt.parse(parsed);
    // An empty list from a clean run is a legitimate answer, so stop here
    // either way rather than falling through to the second command.
    return { failures, diagnostics };
  }

  diagnostics.push(
    `No structured failures could be read from ${path.basename(bundlePath)}; using the log instead.`,
  );
  return { failures: [], diagnostics };
}

/* -------------------------------------------------------------------------- */
/* Merging the two sources                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Combine `.xcresult` failures with log failures.
 *
 * The bundle knows test identities; the log knows repository paths, because it
 * is the only place a full guest path appears. So the bundle's list wins on
 * identity and message, and borrows `file`/`line` from a log entry for the same
 * test. Log-only failures with no counterpart (build errors, linker errors) are
 * appended — they are real failures that no test bundle ever describes.
 */
export function mergeFailures(
  fromXcresult: LaneFailure[],
  fromLog: LaneFailure[],
): LaneFailure[] {
  if (fromXcresult.length === 0) return fromLog;

  /** `LoginTests.testSignIn` and `LoginTests/testSignIn()` must match. */
  const normalize = (name: string): string =>
    name.replace(/\(\)$/, '').replace(/[/.]/g, '.').toLowerCase();

  const logByTest = new Map<string, LaneFailure>();
  for (const failure of fromLog) {
    if (failure.test) logByTest.set(normalize(failure.test), failure);
  }

  const merged = fromXcresult.map((failure) => {
    const counterpart = failure.test ? logByTest.get(normalize(failure.test)) : undefined;
    if (!counterpart) return failure;
    return {
      ...failure,
      ...(failure.file === undefined && counterpart.file ? { file: counterpart.file } : {}),
      ...(failure.line === undefined && counterpart.line ? { line: counterpart.line } : {}),
    };
  });

  const claimed = new Set(
    fromXcresult.filter((failure) => failure.test).map((failure) => normalize(failure.test!)),
  );
  for (const failure of fromLog) {
    if (failure.test && claimed.has(normalize(failure.test))) continue;
    merged.push(failure);
  }
  return merged;
}

/* -------------------------------------------------------------------------- */
/* Ingest                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Copy the runner's results directory into this run's `artifactsDir`.
 *
 * Required, not cosmetic: the contract insists `logPath` and every artifact
 * path live inside `artifactsDir`, and the runner writes into its own data home
 * (`~/Library/Application Support/Tart Xcode Runner/results/<run-id>`), which
 * `tart-runner clean --results N` will eventually delete. Copying is what makes
 * an offstage run directory self-contained and archivable.
 *
 * Never throws — a failed copy degrades to "no artifacts", with the reason.
 */
export async function ingestResultsDir(
  resultsDir: string,
  artifactsDir: string,
): Promise<{ ok: boolean; diagnostics: string[] }> {
  try {
    await fs.mkdir(artifactsDir, { recursive: true });
    await fs.cp(resultsDir, artifactsDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      // Preserve symlinks rather than following them out of the bundle.
      verbatimSymlinks: true,
    });
    return { ok: true, diagnostics: [`Copied runner results from ${resultsDir}.`] };
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        `Could not copy the runner results directory ${resultsDir} into ${artifactsDir}: ` +
          `${(error as Error).message}. The originals are still on disk at ${resultsDir} until ` +
          '`tart-runner clean` removes them.',
      ],
    };
  }
}

/* -------------------------------------------------------------------------- */
/* The whole translation                                                      */
/* -------------------------------------------------------------------------- */

export interface TranslateOptions {
  /** The runner's results directory, as printed on its stdout. */
  resultsDir: string;
  /** This run's output directory. Everything referenced ends up inside it. */
  artifactsDir: string;
  /** Repository root, so failure paths can be made repo-relative. */
  cwd: string;
  /** Injection point for `xcrun`. Defaults to a real spawn. */
  exec?: Exec;
  /** Skip the copy when the caller has already ingested. */
  skipIngest?: boolean;
}

/** The contract-shaped pieces a results directory yields. */
export interface TranslatedResults {
  exitCode: number | null;
  logPath: string | null;
  artifacts: LaneArtifact[];
  failures: LaneFailure[];
  diagnostics: string[];
}

/**
 * Turn a results directory into the fields of a `LaneResult`.
 *
 * Assembles, in order: the exit status, the ingested log, the `.xcresult`
 * bundle as an artifact, structured failures from that bundle where `xcrun`
 * allows it, and log-derived failures either way. Returns *fields* rather than
 * a `LaneResult` so the lane can add timing and status without this module
 * needing to know when the run started.
 */
export async function translateResultsDir(
  options: TranslateOptions,
): Promise<TranslatedResults> {
  const { resultsDir, artifactsDir, cwd } = options;
  const exec = options.exec ?? defaultExec;
  const diagnostics: string[] = [];
  const artifacts: LaneArtifact[] = [];

  const exitCode = await readExitStatus(resultsDir);
  if (exitCode === null) {
    diagnostics.push(
      `Neither ${GUEST_EXIT_STATUS_FILE} nor ${EXIT_STATUS_FILE} was written in ${resultsDir}, ` +
        'so the command never reported an exit code. Nothing can be concluded about the code ' +
        'under test from this run.',
    );
  }

  const logName = await findLogName(resultsDir);

  let ingested = true;
  if (!options.skipIngest) {
    const ingest = await ingestResultsDir(resultsDir, artifactsDir);
    ingested = ingest.ok;
    diagnostics.push(...ingest.diagnostics);
  }

  /* The log. Read from wherever it actually is, but only report a path the
     contract accepts — i.e. one inside artifactsDir. */
  let logPath: string | null = null;
  let logText = '';
  if (logName) {
    const source = ingested ? path.join(artifactsDir, logName) : path.join(resultsDir, logName);
    try {
      logText = await fs.readFile(source, 'utf8');
      if (ingested) {
        logPath = artifactPath(artifactsDir, logName);
        artifacts.push({ kind: 'log', path: logPath });
      } else {
        diagnostics.push(
          `${logName} was parsed in place at ${source} but is not reported as logPath, because ` +
            'the contract requires it to live inside artifactsDir.',
        );
      }
    } catch (error) {
      diagnostics.push(`Could not read ${logName}: ${(error as Error).message}`);
    }
  } else {
    diagnostics.push(
      `No ${XCODEBUILD_LOG} or ${COMMAND_LOG} in ${resultsDir}; the run produced no output log.`,
    );
  }

  /* The .xcresult bundle. */
  const ingestedBundle = path.join(artifactsDir, XCRESULT_BUNDLE);
  const sourceBundle = path.join(resultsDir, XCRESULT_BUNDLE);
  let bundleForParsing: string | null = null;
  try {
    const stats = await fs.stat(ingested ? ingestedBundle : sourceBundle);
    if (stats.isDirectory()) {
      bundleForParsing = ingested ? ingestedBundle : sourceBundle;
      if (ingested) {
        artifacts.push({ kind: 'xcresult', path: artifactPath(artifactsDir, XCRESULT_BUNDLE) });
      }
    }
  } catch {
    // No bundle. Normal for `run`, and for builds that died before xcodebuild
    // wrote one — the log is then the only evidence, which is fine.
  }

  const logParse = logText
    ? parseXcodebuildLog(logText, cwd)
    : { failures: [], diagnostics: [], banners: [] };

  let xcresultFailures: LaneFailure[] = [];
  if (bundleForParsing) {
    const extraction = await extractXcresultFailures(bundleForParsing, exec);
    xcresultFailures = extraction.failures;
    diagnostics.push(...extraction.diagnostics);
  }

  const failures = mergeFailures(xcresultFailures, logParse.failures);
  diagnostics.push(...logParse.diagnostics);

  // A red run that produced no parseable failure is the case where a raw log
  // tail earns its space — otherwise the user gets a status and nothing else.
  if (failures.length === 0 && exitCode !== null && exitCode !== 0 && logText) {
    diagnostics.push(
      `No structured failures were parsed from this run. Last ${TAIL_LINES} lines of ${logName}:`,
      ...logTail(logText),
    );
  }

  return { exitCode, logPath, artifacts, failures, diagnostics };
}
