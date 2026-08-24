/**
 * The output budget: 4 MB retained in memory, a complete log on disk.
 *
 * The headless lane makes two promises about a command's output, and they pull
 * in opposite directions:
 *
 * 1. **At most {@link MAX_CAPTURED_CHARS} characters are held in memory** for
 *    failure parsing, so a runaway command that prints a gigabyte cannot take
 *    the offstage process down with it.
 * 2. **`command.log` on disk is never truncated.** Every byte the command
 *    printed is on disk, because the log is the artifact a human opens when the
 *    parsed summary is not enough.
 *
 * Keeping the first promise by breaking the second (dropping bytes) would be
 * dishonest; keeping the second by breaking the first (queueing the overflow in
 * the write stream's unbounded buffer) would be the same memory blow-up wearing
 * a different hat. These tests hold both at once, and they pin the three things
 * that make that possible: an exact in-memory bound whatever the chunk sizes
 * are, eviction that stays linear over millions of writes, and writes to disk
 * that honor backpressure rather than buffering it.
 */

import { Writable } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { LaneResult } from '../src/contract/index.js';
import { parseLaneResult } from '../src/contract/index.js';
import {
  CappedText,
  COMMAND_LOG_FILENAME,
  MAX_CAPTURED_CHARS,
  appendWithBackpressure,
  headlessLane,
} from '../src/lanes/headless/runner.js';

/* -------------------------------------------------------------------------- */
/* The in-memory bound                                                        */
/* -------------------------------------------------------------------------- */

describe('CappedText: the in-memory bound is exact', () => {
  it('keeps output that fits, and reports nothing dropped', () => {
    const capture = new CappedText(100);
    capture.push('hello ');
    capture.push('world');

    expect(capture.text()).toBe('hello world');
    expect(capture.droppedChars).toBe(0);
  });

  it('ignores empty writes', () => {
    const capture = new CappedText(10);
    capture.push('');
    capture.push('abc');
    capture.push('');

    expect(capture.text()).toBe('abc');
    expect(capture.droppedChars).toBe(0);
  });

  it('retains the newest characters, because reporters summarize last', () => {
    const capture = new CappedText(10);
    for (const chunk of ['aaaa', 'bbbb', 'cccc', 'dddd']) capture.push(chunk);

    expect(capture.text()).toBe('aaaabbbbccccdddd'.slice(-10));
    expect(capture.text()).toBe('bbccccdddd');
    expect(capture.droppedChars).toBe(6);
  });

  it('trims inside a chunk, so the bound is the cap and not the chunk size', () => {
    const capture = new CappedText(10);
    capture.push('abcdefg');
    capture.push('hijklmn');

    /* A boundary-only eviction would have dropped all of 'abcdefg' and kept 7
       characters; the cap is exact, so it keeps 10. */
    expect(capture.text()).toBe('efghijklmn');
    expect(capture.text()).toHaveLength(10);
    expect(capture.droppedChars).toBe(4);
  });

  it('trims a single chunk that is larger than the whole budget', () => {
    const capture = new CappedText(1_000);
    capture.push(`${'x'.repeat(4_000)}END`);

    expect(capture.text()).toHaveLength(1_000);
    expect(capture.text().endsWith('END')).toBe(true);
    expect(capture.droppedChars).toBe(3_003);
  });

  it('drops everything older when one oversized chunk arrives', () => {
    const capture = new CappedText(1_000);
    capture.push('older output');
    capture.push('y'.repeat(2_500));

    expect(capture.text()).toBe('y'.repeat(1_000));
    expect(capture.droppedChars).toBe('older output'.length + 1_500);
  });

  it('never exceeds the cap for any mix of chunk sizes', () => {
    const limit = 997;
    const capture = new CappedText(limit);
    let produced = '';
    /* Deterministic pseudo-random sizes, straddling the cap in both directions. */
    let seed = 7;
    for (let i = 0; i < 400; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const size = seed % 2500;
      const chunk = String.fromCharCode(97 + (i % 26)).repeat(size);
      produced += chunk;
      capture.push(chunk);

      expect(capture.text().length).toBeLessThanOrEqual(limit);
      expect(capture.text()).toBe(produced.slice(-limit));
      expect(capture.droppedChars).toBe(produced.length - capture.text().length);
    }
    expect(produced.length).toBeGreaterThan(limit * 100);
  });

  it('accounts for every character it was given', () => {
    const capture = new CappedText(64);
    let produced = 0;
    for (let i = 0; i < 500; i++) {
      const chunk = 'z'.repeat(i % 40);
      produced += chunk.length;
      capture.push(chunk);
    }

    expect(capture.text().length + capture.droppedChars).toBe(produced);
  });

  it('evicts in amortized constant time, so millions of small writes stay linear', () => {
    const capture = new CappedText(MAX_CAPTURED_CHARS);
    const chunk = 'y'.repeat(31);
    /* 64 MB of output arriving one short line at a time: a plausible shape for
       a verbose test run, and the shape a shift()-per-write buffer turns
       quadratic: the same workload took ~33 s that way, versus ~30 ms here. */
    const writes = Math.floor((64 * 1024 * 1024) / chunk.length);

    const startedAt = Date.now();
    for (let i = 0; i < writes; i++) capture.push(chunk);
    const elapsedMs = Date.now() - startedAt;

    expect(writes).toBeGreaterThan(2_000_000);
    expect(capture.text()).toHaveLength(MAX_CAPTURED_CHARS);
    expect(elapsedMs).toBeLessThan(4_000);
  });

  it('is set to a documented 4 MB', () => {
    expect(MAX_CAPTURED_CHARS).toBe(4_000_000);
  });
});

