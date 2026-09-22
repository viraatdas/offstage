/**
 * Windows that open off the helper session's main display.
 *
 * The daemon's screenshot and input cover only the main display. Measured: a
 * SwiftUI app (i2Message) opened its only window at x=-1920 on a second
 * display, and every screenshot showed an empty desktop. `launch` now asks the
 * daemon to gather such windows; `screenshot` warns about ones it cannot see.
 * Every client here is a fake; nothing touches a real session.
 */

import { describe, expect, it } from 'vitest';

import { sessionGather, sessionLaunch, sessionScreenshot } from '../src/cli/session-control.js';
import { describeGather, describeOffDisplayWindows, gatherWindowsOf, intersects } from '../src/cli/session-gather.js';
import type { SessionGatherWindows } from '../src/session/index.js';
import { SessionRpcError, isUnknownOpError } from '../src/session/index.js';
import type { FakeClient } from './cli.session.fixtures.js';
import { MAIN_DISPLAY, cli, fakeClient, seams } from './cli.session.fixtures.js';

const I2MESSAGE = {
  pid: 51313,
  name: 'i2Message',
  bundleId: 'ai.exla.i2message',
  active: true,
  hidden: false,
};

/** The measured case: the only window, 1920 wide, on the display at x=-1920. */
const OFF_DISPLAY = { x: -1920, y: 67, w: 1920, h: 1050 };

function movedAnswer(pid: number): SessionGatherWindows {
  return {
    pid,
    windows: [{ before: OFF_DISPLAY, after: { x: 0, y: 30, w: 1728, h: 1050 }, moved: true }],
    mainDisplay: MAIN_DISPLAY,
    axError: null,
  };
}

const unknownOp = (): never => {
  throw new SessionRpcError("unknown op 'gather-windows'", 'bad-request');
};

/** A client where i2Message is registered from the first poll. */
function launchedClient(gatherWindows?: (pid: number) => SessionGatherWindows): FakeClient {
  const base = fakeClient(gatherWindows === undefined ? {} : { gatherWindows });
  return Object.assign(base, {
    async apps() {
      base.calls.push({ op: 'apps' });
      return [I2MESSAGE];
    },
  });
}

/** A clock the fake sleep advances, so polling finishes instantly. */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

