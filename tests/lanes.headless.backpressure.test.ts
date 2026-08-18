/**
 * Backpressure: a slow disk must not be able to change the answer.
 *
 * The headless lane streams the command's output to `command.log` while the
 * command runs. That log sits directly on the command's critical path, so how
 * this lane handles a sink that cannot keep up decides whether offstage tells
 * the truth about the code under test. Measured on the pre-fix implementation,
 * against a command that printed 4MB and exited 0 in 68ms on a fast disk (the
 * fixture here is the same shape at 1MB, which is plenty to wedge a pipe and
 * keeps the suite quick):
 *
 * - awaiting the write (honouring backpressure) blocked the child on a full
 *   pipe and the run was killed by its own 20s timeout — reported `errored`,
 *   "the command never finished", which was false;
 * - firing and forgetting queued ~4MB in memory with no bound and then sat in
 *   `end()`, returning after 24.6s against that same 20s deadline.
 *
 * Against a fully wedged sink the pre-fix implementation was worse still: it
 * never returned from `run()` at all.
 *
 * These tests pin the behaviour that replaced both. The sink is a real FIFO
 * whose reader stops consuming, which is a genuinely wedged disk rather than a
 * mocked one; the {@link LogSink} unit tests below drive the drain rate
 * directly, where a FIFO gives no fine-grained control.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  COMMAND_LOG_FILENAME,
  LogSink,
  MAX_BUFFERED_LOG_BYTES,
  headlessLane,
} from '../src/lanes/headless/index.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'headless');
const NOISY = path.join(FIXTURES, 'noisy.mjs');

/**
 * Deadlines used by the integration tests are deliberately far larger than the
 * behaviour they check. These tests spawn real processes that print a megabyte
 * each, and vitest runs test files in parallel, so a tight bound here measures
 * machine load rather than the lane. The claims still hold decisively: before
 * the fix, a wedged sink made `run()` never return at all.
 */
const GENEROUS_TIMEOUT_MS = 120_000;
const GENEROUS_BOUND_MS = 60_000;

const tempDirs: string[] = [];
const closers: Array<() => void> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * An artifacts dir whose `command.log` is a FIFO that nobody drains: a disk
 * that accepts one pipe buffer's worth of output and then wedges.
 *
 * A reader has to be opened or `createWriteStream` would block forever on the
 * FIFO's open(2); it reads nothing after that.
 */
async function wedgedLogDir(): Promise<string> {
  const dir = await tempDir('offstage-wedged-');
  const logPath = path.join(dir, COMMAND_LOG_FILENAME);
  execFileSync('mkfifo', [logPath]);
  const reader = createReadStream(logPath);
  reader.pause();
  reader.on('error', () => {});
  closers.push(() => reader.destroy());
  return dir;
}

describe('a log sink that cannot keep up', () => {
  /* One wedged run, several claims about it: each of these spawns a real
     process and parks a blocked write in the libuv threadpool, so they are
     worth sharing rather than repeating. */
  it('reports the verdict the command earned, and is honest about the log', async () => {
    const dir = await wedgedLogDir();
    const startedAt = Date.now();

    const result = await headlessLane.run({
      command: [process.execPath, NOISY],
      cwd: FIXTURES,
      artifactsDir: dir,
      timeoutMs: GENEROUS_TIMEOUT_MS,
    });
    const elapsed = Date.now() - startedAt;

    /* The verdict is the whole point: this command exits 0, and no amount of
       disk misbehaviour may turn that into `errored`. */
    expect(result.status).toBe('passed');
    expect(result.exitCode).toBe(0);

    const diagnostics = result.diagnostics.join('\n');
    expect(diagnostics).not.toMatch(/Timed out/);
    expect(diagnostics).toMatch(/command\.log is incomplete/);
    expect(diagnostics).toMatch(/could not keep up/);
    expect(diagnostics).toMatch(/did not affect the result/);

    /* And it must not have burned the caller's deadline getting there. The
       pre-fix implementation never returned from this call at all. */
    expect(elapsed).toBeLessThan(GENEROUS_BOUND_MS);
  });

  it('still returns when the deadline is shorter than the stall window', async () => {
    /* A caller asking for an answer in 1s gets one, wedged disk or not. That
       the deadline specifically — rather than the stall backstop — is what
       stops the wait is pinned deterministically in the LogSink tests below. */
    const dir = await wedgedLogDir();

    const result = await headlessLane.run({
      command: [process.execPath, NOISY],
      cwd: FIXTURES,
      artifactsDir: dir,
      timeoutMs: 1_000,
    });

    expect(result.diagnostics.join('\n')).toMatch(/command\.log is incomplete/);
  });
});

