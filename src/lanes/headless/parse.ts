/**
 * Best-effort failure extraction from a test command's captured output.
 *
 * Everything in this module is a **pure function over text**. It never touches
 * the filesystem, never spawns anything, and never reads the clock, which is
 * why it can be tested exhaustively against transcripts of real reporters
 * without running any of them.
 *
 * ## What this deliberately is not
 *
 * Parsing every test reporter is a losing game, and a parser that guesses wrong
 * is worse than one that returns nothing: a fabricated `failures[]` entry sends
 * an agent to edit the wrong line of the wrong file. So the rule is **recognize
 * or abstain**. Three formats are recognized, because between them they cover
 * nearly everything the headless lane is asked to run:
 *
 * | Reporter                       | Header it prints                          |
 * | ------------------------------ | ----------------------------------------- |
 * | Playwright `list` / `line`     | `  1) a.spec.ts:3:1 › suite › title ────` |
 * | Vitest default                 | ` FAIL  a.test.ts > suite > title`        |
 * | Jest default                   | `  ● suite › title`, under `FAIL a.test.js` |
 *
 * Anything else yields `[]`, and the caller puts the tail of the log in
 * `diagnostics` instead. An empty `failures` array next to `status: 'failed'`
 * is explicitly legal in the contract: see `LaneFailure` in
 * `src/contract/index.ts`.
 *
 * ## Path handling
 *
 * `failures[].file` must be repository-relative POSIX (the path conventions
 * table in `src/contract/index.ts` is normative and the schema enforces it).
 * Reporters print paths relative to their own root, which for the commands this
 * lane runs is the directory the command was launched in, so paths are
 * resolved against `cwd` with `toRepoRelative()`. A path that lands outside the
 * repository cannot be expressed in the required form, so `file` is omitted
 * rather than invented.
 */

import type { LaneFailure } from '../../contract/index.js';
import { toRepoRelative } from '../../contract/artifacts.js';

/* -------------------------------------------------------------------------- */
/* Text normalization                                                         */
/* -------------------------------------------------------------------------- */

/**
 * ANSI escape sequences: CSI (colors, cursor movement), OSC (window title, and
 * the hyperlinks Vitest emits), and the two-character sequences. Reporters
 * colorize by default and every regex below would trip over the codes.
 */
const ANSI_PATTERN =
  /\u001B\[[0-9;?]*[ -\/]*[@-~]|\u001B\][\s\S]*?(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;

/** Remove ANSI escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/**
 * Split captured output into lines, handling the two things that break naive
 * splitting: CRLF, and the bare `\r` a spinner uses to redraw a line in place.
 * Each redraw becomes its own line, which is what we want: the final state of
 * a progress line is then just the last one.
 */
export function toLines(text: string): string[] {
  return stripAnsi(text).replace(/\r\n?/g, '\n').split('\n');
}

/**
 * The last `maxLines` lines of `text`, ignoring trailing blanks and capped at
 * `maxChars`. This is what goes in `diagnostics` when a run failed and nothing
 * parsed: the operator still gets to see what the command actually said.
 */
export function tailOf(text: string, maxLines = 40, maxChars = 4000): string {
  const lines = toLines(text);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  const tail = lines.slice(-maxLines).join('\n');
  return tail.length > maxChars ? `…${tail.slice(-maxChars)}` : tail;
}

/* -------------------------------------------------------------------------- */
/* Header recognizers                                                         */
/* -------------------------------------------------------------------------- */

/** What one recognized header line tells us, before its body is read. */
interface Header {
  test?: string;
  file?: string;
  line?: number;
  /** Set when the line names a file but no test: a per-file banner. */
  bannerOnly?: boolean;
}

/**
 * Lines longer than this are never header candidates. This bounds the work a
 * pathological log can cause: a minified bundle dumped to stdout arrives as
 * one enormous line, and there is no reporter header hiding in it.
 */
const MAX_HEADER_LINE = 2_000;

/** Playwright `list`/`line`: `  1) [chromium] › a.spec.ts:3:1 › suite › title ────` */
const PLAYWRIGHT_FAILURE =
  /^\s*\d+\)\s+(?:\[[^\]]*\]\s*(?:›|>)\s*)?(\S.*?):(\d+):(\d+)\s+(?:›|>)\s+(\S.*)$/;

