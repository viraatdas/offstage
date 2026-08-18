/**
 * The headless lane: run the command exactly where you are, and say so.
 *
 * This lane is the load-bearing half of offstage's thesis. `npx playwright
 * test` opens no window, steals no focus and touches no display — wrapping it
 * in a container would buy nothing and cost container startup on every run. So
 * the headless lane applies **no isolation at all**: it spawns the command as a
 * direct child of the offstage process, in the caller's `cwd`, and normalizes
 * the result into the same envelope the container and VM lanes return.
 *
 * "No isolation" is a claim, not a shrug, so this lane states it explicitly in
 * every result's `diagnostics` rather than leaving the reader to infer it.
 *
 * ## Three things worth knowing about the implementation
 *
 * - **`isAvailable()` can never report unavailable.** Its substrate is the
 *   machine offstage is already running on. See {@link HeadlessLane.isAvailable}.
 * - **`stdin` is ignored, never inherited.** A command that reads stdin would
 *   otherwise hang forever waiting on a terminal nobody is watching — or worse,
 *   consume the keystrokes the user is typing somewhere else.
 * - **An obviously-headed command is refused, not run.** Running
 *   `playwright test --headed` in place would put a window on the user's screen,
 *   which is the one thing offstage exists to prevent. See {@link detectHeadedRequest}.
 */

import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import type { Writable } from 'node:stream';

import { execa } from 'execa';

import type {
  LaneAvailability,
  LaneRequest,
  LaneResult,
  LaneRunner,
  LaneStatus,
} from '../../contract/index.js';
import {
  LaneRequestSchema,
  createLaneResult,
  describeValidationError,
  statusFromExitCode,
} from '../../contract/index.js';
import { artifactPath } from '../../contract/artifacts.js';
import { parseFailures, tailOf } from './parse.js';

/** Name of the combined stdout/stderr log this lane writes into `artifactsDir`. */
export const COMMAND_LOG_FILENAME = 'command.log';

/**
 * How much output is retained **in memory** for failure parsing. The log file
 * itself is never truncated — it is streamed straight to disk — but a runaway
 * command that prints a gigabyte must not take the offstage process down with
 * it. When the cap is hit the oldest output is dropped, because reporters print
 * their failure summaries at the end.
 *
 * The cap is only worth the name if the whole output path is bounded, so three
 * things hold together and are tested as one:
 *
 * 1. **The in-memory bound is hard.** {@link CappedText} retains exactly this
 *    many characters whatever the chunk sizes are — a single chunk larger than
 *    the budget is trimmed on the way in — and it evicts in O(1) amortized
 *    time, so a gigabyte arriving in small pieces costs linear work, not
 *    quadratic.
 * 2. **The on-disk log cannot become the leak instead.** Writes to
 *    `command.log` honor backpressure: when the disk is slower than the
 *    command, {@link HeadlessLane.run} stops reading the child rather than
 *    queueing the overflow in the write stream's unbounded internal buffer.
 *    The command is throttled; nothing is dropped.
 * 3. **Dropping is disclosed.** When output is discarded, the result says how
 *    much was lost and that `command.log` on disk is still complete, so a
 *    reader never mistakes a partial parse for the whole run.
 */
export const MAX_CAPTURED_CHARS = 4_000_000;

/* -------------------------------------------------------------------------- */
/* The headed-command guard                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Flags that mean "put a window on the screen". Kept deliberately short and
 * unambiguous: a false positive here refuses a legitimate run, so only flags
 * whose entire purpose is to open a UI belong in this set.
 */
const HEADED_FLAGS = new Set([
  '--headed',
  '--headful',
  '--no-headless',
  '--headless=false',
  '--headless=0',
  '--ui',
]);

/**
 * Decide whether a request would open a window if run in place.
 *
 * This lane's whole premise is that the command is already headless. When the
 * request says otherwise in so many words, running it anyway would defeat the
 * point of the product — so `run()` returns `errored` and points at the
 * container lane instead. The router should never produce such a request; this
 * is the backstop for when something else does.
 *
 * @returns a human-readable reason, or `null` when nothing headed was found.
 */