describe('a log sink that keeps up', () => {
  it('is unaffected: the whole log reaches disk', async () => {
    const dir = await tempDir('offstage-fast-');

    const result = await headlessLane.run({
      command: [process.execPath, NOISY],
      cwd: FIXTURES,
      artifactsDir: dir,
      timeoutMs: GENEROUS_TIMEOUT_MS,
    });

    expect(result.status).toBe('passed');
    const log = await fs.readFile(path.join(dir, COMMAND_LOG_FILENAME), 'utf8');
    expect(log).toMatch(/NOISY FIXTURE PASSED/);
    expect(log).not.toMatch(/bytes omitted here/);
    expect(result.diagnostics.join('\n')).not.toMatch(/incomplete/);
  });
});

/* -------------------------------------------------------------------------- */
/* LogSink, driven directly                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A `Writable` that accepts bytes only when told to, so a test can be the disk.
 * `release(n)` completes queued writes totalling at least `n` bytes.
 */
class ManualSink extends Writable {
  written = '';
  #waiting: Array<{ bytes: number; done: () => void }> = [];

  override _write(
    chunk: Buffer | string,
    _enc: BufferEncoding,
    done: (error?: Error | null) => void,
  ): void {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.#waiting.push({
      bytes: Buffer.byteLength(text),
      done: () => {
        this.written += text;
        done();
      },
    });
  }

  /** Complete queued writes until at least `bytes` have been let through. */
  async release(bytes: number): Promise<void> {
    let freed = 0;
    while (freed < bytes && this.#waiting.length > 0) {
      const next = this.#waiting.shift()!;
      freed += next.bytes;
      next.done();
      await new Promise((r) => setImmediate(r));
    }
  }

  get queuedWrites(): number {
    return this.#waiting.length;
  }
}

