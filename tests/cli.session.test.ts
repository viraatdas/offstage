/**
 * `offstage session …`: the API functions and the command tree over them.
 *
 * Nothing here touches a real daemon, a real account, or `sudo`. Every seam is
 * injected: discovery answers from a literal, the client is a fake, the root
 * script is captured rather than run. That is deliberate and not only for
 * speed: the one thing these tests must never do is inject input into a live
 * macOS session, which on a developer's machine is *their* session.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Lane, LaneRequest, LaneRunner } from '../src/contract/index.js';
import { createLaneResult } from '../src/contract/index.js';
import type { ApiDeps } from '../src/cli/api.js';
import type { SessionSeams } from '../src/cli/session.js';
import { OffstageUsageError, doctor } from '../src/cli/api.js';
import { OffstageSessionError, sessionSetup, sessionStatus } from '../src/cli/session.js';
import {
  sessionApps,
  sessionInput,
  sessionLaunch,
  sessionOpen,
  sessionScreenshot,
  sessionShare,
  sessionUnshare,
} from '../src/cli/session-control.js';
import { main } from '../src/cli/index.js';
import type { CliIo } from '../src/cli/index.js';
import type {
  ExecOutcome,
  InputAction,
  SessionClient,
  SessionDiscovery,
  SessionHello,
} from '../src/session/index.js';
import { SessionRpcError } from '../src/session/index.js';

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix = 'offstage-session-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return await fs.realpath(dir);
}

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

/** A helper account that is logged in, in the background, with the daemon up. */
function discovery(overrides: Partial<SessionDiscovery> = {}): SessionDiscovery {
  return {
    user: 'computeruse',
    uid: 502,
    home: '/Users/computeruse',
    fullName: 'Computer Use',
    accountExists: true,
    guiSession: { exists: true, loginDone: true, onConsole: false, sessionId: 258 },
    socketPath: '/tmp/offstage-session/502.sock',
    socketPresent: true,
    platform: 'darwin',
    ...overrides,
  };
}

