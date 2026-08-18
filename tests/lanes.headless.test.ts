/**
 * Headless lane tests.
 *
 * Two halves, deliberately separated:
 *
 * - **Parser tests** run against verbatim transcripts of real reporters. Every
 *   transcript in `transcripts` below was captured by actually running Vitest
 *   4.1, Jest 30 and Playwright 1.57 and pasting what they printed — not
 *   written from memory of what those reporters look like.
 * - **Lane tests** genuinely spawn processes and assert on the envelope that
 *   comes back. Nothing is mocked: a passing run really runs Vitest, a timeout
 *   really gets killed, and the Playwright block really drives Chromium.
 *
 * The Playwright block is **gated**. It runs only when `@playwright/test`
 * resolves from the fixture directory *and* a Chromium build is already in the
 * Playwright browser cache; otherwise it skips. Nothing here ever downloads a
 * browser — a test suite that pulls 150MB on a cold CI runner is a worse
 * outcome than a skipped test.
 */

import { existsSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LaneRequest, LaneResult } from '../src/contract/index.js';
import { exitCodeForResult, parseLaneResult } from '../src/contract/index.js';
import { allocateRunDir, readResult, writeResult } from '../src/contract/artifacts.js';
import {
  COMMAND_LOG_FILENAME,
  HeadlessLane,
  detectHeadedRequest,
  headlessLane,
  parseFailures,
  stripAnsi,
  tailOf,
  toLines,
} from '../src/lanes/headless/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'headless');
const VITEST_BIN = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

/** `node <vitest> run`, the way the headless lane wants a command: split argv. */
const vitestCommand = (): string[] => [process.execPath, VITEST_BIN, 'run'];

/* -------------------------------------------------------------------------- */
/* Reporter transcripts (verbatim, ANSI already stripped)                     */
/* -------------------------------------------------------------------------- */

const VITEST_TRANSCRIPT = `
 RUN  v4.1.10 /repo/tests/fixtures/headless/vitest-fail

 ❯ sum.test.mjs (2 tests | 1 failed) 5ms
     ✓ adds numbers 2ms
     × is deliberately red 3ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  sum.test.mjs > headless fixture > is deliberately red
AssertionError: expected 2 to be 3 // Object.is equality

- Expected
+ Received

- 3
+ 2

 ❯ sum.test.mjs:9:19
      7|
      8|   it('is deliberately red', () => {
      9|     expect(1 + 1).toBe(3);
       |                   ^
     10|   });
     11| });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
`;

const JEST_TRANSCRIPT = `FAIL t/sum.test.js
  ● headless fixture › is deliberately red

    expect(received).toBe(expected) // Object.is equality

    Expected: 3
    Received: 2

      1 | describe('headless fixture', () => {
      2 |   test('adds numbers', () => { expect(1 + 1).toBe(2); });
    > 3 |   test('is deliberately red', () => { expect(1 + 1).toBe(3); });
        |                                                     ^
      4 | });
      5 |

      at Object.toBe (t/sum.test.js:3:53)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 passed, 2 total
`;

const PLAYWRIGHT_TRANSCRIPT = `
Running 1 test using 1 worker

  ✘  1 failing.spec.mjs:2:1 › reads the rendered heading (5.1s)


  1) failing.spec.mjs:2:1 › reads the rendered heading ─────────────────────────────────────────────

    Error: expect(locator).toHaveText(expected) failed

    Locator:  locator('#heading')
    Expected: "this text is deliberately wrong"
    Received: "offstage headless fixture"
    Timeout:  5000ms

    Call log:
      - Expect "toHaveText" with timeout 5000ms
      - waiting for locator('#heading')
        14 × locator resolved to <h1 id="heading">offstage headless fixture</h1>
           - unexpected value "offstage headless fixture"


      2 | test('reads the rendered heading', async ({ page }) => {
      3 |   await page.setContent('<h1 id="heading">offstage headless fixture</h1>');
    > 4 |   await expect(page.locator('#heading')).toHaveText('this text is deliberately wrong');
        |                                          ^
      5 | });
      6 |
        at /repo/tests/fixtures/headless/playwright/failing.spec.mjs:4:42

    Error Context: test-results/failing-reads-the-rendered-heading/error-context.md

  1 failed
    failing.spec.mjs:2:1 › reads the rendered heading ──────────────────────────────────────────────
`;

