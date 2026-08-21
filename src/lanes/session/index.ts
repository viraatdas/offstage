/**
 * The session lane: run it in the other account's screen, not yours.
 *
 * macOS cannot have an Xvfb, but it can have a second logged-in GUI session.
 * This lane drives one: a helper account (default `computeruse`) that is logged
 * in and sitting in the background with its own window server connection, its
 * own framebuffer and its own HID stream. `offstage-sessiond` runs inside that
 * session as a LaunchAgent; this lane connects to its unix socket and asks it
 * to spawn the command. Windows open there. Nothing reaches the console user's
 * display, and nothing takes their keyboard focus.
 *
 * Read `docs/session-lane.md` for the substrate; three things about *this file*
 * are worth stating up front:
 *
 * - **It is session isolation, not machine isolation.** Same kernel, same disk,
 *   same everything except the display and the input stream. Every result says
 *   so in `diagnostics`, because a reader who mistakes it for a VM would draw
 *   exactly the wrong conclusion about what an installer just did to them.
 * - **The helper account is a different uid, so the filesystem is a real
 *   constraint.** `~` is `0750`; the helper account cannot read a repository
 *   until `offstage session share` grants it. The lane checks *through the
 *   daemon* (so ACLs and the daemon's real uid are what answer) and returns
 *   `errored` with the exact `share` command rather than a spawn failure the
 *   user has to decode.
 * - **It never falls back to your screen.** Every rung of `isAvailable()` that
 *   fails produces `skipped` with a fix; every mid-run failure produces
 *   `errored`. There is no path through this file that runs a headed command on
 *   the console session.
 */

import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import type { Writable } from 'node:stream';

import type {
  LaneAvailability,
  LaneArtifact,
  LaneRequest,
  LaneResult,
  LaneRunner,
} from '../../contract/index.js';
import {
  LaneRequestSchema,
  createLaneResult,
  describeValidationError,
  skippedResult,
  statusFromExitCode,
} from '../../contract/index.js';
import { artifactPath } from '../../contract/artifacts.js';
import {
  CappedText,
  COMMAND_LOG_FILENAME,
  LogSink,
  MAX_BUFFERED_LOG_BYTES,
  MAX_CAPTURED_CHARS,
  LOG_FLUSH_GRACE_MS,
  LOG_FLUSH_STALL_MS,
} from '../headless/runner.js';
import { parseFailures, tailOf } from '../headless/parse.js';

import type {
  DescribeSessionOptions,
  Exec,
  SessionClient,
  SessionClientFactory,
  SessionDiscovery,
  SessionHello,
} from '../../session/index.js';
import {
  DEFAULT_SOCKET_DIR,
  SessionRpcError,
  SessionUnreachableError,
  createSessionClient,
  defaultExec,
  describeSession,
  grantArtifactsWrite,
  sessionUserFullName,
} from '../../session/index.js';

/** Screenshot of the helper session's display, taken after the command exits. */
export const SCREENSHOT_FILENAME = 'screen.png';

/** The sentence every session result carries, because the distinction matters. */
export const ISOLATION_NOTE =
  'This is session isolation, not a VM: the same machine, the same OS and the same disk, with a different display and a different input stream. Use --lane vm for anything that could change the machine (installers, .dmg/.pkg).';

/** `offstage session setup` — the fix for every "the daemon is not there" rung. */
export const SETUP_FIX = 'offstage session setup';

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

export interface SessionLaneOptions {
  /** Helper account. Defaults to the configured one (env → config → default). */
  user?: string;
  /** Socket directory. Defaults to `/tmp/offstage-session`. */
  socketDir?: string;
  /** Discovery seam, so tests never touch `ioreg`/`dscl`. */
  discover?: (options: DescribeSessionOptions) => Promise<SessionDiscovery>;
  /** Client seam, so tests never need a daemon. */
  createClient?: SessionClientFactory;
  /** Exec seam for the `chmod +a` on the artifacts directory. */
  exec?: Exec;
  /** Clock seam. */
  now?: () => number;
}

