/**
 * Session setup tests.
 *
 * Nothing here compiles Swift, writes to `/usr/local`, runs `launchctl`, or
 * changes one ACL on this machine. Everything setup does is either pure
 * rendering (the LaunchAgent plist, the root install script, the `chmod +a`
 * command list) or a call through the injected exec seam, so all of it is
 * asserted as strings and recorded calls.
 *
 * The install script is the piece most worth pinning: a user is asked to read
 * it and then type their password, so what it contains is a promise.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import plist from 'plist';

import type { Exec, ExecOutcome } from '../src/session/index.js';
import {
  ARTIFACTS_WRITE_ACL,
  DAEMON_BINARY_NAME,
  installDirFor,
  DEFAULT_LABEL,
  DAEMON_LOG_NAME,
  PASSWORD_ALPHABET,
  PASSWORD_LENGTH,
  SESSION_CONFIG_RELATIVE_PATH,
  SETUP_ASSISTANT_SEEN_KEYS,
  SHARE_READ_ACL,
  SHARE_TRAVERSE_ACL,
  SWIFTC_INSTALL_FIX,
  SYSTEM_TCC_DB,
  compileDaemon,
  daemonLogPath,
  describeAclCommand,
  exportCsreq,
  findSwiftc,
  generateSessionPassword,
  grantArtifactsWrite,
  grantArtifactsWriteCommands,
  launchAgentPath,
  persistSessionConfig,
  renderInstallScript,
  renderLaunchAgentPlist,
  setupAssistantCommands,
  shareAcl,
  shareAclCommands,
  shareAncestors,
  shellQuote,
  tccGrantCommands,
  unshareAcl,
  unshareAclCommands,
} from '../src/session/index.js';

const ok = (stdout = ''): ExecOutcome => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stderr: string, exitCode = 1): ExecOutcome => ({ stdout: '', stderr, exitCode });

function recordingExec(
  table: Record<string, ExecOutcome> = {},
): Exec & { calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  const exec = (async (file, args) => {
    calls.push({ file, args });
    return table[file] ?? ok();
  }) as Exec & { calls: Array<{ file: string; args: string[] }> };
  exec.calls = calls;
  return exec;
}

/* -------------------------------------------------------------------------- */
/* The LaunchAgent                                                            */
/* -------------------------------------------------------------------------- */

