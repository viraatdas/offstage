/**
 * Reporter coverage is Playwright / Vitest / Jest only — by design.
 *
 * `LaneResult.failures[]` is machine-readable, and an agent handed
 * `{ file, line }` will go and edit that line. So the headless lane recognizes
 * three reporter formats and abstains on everything else, and this file is what
 * keeps "abstains" true:
 *
 * 1. the three documented reporters really do parse (the claim is not larger
 *    than the implementation);
 * 2. sixteen transcripts from tools we do *not* support yield exactly `[]` (the
 *    implementation is not larger than the claim, which is the dangerous
 *    direction — a recognizer that also matches the tool next door fabricates
 *    failures);
 * 3. the boundary is written down where a user can find it, and a fourth
 *    recognizer cannot be added without updating that document;
 * 4. a run whose output nothing recognized still says so out loud, and still
 *    hands over the whole log.
 *
 * The transcripts live in `tests/fixtures/reporters/` rather than inline: exact
 * whitespace, tabs and ANSI bytes are the whole point of the corpus, and a
 * heredoc in a test file quietly normalizes them.
 *
 * See `docs/reporter-coverage.md` for the decision this file enforces.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LaneFailure, LaneResult, LaneRunner } from '../src/contract/index.js';
import { parseLaneResult } from '../src/contract/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'reporters');
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'reporter-coverage.md');
const PARSE_SOURCE = path.join(REPO_ROOT, 'src', 'lanes', 'headless', 'parse.ts');
const LANE_BARREL = path.join(REPO_ROOT, 'src', 'lanes', 'headless', 'index.ts');

/**
 * The design decision, as a value. Every other assertion in this file is
 * downstream of this list; changing it means changing the product, the document
 * and the diagnostic the lane prints — in that order.
 */
const RECOGNIZED = ['Playwright', 'Vitest', 'Jest'] as const;

/* -------------------------------------------------------------------------- */
/* Loading the lane                                                           */
/* -------------------------------------------------------------------------- */

type ParseFailures = (
  output: string,
  options?: { cwd?: string; limit?: number },
) => LaneFailure[];

interface HeadlessModule {
  parseFailures: ParseFailures;
  tailOf: (text: string, maxLines?: number, maxChars?: number) => string;
  headlessLane: LaneRunner;
}

/**
 * The headless lane is another node's module and may not be present in every
 * workspace yet. The specifier is held in a variable so TypeScript treats the
 * import as dynamic rather than resolving it at typecheck time — the shape we
 * rely on is declared above instead, which doubles as an assertion about the
 * lane's public surface.
 */
const LANE_SPECIFIER: string = '../src/lanes/headless/index.js';
const LANE_PRESENT = existsSync(LANE_BARREL) && existsSync(PARSE_SOURCE);
const lane: HeadlessModule | undefined = LANE_PRESENT
  ? ((await import(LANE_SPECIFIER)) as HeadlessModule)
  : undefined;

if (!LANE_PRESENT) {
  console.warn(
    `[reporter-coverage] ${path.relative(REPO_ROOT, LANE_BARREL)} is not in this workspace, ` +
      'so the behavioural half of this suite is skipped. The documentation checks still run.',
  );
}

/* -------------------------------------------------------------------------- */
/* The corpus                                                                 */
/* -------------------------------------------------------------------------- */

const transcriptsIn = (group: string): string[] =>
  readdirSync(path.join(FIXTURES, group))
    .filter((name) => name.endsWith('.txt'))
    .sort();

const readTranscript = (group: string, name: string): string =>
  readFileSync(path.join(FIXTURES, group, name), 'utf8');

const UNSUPPORTED = transcriptsIn('unsupported');
const KNOWN_LEAKS = transcriptsIn('known-leaks');

/* -------------------------------------------------------------------------- */
/* 1. The documented reporters parse                                          */
/* -------------------------------------------------------------------------- */

