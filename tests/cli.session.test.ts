/**
 * `offstage session status` and `offstage session setup`: everything about
 * whether the lane exists and can be reached, over `src/cli/session.ts`.
 *
 * The verbs that drive a lane which is already up live in
 * `cli.session-control.test.ts`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { SessionSeams } from '../src/cli/session.js';
import { sessionSetup, sessionStatus } from '../src/cli/session.js';
import { doctor } from '../src/cli/api.js';
import type { SessionClient } from '../src/session/index.js';
import {
  cleanupTemps,
  cli,
  discovery,
  fakeClient,
  fakeLane,
  hello,
  seams,
} from './cli.session.fixtures.js';
afterEach(cleanupTemps);

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