/** Vitest default reporter: ` FAIL  a.test.ts > suite > title` */
const VITEST_FAILURE = /^\s*FAIL\s+(\S+)\s+>\s+(\S.*)$/;

/**
 * Per-file banner with no test name: `FAIL t/a.test.js` or `FAIL a.test.js (1.2 s)`.
 * Jest prints failures as bare `●` bullets underneath one of these, so this is
 * the only way to learn which file a Jest failure belongs to.
 */
const FILE_BANNER = /^\s*(?:FAIL|PASS)\s+(\S+)\s*(?:\([^)]*\))?\s*$/;

/** Jest default reporter: `  ● suite › title` */
const JEST_FAILURE = /^\s*●\s+(\S.*)$/;

/** Jest bullets that are not failures. */
const JEST_NON_FAILURE = /^(?:Console\b|Deprecation\b|Validation Warning\b)/;

/**
 * Box-drawing characters (U+2500–U+257F) plus the horizontal bar U+23AF that
 * Vitest rules its sections with. Playwright pads failure titles out to the
 * terminal width with these, so they are stripped from the end of a title.
 */
const TRAILING_RULE = /\s*[─-╿⎯]+\s*$/;

/** A line that is nothing but separator characters. */
const DECORATIVE = /^[\s─-╿⎯: –\-_=~*#·•]+$/;

function cleanTitle(raw: string): string {
  return raw.replace(TRAILING_RULE, '').trim();
}

function matchHeader(line: string): Header | null {
  if (line.length > MAX_HEADER_LINE) return null;

  const playwright = PLAYWRIGHT_FAILURE.exec(line);
  if (playwright !== null) {
    const title = cleanTitle(playwright[4]!);
    if (title !== '') {
      return { test: title, file: playwright[1]!, line: Number(playwright[2]) };
    }
  }

  const vitest = VITEST_FAILURE.exec(line);
  if (vitest !== null) {
    const title = cleanTitle(vitest[2]!);
    if (title !== '') return { test: title, file: vitest[1]! };
  }

  const banner = FILE_BANNER.exec(line);
  if (banner !== null) return { file: banner[1]!, bannerOnly: true };

  const jest = JEST_FAILURE.exec(line);
  if (jest !== null) {
    const title = cleanTitle(jest[1]!);
    if (title !== '' && !JEST_NON_FAILURE.test(title)) return { test: title };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Body scanning                                                              */
/* -------------------------------------------------------------------------- */

/** How many lines after a header we will read looking for its details. */
const BODY_WINDOW = 25;

/** How many message lines to keep: enough for an assertion, not a whole diff. */
const MAX_MESSAGE_LINES = 4;

/** Vitest stack pointer: ` ❯ a.test.ts:9:19` */
const VITEST_LOCATION = /^\s*❯\s+(?:.*?\s+)??(\S+?):(\d+):(\d+)\s*$/;

/** Stack frame: `at fn (/abs/a.test.js:5:15)`, or `at /abs/a.spec.mjs:4:42` */
const STACK_LOCATION = /^\s*at\s+(?:.*?\()?([^()\s]+?):(\d+):(\d+)\)?\s*$/;

/**
 * Lines that are useful to a human but are not the failure *message*: code
 * frames (`  3 | expect(...)`), diff markers (`- Expected`), stack pointers.
 */
const NOT_A_MESSAGE = /^\s*(?:\d+\s*\||[|+\->]\s|[❯›»]\s|at\s|\.{3}\s*$)/;

interface Body {
  message: string;
  file?: string;
  line?: number;
}

/**
 * Read the block belonging to the header at `start - 1`: its message (the first
 * contiguous run of prose after the header) and the first source location in it
 * that is not inside `node_modules` or a `node:` internal.
 */
function scanBody(lines: string[], start: number): Body {
  const messageLines: string[] = [];
  let messageDone = false;
  let location: { file: string; line: number } | undefined;

  const end = Math.min(lines.length, start + BODY_WINDOW);
  for (let i = start; i < end; i++) {
    const line = lines[i]!;

    /* The next failure starts here, so this body is over. */
    if (matchHeader(line) !== null) break;

    if (location === undefined) {
      const hit = VITEST_LOCATION.exec(line) ?? STACK_LOCATION.exec(line);
      if (hit !== null && !hit[1]!.includes('node_modules') && !hit[1]!.startsWith('node:')) {
        location = { file: hit[1]!, line: Number(hit[2]) };
      }
    }

    if (messageDone) continue;

    const trimmed = line.trim();
    if (trimmed === '' || DECORATIVE.test(trimmed) || NOT_A_MESSAGE.test(line)) {
      /* A blank or decorative line ends the message, but only once it began,
         so the blank line reporters put between header and message is skipped. */
      if (messageLines.length > 0) messageDone = true;
      continue;
    }

    messageLines.push(trimmed);
    if (messageLines.length >= MAX_MESSAGE_LINES) messageDone = true;
  }

  const body: Body = { message: messageLines.join('\n') };
  if (location !== undefined) {
    body.file = location.file;
    body.line = location.line;
  }
  return body;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export interface ParseFailuresOptions {
  /**
   * Repository root the command ran in. Reporter-printed paths are resolved
   * against it to produce the repository-relative `file` the contract requires.
   * Omit it and `file` is omitted too, rather than guessed.
   */
  cwd?: string;
  /** Cap on returned failures. Default 50: enough to act on, not a whole log. */
  limit?: number;
}

/**
 * Extract failing tests from captured stdout/stderr.
 *
 * Returns `[]` when nothing is recognized, which is a legitimate outcome rather
 * than an error. Results are deduplicated, because Playwright and Jest each
 * print a failure once inline and again in their end-of-run summary.
 */
export function parseFailures(output: string, options: ParseFailuresOptions = {}): LaneFailure[] {
  const limit = options.limit ?? 50;
  if (limit <= 0 || output === '') return [];

  const lines = toLines(output);
  const failures: LaneFailure[] = [];
  const seen = new Set<string>();
  /** The most recent per-file banner: where Jest's `●` failures live. */
  let bannerFile: string | undefined;

  for (let i = 0; i < lines.length && failures.length < limit; i++) {
    const header = matchHeader(lines[i]!);
    if (header === null) continue;

    if (header.bannerOnly === true) {
      bannerFile = header.file;
      continue;
    }

    const body = scanBody(lines, i + 1);
    /* Precedence matters. The header names the file outright; failing that, the
       enclosing `FAIL <path>` banner is authoritative for everything under it.
       A stack frame is the last resort, because the topmost frame is often in a
       helper or a matcher rather than in the test itself. */
    const rawFile = header.file ?? bannerFile ?? body.file;
    /* Only trust a line number from the body when it points at the same file
       we are about to report. A stack frame in a helper module would otherwise
       attach its line number to the test file, which is worse than no line. */
    const line = header.line ?? (rawFile === body.file ? body.line : undefined);
    const file = rawFile === undefined ? undefined : normalizeFile(rawFile, options.cwd);

    const failure: LaneFailure = {
      message: body.message === '' ? (header.test ?? 'test failed') : body.message,
    };
    if (header.test !== undefined) failure.test = header.test;
    if (file !== undefined) failure.file = file;
    if (line !== undefined && Number.isInteger(line) && line > 0) failure.line = line;

    const key = [failure.test, failure.file, failure.line].join("\u0000");
    if (seen.has(key)) continue;
    seen.add(key);
    failures.push(failure);
  }

  return failures;
}

/**
 * Reporter path -> repository-relative POSIX, or `undefined` when it cannot be
 * expressed that way: an absolute path outside `cwd`, a URL, a `<anonymous>`
 * marker, or no `cwd` to resolve against.
 */
function normalizeFile(raw: string, cwd?: string): string | undefined {
  const candidate = raw.trim();
  if (candidate === '' || candidate.startsWith('<') || candidate.includes('://')) return undefined;
  if (cwd === undefined) return undefined;
  const relative = toRepoRelative(cwd, candidate);
  return relative === null ? undefined : relative;
}