export function detectHeadedRequest(req: Pick<LaneRequest, 'command' | 'env'>): string | null {
  for (const arg of req.command) {
    if (HEADED_FLAGS.has(arg.trim().toLowerCase())) {
      return `the command includes ${arg}`;
    }
  }

  const env = req.env ?? {};
  const pwdebug = env['PWDEBUG'];
  if (pwdebug !== undefined && pwdebug !== '' && pwdebug !== '0') {
    return `the environment sets PWDEBUG=${pwdebug}, which opens the Playwright Inspector window`;
  }
  const headless = env['HEADLESS'];
  if (headless !== undefined && /^(?:0|false|no)$/i.test(headless.trim())) {
    return `the environment sets HEADLESS=${headless}`;
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* The lane                                                                   */
/* -------------------------------------------------------------------------- */

export class HeadlessLane implements LaneRunner {
  readonly lane = 'headless' as const;

  /**
   * Always available — and that is a fact about this lane, not an optimism.
   *
   * The other two lanes probe something that can genuinely be missing: Docker
   * may not be running, Tart may not be installed. This lane's substrate is the
   * machine offstage is already executing on. If it were unavailable, this
   * method could not have been called. There is nothing to probe, nothing that
   * can fail, and therefore no honest way for it to return `available: false`.
   *
   * Never throws and never mutates anything, per the contract.
   */
  async isAvailable(): Promise<LaneAvailability> {
    return { available: true };
  }

  /**
   * Run the command in place and normalize the outcome.
   *
   * Never throws: every failure mode — an invalid request, an unwritable
   * artifacts directory, a command that does not exist, a timeout — comes back
   * as a contract-valid {@link LaneResult}.
   */
  async run(req: LaneRequest): Promise<LaneResult> {
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    /* Resolved up front so that even a request too malformed to run still
       yields a *valid* envelope; `artifactsDir` is the one field a LaneResult
       cannot do without. */
    const artifactsDir = path.resolve(req?.artifactsDir ?? process.cwd());

    const errored = (diagnostics: string[]): LaneResult =>
      createLaneResult({
        lane: this.lane,
        status: 'errored',
        artifactsDir,
        startedAt,
        durationMs: Date.now() - startedAtMs,
        diagnostics,
      });

    const parsed = LaneRequestSchema.safeParse(req);
    if (!parsed.success) {
      return errored([
        'The request does not satisfy the offstage lane contract, so nothing was executed.',
        ...describeValidationError(parsed.error),
      ]);
    }
    const request = parsed.data;

    const headed = detectHeadedRequest(request);
    if (headed !== null) {
      return errored([
        `Refused to run: ${headed}, so running it here would open a window on your screen.`,
        'The headless lane applies no isolation — it runs commands in place — so it only accepts commands that are already headless.',
        'Route headed browser work to the container lane, which renders to an Xvfb virtual framebuffer that never touches your display.',
        `Command: ${request.command.join(' ')}`,
      ]);
    }

    try {
      await fs.mkdir(request.artifactsDir, { recursive: true });
    } catch (error) {
      return errored([
        `Could not create the artifacts directory ${request.artifactsDir}, so nothing was executed.`,
        describeError(error),
      ]);
    }

    const logPath = artifactPath(request.artifactsDir, COMMAND_LOG_FILENAME);
    let logStream: Writable | undefined;
    let logProblem: string | undefined;
    let logUsable = false;
    try {
      const stream = createWriteStream(logPath);
      await once(stream, 'open');
      /* Once open, a later write error (a full disk) must not become an
         unhandled 'error' event and take the process down; it is reported in
         diagnostics instead, and the run itself still produces a result. */
      stream.on('error', (error: Error) => {
        logProblem ??= `Writing ${COMMAND_LOG_FILENAME} failed: ${error.message}`;
        logUsable = false;
      });
      logStream = stream;
      logUsable = true;
    } catch (error) {
      logProblem = `Could not open ${logPath} for writing: ${describeError(error)}`;
    }

    /**
     * Append to `command.log`, waiting for the stream to drain when it asks to.
     *
     * `write()` returning false means the bytes are sitting in the stream's
     * *unbounded* in-memory queue. Ignoring that would make a gigabyte of
     * output cost a gigabyte of heap — the exact blow-up
     * {@link MAX_CAPTURED_CHARS} exists to prevent, arriving through the file
     * rather than through the capture. Waiting stops us reading the child, the
     * pipe fills, and the command itself is throttled: the log stays complete
     * and memory stays bounded. A dead stream is reported once and then
     * skipped, so a full disk costs the log, never the run.
     */
    const writeToLog = async (text: string): Promise<void> => {
      if (logStream === undefined || !logUsable) return;
      try {
        await appendWithBackpressure(logStream, text);
      } catch (error) {
        logUsable = false;
        logProblem ??= `Writing ${COMMAND_LOG_FILENAME} failed: ${describeError(error)}`;
      }
    };

    const capture = new CappedText(MAX_CAPTURED_CHARS);
    const [file, ...args] = request.command as [string, ...string[]];

    const subprocess = execa(file, args, {
      cwd: request.cwd,
      env: request.env,
      /* Layer request.env over the ambient environment rather than replacing
         it: a test command needs PATH, HOME and the rest to work at all. */
      extendEnv: true,
      ...(request.timeoutMs === undefined ? {} : { timeout: request.timeoutMs }),
      /* Nothing is piped in. See the module header. */
      stdin: 'ignore',
      /* `all` interleaves stdout and stderr the way a terminal would, so
         command.log reads like what you would have seen. `buffer: false` hands
         us the stream instead of accumulating it, so the log is written while
         the command runs and is tail-able mid-run. */
      all: true,
      buffer: false,
      encoding: 'utf8',
      /* A non-zero exit is a *result* here, not an exception. */
      reject: false,
    });

    const pump = (async () => {
      const all = subprocess.all;
      if (all === undefined) return;
      for await (const chunk of all) {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        capture.push(text);
        await writeToLog(text);
      }
    })().catch((error: unknown) => {
      logProblem ??= `Capturing output failed: ${describeError(error)}`;
    });

    const [result] = await Promise.all([subprocess, pump]);
    await closeStream(logStream);

    const durationMs = Date.now() - startedAtMs;
    const output = capture.text();
    const exitCode = typeof result.exitCode === 'number' ? result.exitCode : null;
    const status: LaneStatus = statusFromExitCode(exitCode);

    const diagnostics = [
      `No isolation was applied. This command is already headless, so the headless lane ran it in place in ${request.cwd}, as a direct child of the offstage process — no container was started and no virtual machine was booted.`,
      'Nothing appeared on your screen: no window was opened, no display was attached, and your keyboard focus was never taken.',
      `Command: ${request.command.join(' ')}`,
    ];
    if (request.env !== undefined && Object.keys(request.env).length > 0) {
      diagnostics.push(
        `Environment overrides layered on the ambient environment: ${Object.keys(request.env).sort().join(', ')}.`,
      );
    }
    if (capture.droppedChars > 0) {
      diagnostics.push(
        `This command printed more than the ${count(MAX_CAPTURED_CHARS)}-character budget offstage keeps in memory for parsing, so the oldest ${count(capture.droppedChars)} characters were dropped from that view and failures[] reflects only the end of the run. ${COMMAND_LOG_FILENAME} on disk is complete: nothing was truncated there.`,
      );
    }

    const failures =
      status === 'failed' ? parseFailures(output, { cwd: request.cwd }) : [];

    if (result.timedOut) {
      diagnostics.push(
        `Timed out after ${request.timeoutMs}ms and was terminated${
          result.signal === undefined ? '' : ` with ${result.signal}`
        }. A timeout is reported as "errored", not "failed": the command never finished, so nothing can be concluded about the code under test.`,
      );
    } else if (exitCode === null && result.signal !== undefined) {
      diagnostics.push(
        `Terminated by ${result.signal} before it could exit, so there is no exit code to interpret.`,
      );
    } else if (exitCode === null) {
      diagnostics.push(
        `The command could not be started: ${result.message ?? describeError(result)}`,
      );
      diagnostics.push(
        `Check that "${file}" exists and is executable from ${request.cwd}.`,
      );
    }

    if (status === 'failed' && failures.length === 0) {
      diagnostics.push(
        `Exited ${exitCode}. No output matched a reporter this lane recognizes (Playwright, Vitest, Jest), so failures[] is empty and the tail of ${COMMAND_LOG_FILENAME} follows verbatim.`,
      );
      const tail = tailOf(output);
      if (tail !== '') diagnostics.push(tail);
    }

    if (logProblem !== undefined) diagnostics.push(logProblem);

    /* The log file exists whenever the stream opened, even for a command that
       never started — in which case it is empty, which is itself informative. */
    const wroteLog = logStream !== undefined;

    return createLaneResult({
      lane: this.lane,
      status,
      exitCode,
      startedAt,
      durationMs,
      artifactsDir: request.artifactsDir,
      logPath: wroteLog ? logPath : null,
      artifacts: wroteLog ? [{ kind: 'log', path: logPath }] : [],
      failures,
      diagnostics,
    });
  }
}

/** The lane instance callers should use; it holds no state. */
export const headlessLane = new HeadlessLane();

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A bounded FIFO of text. Keeps at most `limit` characters, discarding from the
 * front — reporters print their failure summary last, so the end is the half
 * worth keeping.
 *
 * Both of its properties are load-bearing for {@link MAX_CAPTURED_CHARS}, and
 * neither is free:
 *
 * - **The bound is exact, whatever the chunk sizes are.** Eviction trims
 *   *inside* the oldest chunk instead of only at chunk boundaries, and a single
 *   chunk larger than the whole budget is trimmed on the way in. Retention is
 *   `limit` characters, not "`limit` rounded up to the pipe buffer" and not
 *   "one chunk, however big it happened to be".
 * - **Eviction is O(1) amortized.** Released slots are dropped by advancing a
 *   head index and compacting occasionally, never by `shift()`ing the whole
 *   array on every write. Output arrives in pieces as small as a single line,
 *   so a gigabyte can be millions of pushes; shifting each time is quadratic,
 *   which would hang the process on exactly the runaway command this cap is
 *   here to survive.
 *
 * Exported so the cap can be tested directly against both properties. It is an
 * implementation detail of this lane, not part of the offstage contract.
 */
export class CappedText {
  #chunks: string[] = [];
  /** Index of the oldest live chunk; slots before it have been released. */
  #head = 0;
  /** Characters currently retained: always `<= limit`. */
  #length = 0;
  #dropped = 0;

  constructor(private readonly limit: number) {}

  /** How many characters were discarded to stay under the cap. */
  get droppedChars(): number {
    return this.#dropped;
  }

  push(chunk: string): void {
    if (chunk === '') return;

    if (chunk.length >= this.limit) {
      /* Bigger than the entire budget on its own: keep only its tail, and let
         everything older go with it. */
      this.#dropped += this.#length + (chunk.length - this.limit);
      this.#chunks = [chunk.slice(chunk.length - this.limit)];
      this.#head = 0;
      this.#length = this.limit;
      return;
    }

    this.#chunks.push(chunk);
    this.#length += chunk.length;

    while (this.#length > this.limit) {
      const oldest = this.#chunks[this.#head]!;
      const excess = this.#length - this.limit;
      if (oldest.length > excess) {
        this.#chunks[this.#head] = oldest.slice(excess);
        this.#length -= excess;
        this.#dropped += excess;
      } else {
        this.#chunks[this.#head] = '';
        this.#head += 1;
        this.#length -= oldest.length;
        this.#dropped += oldest.length;
      }
    }

    /* Compact once the released prefix is at least half the array: that makes
       the amortized cost of a push constant, however many arrive. */
    if (this.#head >= 32 && this.#head * 2 >= this.#chunks.length) {
      this.#chunks = this.#chunks.slice(this.#head);
      this.#head = 0;
    }
  }

  text(): string {
    return (this.#head === 0 ? this.#chunks : this.#chunks.slice(this.#head)).join('');
  }
}

/**
 * Append to a stream, waiting for it to drain when it says it is full.
 *
 * `Writable.write()` returning `false` does not mean the write failed — it
 * means the bytes are now sitting in the stream's internal queue, which has no
 * upper bound. Writing on regardless turns a slow sink into unbounded heap
 * growth proportional to the *whole* output, which is precisely the failure
 * {@link MAX_CAPTURED_CHARS} is meant to rule out; it would simply arrive
 * through `command.log` instead of through the capture. Awaiting `drain`
 * instead stops the caller reading the child, the pipe fills, and the command
 * is throttled by the disk: complete log, bounded memory.
 *
 * @throws whatever the stream emits as `'error'` while we are waiting, so the
 *         caller can stop logging rather than wait on a stream that is gone.
 */
export async function appendWithBackpressure(stream: Writable, text: string): Promise<void> {
  if (stream.write(text)) return;
  await once(stream, 'drain');
}

/** Digit-grouped for diagnostics a human reads: `4000000` -> `4,000,000`. */
function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** Flush and close the log stream, resolving even if the close reports an error. */
async function closeStream(stream: Writable | undefined): Promise<void> {
  if (stream === undefined) return;
  await new Promise<void>((resolve) => {
    stream.end(() => {
      resolve();
    });
  });
}

/** Best-effort message for anything thrown or returned as an error. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}