describe('sessionLaunch window gathering', () => {
  it('moves a window that opened off the main display, and says so in the diagnostics', async () => {
    const client = launchedClient(movedAnswer);
    const { session } = seams({ client, ...clock() });

    const result = await sessionLaunch({ target: 'i2Message' }, { session });

    expect(result.ok).toBe(true);
    expect(client.calls.filter((call) => call.op === 'gather-windows')).toEqual([
      { op: 'gather-windows', payload: 51313 },
    ]);
    expect(result.gather).toMatchObject({ supported: true, moved: 1, mainDisplay: MAIN_DISPLAY });
    const said = result.diagnostics.join('\n');
    expect(said).toContain('Moved a window of i2Message (pid 51313)');
    expect(said).toContain('{x:-1920, y:67, w:1920, h:1050}');
    expect(said).toContain('{x:0, y:30, w:1728, h:1050}');
  });

  it('keeps asking until the app has a window, since windows appear after registration', async () => {
    let attempts = 0;
    const client = launchedClient((pid) => {
      attempts += 1;
      return attempts < 3
        ? { pid, windows: [], mainDisplay: MAIN_DISPLAY, axError: -25204 }
        : movedAnswer(pid);
    });
    const { session } = seams({ client, ...clock() });

    const result = await sessionLaunch({ target: 'i2Message' }, { session });

    expect(attempts).toBe(3);
    expect(result.gather?.moved).toBe(1);
  });

  it('gives up after the wait window without failing the launch', async () => {
    const client = launchedClient((pid) => ({ pid, windows: [], mainDisplay: MAIN_DISPLAY, axError: -25204 }));
    const { session } = seams({ client, ...clock() });

    const result = await sessionLaunch({ target: 'i2Message' }, { session });

    expect(result.ok).toBe(true);
    expect(result.gather?.moved).toBe(0);
    expect(result.diagnostics.join(' ')).toContain('showed no window within 3.0s');
    expect(result.diagnostics.join(' ')).toContain('offstage session gather');
  });

  it('says nothing when every window is already on the main display', async () => {
    const client = launchedClient();
    const { session } = seams({ client, ...clock() });

    const result = await sessionLaunch({ target: 'i2Message' }, { session });

    expect(result.ok).toBe(true);
    expect(result.gather).toMatchObject({ supported: true, moved: 0 });
    expect(result.diagnostics).toEqual([]);
  });

  it('does not fail the launch on a daemon that predates the op, and says how to update it', async () => {
    const client = launchedClient(unknownOp);
    const { session } = seams({ client, ...clock() });

    const result = await sessionLaunch({ target: 'i2Message' }, { session });

    expect(result.ok).toBe(true);
    expect(result.app?.pid).toBe(51313);
    expect(result.gather).toMatchObject({ supported: false, moved: 0, windows: [] });
    const said = result.diagnostics.join(' ');
    expect(said).toContain('older than window gathering');
    expect(said).toContain('offstage session update');
    expect(said).toContain('offstage session setup');
  });

  it('turns a missing Accessibility grant into a diagnostic carrying the daemon’s fix', async () => {
    const client = launchedClient(() => {
      throw new SessionRpcError(
        'accessibility permission is not granted to offstage-sessiond in the computeruse session',
        'tcc-accessibility',
        'switch to the computeruse account once and allow Accessibility',
      );
    });
    const { session } = seams({ client, ...clock() });

    const result = await sessionLaunch({ target: 'i2Message' }, { session });

    expect(result.ok).toBe(true);
    expect(result.diagnostics.join(' ')).toContain('allow Accessibility');
  });

  it('never asks the daemon to gather when gatherWindows is false', async () => {
    const client = launchedClient(movedAnswer);
    const { session } = seams({ client, ...clock() });

    const result = await sessionLaunch({ target: 'i2Message', gatherWindows: false }, { session });

    expect(result.ok).toBe(true);
    expect(result.gather).toBeNull();
    expect(client.calls.some((call) => call.op === 'gather-windows')).toBe(false);
  });

  it('carries --no-gather-windows from the CLI', async () => {
    const client = launchedClient(movedAnswer);
    const { session } = seams({ client, ...clock() });

    const captured = await cli(['session', 'launch', '--json', '--no-gather-windows', 'i2Message'], {
      deps: { session },
    });

    expect(captured.code).toBe(0);
    expect(client.calls.some((call) => call.op === 'gather-windows')).toBe(false);
  });

  it('prints what it moved in the human rendering', async () => {
    const client = launchedClient(movedAnswer);
    const { session } = seams({ client, ...clock() });

    const captured = await cli(['session', 'launch', 'i2Message'], { deps: { session } });

    expect(captured.code).toBe(0);
    expect(captured.out).toContain('Moved a window of i2Message');
  });
});

