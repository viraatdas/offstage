/**
 * Session discovery tests.
 *
 * Every assertion here runs green on a machine with **no helper account, no
 * daemon and no second session** — and equally on the machine this was written
 * on, which has all three. That is possible because discovery is a pure parser
 * over two pieces of text plus one injected exec seam: the fixtures in
 * `tests/fixtures/session/` are the *real* output of `ioreg -n Root -d1 -a` and
 * `dscl . -read /Users/computeruse …` recorded from that machine (with only
 * ioreg's 97 KB `IOKitDiagnostics` blob elided, which discovery never reads).
 *
 * Nothing here spawns `ioreg`, `dscl`, or anything else.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Exec, ExecOutcome } from '../src/session/index.js';
import {
  DEFAULT_SESSION_USER,
  DEFAULT_SOCKET_DIR,
  SESSION_DEFAULTS,
  SESSION_USER_ENV_VAR,
  describeSession,
  findConsoleUser,
  parseConsoleUsers,
  parseDsclRecord,
  readAccount,
  resolveSessionUser,
  sessionConfigPath,
  sessionSocketPath,
  sessionUserFullName,
} from '../src/session/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'session');

const fixture = async (name: string): Promise<string> =>
  await fs.readFile(path.join(FIXTURES, name), 'utf8');

const ok = (stdout: string): ExecOutcome => ({ stdout, stderr: '', exitCode: 0 });

/** An exec that answers from a table and records what it was asked. */
function fakeExec(table: Record<string, ExecOutcome>): Exec & { calls: string[][] } {
  const calls: string[][] = [];
  const exec = (async (file, args) => {
    calls.push([file, ...args]);
    return table[file] ?? { stdout: '', stderr: `no fake for ${file}`, exitCode: 127 };
  }) as Exec & { calls: string[][] };
  exec.calls = calls;
  return exec;
}

describe('parseConsoleUsers', () => {
  it('reads both GUI sessions out of real ioreg output', async () => {
    const users = parseConsoleUsers(await fixture('ioreg-root.plist'));
    expect(users).toHaveLength(2);

    const helper = users.find((entry) => entry.uid === 502);
    expect(helper).toEqual({
      uid: 502,
      user: 'computeruse',
      fullName: 'Computer Use',
      onConsole: false,
      loginDone: true,
      sessionId: 258,
    });

    const console_ = users.find((entry) => entry.uid === 501);
    expect(console_?.onConsole).toBe(true);
    expect(console_?.loginDone).toBe(true);
  });

  it('returns [] rather than throwing for output that is not a plist', () => {
    expect(parseConsoleUsers('')).toEqual([]);
    expect(parseConsoleUsers('ioreg: not found')).toEqual([]);
    expect(parseConsoleUsers('<plist version="1.0"><dict/></plist>')).toEqual([]);
  });

  it('nulls unknown fields instead of inventing them', () => {
    const users = parseConsoleUsers(
      '<plist version="1.0"><dict><key>IOConsoleUsers</key><array><dict/></array></dict></plist>',
    );
    expect(users).toEqual([
      { uid: null, user: null, fullName: null, onConsole: false, loginDone: false, sessionId: null },
    ]);
  });
});

describe('findConsoleUser', () => {
  it('matches on uid when one is known', async () => {
    const users = parseConsoleUsers(await fixture('ioreg-root.plist'));
    expect(findConsoleUser(users, { uid: 502 })?.user).toBe('computeruse');
    expect(findConsoleUser(users, { uid: 999 })).toBeUndefined();
  });

  it('falls back to the short name when the uid is unknown', async () => {
    const users = parseConsoleUsers(await fixture('ioreg-root.plist'));
    expect(findConsoleUser(users, { user: 'computeruse' })?.uid).toBe(502);
  });
});

describe('parseDsclRecord', () => {
  it('parses the real record, including the continuation line RealName uses', async () => {
    expect(parseDsclRecord(await fixture('dscl-computeruse.txt'))).toEqual({
      exists: true,
      uid: 502,
      home: '/Users/computeruse',
      fullName: 'Computer Use',
    });
  });

  it('reports a missing account rather than guessing', async () => {
    expect(parseDsclRecord(await fixture('dscl-missing.txt'))).toEqual({
      exists: false,
      uid: null,
      home: null,
      fullName: null,
    });
  });
});

describe('readAccount', () => {
  it('asks dscl for exactly the three attributes it needs', async () => {
    const exec = fakeExec({ '/usr/bin/dscl': ok(await fixture('dscl-computeruse.txt')) });
    const record = await readAccount('computeruse', exec);
    expect(record.uid).toBe(502);
    expect(exec.calls[0]).toEqual([
      '/usr/bin/dscl',
      '.',
      '-read',
      '/Users/computeruse',
      'UniqueID',
      'NFSHomeDirectory',
      'RealName',
    ]);
  });

  it('treats a non-zero dscl exit as "no such account"', async () => {
    const exec = fakeExec({
      '/usr/bin/dscl': { stdout: '', stderr: await fixture('dscl-missing.txt'), exitCode: 56 },
    });
    expect((await readAccount('nosuchuser', exec)).exists).toBe(false);
  });
});