describe.skipIf(!LANE_PRESENT)('the three recognized reporters', () => {
  const parseFailures = (output: string, cwd = '/repo'): LaneFailure[] =>
    lane!.parseFailures(output, { cwd });

  it('extracts a Playwright failure', () => {
    const output = [
      '  1) checkout.spec.ts:14:3 › checkout › applies the discount code ─────────────',
      '',
      '    Error: expect(received).toBe(expected)',
      '',
      '    Expected: 90',
      '    Received: 100',
      '',
      '      at checkout.spec.ts:16:24',
      '',
    ].join('\n');

    expect(parseFailures(output)).toEqual([
      {
        test: 'checkout › applies the discount code',
        message: 'Error: expect(received).toBe(expected)',
        file: 'checkout.spec.ts',
        line: 14,
      },
    ]);
  });

  it('extracts a Vitest failure', () => {
    const output = [
      ' FAIL  src/cart.test.ts > cart > totals the line items',
      'AssertionError: expected 3 to be 4',
      ' ❯ src/cart.test.ts:11:19',
      '',
    ].join('\n');

    expect(parseFailures(output)).toEqual([
      {
        test: 'cart > totals the line items',
        message: 'AssertionError: expected 3 to be 4',
        file: 'src/cart.test.ts',
        line: 11,
      },
    ]);
  });

  it('extracts a Jest failure, taking its file from the enclosing banner', () => {
    const withAbsoluteFrame = [
      'FAIL src/sum.test.js',
      '  ● sum › adds two numbers',
      '',
      '    expect(received).toBe(expected) // Object.is equality',
      '',
      '      at Object.<anonymous> (/repo/src/sum.test.js:7:15)',
      '',
    ].join('\n');

    /* No `line`: Jest prints its banner relative and its stack frames absolute,
       and a line number is only trusted when it came from the same *printed*
       path as the file. Losing a line number is the correct trade — the
       alternative is attaching one from a helper or a matcher. */
    expect(parseFailures(withAbsoluteFrame)).toEqual([
      {
        test: 'sum › adds two numbers',
        message: 'expect(received).toBe(expected) // Object.is equality',
        file: 'src/sum.test.js',
      },
    ]);

    /* When the frame is printed the same way as the banner, the line comes too. */
    const withRelativeFrame = withAbsoluteFrame.replace('/repo/src/sum.test.js:7', 'src/sum.test.js:7');
    expect(parseFailures(withRelativeFrame)).toEqual([
      {
        test: 'sum › adds two numbers',
        message: 'expect(received).toBe(expected) // Object.is equality',
        file: 'src/sum.test.js',
        line: 7,
      },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. Everything else abstains                                                */
/* -------------------------------------------------------------------------- */

describe.skipIf(!LANE_PRESENT)('every other reporter abstains rather than guesses', () => {
  it('has a corpus to check against', () => {
    /* If this ever shrinks, the guarantee shrank with it. */
    expect(UNSUPPORTED.length).toBeGreaterThanOrEqual(16);
  });

  it.each(UNSUPPORTED)('%s produces no failures at all', (name) => {
    const transcript = readTranscript('unsupported', name);

    /* With a cwd, because that is how the lane calls it... */
    expect(lane!.parseFailures(transcript, { cwd: REPO_ROOT })).toEqual([]);
    /* ...and without, because an abstention must not depend on path resolution
       succeeding — a match that only fails to produce `file` would still put a
       fabricated test name and message in front of an agent. */
    expect(lane!.parseFailures(transcript)).toEqual([]);
  });

  it.each(UNSUPPORTED)('%s is still handed to the reader as a log tail', (name) => {
    const transcript = readTranscript('unsupported', name);

    /* Abstaining is only acceptable because nothing is swallowed: whatever the
       tool said is what the operator gets. */
    const tail = lane!.tailOf(transcript);
    expect(tail.length).toBeGreaterThan(0);
    expect(transcript).toContain(tail.split('\n').at(-1) ?? ' ');
  });
});

/* -------------------------------------------------------------------------- */
/* 3. Known leaks — the places "abstain" is not true yet                      */
/* -------------------------------------------------------------------------- */

describe.skipIf(!LANE_PRESENT)('known leaks', () => {
  /**
   * Jest's `●` bullet is accepted with no Jest context, so any failing command
   * that prints a `●` bullet gets a fabricated failure. These two transcripts
   * are real (`next build`'s route legend, `systemctl status`) and are marked
   * `it.fails`: they assert the behaviour we want, and pass only while it is
   * still wrong. Fixing `parse.ts` turns them red — at which point delete the
   * `.fails` marker and the "Known leak" section of docs/reporter-coverage.md.
   */
  it('has exactly the leaks the document describes', () => {
    expect(KNOWN_LEAKS).toEqual(['next-build.txt', 'systemctl.txt']);
  });

  it.fails.each(KNOWN_LEAKS)('%s should abstain, and today does not', (name) => {
    expect(lane!.parseFailures(readTranscript('known-leaks', name), { cwd: REPO_ROOT })).toEqual(
      [],
    );
  });

  it.each(KNOWN_LEAKS)('%s at least never invents a source path', (name) => {
    /* The damage is bounded: a fabricated entry with no `file` wastes an
       agent's attention, one with a `file` sends it to edit real source. */
    const failures = lane!.parseFailures(readTranscript('known-leaks', name), {
      cwd: REPO_ROOT,
    });
    expect(failures.every((failure) => failure.file === undefined)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The boundary is written down, and cannot drift silently                 */
/* -------------------------------------------------------------------------- */

describe('the decision is documented', () => {
  const doc = readFileSync(DOC_PATH, 'utf8');

  it('names every recognized reporter', () => {
    for (const reporter of RECOGNIZED) expect(doc).toContain(reporter);
  });

  it('lists every transcript in the corpus, and nothing that is not there', () => {
    for (const name of [...UNSUPPORTED, ...KNOWN_LEAKS]) expect(doc).toContain(name);

    const claimed = [...doc.matchAll(/`([\w.-]+\.txt)`/g)].map((match) => match[1]!);
    const present = new Set([...UNSUPPORTED, ...KNOWN_LEAKS]);
    for (const name of claimed) expect(present).toContain(name);
  });

  it('is reachable from the README', () => {
    expect(readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8')).toContain(
      'docs/reporter-coverage.md',
    );
  });

  it.skipIf(!LANE_PRESENT)('has a recognizer for each documented reporter and no others', () => {
    const source = readFileSync(PARSE_SOURCE, 'utf8');
    const recognizers = [...source.matchAll(/^const\s+([A-Z][A-Z0-9]*)_FAILURE\b/gm)].map(
      (match) => match[1]!,
    );

    /* If this trips, parse.ts stopped naming its recognizers `<TOOL>_FAILURE`
       and this guard needs rewriting rather than deleting — without it, a
       fourth reporter can be added with nobody updating the document. */
    expect(recognizers.length).toBeGreaterThan(0);

    expect(new Set(recognizers)).toEqual(
      new Set(RECOGNIZED.map((reporter) => reporter.toUpperCase())),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 5. A real run says it abstained, and hands over the whole log              */
/* -------------------------------------------------------------------------- */

describe.skipIf(!LANE_PRESENT)('a real run of an unrecognized reporter', () => {
  let scratch: string;
  let result: LaneResult;
  const transcript = readTranscript('unsupported', 'pytest.txt');

  beforeAll(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-reporter-coverage-'));
    result = await lane!.headlessLane.run({
      cwd: REPO_ROOT,
      command: [
        process.execPath,
        '-e',
        `process.stdout.write(${JSON.stringify(transcript)}); process.exit(1)`,
      ],
      artifactsDir: scratch,
      timeoutMs: 60_000,
    });
  });

  afterAll(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it('is a valid, failed result with no parsed failures', () => {
    expect(() => parseLaneResult(result)).not.toThrow();
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.failures).toEqual([]);
  });

  it('names every reporter it does recognize, so empty is never mistaken for clean', () => {
    const diagnostics = result.diagnostics.join('\n');

    expect(diagnostics).toMatch(/no output matched a reporter this lane recognizes/i);
    for (const reporter of RECOGNIZED) expect(diagnostics).toContain(reporter);
  });

  it('quotes the tool verbatim instead of summarising it', () => {
    expect(result.diagnostics.join('\n')).toContain('FAILED tests/test_math.py::test_addition');
  });

  it('keeps the complete output on disk', async () => {
    expect(result.logPath).not.toBeNull();
    await expect(fs.readFile(result.logPath!, 'utf8')).resolves.toBe(transcript);
  });
});
