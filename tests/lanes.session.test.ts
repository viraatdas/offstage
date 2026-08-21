/**
 * Session lane tests.
 *
 * The hard requirement, same as the other lanes: **this file passes on a
 * machine with no `offstage-sessiond` installed** — which is the machine it was
 * written on. Every rung of the availability ladder and every failure mode of
 * `run()` is driven through the lane's three seams (`discover`, `createClient`,
 * `exec`), so nothing here logs anyone in, binds a socket, runs `chmod`, or
 * puts a single pixel on a display.
 *
 * The invariants worth stating: the lane never throws, every result satisfies
 * the contract, and there is no path that runs the command anywhere other than
 * inside the helper session.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LaneRequest } from '../src/contract/index.js';
import { isLaneResult, parseLaneResult } from '../src/contract/index.js';

import type {
  Exec,
  SessionApp,
  SessionClient,
  SessionClientOptions,
  SessionDiscovery,
  SessionHello,
  SessionRunRequest,
  SessionRunResult,
  SessionScreenshot,
} from '../src/session/index.js';
import { SessionRpcError, SessionUnreachableError } from '../src/session/index.js';
import {
  ISOLATION_NOTE,
  SCREENSHOT_FILENAME,
  SETUP_FIX,
  SessionLane,
  createSessionLane,
  sessionLane,
} from '../src/lanes/session/index.js';

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

/** The machine this lane was built against: computeruse, uid 502, backgrounded. */
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

const HELLO: SessionHello = {
  ok: true,
  daemon: { version: '1', pid: 4242, protocol: 1 },
  user: { uid: 502, name: 'computeruse', home: '/Users/computeruse' },
  session: { onConsole: false, managerName: 'Aqua' },
  display: { width: 1728, height: 1117, scale: 2 },
  permissions: { screenCapture: true, accessibility: true },
};

const PNG = Buffer.from('\x89PNG\r\n\x1a\npretend', 'binary');

interface FakeClientOptions {
  hello?: SessionHello | (() => Promise<SessionHello>);
  access?: (target: string) => Promise<{
    ok: true;
    exists: boolean;
    readable: boolean;
    writable: boolean;
    directory: boolean;
  }>;
  run?: (request: SessionRunRequest) => Promise<SessionRunResult>;
  screenshot?: () => Promise<SessionScreenshot>;
}

interface FakeClient extends SessionClient {
  runs: SessionRunRequest[];
  accessed: string[];
  screenshots: number;
}

function fakeClient(options: FakeClientOptions = {}): FakeClient {
  const client: FakeClient = {
    socketPath: '/tmp/offstage-session/502.sock',
    runs: [],
    accessed: [],
    screenshots: 0,
    async hello() {
      return typeof options.hello === 'function'
        ? await options.hello()
        : (options.hello ?? HELLO);
    },
    async access(target) {
      client.accessed.push(target);
      return await (options.access ?? defaultAccess)(target);
    },
    async run(request) {
      client.runs.push(request);
      return await (options.run ?? defaultRun)(request);
    },
    async screenshot() {
      client.screenshots += 1;
      return await (options.screenshot ?? defaultScreenshot)();
    },
    async input() {
      return { performed: 0 };
    },
    async apps(): Promise<SessionApp[]> {
      return [];
    },
    async requestPermissions() {
      return HELLO.permissions;
    },
    async restart() {
      return { restarting: true };
    },
  };
  return client;
}

const defaultAccess = async (): Promise<{
  ok: true;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  directory: boolean;
}> => ({ ok: true, exists: true, readable: true, writable: false, directory: true });

const defaultRun = async (request: SessionRunRequest): Promise<SessionRunResult> => {
  request.onStarted?.(5120);
  request.onOutput?.(Buffer.from('all good\n'));
  return { exitCode: 0, signal: null, timedOut: false, durationMs: 12, pid: 5120 };
};

const defaultScreenshot = async (): Promise<SessionScreenshot> => ({
  png: PNG,
  width: 1728,
  height: 1117,
  scale: 2,
});

/** An exec that records `chmod` calls and succeeds. */
function fakeExec(outcome = { stdout: '', stderr: '', exitCode: 0 as number | null }): Exec & {
  calls: Array<{ file: string; args: string[] }>;
} {
  const calls: Array<{ file: string; args: string[] }> = [];
  const exec = (async (file, args) => {
    calls.push({ file, args });
    return outcome;
  }) as Exec & { calls: Array<{ file: string; args: string[] }> };
  exec.calls = calls;
  return exec;
}