/* -------------------------------------------------------------------------- */
/* Probe                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Everything `isAvailable()` learned, not just its verdict.
 *
 * `LaneAvailability` is three fields wide by contract, and there is genuinely
 * more worth saying here — which session id answered, what the display is,
 * which TCC grants are missing. Rather than smuggle that into `reason`, the
 * probe returns it separately and `run()` puts it in `diagnostics`.
 */
export interface SessionProbe {
  availability: LaneAvailability;
  discovery: SessionDiscovery;
  hello: SessionHello | null;
  /** Notes worth showing even when the lane is available (missing TCC grants). */
  notes: string[];
}

/* -------------------------------------------------------------------------- */
/* The lane                                                                   */
/* -------------------------------------------------------------------------- */

export class SessionLane implements LaneRunner {
  readonly lane = 'session' as const;

  readonly #options: SessionLaneOptions;

  constructor(options: SessionLaneOptions = {}) {
    this.#options = options;
  }

  get #discover(): (options: DescribeSessionOptions) => Promise<SessionDiscovery> {
    return this.#options.discover ?? describeSession;
  }

  get #createClient(): SessionClientFactory {
    return this.#options.createClient ?? createSessionClient;
  }

  get #exec(): Exec {
    return this.#options.exec ?? defaultExec;
  }

  get #now(): () => number {
    return this.#options.now ?? Date.now;
  }

  /**
   * Walk the ladder from `docs/session-lane.md`, stopping at the first rung
   * that fails. Never throws: a discovery that explodes is reported as
   * unavailable with the exception's own message, because a lane that throws
   * out of `isAvailable()` breaks `offstage doctor` for every other lane too.
   */
  async isAvailable(): Promise<LaneAvailability> {
    return (await this.probeSession()).availability;
  }

  /**
   * {@link isAvailable}, plus everything it learned on the way. Never throws.
   *
   * Named `probeSession` rather than `probe` on purpose: `offstage doctor`
   * duck-types a `probe()` method as the *container* runtime probe, and a
   * session probe answering that call would be rendered as nonsense.
   */
  async probeSession(): Promise<SessionProbe> {
    const socketDir = this.#options.socketDir ?? DEFAULT_SOCKET_DIR;

    let discovery: SessionDiscovery;
    try {
      const options: DescribeSessionOptions = { socketDir };
      if (this.#options.user !== undefined) options.user = this.#options.user;
      if (this.#options.exec !== undefined) options.exec = this.#options.exec;
      discovery = await this.#discover(options);
    } catch (error) {
      return {
        availability: {
          available: false,
          reason: `Could not inspect the macOS login sessions on this machine: ${describeError(error)}`,
          fix: SETUP_FIX,
        },
        discovery: unknownDiscovery(this.#options.user ?? 'computeruse', socketDir),
        hello: null,
        notes: [],
      };
    }

    const unavailable = (reason: string, fix?: string): SessionProbe => ({
      availability: fix === undefined ? { available: false, reason } : { available: false, reason, fix },
      discovery,
      hello: null,
      notes: [],
    });

    /* 1. macOS only. There is no second GUI session to borrow anywhere else. */
    if (discovery.platform !== 'darwin') {
      return unavailable(
        `The session lane is macOS-only; this host is ${discovery.platform}. It works by logging a second macOS account into its own GUI session, which has no equivalent on this platform.`,
        'Run headed browser work on the container lane, which uses an Xvfb virtual framebuffer.',
      );
    }

    /* 2. The account has to exist before it can be logged in. */
    if (!discovery.accountExists) {
      return unavailable(
        `There is no "${discovery.user}" account on this Mac, so there is no second session to run in.`,
        'offstage session setup --create',
      );
    }

    /* 3. It has to be logged in — a login window is not a session. */
    if (!discovery.guiSession.exists || !discovery.guiSession.loginDone) {
      const shown = sessionUserFullName(discovery);
      return unavailable(
        `The "${discovery.user}" account exists but has no logged-in GUI session, so there is no framebuffer to render into.`,
        `Log ${discovery.user} in once with fast user switching (user menu → ${shown}), then switch back; the session keeps running in the background.`,
      );
    }

    /* 4. If it is the session on the screen, running there *is* running on
          your screen. Refusing is the entire point of this product. */
    if (discovery.guiSession.onConsole) {
      return unavailable(
        `The "${discovery.user}" session is currently the one on your screen, so running there would put windows in front of you.`,
        'Switch back to your own account (user menu); the helper session keeps running in the background and the lane becomes available again.',
      );
    }

    /* 5. The daemon has to answer. The socket file existing is not proof, but
          its absence is proof of the opposite and gives a better message. */
    if (!discovery.socketPresent) {
      return unavailable(
        `The offstage session daemon is not listening: there is no socket at ${discovery.socketPath}.`,
        SETUP_FIX,
      );
    }

    let hello: SessionHello;
    try {
      hello = await this.#createClient({ socketPath: discovery.socketPath }).hello();
    } catch (error) {
      return unavailable(
        `The offstage session daemon did not answer on ${discovery.socketPath}: ${describeError(error)}`,
        SETUP_FIX,
      );
    }

    /* 6. TCC grants are reported, not required: a run that never captures the
          screen or injects a key works without either, and screenshot/input
          enforce their own. */
    const notes: string[] = [];
    const missing: string[] = [];
    if (!hello.permissions.screenCapture) missing.push('Screen Recording');
    if (!hello.permissions.accessibility) missing.push('Accessibility');
    if (missing.length > 0) {
      notes.push(
        `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not granted to offstage-sessiond inside the "${discovery.user}" session, so ${
          missing.length === 1 && missing[0] === 'Accessibility'
            ? 'input injection will fail'
            : missing.length === 1
              ? 'screenshots will fail'
              : 'screenshots and input injection will fail'
        }. Commands still run. Fix: switch to the ${discovery.user} account once and allow ${missing.join(' and ')} for offstage-sessiond in System Settings → Privacy & Security, then switch back.`,
      );
    }

    return { availability: { available: true }, discovery, hello, notes };
  }

  /**
   * Run the command inside the helper session.
   *
   * Never throws. Unreadable `cwd`, an ACL that will not apply, a daemon that
   * dies mid-run, a timeout — each comes back as a contract-valid
   * {@link LaneResult} with `status: 'errored'` and the fix in `diagnostics`.
   */
  async run(req: LaneRequest): Promise<LaneResult> {
    const now = this.#now;
    const startedAtMs = now();
    const startedAt = new Date(startedAtMs).toISOString();
    /* The log's flush deadline is about the disk, not about the run's reported
       timeline, so it is measured on the real clock even when `now` is
       injected — otherwise a test clock pinned to a fixed instant would make
       every flush look overdue and truncate the log. */
    const wallStartedAtMs = Date.now();
    const artifactsDir = path.resolve(req?.artifactsDir ?? process.cwd());

    const errored = (diagnostics: string[], artifacts: LaneArtifact[] = []): LaneResult =>
      createLaneResult({
        lane: this.lane,
        status: 'errored',
        artifactsDir,
        startedAt,
        durationMs: now() - startedAtMs,
        artifacts,
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

    /* 1. Availability. Nothing runs anywhere if the session is not there. */
    const probe = await this.probeSession();
    if (!probe.availability.available) {
      return skippedResult(this.lane, request.artifactsDir, probe.availability);
    }
    const { discovery } = probe;
    const client = this.#createClient({ socketPath: discovery.socketPath });

    const shareFix = `offstage session share ${request.cwd}`;

    /* 2. Can the helper account read the repository? It is a different uid and
          your home is 0750, so this is the common first failure — and a spawn
          error two steps later would be a much worse way to learn it. */
    try {
      const access = await client.access(request.cwd);
      if (!access.exists) {
        return errored([
          `The "${discovery.user}" account cannot see ${request.cwd}: the daemon reports it does not exist from inside that session.`,
          ISOLATION_NOTE,
        ]);
      }
      if (!access.readable) {
        return errored([
          `The "${discovery.user}" account cannot read ${request.cwd}, so the command was not started. Your home directory is 0750, and the helper account is a different uid.`,
          `Fix: ${shareFix}`,
          'That grants a read-only ACL on that tree and traverse-only on its parents. It never grants write: everything a run writes goes to $OFFSTAGE_ARTIFACTS.',
          ISOLATION_NOTE,
        ]);
      }
    } catch (error) {
      return errored([
        `Could not ask the offstage session daemon whether ${request.cwd} is readable: ${describeError(error)}`,
        `Fix: ${SETUP_FIX}`,
        ISOLATION_NOTE,
      ]);
    }

    /* 3. Open this run's artifacts directory — and only it — to the helper
          account, so the command has somewhere to write. */
    const grant = await grantArtifactsWrite({
      dir: request.artifactsDir,
      user: discovery.user,
      exec: this.#exec,
    });
    if (!grant.ok) {
      return errored([
        `Could not grant the "${discovery.user}" account write access to ${request.artifactsDir}, so the command was not started: it would have had nowhere to write its output.`,
        ...grant.failures.map((failure) => `${failure.command} exited ${failure.exitCode ?? 'null'}: ${failure.stderr}`),
        ISOLATION_NOTE,
      ]);
    }

    /* 4. Run it, streaming output into command.log as it arrives. */
    await fs.mkdir(request.artifactsDir, { recursive: true }).catch(() => undefined);
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
    const log = new LogSink(logStream, MAX_BUFFERED_LOG_BYTES);
    const capture = new CappedText(MAX_CAPTURED_CHARS);

    const env: Record<string, string> = { ...(request.env ?? {}) };
    delete env['DISPLAY'];
    env['OFFSTAGE_ARTIFACTS'] = request.artifactsDir;
    env['OFFSTAGE_LANE'] = 'session';

    const runRequest: Parameters<SessionClient['run']>[0] = {
      argv: request.command,
      cwd: request.cwd,
      env,
      onOutput: (chunk) => {
        const text = chunk.toString('utf8');
        capture.push(text);
        log.write(text);
      },
    };
    if (request.timeoutMs !== undefined) runRequest.timeoutMs = request.timeoutMs;

    let outcome: Awaited<ReturnType<SessionClient['run']>> | null = null;
    let runFailure: unknown;
    try {
      outcome = await client.run(runRequest);
    } catch (error) {
      runFailure = error;
    }

    await log.close({
      deadline:
        request.timeoutMs === undefined
          ? undefined
          : wallStartedAtMs + request.timeoutMs + LOG_FLUSH_GRACE_MS,
      stallMs: LOG_FLUSH_STALL_MS,
    });
    logProblem ??= log.problem;

    const artifacts: LaneArtifact[] = logStream === undefined ? [] : [{ kind: 'log', path: logPath }];
    const sessionLine = `Ran as "${discovery.user}" (uid ${discovery.uid ?? 'unknown'}) in that account's own background GUI session${
      discovery.guiSession.sessionId === null ? '' : ` (session id ${discovery.guiSession.sessionId})`
    } — its window server, its framebuffer, its input stream. Nothing was drawn on your screen and your keyboard focus was never taken.`;

    if (outcome === null) {
      /* The daemon went away mid-run, or refused the request outright. Either
         way nothing can be concluded about the code under test. */
      const diagnostics = [
        describeRunFailure(runFailure, discovery.user, request.cwd, shareFix),
        sessionLine,
        `Command: ${request.command.join(' ')}`,
        ISOLATION_NOTE,
      ];
      if (logProblem !== undefined) diagnostics.push(logProblem);
      return createLaneResult({
        lane: this.lane,
        status: 'errored',
        artifactsDir: request.artifactsDir,
        startedAt,
        durationMs: now() - startedAtMs,
        logPath: logStream === undefined ? null : logPath,
        artifacts,
        diagnostics,
      });
    }

    /* 5. A screenshot of what the session looked like when it finished. Best
          effort by design: a missing TCC grant is a diagnostic, never an error
          — the command already ran, and its verdict does not depend on this. */
    const screenshotNotes: string[] = [];
    try {
      const shot = await client.screenshot();
      const target = artifactPath(request.artifactsDir, SCREENSHOT_FILENAME);
      await fs.writeFile(target, shot.png);
      artifacts.push({ kind: 'screenshot', path: target });
      screenshotNotes.push(
        `Captured the helper session's display to ${SCREENSHOT_FILENAME} (${shot.width}×${shot.height} px at scale ${shot.scale}) after the command exited. That is the other account's screen, not yours.`,
      );
    } catch (error) {
      screenshotNotes.push(describeScreenshotFailure(error, discovery.user));
    }

    const output = capture.text();
    const timedOut = outcome.timedOut;
    const exitCode = outcome.exitCode;
    const status = timedOut ? 'errored' : statusFromExitCode(exitCode);
    const failures = status === 'failed' ? parseFailures(output, { cwd: request.cwd }) : [];

    const diagnostics = [sessionLine, `Command: ${request.command.join(' ')}`];
    diagnostics.push(
      `The command's environment was the daemon's own session environment plus OFFSTAGE_ARTIFACTS=${request.artifactsDir} and OFFSTAGE_LANE=session; DISPLAY was removed, and HOME/USER/TMPDIR are the "${discovery.user}" account's own.`,
    );
    if (probe.notes.length > 0) diagnostics.push(...probe.notes);

    if (timedOut) {
      diagnostics.push(
        `Timed out after ${request.timeoutMs}ms and was terminated inside the helper session${
          outcome.signal === null ? '' : ` with ${outcome.signal}`
        }. A timeout is "errored", not "failed": the command never finished, so nothing can be concluded about the code under test.`,
      );
    } else if (exitCode === null) {
      diagnostics.push(
        `The command was terminated by ${outcome.signal ?? 'a signal'} before it could exit, so there is no exit code to interpret.`,
      );
    }

    if (capture.droppedChars > 0) {
      diagnostics.push(
        `This command printed more than the ${MAX_CAPTURED_CHARS.toLocaleString('en-US')}-character budget offstage keeps in memory for parsing, so the oldest ${capture.droppedChars.toLocaleString('en-US')} characters were dropped from that view and failures[] reflects only the end of the run.`,
      );
    }

    if (status === 'failed' && failures.length === 0) {
      diagnostics.push(
        `Exited ${exitCode}. No output matched a reporter this lane recognizes (Playwright, Vitest, Jest), so failures[] is empty and the tail of ${COMMAND_LOG_FILENAME} follows verbatim.`,
      );
      const tail = tailOf(output);
      if (tail !== '') diagnostics.push(tail);
    }

    diagnostics.push(...screenshotNotes);

    const shortfall = log.describeShortfall(COMMAND_LOG_FILENAME);
    if (shortfall !== undefined) {
      diagnostics.push(shortfall);
      diagnostics.push(
        `This did not affect the result: ${status} and failures[] were determined from the output held in memory, which is captured before the log is written and is independent of it.`,
      );
    }
    if (logProblem !== undefined) diagnostics.push(logProblem);
    diagnostics.push(ISOLATION_NOTE);

    return createLaneResult({
      lane: this.lane,
      status,
      exitCode: timedOut ? null : exitCode,
      startedAt,
      durationMs: now() - startedAtMs,
      artifactsDir: request.artifactsDir,
      logPath: logStream === undefined ? null : logPath,
      artifacts,
      failures,
      diagnostics,
    });
  }
}

/**
 * Render a {@link SessionProbe} as the lines `offstage doctor` prints under the
 * lane, the way `describeRuntimeProbe` does for the container runtime.
 *
 * The heading is unindented and every fact under it is a `  - ` item, because
 * that is what the doctor renderer keys on when it decides whether a lane's
 * detail block says anything its `reason`/`fix` did not.
 */
export function describeSessionProbe(probe: SessionProbe): string[] {
  const { discovery, hello, notes } = probe;
  const uid = discovery.uid === null ? '' : ` (uid ${discovery.uid})`;
  const lines = [`session account: ${discovery.user}${uid}`];

  lines.push(`  - account: ${discovery.accountExists ? 'exists' : 'not on this Mac'}`);
  const gui = discovery.guiSession;
  const session = gui.sessionId === null ? '' : ` (session ${gui.sessionId})`;
  lines.push(
    `  - gui session: ${
      !gui.exists
        ? 'none — the account has never been logged in, or was logged out'
        : !gui.loginDone
          ? 'at the login window, not a full Aqua session'
          : gui.onConsole
            ? `on the console — it is the session on your screen${session}`
            : `logged in, in the background${session}`
    }`,
  );
  lines.push(`  - socket: ${discovery.socketPath}${discovery.socketPresent ? '' : ' (absent)'}`);

  if (hello !== null) {
    lines.push(
      `  - daemon: offstage-sessiond ${hello.daemon.version}, pid ${hello.daemon.pid}, protocol ${hello.daemon.protocol}`,
    );
    lines.push(
      `  - display: ${hello.display.width}×${hello.display.height} points @${hello.display.scale}x`,
    );
    lines.push(
      `  - permissions: Screen Recording ${hello.permissions.screenCapture ? 'granted' : 'NOT granted'}, Accessibility ${
        hello.permissions.accessibility ? 'granted' : 'NOT granted'
      }`,
    );
  }

  for (const note of notes) lines.push(`  - ${note}`);
  return lines;
}

/** Build a lane with seams injected — the shape every test uses. */
export function createSessionLane(options: SessionLaneOptions = {}): SessionLane {
  return new SessionLane(options);
}

/** The lane instance callers should use; it holds no state. */
export const sessionLane: LaneRunner = new SessionLane();

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** A stand-in record for the case where discovery itself blew up. */
function unknownDiscovery(user: string, socketDir: string): SessionDiscovery {
  return {
    user,
    uid: null,
    home: null,
    fullName: null,
    accountExists: false,
    guiSession: { exists: false, loginDone: false, onConsole: false, sessionId: null },
    socketPath: path.join(socketDir, 'unknown.sock'),
    socketPresent: false,
    platform: process.platform,
  };
}

/**
 * Turn whatever the client threw into the sentence a user can act on. The
 * daemon's `spawn-failed` already carries the OS error text and, for an
 * `EACCES` on `cwd`, the `share` command; both are surfaced verbatim rather
 * than paraphrased.
 */
function describeRunFailure(
  error: unknown,
  user: string,
  cwd: string,
  shareFix: string,
): string {
  if (error instanceof SessionRpcError) {
    if (error.code === 'spawn-failed') {
      return `The "${user}" session could not start the command in ${cwd}: ${error.message} Fix: ${error.fix ?? shareFix}`;
    }
    return `The offstage session daemon refused the command (${error.code}): ${error.message}${
      error.fix === undefined ? '' : ` Fix: ${error.fix}`
    }`;
  }
  if (error instanceof SessionUnreachableError) {
    return `The offstage session daemon became unreachable while the command was running: ${error.message} Nothing can be concluded about the code under test. Fix: ${SETUP_FIX}`;
  }
  return `The command could not be run in the "${user}" session: ${describeError(error)}`;
}

/** A failed screenshot is a note, never a verdict. Say why, and say the fix. */
function describeScreenshotFailure(error: unknown, user: string): string {
  if (error instanceof SessionRpcError && error.code === 'tcc-screen-capture') {
    return `No screenshot was taken: Screen Recording is not granted to offstage-sessiond inside the "${user}" session. The command itself ran and its result is unaffected. Fix: ${
      error.fix ?? `switch to the ${user} account once and allow Screen Recording for offstage-sessiond in System Settings → Privacy & Security`
    }`;
  }
  return `No screenshot was taken: ${describeError(error)} The command itself ran and its result is unaffected.`;
}