/* -------------------------------------------------------------------------- */
/* Parser                                                                     */
/* -------------------------------------------------------------------------- */

describe('parseFailures', () => {
  it('extracts a vitest failure with its file, line and assertion message', () => {
    const failures = parseFailures(VITEST_TRANSCRIPT, { cwd: '/repo' });

    expect(failures).toEqual([
      {
        test: 'headless fixture > is deliberately red',
        message: 'AssertionError: expected 2 to be 3 // Object.is equality',
        file: 'sum.test.mjs',
        line: 9,
      },
    ]);
  });

  it('extracts a jest failure, taking the file from the enclosing FAIL banner', () => {
    const failures = parseFailures(JEST_TRANSCRIPT, { cwd: '/repo' });

    expect(failures).toEqual([
      {
        test: 'headless fixture › is deliberately red',
        message: 'expect(received).toBe(expected) // Object.is equality',
        file: 't/sum.test.js',
        line: 3,
      },
    ]);
  });

  it('extracts a playwright failure and strips the box-drawing padding', () => {
    const failures = parseFailures(PLAYWRIGHT_TRANSCRIPT, { cwd: '/repo' });

    expect(failures).toEqual([
      {
        test: 'reads the rendered heading',
        message: 'Error: expect(locator).toHaveText(expected) failed',
        file: 'failing.spec.mjs',
        line: 2,
      },
    ]);
  });

  it('handles the [project] prefix the line reporter adds', () => {
    const failures = parseFailures(
      '  1) [chromium] › tests/a.spec.ts:12:3 › suite › does a thing ────\n\n    Error: nope\n',
      { cwd: '/repo' },
    );

    expect(failures).toEqual([
      {
        test: 'suite › does a thing',
        message: 'Error: nope',
        file: 'tests/a.spec.ts',
        line: 12,
      },
    ]);
  });

  it('deduplicates the failure playwright prints inline and again in its summary', () => {
    const block = '  1) a.spec.ts:2:1 › the test ────\n\n    Error: boom\n\n';
    const failures = parseFailures(block + block, { cwd: '/repo' });

    expect(failures).toHaveLength(1);
  });

  it('reports several failures in order', () => {
    const failures = parseFailures(
      [
        '  1) a.spec.ts:2:1 › first ────',
        '',
        '    Error: one',
        '',
        '  2) b.spec.ts:5:1 › second ────',
        '',
        '    Error: two',
        '',
      ].join('\n'),
      { cwd: '/repo' },
    );

    expect(failures.map((failure) => failure.test)).toEqual(['first', 'second']);
    expect(failures.map((failure) => failure.file)).toEqual(['a.spec.ts', 'b.spec.ts']);
  });

  it('honours the limit', () => {
    const many = Array.from(
      { length: 10 },
      (_unused, index) => `  ${index + 1}) a.spec.ts:${index + 1}:1 › test ${index} ────\n\n    Error: boom\n\n`,
    ).join('');

    expect(parseFailures(many, { cwd: '/repo', limit: 3 })).toHaveLength(3);
    expect(parseFailures(many, { cwd: '/repo', limit: 0 })).toEqual([]);
  });

  it('sees through ANSI colour codes', () => {
    const coloured =
      '\u001B[31m FAIL \u001B[39m \u001B[2msum.test.mjs\u001B[22m > red\n' +
      '\u001B[1mAssertionError: nope\u001B[22m\n';

    expect(parseFailures(coloured, { cwd: '/repo' })).toEqual([
      { test: 'red', message: 'AssertionError: nope', file: 'sum.test.mjs' },
    ]);
  });

  it('returns nothing at all when the output is from an unrecognized reporter', () => {
    const output = [
      'Compiling 42 modules...',
      'error: something went wrong in a bespoke build tool',
      'exit status 1',
    ].join('\n');

    expect(parseFailures(output, { cwd: '/repo' })).toEqual([]);
    expect(parseFailures('', { cwd: '/repo' })).toEqual([]);
  });

  it('omits file rather than inventing one it cannot express repo-relatively', () => {
    const outsideRepo = parseFailures(' FAIL  /somewhere/else/a.test.ts > red\nError: nope\n', {
      cwd: '/repo',
    });
    expect(outsideRepo[0]?.file).toBeUndefined();
    expect(outsideRepo[0]?.test).toBe('red');

    const noCwd = parseFailures(' FAIL  a.test.ts > red\nError: nope\n');
    expect(noCwd[0]?.file).toBeUndefined();
  });

  it('does not attach a line number that belongs to a different file', () => {
    /* The only location in the block is in a helper, not the test file. Taking
       its line number would point an agent at the wrong source. */
    const failures = parseFailures(
      [
        'FAIL t/a.test.js',
        '  ● suite › red',
        '',
        '    expect(received).toBe(expected)',
        '',
        '      at assertThing (t/helpers.js:88:5)',
        '',
      ].join('\n'),
      { cwd: '/repo' },
    );

    expect(failures[0]?.file).toBe('t/a.test.js');
    expect(failures[0]?.line).toBeUndefined();
  });

  it('ignores node_modules and node: frames when locating a failure', () => {
    const failures = parseFailures(
      [
        'FAIL t/a.test.js',
        '  ● suite › red',
        '',
        '    expect(received).toBe(expected)',
        '',
        '      at node:internal/process/task_queues:95:5',
        '      at Object.<anonymous> (node_modules/expect/build/index.js:1:1)',
        '      at Object.toBe (t/a.test.js:7:19)',
        '',
      ].join('\n'),
      { cwd: '/repo' },
    );

    expect(failures[0]).toMatchObject({ file: 't/a.test.js', line: 7 });
  });

  it('skips jest console bullets, which are not failures', () => {
    expect(
      parseFailures('PASS t/a.test.js\n  ● Console\n\n    console.log\n      hi\n', {
        cwd: '/repo',
      }),
    ).toEqual([]);
  });

  it('falls back to the test name when no message line can be found', () => {
    const failures = parseFailures('  1) a.spec.ts:2:1 › lonely ────\n', { cwd: '/repo' });
    expect(failures).toEqual([
      { test: 'lonely', message: 'lonely', file: 'a.spec.ts', line: 2 },
    ]);
  });

  it('produces failures the contract schema accepts', () => {
    const failures = [
      ...parseFailures(VITEST_TRANSCRIPT, { cwd: '/repo' }),
      ...parseFailures(JEST_TRANSCRIPT, { cwd: '/repo' }),
      ...parseFailures(PLAYWRIGHT_TRANSCRIPT, { cwd: '/repo' }),
    ];
    expect(failures).toHaveLength(3);

    expect(() =>
      parseLaneResult({
        lane: 'headless',
        status: 'failed',
        exitCode: 1,
        startedAt: new Date().toISOString(),
        durationMs: 1,
        artifactsDir: '/tmp/offstage-run',
        logPath: null,
        artifacts: [],
        failures,
        diagnostics: [],
      }),
    ).not.toThrow();
  });
});