describe('renderLaunchAgentPlist', () => {
  const rendered = renderLaunchAgentPlist({
    binaryPath: '/usr/local/libexec/offstage/offstage-sessiond',
    uid: 502,
    socketDir: '/tmp/offstage-session',
    home: '/Users/computeruse',
  });

  it('is a valid plist that launchd would accept', () => {
    const parsed = plist.parse(rendered) as Record<string, unknown>;
    expect(parsed['Label']).toBe(DEFAULT_LABEL);
    expect(parsed['ProgramArguments']).toEqual([
      '/usr/local/libexec/offstage/offstage-sessiond',
      '--uid',
      '502',
      '--socket-dir',
      '/tmp/offstage-session',
    ]);
    expect(parsed['RunAtLoad']).toBe(true);
    /* Restart on crash, but not after the deliberate exit-0 uid check. */
    expect(parsed['KeepAlive']).toEqual({ SuccessfulExit: false });
    /* Without this the agent can load in a Background/LoginWindow context,
       where there is no window server to capture or post events to. */
    expect(parsed['LimitLoadToSessionType']).toBe('Aqua');
  });

  it('logs somewhere persistent and helper-owned, never /tmp', () => {
    /* launchd opens this path before exec and creates no parent directory, and
       /tmp is wiped on reboot, so a log there is missing on exactly the launch
       worth reading about, the first one after a restart. */
    const parsed = plist.parse(rendered) as Record<string, unknown>;
    expect(parsed['StandardErrorPath']).toBe(
      '/Users/computeruse/Library/Logs/offstage-sessiond.log',
    );
    expect(parsed['StandardOutPath']).toBe(parsed['StandardErrorPath']);
    expect(String(parsed['StandardOutPath'])).not.toContain('/tmp');
    expect(daemonLogPath('/Users/computeruse')).toBe(
      `/Users/computeruse/Library/Logs/${DAEMON_LOG_NAME}`,
    );
  });

  it('honours a custom label', () => {
    const custom = renderLaunchAgentPlist({
      binaryPath: '/opt/offstage-sessiond',
      uid: 503,
      socketDir: '/var/run/offstage',
      home: '/Users/other',
      label: 'dev.offstage.sessiond.test',
    });
    expect((plist.parse(custom) as Record<string, unknown>)['Label']).toBe(
      'dev.offstage.sessiond.test',
    );
  });

  it('puts the agent in the helper account home', () => {
    expect(launchAgentPath('/Users/computeruse')).toBe(
      '/Users/computeruse/Library/LaunchAgents/dev.offstage.sessiond.plist',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The root install script                                                    */
/* -------------------------------------------------------------------------- */

describe('renderInstallScript', () => {
  const script = renderInstallScript({
    binarySource: '/tmp/offstage-build/offstage-sessiond',
    plistSource: '/tmp/offstage-build/dev.offstage.sessiond.plist',
    user: 'computeruse',
    uid: 502,
    home: '/Users/computeruse',
  });

  it('pre-creates every directory launchd will not create itself', () => {
    /* The socket directory, the log directory and LaunchAgents: launchd creates
       no parent for a plist or a log path, and an account that has never
       finished a first login has neither Library subdirectory yet. */
    expect(script).toContain(`install -d -o 'computeruse' -g staff -m 755 '/tmp/offstage-session'`);
    expect(script).toContain(
      `install -d -o 'computeruse' -g staff -m 755 '/Users/computeruse/Library/Logs'`,
    );
    expect(script).toContain(
      `install -d -o 'computeruse' -g staff -m 755 '/Users/computeruse/Library/LaunchAgents'`,
    );
  });

  it('creates each directory before anything is written into it', () => {
    const at = (needle: string): number => script.indexOf(needle);
    expect(at("-m 755 '/Users/computeruse/Library/LaunchAgents'")).toBeLessThan(
      at("dev.offstage.sessiond.plist' '/Users/computeruse/Library/LaunchAgents"),
    );
    expect(at("-m 755 '/tmp/offstage-session'")).toBeLessThan(at('launchctl bootstrap'));
    expect(at("-m 755 '/Users/computeruse/Library/Logs'")).toBeLessThan(at('launchctl bootstrap'));
  });

  it('does the three root things and nothing else', () => {
    expect(script).toMatchInlineSnapshot(`
      "#!/bin/sh
      # offstage session setup: installs offstage-sessiond into the
      # computeruse account's GUI session. This is the only step that needs root.
      set -eu

      install -d -o 'computeruse' -g staff -m 755 '/Users/computeruse/.offstage/bin'
      install -o 'computeruse' -g staff -m 755 '/tmp/offstage-build/offstage-sessiond' '/Users/computeruse/.offstage/bin/offstage-sessiond'

      # Nothing installs into the old root-owned location any more; drop it so a
      # stale binary cannot be bootstrapped by an old plist.
      rm -f '/usr/local/libexec/offstage/offstage-sessiond'

      install -d -o 'computeruse' -g staff -m 755 '/tmp/offstage-session'
      install -d -o 'computeruse' -g staff -m 755 '/Users/computeruse/Library/Logs'

      install -d -o 'computeruse' -g staff -m 755 '/Users/computeruse/Library/LaunchAgents'
      install -o 'computeruse' -g staff -m 644 '/tmp/offstage-build/dev.offstage.sessiond.plist' '/Users/computeruse/Library/LaunchAgents/dev.offstage.sessiond.plist'

      launchctl bootout 'gui/502/dev.offstage.sessiond' 2>/dev/null || true
      launchctl bootstrap 'gui/502' '/Users/computeruse/Library/LaunchAgents/dev.offstage.sessiond.plist'
      launchctl kickstart -k 'gui/502/dev.offstage.sessiond'
      "
    `);
  });

  it('tolerates a first install, where there is nothing to bootout', () => {
    expect(script).toContain('launchctl bootout');
    expect(script).toMatch(/launchctl bootout .* 2>\/dev\/null \|\| true/);
  });

  it('installs the binary into the helper account\'s own home, owned by that account', () => {
    /* Deliberate: a binary the helper account owns is one the daemon can
       replace over its own socket, so updating it never needs root and never
       raises a password dialog. The grants it holds are protected by its code
       signature, not by the file being root-owned. */
    const installDir = installDirFor('/Users/computeruse');
    expect(installDir).toBe('/Users/computeruse/.offstage/bin');
    expect(script).toContain(`install -d -o 'computeruse' -g staff -m 755 '${installDir}'`);
    expect(script).toContain(path.join(installDir, DAEMON_BINARY_NAME));
    expect(script).not.toContain('-o root -g wheel');
  });

  it('removes the old root-owned copy so a stale binary cannot be bootstrapped', () => {
    expect(script).toContain("rm -f '/usr/local/libexec/offstage/offstage-sessiond'");
  });

  it('never invokes a compiler, a package manager or the network', () => {
    for (const forbidden of ['swiftc', 'xcrun', 'curl', 'npm', 'brew', 'rm -rf']) {
      expect(script).not.toContain(forbidden);
    }
  });

  it('quotes paths that would otherwise be two words', () => {
    const quoted = renderInstallScript({
      binarySource: "/tmp/my build/offstage-sessiond",
      plistSource: "/tmp/my build/agent.plist",
      user: 'computeruse',
      uid: 502,
      home: "/Users/computer use",
    });
    expect(quoted).toContain(`'/tmp/my build/offstage-sessiond'`);
    expect(quoted).toContain(`'/Users/computer use/Library/LaunchAgents'`);
  });
});

describe('shellQuote', () => {
  it('survives an embedded single quote', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  it('round-trips through a real /bin/sh', async () => {
    /* The install script is executed by sh with a user's root password behind
       it, so "I believe this quoting is right" is not good enough. */
    const run = promisify(execFile);
    for (const value of ["it's", '/Users/computer use/x', 'a"b', 'a$b`c', 'a\\b']) {
      const { stdout } = await run('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`]);
      expect(stdout).toBe(value);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* swiftc                                                                     */
/* -------------------------------------------------------------------------- */

describe('findSwiftc', () => {
  it('prefers xcrun --find', async () => {
    const exec = recordingExec({
      '/usr/bin/xcrun': ok('/Library/Developer/CommandLineTools/usr/bin/swiftc\n'),
    });
    expect(await findSwiftc(exec)).toEqual({
      found: true,
      path: '/Library/Developer/CommandLineTools/usr/bin/swiftc',
    });
    expect(exec.calls[0]).toEqual({ file: '/usr/bin/xcrun', args: ['--find', 'swiftc'] });
  });

  it('falls back to which when xcrun cannot help', async () => {
    const exec = recordingExec({
      '/usr/bin/xcrun': fail('xcrun: error: unable to find utility "swiftc"'),
      '/usr/bin/which': ok('/usr/bin/swiftc'),
    });
    expect(await findSwiftc(exec)).toEqual({ found: true, path: '/usr/bin/swiftc' });
  });

  it('names the fix when there is no compiler at all', async () => {
    const exec = recordingExec({
      '/usr/bin/xcrun': fail('no developer tools'),
      '/usr/bin/which': fail('', 1),
    });
    const result = await findSwiftc(exec);
    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.fix).toBe(SWIFTC_INSTALL_FIX);
      expect(result.reason).toContain('Swift');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Compiling                                                                  */
/* -------------------------------------------------------------------------- */

describe('compileDaemon', () => {
  it('uses native/sessiond/build.sh when it is there', async () => {
    const exec = recordingExec();
    const result = await compileDaemon({
      sourceDir: '/pkg/native/sessiond',
      outPath: '/tmp/build/offstage-sessiond',
      exec,
      exists: async (target) => target === '/pkg/native/sessiond/build.sh',
    });
    expect(result.ok).toBe(true);
    expect(result.via).toBe('build.sh');
    expect(exec.calls).toEqual([
      { file: '/bin/bash', args: ['/pkg/native/sessiond/build.sh', '/tmp/build/offstage-sessiond'] },
    ]);
  });

  it('falls back to swiftc over the sources when the script is absent', async () => {
    const exec = recordingExec({
      '/usr/bin/xcrun': ok('/usr/bin/swiftc'),
    });
    const result = await compileDaemon({
      sourceDir: '/pkg/native/sessiond',
      outPath: '/tmp/build/offstage-sessiond',
      exec,
      exists: async () => false,
      listSources: async () => [
        '/pkg/native/sessiond/main.swift',
        '/pkg/native/sessiond/Protocol.swift',
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.via).toBe('swiftc');
    expect(exec.calls.at(-1)).toEqual({
      file: '/usr/bin/swiftc',
      args: [
        '-O',
        '-o',
        '/tmp/build/offstage-sessiond',
        '/pkg/native/sessiond/main.swift',
        '/pkg/native/sessiond/Protocol.swift',
        '-framework',
        'CoreGraphics',
        '-framework',
        'AppKit',
        '-framework',
        'ApplicationServices',
        '-framework',
        'Security',
      ],
    });
  });

  it('reports a compile failure with the compiler output, without throwing', async () => {
    const exec = recordingExec({ '/bin/bash': fail('main.swift:12:5: error: nope', 1) });
    const result = await compileDaemon({
      sourceDir: '/pkg/native/sessiond',
      outPath: '/tmp/out',
      exec,
      exists: async () => true,
    });
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('error: nope');
  });

  it('says what is missing when there is no source and no script', async () => {
    const result = await compileDaemon({
      sourceDir: '/pkg/native/sessiond',
      outPath: '/tmp/out',
      exec: recordingExec(),
      exists: async () => false,
      listSources: async () => [],
    });
    expect(result.ok).toBe(false);
    expect(result.via).toBe('none');
    expect(result.reason).toContain('No Swift sources');
  });

  it('surfaces a missing compiler as the xcode-select fix', async () => {
    const result = await compileDaemon({
      sourceDir: '/pkg/native/sessiond',
      outPath: '/tmp/out',
      exec: recordingExec({ '/usr/bin/xcrun': fail('nope'), '/usr/bin/which': fail('nope') }),
      exists: async () => false,
      listSources: async () => ['/pkg/native/sessiond/main.swift'],
    });
    expect(result.ok).toBe(false);
    expect(result.fix).toBe(SWIFTC_INSTALL_FIX);
  });
});

/* -------------------------------------------------------------------------- */
/* ACLs                                                                       */
/* -------------------------------------------------------------------------- */

describe('shareAncestors', () => {
  it('walks from the owner home down to the tree, and no higher', () => {
    expect(shareAncestors('/Users/viraat/code/app', '/Users/viraat')).toEqual([
      '/Users/viraat',
      '/Users/viraat/code',
    ]);
  });

  it('never touches / itself for a tree outside any home', () => {
    expect(shareAncestors('/opt/work/app', '/Users/viraat')).toEqual(['/opt', '/opt/work']);
  });
});

describe('shareAclCommands', () => {
  const commands = shareAclCommands({
    target: '/Users/viraat/code/app',
    user: 'computeruse',
    home: '/Users/viraat',
  });

  it('grants traverse-only on the ancestors and read on the tree', () => {
    expect(commands.map(describeAclCommand)).toEqual([
      `/bin/chmod '+a' 'computeruse allow ${SHARE_TRAVERSE_ACL}' '/Users/viraat'`,
      `/bin/chmod '+a' 'computeruse allow ${SHARE_TRAVERSE_ACL}' '/Users/viraat/code'`,
      `/bin/chmod '-R' '+a' 'computeruse allow ${SHARE_READ_ACL}' '/Users/viraat/code/app'`,
    ]);
  });

  it('never grants write, add_file or delete anywhere', () => {
    const rendered = commands.map(describeAclCommand).join('\n');
    for (const forbidden of ['write', 'add_file', 'add_subdirectory', 'delete', 'append']) {
      expect(rendered).not.toContain(forbidden);
    }
  });

  it('grants read with inheritance so new files stay readable', () => {
    expect(SHARE_READ_ACL).toBe(
      'read,execute,readattr,readextattr,readsecurity,file_inherit,directory_inherit',
    );
  });
});

describe('shareAcl', () => {
  it('runs every command and reports success', async () => {
    const exec = recordingExec();
    const result = await shareAcl({
      target: '/Users/viraat/code/app',
      user: 'computeruse',
      home: '/Users/viraat',
      exec,
    });
    expect(result.ok).toBe(true);
    expect(result.commands).toHaveLength(3);
    expect(exec.calls).toHaveLength(3);
  });

  it('collects a failing chmod instead of throwing', async () => {
    const exec = recordingExec({ '/bin/chmod': fail('chmod: Operation not permitted', 1) });
    const result = await shareAcl({
      target: '/Users/viraat/code/app',
      user: 'computeruse',
      home: '/Users/viraat',
      exec,
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.stderr).toContain('Operation not permitted');
  });

  it('survives an exec that throws outright', async () => {
    const exploding: Exec = async () => {
      throw new Error('spawn /bin/chmod ENOENT');
    };
    const result = await shareAcl({
      target: '/Users/viraat/code/app',
      user: 'computeruse',
      home: '/Users/viraat',
      exec: exploding,
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.stderr).toContain('ENOENT');
  });
});

/* -------------------------------------------------------------------------- */
/* Unsharing                                                                  */
/* -------------------------------------------------------------------------- */

describe('unshareAclCommands', () => {
  const commands = unshareAclCommands({
    target: '/Users/viraat/code/app',
    user: 'computeruse',
    home: '/Users/viraat',
  });

  it('is the exact inverse of the grant: same paths, same ACL text, minus signs', () => {
    const granted = shareAclCommands({
      target: '/Users/viraat/code/app',
      user: 'computeruse',
      home: '/Users/viraat',
    });
    expect(commands.map(describeAclCommand)).toHaveLength(granted.map(describeAclCommand).length);
    for (let i = 0; i < granted.length; i += 1) {
      const g = granted[i]!;
      const r = commands[i]!;
      // Only the +a/-a sign differs; the entry text and the target are identical.
      expect(r.file).toBe(g.file);
      expect(r.args.join(' ')).toBe(g.args.join(' ').replace(/\+a/g, '-a'));
    }
  });

  it('removes recursively on the tree, which also strips inherited entries', () => {
    expect(commands.at(-1)?.args).toEqual([
      '-R',
      '-a',
      `computeruse allow ${SHARE_READ_ACL}`,
      '/Users/viraat/code/app',
    ]);
  });
});

describe('unshareAcl', () => {
  it('succeeds when every entry was already absent', async () => {
    /* macOS chmod exits 1 with "No ACL present '<path>'" when there is nothing
       to remove: measured, not assumed. That is the goal state of an
       unshare, so it is success. */
    const exec = recordingExec({
      '/bin/chmod': fail("chmod: No ACL present '/Users/viraat'", 1),
    });
    const result = await unshareAcl({
      target: '/Users/viraat/code/app',
      user: 'computeruse',
      home: '/Users/viraat',
      exec,
    });
    expect(result.ok).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('reports a real failure instead of swallowing it', async () => {
    const exec = recordingExec({
      '/bin/chmod': fail('chmod: /Users/viraat/code/app: No such file or directory', 1),
    });
    const result = await unshareAcl({
      target: '/Users/viraat/code/app',
      user: 'computeruse',
      home: '/Users/viraat',
      exec,
    });
    expect(result.ok).toBe(false);
    expect(result.failures[0]?.stderr).toContain('No such file or directory');
  });
});

describe('grantArtifactsWrite', () => {
  it('opens exactly one directory, with the full write set', () => {
    const [command] = grantArtifactsWriteCommands({
      dir: '/Users/viraat/code/app/.offstage/runs/x',
      user: 'computeruse',
    });
    expect(command && describeAclCommand(command)).toBe(
      `/bin/chmod '+a' 'computeruse allow ${ARTIFACTS_WRITE_ACL}' '/Users/viraat/code/app/.offstage/runs/x'`,
    );
    expect(ARTIFACTS_WRITE_ACL).toContain('write');
    expect(ARTIFACTS_WRITE_ACL).toContain('add_file');
  });

  it('reports a failure as data', async () => {
    const exec = recordingExec({ '/bin/chmod': fail('No such file or directory', 1) });
    const result = await grantArtifactsWrite({ dir: '/nope', user: 'computeruse', exec });
    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* The generated account password                                             */
/* -------------------------------------------------------------------------- */

describe('generateSessionPassword', () => {
  it('produces 24 characters drawn only from the unambiguous alphabet', () => {
    for (let i = 0; i < 20; i += 1) {
      const password = generateSessionPassword();
      expect(password).toHaveLength(PASSWORD_LENGTH);
      for (const char of password) {
        expect(PASSWORD_ALPHABET).toContain(char);
      }
    }
  });

  it('is deterministic under an injected byte source', () => {
    const sequence = (count: number): Uint8Array => {
      const bytes = new Uint8Array(count);
      for (let i = 0; i < count; i += 1) bytes[i] = (i * 7 + 3) % 256;
      return bytes;
    };
    expect(generateSessionPassword(sequence)).toBe(generateSessionPassword(sequence));
  });

  it('rejects bytes that would bias the alphabet rather than wrapping them', () => {
    /* With a 58-character alphabet, bytes >= 232 have no home. A source that
       only produces them must still yield a password, via rejection and
       re-asking, rather than a biased or short one. This stub alternates
       rejected and accepted bytes so the loop is exercised without spinning. */
    let call = 0;
    const password = generateSessionPassword((count) => {
      call += 1;
      const bytes = new Uint8Array(count);
      for (let i = 0; i < count; i += 1) bytes[i] = (i + call) % 2 === 0 ? 255 : 10;
      return bytes;
    });
    expect(password).toHaveLength(PASSWORD_LENGTH);
    for (const char of password) expect(PASSWORD_ALPHABET).toContain(char);
  });
});

/* -------------------------------------------------------------------------- */
/* The designated requirement export                                          */
/* -------------------------------------------------------------------------- */

describe('exportCsreq', () => {
  const BLOB = `fade0c00000000a4${'ab'.repeat(40)}`;

  it('returns lowercase hex from a successful --print-csreq run', async () => {
    const exec = recordingExec({
      ['/Users/cd/.offstage/bin/offstage-sessiond']: ok(`${BLOB}\n`),
    } as Record<string, ExecOutcome>);
    const result = await exportCsreq('/Users/cd/.offstage/bin/offstage-sessiond', exec);
    expect(result).toEqual({ ok: true, hex: BLOB });
  });

  it('rejects output that is not a requirement blob', async () => {
    const exec = recordingExec({
      '/tmp/daemon': ok('hello world\n'),
    } as Record<string, ExecOutcome>);
    const result = await exportCsreq('/tmp/daemon', exec);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('not a code requirement');
  });

  it('carries the binary stderr when --print-csreq fails', async () => {
    const exec = recordingExec({
      '/tmp/unsigned': fail('no designated requirement for /tmp/unsigned: OSStatus -67062', 70),
    } as Record<string, ExecOutcome>);
    const result = await exportCsreq('/tmp/unsigned', exec);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('OSStatus -67062');
  });

  it('survives an exec that throws outright', async () => {
    const exploding: Exec = async () => {
      throw new Error('EACCES');
    };
    const result = await exportCsreq('/tmp/daemon', exploding);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('EACCES');
  });
});

/* -------------------------------------------------------------------------- */
/* Pre-seeding TCC                                                            */
/* -------------------------------------------------------------------------- */

describe('tccGrantCommands', () => {
  const grants = tccGrantCommands({
    clientPath: '/Users/computeruse/.offstage/bin/offstage-sessiond',
    csreqHex: 'fade0c00000000a4ab',
  });

  it('writes one row per service, allowed, keyed to the installed path', () => {
    expect(grants).toHaveLength(2);
    expect(grants[0]?.args[0]).toBe(SYSTEM_TCC_DB);
    expect(grants[0]?.args[1]).toContain("'kTCCServiceAccessibility'");
    expect(grants[1]?.args[1]).toContain("'kTCCServiceScreenCapture'");
    for (const grant of grants) {
      expect(grant.file).toBe('/usr/bin/sqlite3');
      expect(grant.args[1]).toContain(
        "'/Users/computeruse/.offstage/bin/offstage-sessiond', 1, 2, 4, 1",
      );
      expect(grant.args[1]).toContain("X'fade0c00000000a4ab'");
    }
  });

  it('matches the row shape System Settings itself writes', () => {
    /* auth_value 2 = allowed; client_type 1; auth_reason 4; version 1;
       indirect_object 'UNUSED' with type 0. Recorded from a real machine. */
    expect(grants[0]?.args[1]).toBe(
      "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, policy_id, indirect_object_identifier_type, indirect_object_identifier, indirect_object_code_identity, flags, last_modified) "
        + "VALUES ('kTCCServiceAccessibility', '/Users/computeruse/.offstage/bin/offstage-sessiond', 1, 2, 4, 1, X'fade0c00000000a4ab', NULL, 0, 'UNUSED', NULL, 0, strftime('%s','now'));",
    );
  });

  it('escapes single quotes in the client path', () => {
    const quoted = tccGrantCommands({
      clientPath: "/Users/o'brien/.offstage/bin/offstage-sessiond",
      csreqHex: 'fade0cab',
    });
    expect(quoted[0]?.args[1]).toContain("/Users/o''brien/.offstage");
  });

  it('refuses to build SQL from non-hex input', () => {
    expect(() =>
      tccGrantCommands({ clientPath: '/x', csreqHex: 'not hex!' }),
    ).toThrow(/hex/);
  });
});

/* -------------------------------------------------------------------------- */
/* Setup Assistant suppression                                                */
/* -------------------------------------------------------------------------- */

describe('setupAssistantCommands', () => {
  const commands = setupAssistantCommands({ user: 'computeruse', home: '/Users/computeruse' });
  const rendered = commands.map((command) => `${command.file} ${command.args.join(' ')}`);

  it('creates the home before writing into it, then marks .skipbuddy', () => {
    expect(rendered[0]).toBe(
      `/usr/bin/install -d -o computeruse -g staff -m 755 '/Users/computeruse'`,
    );
    expect(rendered[1]).toBe(`/usr/bin/touch '/Users/computeruse/.skipbuddy'`);
    expect(rendered[2]).toBe(`/usr/sbin/chown computeruse '/Users/computeruse/.skipbuddy'`);
  });

  it('marks every Setup Assistant pane as already seen', () => {
    const writes = rendered.filter((line) => line.startsWith('/usr/bin/defaults write'));
    expect(writes.length).toBe(SETUP_ASSISTANT_SEEN_KEYS.length);
    expect(rendered.join('\n')).toContain('DidSeeCloudSetupFinished');
    expect(rendered.join('\n')).toContain('com.apple.SetupAssistant.plist');
  });

  it('hands ownership back to the helper account', () => {
    const chowns = rendered.filter((line) => line.startsWith('/usr/sbin/chown'));
    expect(chowns.length).toBeGreaterThanOrEqual(2);
    expect(chowns.at(-1)).toContain('com.apple.SetupAssistant.plist');
  });
});

/* -------------------------------------------------------------------------- */
/* The full script, every section                                             */
/* -------------------------------------------------------------------------- */

describe('renderInstallScript with every section armed', () => {
  const script = renderInstallScript({
    binarySource: '/tmp/build/offstage-sessiond',
    plistSource: '/tmp/build/dev.offstage.sessiond.plist',
    user: 'computeruse',
    uid: 502,
    home: '/Users/computeruse',
    createAccount: { password: 'correcthorsebattery' },
    skipSetupAssistant: true,
    tcc: { csreqHex: 'fade0c00000000a4ab' },
    enableFastUserSwitching: true,
    autoLoginPassword: 'correcthorsebattery',
  });

  it('orders the sections: account → assistant → install → tcc → switching → launchd → autologin', () => {
    const at = (needle: string): number => script.indexOf(needle);
    expect(at('sysadminctl -addUser')).toBeGreaterThan(-1);
    expect(at('sysadminctl -addUser')).toBeLessThan(at('.skipbuddy'));
    expect(at('.skipbuddy')).toBeLessThan(at("install -d -o 'computeruse'"));
    expect(at("INSERT OR REPLACE INTO access")).toBeGreaterThan(at('dev.offstage.sessiond.plist'));
    expect(at('INSERT OR REPLACE INTO access')).toBeLessThan(at('MultipleSessionEnabled'));
    expect(at('MultipleSessionEnabled')).toBeLessThan(at('launchctl bootstrap'));
    expect(at('-autologin set')).toBeGreaterThan(at('launchctl kickstart'));
  });

  it('gates the TCC inserts behind a write probe that mutates nothing', () => {
    expect(script).toContain(`sqlite3 '/Library/Application Support/com.apple.TCC/TCC.db' 'BEGIN IMMEDIATE; ROLLBACK;'`);
    expect(script).toContain('TCC_PRESEED_SKIPPED');
    expect(script).toContain('killall tccd');
  });

  it('lets sysadminctl refuse auto-login without failing the install', () => {
    expect(script).toContain("-autologin set -userName 'computeruse'");
    expect(script).toContain('AUTOLOGIN_NOT_ARMED');
  });

  it('survives /bin/sh -n, because a user reads this script before trusting it with sudo', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-script-'));
    const file = path.join(dir, 'install.sh');
    await fs.writeFile(file, script, { mode: 0o700 });
    const run = promisify(execFile);
    // A syntax error exits non-zero and prints where it broke.
    await run('/bin/sh', ['-n', file]);
  });
});

/* -------------------------------------------------------------------------- */
/* Persisting the account secret                                              */
/* -------------------------------------------------------------------------- */

describe('persistSessionConfig', () => {
  it('merges into an existing config file and tightens its mode to 0600', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-config-'));
    const configPath = path.join(dir, SESSION_CONFIG_RELATIVE_PATH);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ user: 'someoneelse', note: 'keep me' }), 'utf8');

    await persistSessionConfig('computeruse', 'pw123', { HOME: dir } as NodeJS.ProcessEnv);

    const written = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(written['user']).toBe('computeruse');
    expect(written['password']).toBe('pw123');
    expect(written['note']).toBe('keep me');
    const mode = (await fs.stat(configPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  }, 15000);

  it('creates the config directory when there was never one', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-config2-'));
    await persistSessionConfig('computeruse', 'pw123', { HOME: dir } as NodeJS.ProcessEnv);
    const configPath = path.join(dir, SESSION_CONFIG_RELATIVE_PATH);
    const written = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(written['password']).toBe('pw123');
  });
});
