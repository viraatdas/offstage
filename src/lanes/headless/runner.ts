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
 * - **Writing the log can never change the verdict.** A slow disk must not be
 *   able to turn a passing run into a timeout, so this lane never lets the log
 *   file apply backpressure to the command. See {@link LogSink}.
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
 * How much output is retained **in memory** for failure parsing. A runaway
 * command that prints a gigabyte must not take the offstage process down with
 * it. When the cap is hit the oldest output is dropped, because reporters print
 * their failure summaries at the end.
 *
 * This buffer is what the verdict and `failures[]` are computed from, and it is
 * deliberately independent of {@link COMMAND_LOG_FILENAME}: however badly the
 * disk misbehaves, what offstage *concludes* about the code under test is
 * unaffected. See {@link LogSink}.
 */
export const MAX_CAPTURED_CHARS = 4_000_000;

/**
 * How many bytes may sit queued for the log file before this lane stops feeding
 * it. See {@link LogSink} for why the alternative — letting the queue grow, or
 * waiting for it to drain — is worse.
 */
export const MAX_BUFFERED_LOG_BYTES = 8_000_000;

/**
 * Extra time the log may take to reach disk after the command has already
 * finished, on top of the caller's `timeoutMs`. Small on purpose: a caller who
 * asked for an answer within a deadline should get one.
 */
export const LOG_FLUSH_GRACE_MS = 2_000;

/**
 * How long the log may make **no progress at all** before it is abandoned. This
 * is the backstop for a wedged disk when the caller set no `timeoutMs`: a sink
 * that is still draining, however slowly, is allowed to finish.
 */
export const LOG_FLUSH_STALL_MS = 5_000;

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
 * The same flags, found anywhere in a token rather than as the whole of one.
 *
 * Bounded so `--ui` does not match `--uikit` and `--headless=false` is not read
 * out of `--headless=falsey`. `=` is allowed on the left, because
 * `HEADED=--headed` is exactly the shape this needs to catch, and disallowed on
 * the right, where it would mean a different flag. Built from
 * {@link HEADED_FLAGS} so the two can never drift apart.
 */
const HEADED_FLAG_IN_TEXT = new RegExp(
  `(?:^|[^\\w-])(${[...HEADED_FLAGS]
    .map((flag) => flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})(?:$|[^\\w=-])`,
  'i',
);