describe('text helpers', () => {
  it('strips CSI and OSC escape sequences', () => {
    expect(stripAnsi('\u001B[31mred\u001B[39m')).toBe('red');
    expect(stripAnsi('\u001B]8;;https://example.com\u0007link\u001B]8;;\u0007')).toBe('link');
  });

  it('treats a spinner carriage return as a line break', () => {
    expect(toLines('a\r\nb\rc')).toEqual(['a', 'b', 'c']);
  });

  it('returns the tail without trailing blank lines, capped by line count', () => {
    const text = Array.from({ length: 100 }, (_unused, index) => `line ${index}`).join('\n');
    const tail = tailOf(`${text}\n\n\n`, 3);

    expect(tail).toBe('line 97\nline 98\nline 99');
  });

  it('caps the tail by character count too', () => {
    expect(tailOf('x'.repeat(500), 40, 100)).toHaveLength(101); // 100 chars + the ellipsis
  });
});

/* -------------------------------------------------------------------------- */
/* The headed-command guard                                                   */
/* -------------------------------------------------------------------------- */

describe('detectHeadedRequest', () => {
  it('recognizes the flags that put a window on screen', () => {
    for (const flag of ['--headed', '--headful', '--no-headless', '--headless=false', '--ui']) {
      expect(detectHeadedRequest({ command: ['npx', 'playwright', 'test', flag] })).toContain(flag);
    }
  });

  it('recognizes environment that opens a window', () => {
    expect(
      detectHeadedRequest({ command: ['npx', 'playwright', 'test'], env: { PWDEBUG: '1' } }),
    ).toContain('PWDEBUG');
    expect(
      detectHeadedRequest({ command: ['npx', 'playwright', 'test'], env: { HEADLESS: 'false' } }),
    ).toContain('HEADLESS');
  });

  it('leaves ordinary headless commands alone', () => {
    expect(detectHeadedRequest({ command: ['npx', 'playwright', 'test'] })).toBeNull();
    expect(detectHeadedRequest({ command: ['npx', 'vitest', 'run', '--reporter=json'] })).toBeNull();
    expect(
      detectHeadedRequest({ command: ['npx', 'playwright', 'test'], env: { HEADLESS: '1' } }),
    ).toBeNull();
    expect(
      detectHeadedRequest({ command: ['npx', 'playwright', 'test'], env: { PWDEBUG: '0' } }),
    ).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The lane                                                                   */
/* -------------------------------------------------------------------------- */

describe('HeadlessLane', () => {
  let scratch: string;
  let runCounter = 0;

  beforeAll(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-headless-'));
  });

  afterAll(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  /** A fresh artifacts directory per run, outside the repository. */
  const nextArtifactsDir = async (): Promise<string> => {
    const dir = path.join(scratch, `run-${(runCounter += 1)}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  };

  /** Every result this lane returns must satisfy the contract, without exception. */
  const expectContractValid = (result: LaneResult): void => {
    expect(() => parseLaneResult(result)).not.toThrow();
    expect(result.lane).toBe('headless');
  };

  const readLog = (result: LaneResult): Promise<string> =>
    fs.readFile(result.logPath!, 'utf8');

  describe('isAvailable', () => {
    it('never reports unavailable', async () => {
      const availability = await headlessLane.isAvailable();

      expect(availability).toEqual({ available: true });
      expect(availability.reason).toBeUndefined();
      expect(availability.fix).toBeUndefined();
    });

    it('is stable across instances and repeated calls', async () => {
      const results = await Promise.all([
        new HeadlessLane().isAvailable(),
        new HeadlessLane().isAvailable(),
        headlessLane.isAvailable(),
        headlessLane.isAvailable(),
      ]);

      expect(results.every((availability) => availability.available)).toBe(true);
    });
  });

  describe('a passing run', () => {
    let result: LaneResult;

    beforeAll(async () => {
      result = await headlessLane.run({
        cwd: path.join(FIXTURES, 'vitest-pass'),
        command: vitestCommand(),
        artifactsDir: await nextArtifactsDir(),
        timeoutMs: 60_000,
      });
    });

    it('reports passed with exit code 0', () => {
      expectContractValid(result);
      expect(result.status).toBe('passed');
      expect(result.exitCode).toBe(0);
      expect(result.failures).toEqual([]);
      expect(exitCodeForResult(result)).toBe(0);
    });

    it('streams the command output to command.log inside artifactsDir', async () => {
      expect(result.logPath).toBe(path.join(result.artifactsDir, COMMAND_LOG_FILENAME));
      expect(result.artifacts).toEqual([{ kind: 'log', path: result.logPath }]);

      const log = await readLog(result);
      expect(log).toContain('sum.test.mjs');
      expect(log).toContain('1 passed');
    });

    it('records a plausible start time and duration', () => {
      expect(new Date(result.startedAt).getTime()).toBeLessThanOrEqual(Date.now());
      expect(result.durationMs).toBeGreaterThan(0);
    });

    it('states that no isolation was applied and nothing reached the screen', () => {
      const diagnostics = result.diagnostics.join('\n');

      expect(diagnostics).toMatch(/no isolation was applied/i);
      expect(diagnostics).toMatch(/ran it in place/i);
      expect(diagnostics).toMatch(/no container was started/i);
      expect(diagnostics).toMatch(/nothing appeared on your screen/i);
      expect(diagnostics).toMatch(/no window was opened/i);
    });

    it('round-trips through result.json', async () => {
      const written = await writeResult(result);
      expect(written).toBe(path.join(result.artifactsDir, 'result.json'));
      expect(await readResult(result.artifactsDir)).toEqual(result);
    });
  });

  describe('a failing run', () => {
    let result: LaneResult;
    const cwd = path.join(FIXTURES, 'vitest-fail');

    beforeAll(async () => {
      result = await headlessLane.run({
        cwd,
        command: vitestCommand(),
        artifactsDir: await nextArtifactsDir(),
        timeoutMs: 60_000,
      });
    });

    it('reports failed, not errored, and keeps the command exit code', () => {
      expectContractValid(result);
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
      expect(exitCodeForResult(result)).toBe(1);
    });

    it('parses the red test out of the real vitest output', () => {
      expect(result.failures).toEqual([
        {
          test: 'headless fixture > is deliberately red',
          message: expect.stringContaining('expected 2 to be 3'),
          file: 'sum.test.mjs',
          line: 9,
        },
      ]);
    });

    it('points at a file that actually exists, relative to cwd', () => {
      expect(existsSync(path.join(cwd, result.failures[0]!.file!))).toBe(true);
    });
  });

  describe('a failing run nothing can parse', () => {
    it('leaves failures empty and puts the tail of the log in diagnostics', async () => {
      const result = await headlessLane.run({
        cwd: REPO_ROOT,
        command: [
          process.execPath,
          '-e',
          'console.log("a bespoke build tool speaks only for itself"); process.exit(2)',
        ],
        artifactsDir: await nextArtifactsDir(),
      });

      expectContractValid(result);
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(2);
      expect(result.failures).toEqual([]);

      const diagnostics = result.diagnostics.join('\n');
      expect(diagnostics).toMatch(/no output matched a reporter this lane recognizes/i);
      expect(diagnostics).toContain('a bespoke build tool speaks only for itself');
      expect(exitCodeForResult(result)).toBe(2);
    });
  });

  describe('a command that cannot be started', () => {
    it('is errored, not failed, and says what to check', async () => {
      const result = await headlessLane.run({
        cwd: REPO_ROOT,
        command: ['offstage-definitely-not-a-real-binary', '--version'],
        artifactsDir: await nextArtifactsDir(),
      });

      expectContractValid(result);
      expect(result.status).toBe('errored');
      expect(result.exitCode).toBeNull();
      expect(result.failures).toEqual([]);
      expect(result.diagnostics.join('\n')).toMatch(/could not be started/i);
      expect(result.diagnostics.join('\n')).toContain('offstage-definitely-not-a-real-binary');
      expect(exitCodeForResult(result)).toBe(70);
    });
  });

  describe('a command that outlives its timeout', () => {
    it('is errored, keeps the output captured before the kill, and says why', async () => {
      const result = await headlessLane.run({
        cwd: FIXTURES,
        command: [process.execPath, path.join(FIXTURES, 'slow.mjs')],
        artifactsDir: await nextArtifactsDir(),
        timeoutMs: 1_500,
      });

      expectContractValid(result);
      expect(result.status).toBe('errored');
      expect(result.exitCode).toBeNull();
      expect(result.diagnostics.join('\n')).toMatch(/timed out after 1500ms/i);
      expect(result.diagnostics.join('\n')).toMatch(/nothing can be concluded/i);
      expect(await readLog(result)).toContain('slow fixture started');
      expect(exitCodeForResult(result)).toBe(70);
    });
  });

  describe('environment handling', () => {
    it('layers the requested variables over the ambient environment', async () => {
      const result = await headlessLane.run({
        cwd: REPO_ROOT,
        command: [
          process.execPath,
          '-e',
          'console.log(process.env.OFFSTAGE_FIXTURE_ENV, process.env.PATH ? "has-path" : "no-path")',
        ],
        env: { OFFSTAGE_FIXTURE_ENV: 'layered' },
        artifactsDir: await nextArtifactsDir(),
      });

      expectContractValid(result);
      expect(result.status).toBe('passed');
      expect(await readLog(result)).toContain('layered has-path');
      expect(result.diagnostics.join('\n')).toContain('OFFSTAGE_FIXTURE_ENV');
    });

    it('runs in the requested cwd', async () => {
      const cwd = path.join(FIXTURES, 'vitest-pass');
      const result = await headlessLane.run({
        cwd,
        command: [process.execPath, '-e', 'console.log(process.cwd())'],
        artifactsDir: await nextArtifactsDir(),
      });

      expect(result.status).toBe('passed');
      expect(await readLog(result)).toContain(await fs.realpath(cwd));
    });
  });

  describe('refusing work that would open a window', () => {
    it('errors instead of running an explicitly headed command', async () => {
      const artifactsDir = await nextArtifactsDir();
      const result = await headlessLane.run({
        cwd: REPO_ROOT,
        command: ['npx', 'playwright', 'test', '--headed'],
        artifactsDir,
      });

      expectContractValid(result);
      expect(result.status).toBe('errored');
      expect(result.exitCode).toBeNull();

      const diagnostics = result.diagnostics.join('\n');
      expect(diagnostics).toMatch(/refused to run/i);
      expect(diagnostics).toMatch(/open a window on your screen/i);
      expect(diagnostics).toMatch(/container lane/i);
    });

    it('does not execute anything, so no log is produced', async () => {
      const artifactsDir = await nextArtifactsDir();
      const result = await headlessLane.run({
        cwd: REPO_ROOT,
        command: ['npx', 'playwright', 'test', '--headed'],
        artifactsDir,
      });

      expect(result.logPath).toBeNull();
      expect(result.artifacts).toEqual([]);
      expect(existsSync(path.join(artifactsDir, COMMAND_LOG_FILENAME))).toBe(false);
    });
  });

  describe('a request that violates the contract', () => {
    it('errors with the schema violations instead of throwing', async () => {
      const result = await headlessLane.run({
        cwd: 'tests/fixtures/headless/vitest-pass',
        command: vitestCommand(),
        artifactsDir: await nextArtifactsDir(),
      } as LaneRequest);

      expectContractValid(result);
      expect(result.status).toBe('errored');
      expect(result.diagnostics.join('\n')).toMatch(/does not satisfy the offstage lane contract/i);
      expect(result.diagnostics.join('\n')).toMatch(/cwd must be an absolute path/i);
    });

    it('survives a request with an empty command', async () => {
      const result = await headlessLane.run({
        cwd: REPO_ROOT,
        command: [],
        artifactsDir: await nextArtifactsDir(),
      });

      expect(result.status).toBe('errored');
      expect(result.diagnostics.join('\n')).toMatch(/at least one element/i);
    });

    it('survives a request with nothing in it at all', async () => {
      const result = await headlessLane.run({} as unknown as LaneRequest);

      expectContractValid(result);
      expect(result.status).toBe('errored');
      expect(exitCodeForResult(result)).toBe(70);
    });
  });

  describe('run directories allocated the normal way', () => {
    it('writes command.log into the directory allocateRunDir handed out', async () => {
      const repo = await fs.mkdtemp(path.join(scratch, 'repo-'));
      const run = await allocateRunDir({ cwd: repo });

      const result = await headlessLane.run({
        cwd: repo,
        command: [process.execPath, '-e', 'console.log("hello from a real run dir")'],
        artifactsDir: run.artifactsDir,
      });

      expectContractValid(result);
      expect(result.status).toBe('passed');
      expect(result.artifactsDir).toBe(run.artifactsDir);
      expect(await readLog(result)).toContain('hello from a real run dir');

      await writeResult(result);
      expect((await readResult(run.resultPath)).status).toBe('passed');
    });

    it('creates artifactsDir when the caller has not', async () => {
      const artifactsDir = path.join(scratch, 'not-yet-created', 'nested');

      const result = await headlessLane.run({
        cwd: REPO_ROOT,
        command: [process.execPath, '-e', 'console.log("ok")'],
        artifactsDir,
      });

      expect(result.status).toBe('passed');
      expect(existsSync(path.join(artifactsDir, COMMAND_LOG_FILENAME))).toBe(true);
    });
  });

  describe('output handling', () => {
    it('interleaves stdout and stderr into one log', async () => {
      const result = await headlessLane.run({
        cwd: REPO_ROOT,
        command: [
          process.execPath,
          '-e',
          'process.stdout.write("to-stdout\\n"); process.stderr.write("to-stderr\\n")',
        ],
        artifactsDir: await nextArtifactsDir(),
      });

      const log = await readLog(result);
      expect(log).toContain('to-stdout');
      expect(log).toContain('to-stderr');
    });

    it('does not hand the command a stdin to block on', async () => {
      const result = await headlessLane.run({
        cwd: REPO_ROOT,
        command: [
          process.execPath,
          '-e',
          'process.stdin.on("end", () => { console.log("stdin closed"); }); process.stdin.resume();',
        ],
        artifactsDir: await nextArtifactsDir(),
        timeoutMs: 10_000,
      });

      expect(result.status).toBe('passed');
      expect(result.exitCode).toBe(0);
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Real Playwright — gated on an already-installed browser                    */
/* -------------------------------------------------------------------------- */

const PLAYWRIGHT_FIXTURE = path.join(FIXTURES, 'playwright');

/**
 * Resolve `@playwright/test`'s CLI **from the fixture directory**, which is the
 * question that actually matters: the specs import `@playwright/test`, so the
 * lane can only run them if Node can resolve it from where they live.
 */
function resolvePlaywrightCli(): string | null {
  try {
    const requireFromFixture = createRequire(path.join(PLAYWRIGHT_FIXTURE, 'noop.cjs'));
    const cli = path.join(
      path.dirname(requireFromFixture.resolve('@playwright/test/package.json')),
      'cli.js',
    );
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

/** Where Playwright keeps downloaded browsers, when it is not told otherwise. */
function browsersPath(): string | null {
  const configured = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  /* '0' means "next to the package", which the check below cannot inspect. */
  if (configured === '0') return null;
  if (configured !== undefined && configured !== '') return configured;

  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Local', 'ms-playwright');
  return path.join(home, '.cache', 'ms-playwright');
}

/** True only when a Chromium build is *already* on disk. Never downloads one. */
function hasChromium(): boolean {
  const base = browsersPath();
  if (base === null) return false;
  try {
    return readdirSync(base).some(
      (entry) =>
        /^chromium(?:_headless_shell)?-\d+$/.test(entry) &&
        existsSync(path.join(base, entry, 'INSTALLATION_COMPLETE')),
    );
  } catch {
    return false;
  }
}

const PLAYWRIGHT_CLI = resolvePlaywrightCli();
const PLAYWRIGHT_READY = PLAYWRIGHT_CLI !== null && hasChromium();

describe.skipIf(!PLAYWRIGHT_READY)('HeadlessLane driving real Playwright', () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-headless-pw-'));
  });

  afterAll(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  const runSpec = async (spec: string, name: string): Promise<LaneResult> => {
    const artifactsDir = path.join(scratch, name);
    await fs.mkdir(artifactsDir, { recursive: true });
    return headlessLane.run({
      cwd: PLAYWRIGHT_FIXTURE,
      command: [
        process.execPath,
        PLAYWRIGHT_CLI!,
        'test',
        spec,
        /* Keep Playwright's own trace/screenshot output inside this run's
           artifacts dir. Without it Playwright writes `test-results/` next to
           the fixture, which would litter the repository on every test run. */
        `--output=${path.join(artifactsDir, 'playwright-output')}`,
      ],
      artifactsDir,
      timeoutMs: 120_000,
    });
  };

  it('runs a headless chromium spec in place and reports passed', async () => {
    const result = await runSpec('smoke.spec.mjs', 'pass');

    expect(() => parseLaneResult(result)).not.toThrow();
    expect(result.status).toBe('passed');
    expect(result.exitCode).toBe(0);
    expect(await fs.readFile(result.logPath!, 'utf8')).toContain('1 passed');
    expect(result.diagnostics.join('\n')).toMatch(/nothing appeared on your screen/i);
    expect(result.diagnostics.join('\n')).toMatch(/no isolation was applied/i);
  });

  it('parses a real playwright failure out of a red spec', async () => {
    const result = await runSpec('failing.spec.mjs', 'fail');

    expect(() => parseLaneResult(result)).not.toThrow();
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBeGreaterThan(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      test: 'reads the rendered heading',
      file: 'failing.spec.mjs',
      line: 3,
    });
    expect(result.failures[0]!.message).toMatch(/toHaveText/);
  });
});