/* -------------------------------------------------------------------------- */
/* Backpressure on the way to disk                                            */
/* -------------------------------------------------------------------------- */

describe('appendWithBackpressure: the log cannot become the buffer', () => {
  /** A sink that accepts writes only when its held callbacks are released. */
  const heldSink = (): { stream: Writable; release: () => void; pending: number } => {
    const callbacks: Array<() => void> = [];
    const stream = new Writable({
      highWaterMark: 16,
      write(_chunk, _encoding, callback) {
        callbacks.push(() => {
          callback();
        });
      },
    });
    return {
      stream,
      release: () => callbacks.shift()?.(),
      get pending() {
        return callbacks.length;
      },
    };
  };

  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('returns immediately while the sink is keeping up', async () => {
    const stream = new Writable({
      highWaterMark: 1024,
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    await expect(appendWithBackpressure(stream, 'short')).resolves.toBeUndefined();
  });

  it('waits for drain instead of queueing when the sink is full', async () => {
    const sink = heldSink();
    let done = false;
    const write = appendWithBackpressure(sink.stream, 'x'.repeat(64)).then(() => {
      done = true;
    });

    await settle();
    expect(done).toBe(false);
    expect(sink.pending).toBe(1);

    sink.release();
    await write;
    expect(done).toBe(true);
  });

  it('keeps the queued bytes bounded, where writing on regardless does not', async () => {
    const slowSink = (): Writable =>
      new Writable({
        highWaterMark: 64,
        write(_chunk, _encoding, callback) {
          setImmediate(callback);
        },
      });
    const block = 'z'.repeat(100);
    const writes = 200;

    const awaited = slowSink();
    let peak = 0;
    for (let i = 0; i < writes; i++) {
      await appendWithBackpressure(awaited, block);
      peak = Math.max(peak, awaited.writableLength);
    }

    /* Never more than one block beyond the stream's own watermark. */
    expect(peak).toBeLessThanOrEqual(64 + block.length);

    /* The same writes with the return value ignored: how the queue grows when
       backpressure is dropped on the floor. */
    const ignored = slowSink();
    for (let i = 0; i < writes; i++) ignored.write(block);
    expect(ignored.writableLength).toBeGreaterThan(peak);
    expect(ignored.writableLength).toBeGreaterThan((writes * block.length) / 2);
  });

  it('rejects when the sink dies, so the caller can stop logging', async () => {
    const stream = new Writable({
      highWaterMark: 16,
      write(_chunk, _encoding, callback) {
        setImmediate(() => {
          callback(new Error('ENOSPC: no space left on device'));
        });
      },
    });

    await expect(appendWithBackpressure(stream, 'x'.repeat(64))).rejects.toThrow('ENOSPC');
  });
});

/* -------------------------------------------------------------------------- */
/* End to end: a command that outprints the budget                            */
/* -------------------------------------------------------------------------- */

const HEAD = 'OFFSTAGE-FIRST-LINE-MARKER';
const TAIL = 'OFFSTAGE-LAST-LINE-MARKER';
/** Comfortably past MAX_CAPTURED_CHARS, and quick for the child to print. */
const FILLER_BLOCKS = 80;
const FILLER_CHARS = FILLER_BLOCKS * (65_536 + 1);

/**
 * A child that prints `HEAD`, ~5 MB of filler, then `trailer`, and fails.
 *
 * The markers travel in `env`, never in argv: the lane echoes the command into
 * `diagnostics`, so a marker spelled out in the script would show up there for
 * reasons that have nothing to do with what the capture retained.
 */
const NOISY_SCRIPT = `
process.stdout.write(process.env.OFFSTAGE_HEAD + '\\n');
const block = 'f'.repeat(65536) + '\\n';
for (let i = 0; i < ${FILLER_BLOCKS}; i++) process.stdout.write(block);
process.stdout.write(process.env.OFFSTAGE_TRAILER);
process.stdout.write(process.env.OFFSTAGE_TAIL + '\\n');
process.exitCode = 1;
`;

describe('a run that prints more than the budget', () => {
  let scratch: string;
  let runCounter = 0;

  beforeAll(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-capture-'));
  });

  afterAll(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  const runNoisy = async (trailer: string): Promise<LaneResult> => {
    const artifactsDir = path.join(scratch, `run-${(runCounter += 1)}`);
    await fs.mkdir(artifactsDir, { recursive: true });
    return headlessLane.run({
      cwd: process.cwd(),
      command: ['node', '-e', NOISY_SCRIPT],
      env: { OFFSTAGE_HEAD: HEAD, OFFSTAGE_TAIL: TAIL, OFFSTAGE_TRAILER: trailer },
      artifactsDir,
      timeoutMs: 120_000,
    });
  };

  describe('with a reporter summary at the very end', () => {
    let result: LaneResult;
    let log: string;

    beforeAll(async () => {
      result = await runNoisy(
        '\n FAIL  tests/huge.test.mjs > the summary a reporter prints last\n' +
          'AssertionError: expected 1 to be 2\n' +
          ' ❯ tests/huge.test.mjs:12:5\n',
      );
      log = await fs.readFile(result.logPath!, 'utf8');
    }, 180_000);

    it('still returns a contract-valid failed result', () => {
      expect(() => parseLaneResult(result)).not.toThrow();
      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(1);
    });

    it('writes every byte to command.log, including the first line', async () => {
      expect(result.logPath).toBe(path.join(result.artifactsDir, COMMAND_LOG_FILENAME));

      const { size } = await fs.stat(result.logPath!);
      expect(size).toBeGreaterThan(FILLER_CHARS);
      expect(size).toBeGreaterThan(MAX_CAPTURED_CHARS);

      /* The head is the half the in-memory view threw away. On disk it is
         still the very first line, and the tail is still the last. */
      expect(log.startsWith(`${HEAD}\n`)).toBe(true);
      expect(log.trimEnd().endsWith(TAIL)).toBe(true);
      expect(Buffer.byteLength(log, 'utf8')).toBe(size);
    });

    it('parses the failure the cap was designed to keep', () => {
      expect(result.failures).toContainEqual({
        test: 'the summary a reporter prints last',
        message: 'AssertionError: expected 1 to be 2',
        file: 'tests/huge.test.mjs',
        line: 12,
      });
    });

    it('says how much it dropped, and that the log on disk is complete', () => {
      const disclosure = result.diagnostics.find((line) => line.includes('budget'));

      expect(disclosure).toBeDefined();
      expect(disclosure).toMatch(/more than the 4,000,000-character budget/);
      /* The budget is a property of the in-memory capture alone. It never
         truncates the file, so the disclosure scopes itself to the capture
         rather than claiming the log is whole: whether the *log* is whole is
         the log sink's question, and it answers it separately below. */
      expect(disclosure).toMatch(/applies to the in-memory capture only/);
      expect(disclosure).toMatch(/is not truncated by it/);

      /* And on this disk it is whole: a sink that dropped or abandoned bytes
         discloses that itself, so the absence of that disclosure is the claim
         'command.log on disk is complete': now made by the component that
         actually knows, instead of asserted unconditionally here. */
      const shortfall = result.diagnostics.find(
        (line) => line.includes('bytes were dropped') || line.includes('still unwritten'),
      );
      expect(shortfall).toBeUndefined();

      const dropped = /oldest ([\d,]+) characters were dropped/.exec(disclosure!);
      expect(dropped).not.toBeNull();
      expect(Number(dropped![1]!.replaceAll(',', ''))).toBe(log.length - MAX_CAPTURED_CHARS);
    });

    it('never leaks the dropped head into the diagnostics', () => {
      expect(result.diagnostics.join('\n')).not.toContain(HEAD);
    });
  });

  describe('with output no reporter recognizes', () => {
    let result: LaneResult;

    beforeAll(async () => {
      result = await runNoisy('nothing here looks like a test reporter\n');
    }, 180_000);

    it('falls back to the tail of the log, which is the end of the run', () => {
      expect(result.failures).toEqual([]);

      const diagnostics = result.diagnostics.join('\n');
      expect(diagnostics).toContain(TAIL);
      expect(diagnostics).not.toContain(HEAD);
      expect(diagnostics).toMatch(/oldest [\d,]+ characters were dropped/);
    });

    it('still has the unrecognized output in full on disk', async () => {
      const log = await fs.readFile(result.logPath!, 'utf8');

      expect(log).toContain(HEAD);
      expect(log).toContain('nothing here looks like a test reporter');
      expect(log).toContain(TAIL);
      expect(log.length).toBeGreaterThan(MAX_CAPTURED_CHARS);
    });
  });

  describe('a run that fits inside the budget', () => {
    it('reports no drop at all', async () => {
      const artifactsDir = path.join(scratch, `run-${(runCounter += 1)}`);
      await fs.mkdir(artifactsDir, { recursive: true });

      const result = await headlessLane.run({
        cwd: process.cwd(),
        command: ['node', '-e', "process.stdout.write('small and complete\\n')"],
        artifactsDir,
        timeoutMs: 60_000,
      });

      expect(result.status).toBe('passed');
      expect(result.diagnostics.join('\n')).not.toMatch(/dropped/);
      expect(await fs.readFile(result.logPath!, 'utf8')).toBe('small and complete\n');
    });
  });
});