describe('sessionScreenshot off-display warning', () => {
  const WINDOW = { pid: 51313, owner: 'i2Message', name: 'i2Message', bounds: OFF_DISPLAY };

  it('reports windows the capture could not include, with a warning naming them', async () => {
    const { session } = seams({ client: fakeClient({ offDisplayWindows: [WINDOW] }) });

    const result = await sessionScreenshot({ out: null }, { session });

    expect(result.offDisplayWindows).toEqual([WINDOW]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toContain("1 window(s) are on a display this capture doesn't include");
    expect(result.diagnostics[0]).toContain('i2Message "i2Message" (pid 51313) at {x:-1920, y:67, w:1920, h:1050}');
    expect(result.diagnostics[0]).toContain('offstage session gather');
  });

  it('warns nothing when every window is on the captured display', async () => {
    const { session } = seams();

    const result = await sessionScreenshot({ out: null }, { session });

    expect(result.offDisplayWindows).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('prints the warning from the CLI and keeps it in the JSON envelope', async () => {
    const { session } = seams({ client: fakeClient({ offDisplayWindows: [WINDOW] }) });

    const human = await cli(['session', 'screenshot', '--out', '/dev/null'], { deps: { session } });
    expect(human.out).toContain("on a display this capture doesn't include");

    const json = await cli(['session', 'screenshot', '--json', '--out', '/dev/null'], { deps: { session } });
    const envelope = JSON.parse(json.out) as { offDisplayWindows: unknown[]; diagnostics: string[] };
    expect(envelope.offDisplayWindows).toHaveLength(1);
    expect(envelope.diagnostics[0]).toContain('offstage session gather');
  });
});

describe('sessionGather', () => {
  it('gathers every matching app once', async () => {
    const client = launchedClient(movedAnswer);
    const { session } = seams({ client, ...clock() });

    const result = await sessionGather({ target: 'i2Message' }, { session });

    expect(result.ok).toBe(true);
    expect(result.apps).toEqual([
      { pid: 51313, name: 'i2Message', windows: movedAnswer(51313).windows, moved: 1 },
    ]);
    expect(client.calls.filter((call) => call.op === 'gather-windows')).toHaveLength(1);
  });

  it('takes a pid without listing apps', async () => {
    const client = launchedClient(movedAnswer);
    const { session } = seams({ client, ...clock() });

    const result = await sessionGather({ target: 4242 }, { session });

    expect(result.apps[0]?.pid).toBe(4242);
    expect(client.calls.some((call) => call.op === 'apps')).toBe(false);
  });

  it('is not ok when nothing matches, or when the daemon predates the op', async () => {
    const { session } = seams({ client: launchedClient(), ...clock() });
    const none = await sessionGather({ target: 'NotRunning' }, { session });
    expect(none.ok).toBe(false);
    expect(none.diagnostics.join(' ')).toContain('No app running');

    const old = seams({ client: launchedClient(unknownOp), ...clock() });
    const stale = await sessionGather({ target: 'i2Message' }, { session: old.session });
    expect(stale.ok).toBe(false);
    expect(stale.diagnostics.join(' ')).toContain('offstage session update');
  });

  it('is wired into the command tree', async () => {
    const { session } = seams({ client: launchedClient(movedAnswer), ...clock() });

    const captured = await cli(['session', 'gather', 'i2Message'], { deps: { session } });

    expect(captured.code).toBe(0);
    expect(captured.out).toContain('1 window checked, 1 moved onto the captured display');
  });
});

describe('gathering helpers', () => {
  it('isUnknownOpError recognises only the daemon’s unknown-op refusal', () => {
    expect(isUnknownOpError(new SessionRpcError("unknown op 'gather-windows'", 'bad-request'))).toBe(true);
    expect(isUnknownOpError(new SessionRpcError('gather-windows requires a positive integer "pid"', 'bad-request'))).toBe(false);
    expect(isUnknownOpError(new SessionRpcError("unknown op 'x'", 'internal'))).toBe(false);
    expect(isUnknownOpError(new Error("unknown op 'x'"))).toBe(false);
  });

  it('intersects matches CGRect semantics for touching and overlapping frames', () => {
    expect(intersects(OFF_DISPLAY, MAIN_DISPLAY)).toBe(false); // touches x=0, no area
    expect(intersects({ x: -10, y: 0, w: 20, h: 20 }, MAIN_DISPLAY)).toBe(true);
    expect(intersects({ x: 0, y: 0, w: 0, h: 20 }, MAIN_DISPLAY)).toBe(false);
  });

  it('describeGather reports a window it could not move', () => {
    const lines = describeGather(
      {
        pid: 1,
        windows: [{ before: OFF_DISPLAY, after: OFF_DISPLAY, moved: false, error: 'setting position failed (AXError -25200)' }],
        mainDisplay: MAIN_DISPLAY,
        axError: null,
      },
      'App (pid 1)',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('could not be moved: setting position failed');
  });

  it('describeOffDisplayWindows is silent for an empty list', () => {
    expect(describeOffDisplayWindows([])).toEqual([]);
  });

  it('gatherWindowsOf with no wait asks exactly once', async () => {
    const client = fakeClient({ gatherWindows: (pid) => ({ pid, windows: [], mainDisplay: MAIN_DISPLAY, axError: null }) });
    const outcome = await gatherWindowsOf(client, 7, { label: 'X (pid 7)', waitMs: 0, ...clock() });
    expect(client.calls.filter((call) => call.op === 'gather-windows')).toHaveLength(1);
    expect(outcome.diagnostics[0]).toContain('X (pid 7) showed no window, so none was gathered');
  });
});
