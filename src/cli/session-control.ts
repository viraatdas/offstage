/**
 * offstage: driving a session lane that is already up.
 *
 * Every verb here talks to a running `offstage-sessiond` over its unix socket,
 * or to the filesystem ACLs that decide what the helper account may read. None
 * of them needs root, and none of them can bring the lane into existence: when
 * the daemon is not there they raise {@link OffstageSessionError} carrying the
 * same `fix` string `offstage session status` prints.
 *
 * `./session.ts` owns the seams, the error type, and the setup path these build on.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { DescribeSessionOptions, InputAction, SessionApp } from '../session/index.js';
import { describeSession, parseInputActions, shareAcl, unshareAcl } from '../session/index.js';
import type { ApiDeps, RunOutcome } from './api.js';
import { OffstageUsageError, run, withDefaults } from './api.js';
import {
  asSessionError,
  defaultSleep,
  seamsOf,
  sessionConnect,
} from './session.js';

/* ---------------------------------- share --------------------------------- */

export interface SessionShareResult {
  ok: boolean;
  user: string;
  target: string;
  /** The `chmod +a` commands, exactly as run. */
  commands: string[];
  failures: Array<{ command: string; stderr: string; exitCode: number | null }>;
}

/**
 * Give the helper account read access to one tree, and nothing else.
 *
 * Traverse-only (`search`) on each ancestor so the path is reachable, read on
 * the tree itself. It never grants write: a run's output goes to
 * `$OFFSTAGE_ARTIFACTS`, which the lane opens per run because it owns it.
 */
export async function sessionShare(
  input: { path: string; user?: string },
  deps?: Partial<ApiDeps>,
): Promise<SessionShareResult> {
  const d = withDefaults(deps);
  const seams = seamsOf(d);
  if (typeof input?.path !== 'string' || input.path.trim() === '') {
    throw new OffstageUsageError('offstage session share needs a directory to share.');
  }
  const target = path.resolve(input.path);
  if (!(await d.directoryExists(target)) && !(await fileExists(target))) {
    throw new OffstageUsageError(`No such file or directory: ${target}`, 66);
  }

  const discoverOptions: DescribeSessionOptions = {};
  if (input.user !== undefined) discoverOptions.user = input.user;
  if (seams.socketDir !== undefined) discoverOptions.socketDir = seams.socketDir;
  if (seams.exec !== undefined) discoverOptions.exec = seams.exec;
  const discovery = await (seams.discover ?? describeSession)(discoverOptions);

  const options = {
    target,
    user: discovery.user,
    home: seams.home ?? os.homedir(),
    ...(seams.exec === undefined ? {} : { exec: seams.exec }),
  };
  const result = await shareAcl(options);
  return {
    ok: result.ok,
    user: discovery.user,
    target,
    commands: result.commands,
    failures: result.failures,
  };
}

/* --------------------------------- unshare -------------------------------- */

export interface SessionUnshareResult {
  ok: boolean;
  user: string;
  target: string;
  /** The `chmod -a` commands, exactly as run (absence-tolerant). */
  commands: string[];
  failures: Array<{ command: string; stderr: string; exitCode: number | null }>;
}

/**
 * Revoke exactly what {@link sessionShare} granted: the read ACL on the tree,
 * applied recursively so that entries children inherited while the grant stood
 * come off too, and the traverse-only entries on its ancestors.
 *
 * The tree does not have to exist any more for this to be worth calling;
 * a `chmod` that finds nothing to remove is success, and anything else comes
 * back in `failures`.
 */
export async function sessionUnshare(
  input: { path: string; user?: string },
  deps?: Partial<ApiDeps>,
): Promise<SessionUnshareResult> {
  const d = withDefaults(deps);
  const seams = seamsOf(d);
  if (typeof input?.path !== 'string' || input.path.trim() === '') {
    throw new OffstageUsageError('offstage session unshare needs a directory to unshare.');
  }
  const target = path.resolve(input.path);

  const discoverOptions: DescribeSessionOptions = {};
  if (input.user !== undefined) discoverOptions.user = input.user;
  if (seams.socketDir !== undefined) discoverOptions.socketDir = seams.socketDir;
  if (seams.exec !== undefined) discoverOptions.exec = seams.exec;
  const discovery = await (seams.discover ?? describeSession)(discoverOptions);

  const result = await unshareAcl({
    target,
    user: discovery.user,
    home: seams.home ?? os.homedir(),
    ...(seams.exec === undefined ? {} : { exec: seams.exec }),
  });
  return {
    ok: result.ok,
    user: discovery.user,
    target,
    commands: result.commands,
    failures: result.failures,
  };
}