describe('LogSink', () => {
  it('never blocks the caller, however wedged the sink is', () => {
    const sink = new ManualSink();
    const log = new LogSink(sink, 1_000);

    /* If any of this awaited the disk, the loop would not complete at all. */
    const startedAt = Date.now();
    for (let i = 0; i < 500; i++) log.write('x'.repeat(1_000));

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('stops feeding a backed-up sink instead of queueing without bound', () => {
    const sink = new ManualSink();
    const log = new LogSink(sink, 1_000);

    for (let i = 0; i < 100; i++) log.write('x'.repeat(1_000));

    /* Writes stop once the queue passes the cap, so only the first few chunks
       are ever handed over. */
    expect(sink.writableLength).toBeLessThanOrEqual(3_000);
    expect(log.describeShortfall('command.log')).toMatch(/bytes were dropped/);
  });

  it('marks the gap in the file once the sink catches up', async () => {
    const sink = new ManualSink();
    const log = new LogSink(sink, 1_000);

    log.write('before\n');
    for (let i = 0; i < 50; i++) log.write('x'.repeat(1_000));
    await sink.release(10_000);
    log.write('after\n');
    await sink.release(100_000);

    expect(sink.written).toMatch(/before/);
    expect(sink.written).toMatch(/\[offstage\] ---- \d+ bytes omitted here/);
    expect(sink.written).toMatch(/after/);
  });

  it('records the gap at close when the sink never recovered mid-run', async () => {
    /* The resume marker is written by the next `write()` after the backlog
       clears. A command that floods the sink and then exits never makes that
       call, so without a marker at close the file would just stop, with
       nothing in it to say that anything was missing. */
    const sink = new ManualSink();
    const log = new LogSink(sink, 1_000);

    log.write('start\n');
    for (let i = 0; i < 20; i++) log.write('x'.repeat(1_000));

    /* The sink comes back to life as the run ends, so the queue — marker and
       all — reaches disk. When it does not, the marker is abandoned with
       everything else and the diagnostic stops claiming one: the next test. */
    const drip = setInterval(() => void sink.release(2_000), 20);
    closers.push(() => clearInterval(drip));

    await log.close({ stallMs: 1_000 });

    expect(sink.written).toMatch(/\[offstage\] ---- \d+ bytes omitted here/);
    expect(log.describeShortfall('command.log')).toMatch(/marked in the file/);
  });

  it('does not claim a marker it never wrote', async () => {
    /* Bytes abandoned at close leave no trace in the file, so the diagnostic
       must not send the reader looking for one. */
    const sink = new ManualSink();
    const log = new LogSink(sink, MAX_BUFFERED_LOG_BYTES);
    log.write('x'.repeat(5_000));

    await log.close({ stallMs: 200 });

    const shortfall = log.describeShortfall('command.log');
    expect(shortfall).toMatch(/still unwritten/);
    expect(shortfall).not.toMatch(/marked in the file/);
  });

  it('keeps waiting while the sink is still draining', async () => {
    const sink = new ManualSink();
    const log = new LogSink(sink, MAX_BUFFERED_LOG_BYTES);
    for (let i = 0; i < 5; i++) log.write('x'.repeat(1_000));

    /* Drip-feed slower than the poll interval but faster than the stall window:
       a slow disk that is working must be allowed to finish. */
    const drip = setInterval(() => void sink.release(1_000), 100);
    closers.push(() => clearInterval(drip));

    await log.close({ stallMs: 1_000 });

    expect(sink.written).toBe('x'.repeat(5_000));
    expect(log.describeShortfall('command.log')).toBeUndefined();
  });

  it('gives up on a sink that has stopped making progress', async () => {
    const sink = new ManualSink();
    const log = new LogSink(sink, MAX_BUFFERED_LOG_BYTES);
    for (let i = 0; i < 5; i++) log.write('x'.repeat(1_000));

    const startedAt = Date.now();
    await log.close({ stallMs: 300 });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(log.describeShortfall('command.log')).toMatch(/still unwritten/);
  });

  it('stops at the deadline even while the sink is making progress', async () => {
    const sink = new ManualSink();
    const log = new LogSink(sink, MAX_BUFFERED_LOG_BYTES);
    for (let i = 0; i < 200; i++) log.write('x'.repeat(1_000));

    /* Progress forever, one small chunk at a time: only the deadline can end
       this, and it must. */
    const drip = setInterval(() => void sink.release(1_000), 50);
    closers.push(() => clearInterval(drip));

    const startedAt = Date.now();
    await log.close({ deadline: Date.now() + 400, stallMs: 60_000 });

    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(log.describeShortfall('command.log')).toMatch(/still unwritten/);
  });

  it('reports nothing when there was no shortfall', async () => {
    const sink = new ManualSink();
    const log = new LogSink(sink, MAX_BUFFERED_LOG_BYTES);
    log.write('all of it\n');
    await sink.release(100);
    await log.close({ stallMs: 1_000 });

    expect(log.describeShortfall('command.log')).toBeUndefined();
    expect(sink.written).toBe('all of it\n');
  });

  it('does nothing at all when there is no stream to write to', async () => {
    const log = new LogSink(undefined, MAX_BUFFERED_LOG_BYTES);
    log.write('dropped on the floor');
    await log.close({ stallMs: 10 });
    expect(log.describeShortfall('command.log')).toBeUndefined();
    expect(log.problem).toBeUndefined();
  });
});