/** Trim a long token for a message; the whole of a shell script is not useful. */
function shorten(text: string, limit = 120): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

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

    // A whole command can hide inside one token, and a shell can hide the flag
    // inside *that*: `sh -c 'npx playwright test `echo --headed`'`,
    // `H=--headed; npx playwright test $H`, `${HEADED:+--headed}`. Whatever
    // the shell will do with the surrounding syntax, the flag itself is right
    // there in the text, and this lane runs in place — so the text is enough
    // to refuse on. This is the last line before a window opens on a real
    // screen, so it reads the token rather than trying to parse the shell.
    const hidden = HEADED_FLAG_IN_TEXT.exec(arg);
    if (hidden !== null) {
      return `the command includes ${hidden[1]} inside ${JSON.stringify(shorten(arg))}`;
    }

    // `env PWDEBUG=1 npx playwright test` carries the switch as an argv token
    // rather than in `env`, so the check below would never see it.
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(arg.trim());
    if (assignment !== null) {
      const name = (assignment[1] as string).toUpperCase();
      const value = assignment[2] as string;
      if (name === 'PWDEBUG' && value !== '' && value !== '0') {
        return `the command sets ${arg}, which opens the Playwright Inspector window`;
      }
      if (name === 'HEADLESS' && /^(?:0|false|no)$/i.test(value.trim())) {
        return `the command sets ${arg}`;
      }
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
   * may not be running, the session daemon may not be set up. This lane's
   * substrate is the machine offstage is already executing on. If it were
   * unavailable, this method could not have been called. There is nothing to
   * probe, nothing that can fail, and therefore no honest way for it to return
   * `available: false`.
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
    try {
      const stream = createWriteStream(logPath);
      await once(stream, 'open');
      logStream = stream;
    } catch (error) {
      logProblem = `Could not open ${logPath} for writing: ${describeError(error)}`;
    }

    /* Once open, a later write error (a full disk) must not become an unhandled
       'error' event and take the process down; it is reported in diagnostics
       instead, and the run itself still produces a result. */
    const log = new LogSink(logStream, MAX_BUFFERED_LOG_BYTES);

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

    /* This loop is on the command's critical path: every iteration that does
       not return promptly is time the child spends blocked on a full pipe. So
       it awaits nothing but the next chunk — `log.write()` is non-blocking by
       construction. */
    const pump = (async () => {
      const all = subprocess.all;
      if (all === undefined) return;
      for await (const chunk of all) {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        capture.push(text);
        log.write(text);
      }
    })().catch((error: unknown) => {
      logProblem ??= `Capturing output failed: ${describeError(error)}`;
    });

    const [result] = await Promise.all([subprocess, pump]);
    /* The command is done; only the log is still in flight. Give it a bounded
       window to land so a slow disk cannot extend a run past its deadline. */
    await log.close({
      deadline:
        request.timeoutMs === undefined
          ? undefined
          : startedAtMs + request.timeoutMs + LOG_FLUSH_GRACE_MS,
      stallMs: LOG_FLUSH_STALL_MS,
    });
    logProblem ??= log.problem;

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
        `This command printed more than the ${count(MAX_CAPTURED_CHARS)}-character budget offstage keeps in memory for parsing, so the oldest ${count(capture.droppedChars)} characters were dropped from that view and failures[] reflects only the end of the run. This budget applies to the in-memory capture only: ${COMMAND_LOG_FILENAME} on disk is written from the same output and is not truncated by it.`,
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

    /* If the disk could not keep up, say so plainly, and say what it did and
       did not cost. Silently handing back a log with a hole in it would be the
       dishonest option. */
    const shortfall = log.describeShortfall(COMMAND_LOG_FILENAME);
    if (shortfall !== undefined) {
      diagnostics.push(shortfall);
      diagnostics.push(
        `This did not affect the result: ${status} and failures[] were determined from the output held in memory, which is captured before the log is written and is independent of it.`,
      );
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
 * The command log, written so that it can never change the answer.
 *
 * ## Why this is not just `stream.write(text)`
 *
 * The obvious two implementations are both wrong, and both were measured
 * against a 4MB-of-output command whose log was drained at 160 KB/s:
 *
 * - **Await the write** (honour backpressure). The pump stops reading the
 *   child's pipe, the pipe fills, and the child blocks in `write(2)`. A command
 *   that passes in 68ms on a fast disk was killed by its own 20s timeout and
 *   reported `errored` — "the command never finished, so nothing can be
 *   concluded about the code under test". That sentence was false: the code was
 *   fine and the *disk* was slow. For a tool whose whole product is an honest
 *   verdict, this is the worst available failure.
 * - **Fire and forget** (`write()` and ignore the `false`). The child never
 *   blocks, but the unwritten bytes pile up in the stream's internal queue with
 *   no bound — reintroducing exactly the runaway-memory failure that
 *   {@link MAX_CAPTURED_CHARS} exists to prevent — and `run()` then sat in
 *   `end()` flushing them, returning after 24.6s against a 20s deadline.
 *
 * So this sink does neither. It **absorbs** backpressure instead of propagating
 * it: writes are always non-blocking, the queue is capped at
 * {@link MAX_BUFFERED_LOG_BYTES}, and output that arrives while the queue is
 * over that cap is dropped **from the log only** — never from the in-memory
 * capture the verdict is computed from. When the sink catches up, a marker is
 * written at the point of the hole so the gap is visible in the file itself
 * rather than inferred. The result: the log degrades, the verdict does not.
 */
export class LogSink {
  #stream: Writable | undefined;
  #dropping = false;
  #droppedBytes = 0;
  #pendingDropBytes = 0;
  #abandonedBytes = 0;
  #markersWritten = 0;
  #dead = false;

  /** Set when the stream itself reported an error, for `diagnostics`. */
  problem: string | undefined;

  constructor(
    stream: Writable | undefined,
    private readonly limit: number,
  ) {
    this.#stream = stream;
    stream?.on('error', (error: Error) => {
      this.problem ??= `Writing ${COMMAND_LOG_FILENAME} failed: ${error.message}`;
      /* Every subsequent write would queue behind a stream that is never going
         to drain, so stop feeding it. */
      this.#dead = true;
    });
  }

  /**
   * Queue `text` for the log. Returns immediately, always: this runs on the
   * command's critical path.
   */
  write(text: string): void {
    const stream = this.#stream;
    if (stream === undefined || this.#dead) return;

    if (this.#dropping) {
      /* Hysteresis: resume only once the backlog has properly cleared, so a
         queue hovering at the cap does not shred the log into markers. */
      if (stream.writableLength > this.limit / 2) {
        this.#pendingDropBytes += Buffer.byteLength(text);
        return;
      }
      this.#dropping = false;
      this.#droppedBytes += this.#pendingDropBytes;
      const omitted = this.#pendingDropBytes;
      this.#pendingDropBytes = 0;
      this.#writeMarker(stream, omitted);
    } else if (stream.writableLength > this.limit) {
      this.#dropping = true;
      this.#pendingDropBytes += Buffer.byteLength(text);
      return;
    }

    stream.write(text);
  }

  /**
   * Flush what is queued and close, within bounds.
   *
   * Waiting is allowed while the sink is demonstrably making progress — a slow
   * disk that is still draining should be permitted to finish, and truncating
   * a log that is actively being written would be gratuitous. Waiting stops at
   * the caller's `deadline`, or once the queue has not shrunk for `stallMs`,
   * whichever comes first.
   */
  async close(opts: { deadline?: number; stallMs: number }): Promise<void> {
    const stream = this.#stream;
    if (stream === undefined) return;

    /* Output was still being dropped when the command exited, so no resume ever
       wrote the marker. Record the hole now, at the end of the queue — which is
       exactly where it falls — so the file testifies to its own gap instead of
       ending mid-stream with nothing to explain it. */
    if (this.#pendingDropBytes > 0) {
      this.#droppedBytes += this.#pendingDropBytes;
      const omitted = this.#pendingDropBytes;
      this.#pendingDropBytes = 0;
      this.#dropping = false;
      if (!this.#dead) this.#writeMarker(stream, omitted);
    }

    if (!this.#dead) {
      let remaining = stream.writableLength;
      let lastProgressAt = Date.now();
      while (remaining > 0) {
        const now = Date.now();
        if (opts.deadline !== undefined && now >= opts.deadline) break;
        if (now - lastProgressAt >= opts.stallMs) break;
        await delay(FLUSH_POLL_MS);
        const next = stream.writableLength;
        if (next < remaining) lastProgressAt = Date.now();
        remaining = next;
      }
      this.#abandonedBytes = stream.writableLength;
    }

    if (this.#abandonedBytes > 0 || this.#dead) {
      stream.destroy();
      return;
    }
    await new Promise<void>((resolve) => {
      stream.end(() => {
        resolve();
      });
    });
  }

  /** Write the omission marker, and remember that we did. */
  #writeMarker(stream: Writable, omitted: number): void {
    stream.write(
      `\n[offstage] ---- ${omitted} bytes omitted here: the disk could not keep up with this command's output ----\n`,
    );
    this.#markersWritten += 1;
  }

  /**
   * One sentence naming everything that did not reach the log, or `undefined`
   * when the log is complete.
   */
  describeShortfall(filename: string): string | undefined {
    const parts: string[] = [];
    /* Counts drops still pending a resume marker too, so this reads the same
       whether or not `close()` has folded them in yet. */
    const dropped = this.#droppedBytes + this.#pendingDropBytes;
    if (dropped > 0) {
      parts.push(
        `${dropped} bytes were dropped while the command was running, because more than ${this.limit} bytes were already queued and waiting on the disk`,
      );
    }
    if (this.#abandonedBytes > 0) {
      parts.push(
        `${this.#abandonedBytes} bytes were still unwritten when the run ended and were abandoned rather than delay the result any further`,
      );
    }
    if (parts.length === 0) return undefined;
    /* Only claim a marker when one was actually written *and* had room to
       reach disk. Bytes abandoned at close leave no trace — the queue they sat
       in never reached the disk — and saying otherwise would send a reader
       looking for something that is not there. */
    const marked =
      this.#markersWritten > 0 && this.#abandonedBytes === 0
        ? ' The omitted stretches are marked in the file.'
        : '';
    return `${filename} is incomplete: ${parts.join(', and ')}. The disk could not keep up with this command's output.${marked}`;
  }
}

/** How often {@link LogSink.close} samples the queue for progress. */
const FLUSH_POLL_MS = 50;

/**
 * A promise that resolves after `ms`.
 *
 * Deliberately **not** `unref`'d: this timer is what keeps the event loop alive
 * while {@link LogSink.close} waits for the disk, and an unref'd one would let
 * a process whose only remaining work is this flush exit out from under it —
 * losing the log silently and never resolving `run()`. The wait is bounded by
 * the caller's deadline and by {@link LOG_FLUSH_STALL_MS}, so a live timer here
 * cannot hold anything open for long.
 */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
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

/** Best-effort message for anything thrown or returned as an error. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error);
}
