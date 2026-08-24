/**
 * The `offstage session` verbs that drive a daemon which is already running,
 * over `src/cli/session-control.ts`: screenshot, input, apps, open, share,
 * unshare and launch.
 *
 * Bringing the lane up is `cli.session.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';

import fs from 'node:fs/promises';
import path from 'node:path';

import { OffstageUsageError } from '../src/cli/api.js';
import { OffstageSessionError } from '../src/cli/session.js';
import {
  sessionApps,
  sessionInput,
  sessionLaunch,
  sessionOpen,
  sessionScreenshot,
  sessionShare,
  sessionUnshare,
} from '../src/cli/session-control.js';
import type { ExecOutcome, InputAction } from '../src/session/index.js';
import { SessionRpcError } from '../src/session/index.js';
import type { FakeClient } from './cli.session.fixtures.js';

import {
  PNG,
  cleanupTemps,
  cli,
  discovery,
  fakeClient,
  fakeLane,
  hello,
  seams,
  tempDir,
} from './cli.session.fixtures.js';

afterEach(cleanupTemps);


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