const fileExists = async (target: string): Promise<boolean> => {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
};

/* ------------------------------- screenshot ------------------------------- */

export interface SessionScreenshotInput {
  /** Longest edge of the returned image, in pixels. Omit for the full framebuffer. */
  maxDimension?: number;
  /**
   * Where to write the PNG. `undefined` writes to
   * `<cwd>/.offstage/screenshots/<timestamp>.png`; `null` writes nothing and
   * returns the bytes only, which is what the MCP tool wants.
   */
  out?: string | null;
  cwd?: string;
  user?: string;
}

export interface SessionScreenshotResult {
  /** Absolute path of the PNG on disk, or `null` when nothing was written. */
  path: string | null;
  /** The image's own pixel size, not the display's point size. */
  width: number;
  height: number;
  /** Backing scale of the captured display: pixels per point. */
  scale: number;
  png: Buffer;
}

/** Capture the helper session's screen. Never the console's: the daemon is in the other session. */
export async function sessionScreenshot(
  input: SessionScreenshotInput = {},
  deps?: Partial<ApiDeps>,
): Promise<SessionScreenshotResult> {
  const d = withDefaults(deps);
  if (
    input.maxDimension !== undefined &&
    (!Number.isInteger(input.maxDimension) || input.maxDimension <= 0)
  ) {
    throw new OffstageUsageError('--max must be a positive whole number of pixels.');
  }

  const { client } = await sessionConnect(d, input.user);
  let shot;
  try {
    shot = await client.screenshot(
      input.maxDimension === undefined ? {} : { maxDimension: input.maxDimension },
    );
  } catch (error) {
    return asSessionError(error);
  }

  let out: string | null = null;
  if (input.out !== null) {
    out =
      input.out ??
      path.join(
        path.resolve(input.cwd ?? process.cwd()),
        '.offstage',
        'screenshots',
        `${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
      );
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, shot.png);
  }

  return { path: out, width: shot.width, height: shot.height, scale: shot.scale, png: shot.png };
}

/* ---------------------------------- input --------------------------------- */

export interface SessionInputResult {
  performed: number;
  actions: InputAction[];
}

/**
 * Inject keyboard and mouse events into the helper session.
 *
 * Coordinates are **points** in the helper display's global space, origin at
 * its top-left: the same space `status.display` reports and the same space a
 * screenshot describes once divided by `scale`.
 */
export async function sessionInput(
  input: { actions: unknown; user?: string },
  deps?: Partial<ApiDeps>,
): Promise<SessionInputResult> {
  const d = withDefaults(deps);
  let actions: InputAction[];
  try {
    actions = parseInputActions(input?.actions);
  } catch (error) {
    throw new OffstageUsageError(
      `Those are not valid input actions: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (actions.length === 0) {
    throw new OffstageUsageError('offstage session input needs at least one action.');
  }

  const { client } = await sessionConnect(d, input.user);
  try {
    const { performed } = await client.input(actions);
    return { performed, actions };
  } catch (error) {
    return asSessionError(error);
  }
}

/* ---------------------------------- apps ---------------------------------- */

/** The regular-activation-policy apps running in the helper session. */
export async function sessionApps(
  input: { user?: string } = {},
  deps?: Partial<ApiDeps>,
): Promise<SessionApp[]> {
  const d = withDefaults(deps);
  const { client } = await sessionConnect(d, input.user);
  try {
    return await client.apps();
  } catch (error) {
    return asSessionError(error);
  }
}

/* --------------------------------- launch --------------------------------- */

export interface SessionLaunchInput {
  /** App name (`TextEdit`) or path to an `.app` bundle (`build/MyApp.app`). */
  target: string;
  /** Extra arguments for `open`: files to open, `-a`, etc. */
  args?: string[];
  cwd?: string;
  user?: string;
  /**
   * Open a NEW instance even if one is already running (`open -n`). Testing
   * flows usually want this: plain `open` would just activate the existing
   * instance and the registration check below would match the old process.
   */
  fresh?: boolean;
  /**
   * How long to wait for the app to register before giving up. First launches
   * can trip a Gatekeeper scan, so this is generous by default.
   */
  waitMs?: number;
}

export interface SessionLaunchResult {
  /**
   * True only when `open` succeeded AND the app registered with LaunchServices
   * inside the helper session: the state `offstage session apps` reports from.
   * A bare `open` returning 0 does not tell you that; this does.
   */
  ok: boolean;
  target: string;
  /** The registered app, when it appeared. */
  app: SessionApp | null;
  waitedMs: number;
  diagnostics: string[];
}

/** How long {@link sessionLaunch} waits for a launch to register, by default. */
export const SESSION_LAUNCH_DEFAULT_WAIT_MS = 20_000;

/** Poll interval between `apps` checks while waiting for a launch to register. */
export const SESSION_LAUNCH_POLL_MS = 400;

/**
 * Does this running app correspond to the launch target?
 *
 * Matches the bundle's basename (`GestureEngine.app` → `gestureengine`)
 * against the app's display name or the last component of its bundle id
 * (`dev.viraat.GestureEngine` → `gestureengine`). Pure, exported for tests.
 */
export function appMatchesTarget(
  target: string,
  app: Pick<SessionApp, 'name' | 'bundleId'>,
): boolean {
  let expected = path.basename(target.trim()).toLowerCase();
  if (expected.endsWith('.app')) expected = expected.slice(0, -4);
  if (expected === '') return false;
  if ((app.name ?? '').toLowerCase() === expected) return true;
  const lastBundleComponent = (app.bundleId ?? '').split('.').pop() ?? '';
  return lastBundleComponent === expected;
}

/**
 * Open an app inside the helper session and wait until it is really there.
 *
 * The lesson this encodes came from a real agent session: `open` exits 0 the
 * moment LaunchServices accepts the request, which says nothing about whether
 * the app finished launching: Gatekeeper scans, first-run panes and slow
 * disks all delay it. An agent that treats exit 0 as success launches three
 * more copies and then gives up on isolation entirely. This waits until the
 * app actually appears in the session's own app list, and reports its pid.
 */
export async function sessionLaunch(
  input: SessionLaunchInput,
  deps?: Partial<ApiDeps>,
): Promise<SessionLaunchResult> {
  const d = withDefaults(deps);
  const seams = seamsOf(d);
  if (typeof input?.target !== 'string' || input.target.trim() === '') {
    throw new OffstageUsageError('offstage session launch needs an app name or a path to an .app bundle.');
  }
  const now = seams.now ?? Date.now;
  const sleep = seams.sleep ?? defaultSleep;
  const startedAtMs = now();

  const { client } = await sessionConnect(d, input.user);

  /* A path-shaped target (`build/App.app`) is resolved against the CALLER's
     cwd before crossing the socket: the helper account's own cwd would be
     its home directory, where the relative path means nothing (measured:
     `open -n build/GestureEngine.app` exited 1 exactly that way). A bare
     name goes through `open -a`, because without it `open` treats the name
     as a file path too (`open Calculator` exits 1 complaining
     `/Users/computeruse/Calculator does not exist`). */
  const looksLikePath = /[\\/]/.test(input.target) || /\.app$/i.test(input.target.trim());
  const targetArg = looksLikePath ? path.resolve(input.cwd ?? process.cwd(), input.target) : input.target;

  const argv = [
    'open',
    ...(input.fresh === true ? ['-n'] : []),
    ...(looksLikePath ? [] : ['-a']),
    targetArg,
    ...(input.args ?? []),
  ];
  let openOutput = '';
  try {
    const outcome = await client.run({
      argv,
      // `open` runs wherever it pleases inside the helper session; the app
      // bundle carries its own working directory.
      cwd: input.cwd ?? (await client.hello()).user.home,
      timeoutMs: 30_000,
      onOutput: (chunk) => {
        if (openOutput.length < 2000) openOutput += chunk.toString('utf8');
      },
    });
    if (outcome.exitCode !== 0) {
      return {
        ok: false,
        target: input.target,
        app: null,
        waitedMs: now() - startedAtMs,
        diagnostics: [
          outcome.timedOut
            ? '`open` did not return within 30s.'
            : `\`open\` exited ${outcome.exitCode ?? 'to a signal'}${
                outcome.signal === null ? '' : ` (${outcome.signal})`
              }.`,
          ...(openOutput.trim() === '' ? [] : [`Its output: ${openOutput.trim().split('\n').slice(-4).join(' | ')}`]),
        ],
      };
    }
  } catch (error) {
    return asSessionError(error);
  }

  /* When `fresh` is set, snapshot which matching pids already exist so the
     poll can demand a NEW one. Matching a stale instance would report success
     while `open -n`'s process went somewhere else entirely. Measured live:
     two old copies were running and the poll happily blessed one of them. */
  const diagnostics: string[] = [];
  let preExistingPids = new Set<number>();
  if (input.fresh === true) {
    try {
      for (const app of await client.apps()) {
        if (appMatchesTarget(targetArg, app)) preExistingPids.add(app.pid);
      }
    } catch {
      /* A failed snapshot must not block the launch; the poll below simply
         loses its freshness guarantee and matches any registration. */
      diagnostics.push('could not snapshot pre-existing apps; matching any registration.');
    }
  }

  const deadline = now() + (input.waitMs ?? SESSION_LAUNCH_DEFAULT_WAIT_MS);
  for (;;) {
    let apps: SessionApp[];
    try {
      apps = await client.apps();
    } catch (error) {
      /* A transient socket hiccup must not end the poll: the launch may be fine. */
      diagnostics.push(`apps poll failed transiently: ${error instanceof Error ? error.message : String(error)}`);
      apps = [];
    }
    const found = apps.find(
      (app) => appMatchesTarget(targetArg, app) && !preExistingPids.has(app.pid),
    );
    if (found !== undefined) {
      return { ok: true, target: input.target, app: found, waitedMs: now() - startedAtMs, diagnostics };
    }
    if (now() >= deadline) {
      const stale = [...preExistingPids];
      return {
        ok: false,
        target: input.target,
        app: null,
        waitedMs: now() - startedAtMs,
        diagnostics: [
          `"${input.target}" did not register with the helper session within the wait window.`,
          ...(stale.length > 0
            ? [`A matching app was already running (pid ${stale.join(', pid ')}); \`fresh\` asked for a new instance and none appeared.`]
            : []),
          'First launches can be slow while Gatekeeper verifies the bundle; one retry usually succeeds.',
          'Take a screenshot before trying anything else: the window may simply not have a regular activation policy.',
          'Never fall back to launching the app outside offstage; that puts it on the user\'s screen.',
        ],
      };
    }
    await sleep(SESSION_LAUNCH_POLL_MS);
  }
}

/* ---------------------------------- open ---------------------------------- */

/**
 * `open <target> [args…]`, in the helper session.
 *
 * Deliberately a thin call into {@link run} with `lane: 'session'` rather than
 * a fifth code path: it gets the run directory, the `result.json`, the
 * screenshot and the diagnostics for free, and an agent that reads one run
 * envelope can read this one. When you need to know the app actually came up,
 * not just that `open` handed off the request, use {@link sessionLaunch}.
 */
export async function sessionOpen(
  input: { target: string; args?: string[]; cwd?: string; timeoutMs?: number },
  deps?: Partial<ApiDeps>,
): Promise<RunOutcome> {
  if (typeof input?.target !== 'string' || input.target.trim() === '') {
    throw new OffstageUsageError('offstage session open needs an app name or a path to open.');
  }
  return await run(
    {
      ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
      command: ['open', input.target, ...(input.args ?? [])],
      lane: 'session',
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    },
    deps,
  );
}