/** Build a lane whose seams are all fake, with sensible defaults. */
function laneWith(options: {
  discovery?: SessionDiscovery;
  client?: FakeClient;
  exec?: Exec;
}): { lane: SessionLane; client: FakeClient; exec: Exec & { calls: Array<{ file: string; args: string[] }> } } {
  const client = options.client ?? fakeClient();
  const exec = (options.exec ?? fakeExec()) as Exec & {
    calls: Array<{ file: string; args: string[] }>;
  };
  const lane = createSessionLane({
    discover: async () => options.discovery ?? discovery(),
    createClient: (_clientOptions: SessionClientOptions) => client,
    exec,
    now: () => 1_700_000_000_000,
  });
  return { lane, client, exec };
}

/* -------------------------------------------------------------------------- */
/* Scratch run directory                                                      */
/* -------------------------------------------------------------------------- */

let artifactsDir: string;
let cwd: string;

beforeEach(async () => {
  const root = await fs.mkdtemp('/tmp/offstage-session-lane-');
  artifactsDir = path.join(root, 'runs', 'x');
  cwd = path.join(root, 'repo');
  await fs.mkdir(artifactsDir, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
});

afterEach(async () => {
  await fs.rm(path.dirname(path.dirname(artifactsDir)), { recursive: true, force: true });
});

const request = (overrides: Partial<LaneRequest> = {}): LaneRequest => ({
  cwd,
  command: ['npx', 'playwright', 'test', '--headed'],
  artifactsDir,
  ...overrides,
});

/* -------------------------------------------------------------------------- */
/* isAvailable                                                                */
/* -------------------------------------------------------------------------- */

describe('SessionLane.isAvailable', () => {
  it('refuses off macOS, and points at the container lane', async () => {
    const { lane } = laneWith({ discovery: discovery({ platform: 'linux' }) });
    const availability = await lane.isAvailable();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('macOS-only');
    expect(availability.fix).toContain('container lane');
  });

  it('says to create the account when it does not exist', async () => {
    const { lane } = laneWith({
      discovery: discovery({ accountExists: false, uid: null, guiSession: { exists: false, loginDone: false, onConsole: false, sessionId: null } }),
    });
    const availability = await lane.isAvailable();
    expect(availability.reason).toContain('no "computeruse" account');
    expect(availability.fix).toBe('offstage session setup --create');
  });

  it('says to log the account in when it has no GUI session', async () => {
    const { lane } = laneWith({
      discovery: discovery({
        guiSession: { exists: false, loginDone: false, onConsole: false, sessionId: null },
      }),
    });
    const availability = await lane.isAvailable();
    expect(availability.reason).toContain('no logged-in GUI session');
    expect(availability.fix).toContain('fast user switching');
    expect(availability.fix).toContain('Computer Use');
    expect(availability.fix).toContain('keeps running in the background');
  });

  it('treats a login window (loginDone false) as no session', async () => {
    const { lane } = laneWith({
      discovery: discovery({
        guiSession: { exists: true, loginDone: false, onConsole: false, sessionId: 258 },
      }),
    });
    expect((await lane.isAvailable()).fix).toContain('fast user switching');
  });

  it('refuses when the helper session is the one on screen', async () => {
    const { lane } = laneWith({
      discovery: discovery({
        guiSession: { exists: true, loginDone: true, onConsole: true, sessionId: 258 },
      }),
    });
    const availability = await lane.isAvailable();
    expect(availability.reason).toContain('currently the one on your screen');
    expect(availability.fix).toContain('Switch back to your own account');
  });

  it('says setup when there is no socket', async () => {
    const { lane } = laneWith({ discovery: discovery({ socketPresent: false }) });
    const availability = await lane.isAvailable();
    expect(availability.reason).toContain('/tmp/offstage-session/502.sock');
    expect(availability.fix).toBe(SETUP_FIX);
  });

  it('says setup when the daemon does not answer hello', async () => {
    const { lane } = laneWith({
      client: fakeClient({
        hello: async () => {
          throw new SessionUnreachableError(
            'Could not talk to the offstage session daemon',
            '/tmp/offstage-session/502.sock',
            'ECONNREFUSED',
          );
        },
      }),
    });
    const availability = await lane.isAvailable();
    expect(availability.available).toBe(false);
    expect(availability.fix).toBe(SETUP_FIX);
  });

  it('is available when the daemon answers, TCC grants or not', async () => {
    const { lane } = laneWith({});
    expect(await lane.isAvailable()).toEqual({ available: true });

    const { lane: ungranted } = laneWith({
      client: fakeClient({
        hello: async () => ({
          ...HELLO,
          permissions: { screenCapture: false, accessibility: false },
        }),
      }),
    });
    expect((await ungranted.isAvailable()).available).toBe(true);
  });

  it('never throws, even when discovery itself does', async () => {
    const lane = createSessionLane({
      discover: async () => {
        throw new Error('ioreg exploded');
      },
    });
    const availability = await lane.isAvailable();
    expect(availability.available).toBe(false);
    expect(availability.reason).toContain('ioreg exploded');
  });

  it('reports missing TCC grants as a note, not a refusal', async () => {
    const { lane } = laneWith({
      client: fakeClient({
        hello: async () => ({
          ...HELLO,
          permissions: { screenCapture: false, accessibility: false },
        }),
      }),
    });
    const probe = await lane.probeSession();
    expect(probe.availability.available).toBe(true);
    expect(probe.notes.join('\n')).toContain('Screen Recording and Accessibility');
    expect(probe.notes.join('\n')).toContain('System Settings → Privacy & Security');
  });
});

/* -------------------------------------------------------------------------- */
/* run                                                                        */
/* -------------------------------------------------------------------------- */

describe('SessionLane.run', () => {
  it('skips without running anything when the lane is unavailable', async () => {
    const { lane, client } = laneWith({ discovery: discovery({ socketPresent: false }) });
    const result = await lane.run(request());

    expect(parseLaneResult(result).status).toBe('skipped');
    expect(client.runs).toHaveLength(0);
    expect(result.diagnostics.join('\n')).toContain('does not fall back to your real screen');
    expect(result.diagnostics.join('\n')).toContain(SETUP_FIX);
  });

  it('errors with the share command when the helper account cannot read cwd', async () => {
    const client = fakeClient({
      access: async () => ({
        ok: true,
        exists: true,
        readable: false,
        writable: false,
        directory: true,
      }),
    });
    const { lane } = laneWith({ client });
    const result = await lane.run(request());

    expect(result.status).toBe('errored');
    expect(client.runs).toHaveLength(0);
    expect(result.diagnostics.join('\n')).toContain(`offstage session share ${cwd}`);
    expect(result.diagnostics.join('\n')).toContain('never grants write');
    expect(isLaneResult(result)).toBe(true);
  });

  it('errors when the daemon cannot be asked about cwd at all', async () => {
    const client = fakeClient({
      access: async () => {
        throw new SessionUnreachableError('daemon gone', '/tmp/offstage-session/502.sock');
      },
    });
    const { lane } = laneWith({ client });
    const result = await lane.run(request());
    expect(result.status).toBe('errored');
    expect(result.diagnostics.join('\n')).toContain('daemon gone');
    expect(client.runs).toHaveLength(0);
  });

  it('errors when the artifacts directory cannot be opened to the helper account', async () => {
    const { lane, client } = laneWith({
      exec: fakeExec({ stdout: '', stderr: 'chmod: Operation not permitted', exitCode: 1 }),
    });
    const result = await lane.run(request());

    expect(result.status).toBe('errored');
    expect(client.runs).toHaveLength(0);
    expect(result.diagnostics.join('\n')).toContain('Operation not permitted');
  });

  it('grants write on exactly the run directory, and nothing else', async () => {
    const { lane, exec } = laneWith({});
    await lane.run(request());
    expect(exec.calls).toHaveLength(1);
    const call = exec.calls[0]!;
    expect(call.file).toBe('/bin/chmod');
    expect(call.args[0]).toBe('+a');
    expect(call.args[1]).toContain('computeruse allow read,write');
    expect(call.args[2]).toBe(artifactsDir);
  });

  it('runs the command in the session and streams output into command.log', async () => {
    const client = fakeClient({
      run: async (runRequest) => {
        runRequest.onStarted?.(5120);
        runRequest.onOutput?.(Buffer.from('chunk one\n'));
        runRequest.onOutput?.(Buffer.from('chunk two\n'));
        return { exitCode: 0, signal: null, timedOut: false, durationMs: 42, pid: 5120 };
      },
    });
    const { lane } = laneWith({ client });
    const result = await lane.run(request({ timeoutMs: 60_000 }));

    expect(parseLaneResult(result)).toBeTruthy();
    expect(result.status).toBe('passed');
    expect(result.exitCode).toBe(0);
    expect(result.logPath).toBe(path.join(artifactsDir, 'command.log'));
    expect(await fs.readFile(path.join(artifactsDir, 'command.log'), 'utf8')).toBe(
      'chunk one\nchunk two\n',
    );
    expect(client.runs[0]?.argv).toEqual(['npx', 'playwright', 'test', '--headed']);
    expect(client.runs[0]?.cwd).toBe(cwd);
    expect(client.runs[0]?.timeoutMs).toBe(60_000);
  });

  it('strips DISPLAY and sets the offstage environment', async () => {
    const { lane, client } = laneWith({});
    await lane.run(request({ env: { DISPLAY: ':99', CI: '1' } }));

    expect(client.runs[0]?.env).toEqual({
      CI: '1',
      OFFSTAGE_ARTIFACTS: artifactsDir,
      OFFSTAGE_LANE: 'session',
    });
  });

  it('names the account, the session and the isolation it is not', async () => {
    const { lane } = laneWith({});
    const diagnostics = (await lane.run(request())).diagnostics.join('\n');

    expect(diagnostics).toContain('"computeruse"');
    expect(diagnostics).toContain('uid 502');
    expect(diagnostics).toContain('session id 258');
    expect(diagnostics).toContain('Nothing was drawn on your screen');
    expect(diagnostics).toContain(ISOLATION_NOTE);
    expect(diagnostics).toContain('session isolation, not machine isolation');
  });

  it('captures the helper session screen as a screenshot artifact', async () => {
    const { lane, client } = laneWith({});
    const result = await lane.run(request());

    expect(client.screenshots).toBe(1);
    const shot = result.artifacts.find((artifact) => artifact.kind === 'screenshot');
    expect(shot?.path).toBe(path.join(artifactsDir, SCREENSHOT_FILENAME));
    expect(await fs.readFile(path.join(artifactsDir, SCREENSHOT_FILENAME))).toEqual(PNG);
    expect(result.diagnostics.join('\n')).toContain("other account's screen, not yours");
  });

  it('turns a screenshot TCC failure into a diagnostic, never an error', async () => {
    const client = fakeClient({
      screenshot: async () => {
        throw new SessionRpcError(
          'Screen Recording is not granted.',
          'tcc-screen-capture',
          'switch to the computeruse account once and allow Screen Recording for offstage-sessiond in System Settings → Privacy & Security',
        );
      },
    });
    const { lane } = laneWith({ client });
    const result = await lane.run(request());

    expect(result.status).toBe('passed');
    expect(result.artifacts.some((artifact) => artifact.kind === 'screenshot')).toBe(false);
    expect(result.diagnostics.join('\n')).toContain('No screenshot was taken');
    expect(result.diagnostics.join('\n')).toContain('Screen Recording');
    expect(result.diagnostics.join('\n')).toContain('its result is unaffected');
  });

  it('parses failures out of a failing run', async () => {
    const output = [
      '  1) [chromium] › tests/login.spec.ts:12:3 › login › shows an error ─────────',
      '',
      '    Error: expect(received).toBe(expected)',
      '',
      '      at tests/login.spec.ts:14:22',
      '',
      '  1 failed',
    ].join('\n');

    const client = fakeClient({
      run: async (runRequest) => {
        runRequest.onOutput?.(Buffer.from(output));
        return { exitCode: 1, signal: null, timedOut: false, durationMs: 90, pid: 1 };
      },
    });
    const { lane } = laneWith({ client });
    const result = await lane.run(request());

    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.failures[0]?.test).toBe('login › shows an error');
    expect(result.failures[0]?.file).toBe('tests/login.spec.ts');
    expect(result.failures[0]?.line).toBe(12);
  });

  it('reports a timeout as errored, with no exit code to interpret', async () => {
    const client = fakeClient({
      run: async () => ({
        exitCode: null,
        signal: 'SIGKILL',
        timedOut: true,
        durationMs: 5_000,
        pid: 1,
      }),
    });
    const { lane } = laneWith({ client });
    const result = await lane.run(request({ timeoutMs: 5_000 }));

    expect(result.status).toBe('errored');
    expect(result.exitCode).toBeNull();
    expect(result.diagnostics.join('\n')).toContain('Timed out after 5000ms');
    expect(result.diagnostics.join('\n')).toContain('nothing can be concluded');
  });

  it('never carries an exit code out of a timeout, even if one arrives', async () => {
    /* The daemon promises timedOut:true implies exitCode:null, because a child
       that exits during the SIGTERM grace period must not read as a clean run.
       The lane holds that line on its own side too. */
    const client = fakeClient({
      run: async () => ({
        exitCode: 0,
        signal: 'SIGTERM',
        timedOut: true,
        durationMs: 5_000,
        pid: 1,
      }),
    });
    const { lane } = laneWith({ client });
    const result = await lane.run(request({ timeoutMs: 5_000 }));
    expect(result.status).toBe('errored');
    expect(result.exitCode).toBeNull();
  });

  it('reports a spawn failure with the daemon’s own fix', async () => {
    const client = fakeClient({
      run: async () => {
        throw new SessionRpcError(
          'posix_spawn: No such file or directory',
          'spawn-failed',
          'offstage session share /Users/viraat/code/app',
        );
      },
    });
    const { lane } = laneWith({ client });
    const result = await lane.run(request());

    expect(result.status).toBe('errored');
    expect(result.diagnostics.join('\n')).toContain('No such file or directory');
    expect(result.diagnostics.join('\n')).toContain('offstage session share /Users/viraat/code/app');
    expect(isLaneResult(result)).toBe(true);
  });

  it('reports a daemon that dies mid-run as errored', async () => {
    const client = fakeClient({
      run: async (runRequest) => {
        runRequest.onOutput?.(Buffer.from('half a line'));
        throw new SessionUnreachableError(
          'The offstage session daemon closed the connection',
          '/tmp/offstage-session/502.sock',
          'closed',
        );
      },
    });
    const { lane } = laneWith({ client });
    const result = await lane.run(request());

    expect(result.status).toBe('errored');
    expect(result.diagnostics.join('\n')).toContain('became unreachable');
    /* Whatever did arrive is still on disk: a partial log beats no log. */
    expect(await fs.readFile(path.join(artifactsDir, 'command.log'), 'utf8')).toBe('half a line');
  });

  it('surfaces missing TCC grants in the run diagnostics', async () => {
    const client = fakeClient({
      hello: async () => ({
        ...HELLO,
        permissions: { screenCapture: true, accessibility: false },
      }),
    });
    const { lane } = laneWith({ client });
    const result = await lane.run(request());
    expect(result.diagnostics.join('\n')).toContain('Accessibility is not granted');
  });

  it('rejects a malformed request without touching the session', async () => {
    const { lane, client } = laneWith({});
    const result = await lane.run({
      cwd: 'not-absolute',
      command: [],
      artifactsDir,
    } as LaneRequest);

    expect(result.status).toBe('errored');
    expect(client.runs).toHaveLength(0);
    expect(result.diagnostics[0]).toContain('does not satisfy the offstage lane contract');
    expect(isLaneResult(result)).toBe(true);
  });

  it('always returns a contract-valid result', async () => {
    const scenarios: Array<() => Promise<unknown>> = [
      async () => await laneWith({}).lane.run(request()),
      async () =>
        await laneWith({ discovery: discovery({ platform: 'linux' }) }).lane.run(request()),
      async () =>
        await laneWith({
          client: fakeClient({
            run: async () => {
              throw new Error('boom');
            },
          }),
        }).lane.run(request()),
    ];
    for (const scenario of scenarios) {
      const result = await scenario();
      expect(isLaneResult(result)).toBe(true);
    }
  });
});

describe('the exported lane instance', () => {
  it('is a session lane that reports honestly on this machine', async () => {
    expect(sessionLane.lane).toBe('session');
    /* No daemon is installed here, so this must be false with a fix — and it
       must not throw, whatever this machine looks like. */
    const availability = await sessionLane.isAvailable();
    expect(typeof availability.available).toBe('boolean');
    if (!availability.available) expect(availability.reason).toBeTruthy();
  });
});