describe('resolveSessionUser', () => {
  const noConfig = async (): Promise<string | null> => null;

  it('defaults to computeruse', async () => {
    expect(await resolveSessionUser({}, noConfig)).toBe(DEFAULT_SESSION_USER);
    expect(SESSION_DEFAULTS.user).toBe('computeruse');
  });

  it('prefers the environment over everything', async () => {
    const user = await resolveSessionUser({ [SESSION_USER_ENV_VAR]: 'offstagebot' }, async () =>
      JSON.stringify({ user: 'fromconfig' }),
    );
    expect(user).toBe('offstagebot');
  });

  it('falls back to ~/.config/offstage/session.json', async () => {
    const seen: string[] = [];
    const user = await resolveSessionUser({ HOME: '/Users/someone' }, async (configPath) => {
      seen.push(configPath);
      return JSON.stringify({ user: 'fromconfig' });
    });
    expect(user).toBe('fromconfig');
    expect(seen).toEqual(['/Users/someone/.config/offstage/session.json']);
    expect(sessionConfigPath({ HOME: '/Users/someone' })).toBe(
      '/Users/someone/.config/offstage/session.json',
    );
  });

  it('ignores a broken config rather than failing the probe', async () => {
    expect(await resolveSessionUser({}, async () => '{not json')).toBe(DEFAULT_SESSION_USER);
    expect(await resolveSessionUser({}, async () => '{"user": ""}')).toBe(DEFAULT_SESSION_USER);
    expect(await resolveSessionUser({}, async () => '[]')).toBe(DEFAULT_SESSION_USER);
  });
});

describe('sessionSocketPath', () => {
  it('is <socketDir>/<uid>.sock', () => {
    expect(sessionSocketPath(502)).toBe('/tmp/offstage-session/502.sock');
    expect(sessionSocketPath(502, '/var/run/offstage')).toBe('/var/run/offstage/502.sock');
    expect(DEFAULT_SOCKET_DIR).toBe('/tmp/offstage-session');
  });
});

describe('describeSession', () => {
  const table = async (): Promise<Record<string, ExecOutcome>> => ({
    '/usr/bin/dscl': ok(await fixture('dscl-computeruse.txt')),
    '/usr/sbin/ioreg': ok(await fixture('ioreg-root.plist')),
  });

  it('describes the recorded machine exactly as it is', async () => {
    const discovery = await describeSession({
      user: 'computeruse',
      exec: fakeExec(await table()),
      platform: 'darwin',
      statSocket: async () => false,
    });

    expect(discovery).toEqual({
      user: 'computeruse',
      uid: 502,
      home: '/Users/computeruse',
      fullName: 'Computer Use',
      accountExists: true,
      guiSession: { exists: true, loginDone: true, onConsole: false, sessionId: 258 },
      socketPath: '/tmp/offstage-session/502.sock',
      socketPresent: false,
      platform: 'darwin',
    });
  });

  it('reports the socket when one is bound', async () => {
    const seen: string[] = [];
    const discovery = await describeSession({
      user: 'computeruse',
      exec: fakeExec(await table()),
      platform: 'darwin',
      socketDir: '/tmp/elsewhere',
      statSocket: async (socketPath) => {
        seen.push(socketPath);
        return true;
      },
    });
    expect(discovery.socketPath).toBe('/tmp/elsewhere/502.sock');
    expect(discovery.socketPresent).toBe(true);
    expect(seen).toEqual(['/tmp/elsewhere/502.sock']);
  });

  it('reports a missing account without touching ioreg conclusions', async () => {
    const discovery = await describeSession({
      user: 'nosuchuser',
      exec: fakeExec({
        '/usr/bin/dscl': { stdout: await fixture('dscl-missing.txt'), stderr: '', exitCode: 56 },
        '/usr/sbin/ioreg': ok(await fixture('ioreg-root.plist')),
      }),
      platform: 'darwin',
      statSocket: async () => false,
    });
    expect(discovery.accountExists).toBe(false);
    expect(discovery.uid).toBeNull();
    expect(discovery.guiSession.exists).toBe(false);
    expect(discovery.socketPresent).toBe(false);
  });

  it('short-circuits off macOS without spawning anything', async () => {
    const exec = fakeExec({});
    const discovery = await describeSession({
      user: 'computeruse',
      exec,
      platform: 'linux',
      statSocket: async () => true,
    });
    expect(exec.calls).toEqual([]);
    expect(discovery.platform).toBe('linux');
    expect(discovery.accountExists).toBe(false);
    expect(discovery.guiSession.exists).toBe(false);
  });

  it('survives an ioreg that is missing or says nothing useful', async () => {
    const discovery = await describeSession({
      user: 'computeruse',
      exec: fakeExec({
        '/usr/bin/dscl': ok(await fixture('dscl-computeruse.txt')),
        '/usr/sbin/ioreg': { stdout: '', stderr: 'command not found', exitCode: 127 },
      }),
      platform: 'darwin',
      statSocket: async () => false,
    });
    expect(discovery.accountExists).toBe(true);
    expect(discovery.guiSession).toEqual({
      exists: false,
      loginDone: false,
      onConsole: false,
      sessionId: null,
    });
  });
});

describe('sessionUserFullName', () => {
  it('prefers the full name the user menu shows', () => {
    expect(sessionUserFullName({ user: 'computeruse', fullName: 'Computer Use' })).toBe(
      'Computer Use',
    );
    expect(sessionUserFullName({ user: 'computeruse', fullName: null })).toBe('computeruse');
  });
});
