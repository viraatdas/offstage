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
    try {
      const stream = createWriteStream(logPath);
      await once(stream, 'open');
      /* Once open, a later write error (a full disk) must not become an
         unhandled 'error' event and take the process down; it is reported in
         diagnostics instead, and the run itself still produces a result. */
      stream.on('error', (error: Error) => {
        logProblem ??= `Writing ${COMMAND_LOG_FILENAME} failed: ${error.message}`;
      });
      logStream = stream;
    } catch (error) {
      logProblem = `Could not open ${logPath} for writing: ${describeError(error)}`;
    }

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
        logStream?.write(text);
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
 */
class CappedText {
  #chunks: string[] = [];
  #length = 0;
  #dropped = false;

  constructor(private readonly limit: number) {}

  push(chunk: string): void {
    this.#chunks.push(chunk);
    this.#length += chunk.length;
    while (this.#length > this.limit && this.#chunks.length > 1) {
      this.#length -= this.#chunks.shift()!.length;
      this.#dropped = true;
    }
  }

  text(): string {
    const joined = this.#chunks.join('');
    return this.#dropped ? joined.slice(-this.limit) : joined;
  }
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