function hello(overrides: Partial<SessionHello> = {}): SessionHello {
  return {
    ok: true,
    daemon: { version: '1', pid: 4242, protocol: 1 },
    user: { uid: 502, name: 'computeruse', home: '/Users/computeruse' },
    session: { onConsole: false, managerName: 'Aqua' },
    display: { width: 1728, height: 1117, scale: 2 },
    permissions: { screenCapture: true, accessibility: true },
    ...overrides,
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface FakeClient extends SessionClient {
  calls: Array<{ op: string; payload?: unknown }>;
}

function fakeClient(options: {
  hello?: SessionHello;
  onScreenshot?: () => never;
  onInput?: () => never;
  apps?: Awaited<ReturnType<SessionClient['apps']>>;
  permissions?: { screenCapture: boolean; accessibility: boolean };
} = {}): FakeClient {
  const calls: FakeClient['calls'] = [];
  return {
    calls,
    socketPath: '/tmp/offstage-session/502.sock',
    async hello() {
      calls.push({ op: 'hello' });
      return options.hello ?? hello();
    },
    async access(target) {
      calls.push({ op: 'access', payload: target });
      return { ok: true, exists: true, readable: true, writable: false, directory: true };
    },
    async run(request) {
      calls.push({ op: 'run', payload: request.argv });
      return { exitCode: 0, signal: null, timedOut: false, durationMs: 1, pid: 1 };
    },
    async screenshot(screenshotOptions) {
      calls.push({ op: 'screenshot', payload: screenshotOptions });
      options.onScreenshot?.();
      return { png: PNG, width: 1728, height: 1117, scale: 2 };
    },
    async input(actions) {
      calls.push({ op: 'input', payload: actions });
      options.onInput?.();
      return { performed: actions.length };
    },
    async apps() {
      calls.push({ op: 'apps' });
      return (
        options.apps ?? [
          { pid: 5120, name: 'Safari', bundleId: 'com.apple.Safari', active: true, hidden: false },
        ]
      );
    },
    async requestPermissions() {
      calls.push({ op: 'request-permissions' });
      return options.permissions ?? { screenCapture: true, accessibility: true };
    },
    async restart() {
      calls.push({ op: 'restart' });
      return { restarting: true };
    },
  };
}

/** Build the seams for one scenario, plus a handle on the client the lane got. */
function seams(overrides: Partial<SessionSeams> & { discovery?: SessionDiscovery; client?: FakeClient } = {}): {
  session: SessionSeams;
  client: FakeClient;
} {
  const client = overrides.client ?? fakeClient();
  const found = overrides.discovery ?? discovery();
  const session: SessionSeams = {
    discover: async () => found,
    createClient: () => client,
    ...overrides,
  };
  delete (session as { discovery?: unknown }).discovery;
  delete (session as { client?: unknown }).client;
  return { session, client };
}

function fakeLane(lane: Lane): LaneRunner & { calls: LaneRequest[] } {
  const calls: LaneRequest[] = [];
  return {
    lane,
    calls,
    async isAvailable() {
      return { available: true };
    },
    async run(req: LaneRequest) {
      calls.push(req);
      return createLaneResult({ lane, status: 'passed', exitCode: 0, artifactsDir: req.artifactsDir });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* status                                                                     */
/* -------------------------------------------------------------------------- */

describe('sessionStatus', () => {
  it('reports the account, the session, the daemon, the display and both grants', async () => {
    const { session } = seams();
    const status = await sessionStatus({}, { session });

    expect(status.available).toBe(true);
    expect(status.user).toBe('computeruse');
    expect(status.uid).toBe(502);
    expect(status.guiSession.onConsole).toBe(false);
    expect(status.daemon).toEqual({ version: '1', pid: 4242, protocol: 1 });
    expect(status.display).toEqual({ width: 1728, height: 1117, scale: 2 });
    expect(status.permissions).toEqual({ screenCapture: true, accessibility: true });
    expect(status.reason).toBeNull();
    expect(status.notes).toEqual([]);
  });

  it('carries the ladder’s first failure and its fix, and says nothing it did not learn', async () => {
    const { session } = seams({ discovery: discovery({ socketPresent: false }) });
    const status = await sessionStatus({}, { session });

    expect(status.available).toBe(false);
    expect(status.reason).toContain('no socket at');
    expect(status.fix).toBe('offstage session setup');
    // The daemon never answered, so nothing pretends to know its version.
    expect(status.daemon).toBeNull();
    expect(status.display).toBeNull();
    expect(status.permissions).toBeNull();
  });

  it('refuses the lane when the helper session is the one on screen', async () => {
    const { session } = seams({
      discovery: discovery({
        guiSession: { exists: true, loginDone: true, onConsole: true, sessionId: 258 },
      }),
    });
    const status = await sessionStatus({}, { session });

    expect(status.available).toBe(false);
    expect(status.reason).toContain('on your screen');
  });

  it('stays available with a missing TCC grant, but says what will fail', async () => {
    const { session } = seams({
      client: fakeClient({ hello: hello({ permissions: { screenCapture: true, accessibility: false } }) }),
    });
    const status = await sessionStatus({}, { session });

    expect(status.available).toBe(true);
    expect(status.notes.join(' ')).toContain('Accessibility');
    expect(status.notes.join(' ')).toContain('input injection will fail');
  });
});

describe('doctor', () => {
  it('renders the session probe under the lane, the way it renders the container runtime probe', async () => {
    const { session } = seams();
    const report = await doctor({
      session,
      lanes: {
        headless: fakeLane('headless'),
        // The real lane, driven through the seams: doctor duck-types
        // probeSession() the same way it duck-types the container probe().
        session: (await import('../src/lanes/session/index.js')).createSessionLane({
          discover: session.discover as never,
          createClient: session.createClient as never,
        }),
        container: fakeLane('container'),
      },
    });

    const health = report.lanes.find((lane) => lane.lane === 'session');
    expect(health?.availability.available).toBe(true);
    expect(health?.detail[0]).toContain('session account: computeruse (uid 502)');
    expect(health?.detail.join('\n')).toContain('- gui session: logged in, in the background');
    expect(health?.detail.join('\n')).toContain('- display: 1728×1117 points @2x');
    expect(health?.detail.join('\n')).toContain('Screen Recording granted');
  });
});

/* -------------------------------------------------------------------------- */
/* screenshot / input / apps                                                  */
/* -------------------------------------------------------------------------- */

describe('sessionScreenshot', () => {
  it('writes the PNG where it was told and reports the geometry', async () => {
    const dir = await tempDir();
    const out = path.join(dir, 'shot.png');
    const { session, client } = seams();

    const result = await sessionScreenshot({ out, maxDimension: 1280 }, { session });

    expect(result.path).toBe(out);
    expect(await fs.readFile(out)).toEqual(PNG);
    expect(result.width).toBe(1728);
    expect(result.scale).toBe(2);
    expect(client.calls.at(-1)).toEqual({ op: 'screenshot', payload: { maxDimension: 1280 } });
  });

  it('defaults to .offstage/screenshots/<timestamp>.png under the cwd', async () => {
    const cwd = await tempDir();
    const { session } = seams();

    const result = await sessionScreenshot({ cwd }, { session });

    expect(result.path).not.toBeNull();
    expect(result.path?.startsWith(path.join(cwd, '.offstage', 'screenshots'))).toBe(true);
    expect(result.path?.endsWith('.png')).toBe(true);
    await fs.access(result.path as string);
  });

  it('writes nothing at all when out is null, which is what the MCP tool asks for', async () => {
    const cwd = await tempDir();
    const { session } = seams();

    const result = await sessionScreenshot({ cwd, out: null }, { session });

    expect(result.path).toBeNull();
    expect(result.png).toEqual(PNG);
    await expect(fs.access(path.join(cwd, '.offstage'))).rejects.toThrow();
  });

  it('turns a denied Screen Recording grant into an error carrying the daemon’s own fix', async () => {
    const { session } = seams({
      client: fakeClient({
        onScreenshot: () => {
          throw new SessionRpcError(
            'screen capture is not permitted for this process',
            'tcc-screen-capture',
            'switch to the computeruse account once and allow Screen Recording for offstage-sessiond',
          );
        },
      }),
    });

    await expect(sessionScreenshot({ out: null }, { session })).rejects.toThrow(OffstageSessionError);
    await expect(sessionScreenshot({ out: null }, { session })).rejects.toMatchObject({
      code: 'tcc-screen-capture',
      exitCode: 69,
      fix: expect.stringContaining('Screen Recording'),
    });
  });

  it('never opens a socket when the lane is unavailable, and hands back the lane’s fix', async () => {
    const { session, client } = seams({ discovery: discovery({ accountExists: false }) });

    await expect(sessionScreenshot({ out: null }, { session })).rejects.toMatchObject({
      name: 'OffstageSessionError',
      fix: 'offstage session setup --create',
    });
    expect(client.calls).toHaveLength(0);
  });

  it('rejects a nonsensical --max as caller error, before anything is connected', async () => {
    const { session, client } = seams();
    await expect(sessionScreenshot({ maxDimension: 0, out: null }, { session })).rejects.toThrow(
      OffstageUsageError,
    );
    expect(client.calls).toHaveLength(0);
  });
});

describe('sessionInput', () => {
  it('validates the actions against the daemon’s schema before opening a socket', async () => {
    const { session, client } = seams();

    await expect(sessionInput({ actions: [{ type: 'teleport' }] }, { session })).rejects.toThrow(
      OffstageUsageError,
    );
    await expect(sessionInput({ actions: [] }, { session })).rejects.toThrow(OffstageUsageError);
    await expect(sessionInput({ actions: 'click 1 2' }, { session })).rejects.toThrow(OffstageUsageError);
    expect(client.calls).toHaveLength(0);
  });

  it('passes valid actions through untouched and reports how many were performed', async () => {
    const { session, client } = seams();
    const actions: InputAction[] = [
      { type: 'click', x: 640, y: 400 },
      { type: 'type', text: 'hello' },
    ];

    const result = await sessionInput({ actions }, { session });

    expect(result.performed).toBe(2);
    expect(client.calls.at(-1)).toEqual({ op: 'input', payload: actions });
  });

  it('turns a missing Accessibility grant into an error with the fix, not a silent no-op', async () => {
    const { session } = seams({
      client: fakeClient({
        onInput: () => {
          throw new SessionRpcError(
            'accessibility is not granted',
            'tcc-accessibility',
            'switch to the computeruse account once and allow Accessibility for offstage-sessiond',
          );
        },
      }),
    });

    await expect(
      sessionInput({ actions: [{ type: 'key', key: 'cmd+q' }] }, { session }),
    ).rejects.toMatchObject({ code: 'tcc-accessibility', fix: expect.stringContaining('Accessibility') });
  });
});

describe('sessionApps', () => {
  it('returns what the daemon listed', async () => {
    const { session } = seams();
    const apps = await sessionApps({}, { session });
    expect(apps).toEqual([
      { pid: 5120, name: 'Safari', bundleId: 'com.apple.Safari', active: true, hidden: false },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* open                                                                       */
/* -------------------------------------------------------------------------- */

describe('sessionOpen', () => {
  it('is `run --lane session -- open …` and nothing else', async () => {
    const cwd = await tempDir();
    const lane = fakeLane('session');
    const outcome = await sessionOpen(
      { target: 'Safari', args: ['--args', '--incognito'], cwd },
      {
        lanes: {
          headless: fakeLane('headless'),
          session: lane,
          container: fakeLane('container'),
        },
      },
    );

    expect(outcome.lane).toBe('session');
    expect(outcome.laneSource).toBe('explicit');
    expect(lane.calls[0]?.command).toEqual(['open', 'Safari', '--args', '--incognito']);
  });

  it('rejects an empty target as caller error', async () => {
    await expect(sessionOpen({ target: '  ' })).rejects.toThrow(OffstageUsageError);
  });
});

/* -------------------------------------------------------------------------- */
/* share                                                                      */
/* -------------------------------------------------------------------------- */

describe('sessionShare', () => {
  it('grants traverse on the ancestors and read on the tree, and never write', async () => {
    const home = await tempDir('offstage-home-');
    const target = path.join(home, 'code', 'app');
    await fs.mkdir(target, { recursive: true });

    const ran: Array<{ file: string; args: string[] }> = [];
    const exec = async (file: string, args: string[]): Promise<ExecOutcome> => {
      ran.push({ file, args });
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const { session } = seams({ exec, home });

    const result = await sessionShare({ path: target }, { session });

    expect(result.ok).toBe(true);
    expect(result.user).toBe('computeruse');
    expect(ran.every((command) => command.file === '/bin/chmod')).toBe(true);
    const rendered = ran.map((command) => command.args.join(' ')).join('\n');
    expect(rendered).toContain('computeruse allow search');
    expect(rendered).toContain(`-R +a computeruse allow`);
    // Read-only: nothing in a share grants write, ever.
    expect(rendered).not.toMatch(/allow [^\n]*\bwrite\b/);
  });

  it('reports a chmod that failed rather than claiming the tree is shared', async () => {
    const dir = await tempDir();
    const exec = async (): Promise<ExecOutcome> => ({
      stdout: '',
      stderr: 'chmod: Failed to set ACL on file',
      exitCode: 1,
    });
    const { session } = seams({ exec, home: dir });

    const result = await sessionShare({ path: dir }, { session });

    expect(result.ok).toBe(false);
    expect(result.failures[0]?.stderr).toContain('Failed to set ACL');
  });

  it('refuses a path that is not there, as caller error', async () => {
    const { session } = seams();
    await expect(sessionShare({ path: '/definitely/not/here' }, { session })).rejects.toThrow(
      OffstageUsageError,
    );
  });
});

describe('sessionUnshare', () => {
  it('runs the inverse ACLs and succeeds even when nothing was granted', async () => {
    const home = await tempDir('offstage-home-');
    const target = path.join(home, 'code', 'app');
    const ran: Array<{ file: string; args: string[] }> = [];
    const exec = async (file: string, args: string[]): Promise<ExecOutcome> => {
      ran.push({ file, args });
      // Every entry is already gone: the state an unshare wants.
      return { stdout: '', stderr: `chmod: No ACL present '${target}'`, exitCode: 1 };
    };
    const { session } = seams({ exec, home });

    const result = await sessionUnshare({ path: target }, { session });

    expect(result.ok).toBe(true);
    expect(ran.every((command) => command.file === '/bin/chmod')).toBe(true);
    expect(ran.map((c) => c.args.join(' ')).join('\n')).toContain('-a computeruse allow search');
    expect(ran.some((c) => c.args[0] === '-R' && c.args[1] === '-a')).toBe(true);
  });

  it('reports a chmod that failed for a reason other than absence', async () => {
    const dir = await tempDir();
    const exec = async (): Promise<ExecOutcome> => ({
      stdout: '',
      stderr: "chmod: /no/such/dir: No such file or directory",
      exitCode: 1,
    });
    const { session } = seams({ exec, home: dir });

    const result = await sessionUnshare({ path: dir }, { session });

    expect(result.ok).toBe(false);
    expect(result.failures[0]?.stderr).toContain('No such file or directory');
  });

  it('is wired into the command tree with its own renderer', async () => {
    const home = await tempDir('offstage-home-');
    const target = path.join(home, 'tree');
    const exec = async (): Promise<ExecOutcome> => ({ stdout: '', stderr: '', exitCode: 0 });
    const { session } = seams({ exec, home });

    const captured = await cli(['session', 'unshare', '--json', target], { deps: { session } });

    expect(captured.code).toBe(0);
    const envelope = JSON.parse(captured.out) as { ok: boolean; user: string; target: string };
    expect(envelope.ok).toBe(true);
    expect(envelope.user).toBe('computeruse');
    expect(envelope.target).toBe(target);
  });
});

/* -------------------------------------------------------------------------- */
/* launch                                                                     */
/* -------------------------------------------------------------------------- */

describe('sessionLaunch', () => {
  const GESTURE_APP = {
    pid: 45272,
    name: 'GestureEngine',
    bundleId: 'dev.viraat.GestureEngine',
    active: true,
    hidden: false,
  };

  it('appMatchesTarget: name, bundle basename, case-insensitive', async () => {
    const api = await import('../src/cli/session-control.js');
    const app = { name: 'GestureEngine', bundleId: 'dev.viraat.GestureEngine' };
    expect(api.appMatchesTarget('GestureEngine', app)).toBe(true);
    expect(api.appMatchesTarget('build/GestureEngine.app', app)).toBe(true);
    expect(api.appMatchesTarget('gestureengine', app)).toBe(true);
    expect(api.appMatchesTarget('SomethingElse', app)).toBe(false);
  });

  it('with fresh, snapshots pre-existing instances and returns only the NEW pid', async () => {
    const OLD = { ...GESTURE_APP, pid: 2418 };
    const NEW = { ...GESTURE_APP, pid: 9999 };
    let appsCalls = 0;
    const base = fakeClient();
    const client = {
      ...base,
      async apps() {
        appsCalls += 1;
        // Snapshot sees the stale instance; polls see both, then just the new one.
        return appsCalls === 1 ? [OLD] : appsCalls === 2 ? [] : [OLD, NEW];
      },
    } as unknown as FakeClient;
    const { session } = seams({
      client,
      sleep: async () => {},
    });

    const result = await sessionLaunch(
      { target: '/Users/viraat/code/GestureEngine/build/GestureEngine.app', fresh: true },
      { session },
    );

    expect(result.ok).toBe(true);
    // Blessing the old pid here is exactly the bug that sent an agent into a
    // relaunch spiral: fresh means a NEW process.
    expect(result.app?.pid).toBe(9999);
    const runCall = base.calls.find((call) => call.op === 'run');
    // fakeClient records the argv itself as the payload.
    expect(runCall?.payload).toEqual(['open', '-n', '/Users/viraat/code/GestureEngine/build/GestureEngine.app']);
  });

  it('routes bare app names through `open -a`, because bare paths mean files', async () => {
    // Measured on a live helper session: `open Calculator` exits 1 with
    // "The file /Users/computeruse/Calculator does not exist.": open only
    // resolves application names when given -a.
    const base = fakeClient();
    const CALCULATOR = { pid: 5120, name: 'Calculator', bundleId: 'com.apple.calculator', active: true, hidden: false };
    const client = { ...base, async apps() { return [CALCULATOR]; } } as unknown as FakeClient;
    const { session } = seams({ client });

    const result = await sessionLaunch({ target: 'Calculator' }, { session });

    expect(result.ok).toBe(true);
    expect(result.app?.name).toBe('Calculator');
    const runCall = base.calls.find((call) => call.op === 'run');
    expect(runCall?.payload).toEqual(['open', '-a', 'Calculator']);
  });

  it('fails honestly when the app never registers, and says what to do instead', async () => {
    const base = fakeClient();
    const client = { ...base, async apps() { return []; } } as unknown as FakeClient;
    const { session } = seams({ client, sleep: async () => {} });

    const result = await sessionLaunch({ target: 'NeverThere', waitMs: 1 }, { session });

    expect(result.ok).toBe(false);
    expect(result.app).toBeNull();
    expect(result.diagnostics.join(' ')).toContain('screenshot');
    expect(result.diagnostics.join(' ')).toContain('Never fall back');
  });

  it('is wired into the command tree and exits 0 when registered', async () => {
    // Registers on the very first poll: this only needs to prove the wiring.
    const base = fakeClient();
    const client = { ...base, async apps() { return [GESTURE_APP]; } } as unknown as FakeClient;
    const { session } = seams({ client });

    const captured = await cli(['session', 'launch', '--json', 'GestureEngine'], { deps: { session } });

    expect(captured.code).toBe(0);
    const envelope = JSON.parse(captured.out) as { ok: boolean; app: { pid: number } | null };
    expect(envelope.ok).toBe(true);
    expect(envelope.app?.pid).toBe(45272);
  });
});

/* -------------------------------------------------------------------------- */
/* setup                                                                      */
/* -------------------------------------------------------------------------- */

function setupSeams(overrides: Partial<SessionSeams> = {}, found = discovery({ socketPresent: false })): {
  session: SessionSeams;
  scripts: string[];
} {
  const scripts: string[] = [];
  const session: SessionSeams = {
    discover: async () => found,
    createClient: () => fakeClient(),
    compileDaemon: async ({ outPath }) => ({
      ok: true,
      command: `swiftc -o ${outPath}`,
      stdout: '',
      stderr: '',
      exitCode: 0,
      via: 'build.sh',
    }),
    /* The freshly compiled binary is asked for its own designated requirement;
       answer with a well-formed blob so the default scenario exercises the
       TCC pre-seed path. */
    exec: async (_file, args) =>
      args.includes('--print-csreq')
        ? { stdout: `fade0c00000000a4${'ab'.repeat(40)}\n`, stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 },
    runRootScript: async (scriptPath) => {
      scripts.push(scriptPath);
      return 0;
    },
    sleep: async () => {},
    sourceDir: '/fake/native/sessiond',
    ...overrides,
  };
  return { session, scripts };
}

describe('sessionSetup', () => {
  it('prints the root script before running it, and the script is the whole install', async () => {
    const printed: string[] = [];
    const { session, scripts } = setupSeams();

    const result = await sessionSetup({ io: (line) => printed.push(line) }, { session });

    expect(result.ok).toBe(true);
    expect(scripts).toHaveLength(1);
    // Printed before it ran, in full: the user is about to type a password.
    const output = printed.join('\n');
    expect(output).toContain('This is the only step that needs root');
    expect(output).toContain('launchctl bootstrap');
    expect(output.indexOf('launchctl bootstrap')).toBeLessThan(output.indexOf('Running: sudo'));
    expect(result.script).toContain(`launchctl bootstrap 'gui/502'`);
    expect(result.script).toContain('offstage-sessiond');
    expect(result.steps.map((step) => step.step)).toEqual([
      'compile',
      'codesign',
      'tcc',
      'install',
      'wait',
      'permissions',
    ]);
    expect(result.steps.every((step) => step.ok)).toBe(true);
  });

  it('creates the account only when asked, and refuses with the flag to pass otherwise', async () => {
    const { session } = setupSeams({}, discovery({ accountExists: false, uid: null, home: null }));

    const refused = await sessionSetup({}, { session });
    expect(refused.ok).toBe(false);
    expect(refused.script).toBe('');
    expect(refused.nextSteps.join(' ')).toContain('offstage session setup --create');
  });

  it('adds sysadminctl to the same root script when --create is given, with a generated password', async () => {
    let call = 0;
    // After creation the account still has no GUI session: that is the state
    // every fresh account is in, and why one human switch remains.
    const created = discovery({
      guiSession: { exists: false, loginDone: false, onConsole: false, sessionId: null },
      socketPresent: false,
    });
    const missing = discovery({ accountExists: false, uid: null, home: null });
    const { session } = setupSeams({
      // Before the script runs the account is absent; afterwards it is there.
      discover: async () => (call++ === 0 ? missing : created),
      exec: async (_file, args) => {
        if (args.includes('--print-csreq')) {
          return { stdout: `fade0c00000000a4${'ab'.repeat(40)}\n`, stderr: '', exitCode: 0 };
        }
        if (args.includes('-list')) {
          return { stdout: '_mbsetupuser 248\ndaemon 1\nnobody -2\nviraat 501\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }, missing);

    const result = await sessionSetup({ create: true }, { session });

    expect(result.ok).toBe(true);
    // 501 is taken, 502 is the first free one.
    expect(result.uid).toBe(502);
    expect(result.script).toContain('sysadminctl -addUser');
    expect(result.script).toContain(`-fullName 'Computer Use'`);
    // Non-interactive by design: a generated password, not a prompt. An empty
    // password would leave the account unable to log in under FileVault.
    expect(result.script).toMatch(/-password '[A-Za-z0-9]{24}'/);
    // The creation has to come before anything that chowns to that account.
    expect(result.script.indexOf('sysadminctl')).toBeLessThan(result.script.indexOf('launchctl bootstrap'));
    expect(result.nextSteps.join(' ')).toContain('fast user switching');
  });

  it('pre-seeds both TCC grants in the root script when the requirement exported cleanly', async () => {
    const { session } = setupSeams();

    const result = await sessionSetup({}, { session });

    expect(result.ok).toBe(true);
    expect(result.script).toContain("INSERT OR REPLACE INTO access");
    expect(result.script).toContain("'kTCCServiceAccessibility'");
    expect(result.script).toContain("'kTCCServiceScreenCapture'");
    expect(result.script).toContain('fade0c00000000a4');
    // The probe comes first: without Full Disk Access the inserts are skipped
    // with an explanation instead of failing the whole install.
    expect(result.script.indexOf('BEGIN IMMEDIATE')).toBeLessThan(result.script.indexOf('INSERT OR REPLACE'));
    expect(result.nextSteps.join(' ')).not.toContain('Privacy & Security');
  });

  it('falls back to the manual toggles when no code requirement could be exported', async () => {
    const { session } = setupSeams({
      exec: async (_file, args) =>
        args.includes('--print-csreq')
          ? { stdout: 'not a blob at all\n', stderr: '', exitCode: 0 }
          : { stdout: '', stderr: '', exitCode: 0 },
      // The daemon came up without either grant, which is exactly the state
      // pre-seeding was meant to prevent.
      createClient: () =>
        fakeClient({
          hello: hello({ permissions: { screenCapture: false, accessibility: false } }),
          permissions: { screenCapture: false, accessibility: false },
        }),
    });

    const result = await sessionSetup({}, { session });

    expect(result.steps.find((step) => step.step === 'codesign')?.ok).toBe(false);
    expect(result.steps.find((step) => step.step === 'tcc')?.ok).toBe(false);
    expect(result.script).not.toContain('INSERT OR REPLACE');
    expect(result.nextSteps.join(' ')).toContain('Privacy & Security');
  });

  it('arms auto-login on request and warns when FileVault blocks it', async () => {
    let call = 0;
    // Even after the script ran, no session exists yet: under FileVault the
    // helper cannot be auto-logged-in, so a human switch is still required.
    const created = discovery({
      guiSession: { exists: false, loginDone: false, onConsole: false, sessionId: null },
      socketPresent: false,
    });
    const missing = discovery({ accountExists: false, uid: null, home: null });
    const { session } = setupSeams({
      discover: async () => (call++ === 0 ? missing : created),
      exec: async (_file, args) => {
        if (args.includes('--print-csreq')) {
          return { stdout: `fade0c00000000a4${'ab'.repeat(40)}\n`, stderr: '', exitCode: 0 };
        }
        if (args.includes('-list')) {
          return { stdout: 'viraat 501\n', stderr: '', exitCode: 0 };
        }
        if (args.includes('status')) {
          return { stdout: 'FileVault is On.\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }, missing);

    const result = await sessionSetup({ create: true, autoLogin: true }, { session });

    expect(result.ok).toBe(true);
    expect(result.script).toMatch(/-autologin set -userName 'computeruse' -password '[A-Za-z0-9]{24}'/);
    expect(result.steps.find((step) => step.step === 'auto-login')?.ok).toBe(false);
    expect(result.nextSteps.join(' ')).toContain('FileVault');
  });

  it('persists the generated account secret through the seam once the install completed', async () => {
    let call = 0;
    const created = discovery();
    const missing = discovery({ accountExists: false, uid: null, home: null });
    const persisted: Array<{ user: string; password: string }> = [];
    const { session } = setupSeams({
      discover: async () => (call++ === 0 ? missing : created),
      writeSessionConfig: async (user, password) => {
        persisted.push({ user, password });
      },
      exec: async (_file, args) => {
        if (args.includes('-list')) {
          return { stdout: 'viraat 501\n', stderr: '', exitCode: 0 };
        }
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }, missing);

    const result = await sessionSetup({ create: true }, { session });

    expect(result.ok).toBe(true);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.user).toBe('computeruse');
    expect(persisted[0]?.password).toMatch(/^[A-Za-z0-9]{24}$/);
  });

  it('stops at a compiler it does not have, and says how to get one', async () => {
    const { session, scripts } = setupSeams({
      compileDaemon: async () => ({
        ok: false,
        command: '',
        stdout: '',
        stderr: '',
        exitCode: null,
        reason: 'No Swift compiler was found',
        fix: 'xcode-select --install',
        via: 'none',
      }),
    });

    const result = await sessionSetup({}, { session });

    expect(result.ok).toBe(false);
    expect(scripts).toHaveLength(0);
    expect(result.nextSteps.join(' ')).toContain('xcode-select --install');
  });

  it('reports a daemon that never answered, and blames the missing login when that is why', async () => {
    const unreachable = discovery({
      socketPresent: false,
      guiSession: { exists: false, loginDone: false, onConsole: false, sessionId: null },
    });
    const { session } = setupSeams(
      {
        discover: async () => unreachable,
        createClient: () =>
          ({
            ...fakeClient(),
            hello: async () => {
              throw new Error('ENOENT');
            },
          }) as unknown as SessionClient,
        now: (() => {
          // First read starts the clock, the second is already past the budget,
          // so the poll loop runs exactly once instead of for 15 real seconds.
          let calls = 0;
          return () => (calls++ === 0 ? 0 : 1_000_000);
        })(),
      },
      unreachable,
    );

    const result = await sessionSetup({}, { session });

    expect(result.ok).toBe(false);
    expect(result.steps.find((step) => step.step === 'wait')?.ok).toBe(false);
    expect(result.nextSteps.join(' ')).toContain('fast user switching');
  });

  it('does not touch sudo on a host that is not macOS', async () => {
    const { session, scripts } = setupSeams({}, discovery({ platform: 'linux' }));
    const result = await sessionSetup({}, { session });

    expect(result.ok).toBe(false);
    expect(scripts).toHaveLength(0);
    expect(result.nextSteps.join(' ')).toContain('macOS-only');
  });
});

/* -------------------------------------------------------------------------- */
/* the command tree                                                           */
/* -------------------------------------------------------------------------- */

interface Captured {
  code: number;
  out: string;
  err: string;
}

async function cli(
  argv: string[],
  options: { cwd?: string; deps?: Partial<ApiDeps>; isTty?: boolean } = {},
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    cwd: () => options.cwd ?? process.cwd(),
    env: {},
    isTty: () => options.isTty ?? false,
    ...(options.deps === undefined ? {} : { deps: options.deps }),
  };
  const code = await main(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('offstage session status', () => {
  it('exits 0 when the lane is available, so a script can gate on it', async () => {
    const { session } = seams();
    const result = await cli(['session', 'status'], { deps: { session } });

    expect(result.code).toBe(0);
    expect(result.out).toContain('session lane available');
    expect(result.out).toContain('off your screen');
  });

  it('exits 69 with the fix when it is not', async () => {
    const { session } = seams({ discovery: discovery({ socketPresent: false }) });
    const result = await cli(['session', 'status'], { deps: { session } });

    expect(result.code).toBe(69);
    expect(result.out).toContain('unavailable');
    expect(result.out).toContain('fix: offstage session setup');
  });

  it('puts the JSON on stdout and the human lines on stderr under --json', async () => {
    const { session } = seams();
    const result = await cli(['session', 'status', '--json'], { deps: { session } });

    const parsed = JSON.parse(result.out) as { available: boolean; display: { scale: number } };
    expect(parsed.available).toBe(true);
    expect(parsed.display.scale).toBe(2);
    expect(result.err).toContain('session lane available');
  });
});

describe('offstage session setup', () => {
  it('refuses without a terminal, because sudo has nowhere to prompt', async () => {
    const { session, scripts } = setupSeams();
    const result = await cli(['session', 'setup'], { deps: { session }, isTty: false });

    expect(result.code).toBe(64);
    expect(result.err).toContain('Run it in a terminal.');
    expect(scripts).toHaveLength(0);
  });

  it('runs when there is a terminal, and prints the script it ran', async () => {
    const { session, scripts } = setupSeams();
    const result = await cli(['session', 'setup'], { deps: { session }, isTty: true });

    expect(result.code).toBe(0);
    expect(scripts).toHaveLength(1);
    expect(result.out).toContain('launchctl bootstrap');
    expect(result.out).toContain('Next:');
  });

  it('keeps stdout a single JSON document under --json, script and all', async () => {
    const { session } = setupSeams();
    const result = await cli(['session', 'setup', '--json'], { deps: { session }, isTty: true });

    const parsed = JSON.parse(result.out) as { ok: boolean; script: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.script).toContain('launchctl bootstrap');
    expect(result.err).toContain('This is the only step that needs root');
  });
});

describe('offstage session input, click, type, key', () => {
  it('takes a JSON actions array', async () => {
    const { session, client } = seams();
    const result = await cli(
      ['session', 'input', '[{"type":"move","x":10,"y":20},{"type":"wait","ms":50}]'],
      { deps: { session } },
    );

    expect(result.code).toBe(0);
    expect(client.calls.at(-1)?.payload).toEqual([
      { type: 'move', x: 10, y: 20 },
      { type: 'wait', ms: 50 },
    ]);
  });

  it('rejects an actions argument that is not JSON, with exit 64', async () => {
    const { session, client } = seams();
    const result = await cli(['session', 'input', '{not json}'], { deps: { session } });

    expect(result.code).toBe(64);
    expect(client.calls).toHaveLength(0);
  });

  it('builds exactly one action for click, type and key', async () => {
    const { session, client } = seams();

    await cli(['session', 'click', '640', '400', '--button', 'right', '--count', '2'], {
      deps: { session },
    });
    expect(client.calls.at(-1)?.payload).toEqual([
      { type: 'click', x: 640, y: 400, button: 'right', count: 2 },
    ]);

    await cli(['session', 'type', 'hello world'], { deps: { session } });
    expect(client.calls.at(-1)?.payload).toEqual([{ type: 'type', text: 'hello world' }]);

    await cli(['session', 'key', 'cmd+shift+t'], { deps: { session } });
    expect(client.calls.at(-1)?.payload).toEqual([{ type: 'key', key: 'cmd+shift+t' }]);
  });

  it('exits 69 with the fix when the daemon refuses for a missing grant', async () => {
    const { session } = seams({
      client: fakeClient({
        onInput: () => {
          throw new SessionRpcError('accessibility is not granted', 'tcc-accessibility', 'allow Accessibility');
        },
      }),
    });
    const result = await cli(['session', 'key', 'cmd+q'], { deps: { session } });

    expect(result.code).toBe(69);
    expect(result.err).toContain('fix: allow Accessibility');
  });
});

describe('offstage session screenshot and apps', () => {
  it('writes the PNG to --out and prints where it went', async () => {
    const dir = await tempDir();
    const out = path.join(dir, 'shot.png');
    const { session } = seams();

    const result = await cli(['session', 'screenshot', '--out', out], { deps: { session } });

    expect(result.code).toBe(0);
    expect(result.out).toContain(out);
    expect(await fs.readFile(out)).toEqual(PNG);
  });

  it('writes into .offstage/screenshots and prints the path when --out is absent', async () => {
    const cwd = await tempDir();
    const { session } = seams();

    const result = await cli(['session', 'screenshot'], { cwd, deps: { session } });

    expect(result.code).toBe(0);
    expect(result.out).toContain(path.join(cwd, '.offstage', 'screenshots'));
    const written = await fs.readdir(path.join(cwd, '.offstage', 'screenshots'));
    expect(written).toHaveLength(1);
  });

  it('keeps the PNG bytes out of the JSON envelope', async () => {
    const dir = await tempDir();
    const { session } = seams();
    const result = await cli(['session', 'screenshot', '--json', '--out', path.join(dir, 'a.png')], {
      deps: { session },
    });

    const parsed = JSON.parse(result.out) as Record<string, unknown>;
    expect(parsed.png).toBeUndefined();
    expect(parsed.width).toBe(1728);
  });

  it('lists the apps running in the helper session', async () => {
    const { session } = seams();
    const result = await cli(['session', 'apps'], { deps: { session } });

    expect(result.code).toBe(0);
    expect(result.out).toContain('Safari');
    expect(result.out).toContain('com.apple.Safari');
  });
});

describe('defaultSleep', () => {
  it('keeps the event loop alive while waiting (regression: setup exited mid-await on the first live run)', async () => {
    const { defaultSleep } = await import('../src/cli/session.js');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    // A child process that sleeps via the same mechanism and then prints: if the
    // timer were unref'd, the process would exit before printing anything.
    const script = `const p = new Promise(r => setTimeout(r, 50)); await p; console.log('awake');`;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script]);
    expect(stdout.trim()).toBe('awake');
    const started = Date.now();
    await defaultSleep(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});
