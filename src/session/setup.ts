/**
 * Installing the daemon, and opening exactly enough of the filesystem.
 *
 * `offstage session setup` needs root for three things and no more: putting the
 * binary in `/usr/local/libexec/offstage`, writing a LaunchAgent plist into the
 * helper account's `~/Library/LaunchAgents`, and bootstrapping it into
 * `gui/<uid>`. Everything after that is an ordinary user connecting to a
 * socket. So this module's job is to *render* that root step as a script a
 * human can read before typing their password, rather than to scatter `sudo`
 * calls through the codebase.
 *
 * The same principle applies to the ACLs: `share` and the per-run artifacts
 * grant are computed as `chmod +a` commands first (pure data, snapshot-tested)
 * and only then handed to the injected {@link Exec}. Nothing in this file
 * shells out on its own.
 */

import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import plist from 'plist';

import type { Exec, ExecOutcome } from './discover.js';
import { DEFAULT_SOCKET_DIR, SESSION_CONFIG_RELATIVE_PATH, defaultExec } from './discover.js';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** LaunchAgent label, and therefore the launchd service name under `gui/<uid>`. */
export const DEFAULT_LABEL = 'dev.offstage.sessiond';

/** Where the daemon binary is installed. Root-owned, outside any home. */
/**
 * Where the daemon binary lives, inside the helper account's own home.
 *
 * It used to sit in `/usr/local/libexec/offstage`, owned by root. That made
 * every update a `sudo` step, and a password prompt raised from a background
 * task puts an invisible dialog on the console that captures the user's
 * keyboard until it is answered. Updates therefore have to be possible without
 * root, so the binary lives where the account that runs it can replace it: the
 * daemon can update itself over its own socket, and root is needed only once,
 * at first setup, to bootstrap the LaunchAgent.
 *
 * A user-writable binary is a real trade, so it is worth being precise about
 * what it does and does not give away. Anything already running as the helper
 * account could swap this file. It could NOT thereby inherit the daemon's
 * Screen Recording or Accessibility grants: a TCC record is keyed to a path AND
 * carries a code requirement, so a replacement that does not satisfy that
 * requirement is refused (`tccd` logs `Failed to match existing code
 * requirement`). The signature, not the file permissions, is what guards the
 * privileges here.
 *
 * The corollary, and the reason this path must now stay put: a record belongs
 * to its path. Moving the binary leaves the grant behind on the old path and
 * costs the user a fresh approval for both permissions. Do not move it again.
 */
export function installDirFor(home: string): string {
  return path.join(home, '.offstage', 'bin');
}

/**
 * The pre-0.3 location. Kept only so setup can clean it up; nothing installs
 * here any more.
 */
export const LEGACY_INSTALL_DIR = '/usr/local/libexec/offstage';

/** Filename of the compiled daemon. */
export const DAEMON_BINARY_NAME = 'offstage-sessiond';

/** Where the Swift source lives inside the published package. */
export const DAEMON_SOURCE_RELATIVE_DIR = path.join('native', 'sessiond');

/** Filename of the daemon's log, inside the helper account's `Library/Logs`. */
export const DAEMON_LOG_NAME = 'offstage-sessiond.log';

/**
 * Where launchd sends the daemon's stdout and stderr.
 *
 * Deliberately **not** in the socket directory. launchd opens this path before
 * `exec` and creates no parent directories, and `/tmp` is wiped on reboot, so
 * a log under `/tmp/offstage-session` is guaranteed to be missing on exactly
 * the launch you most want to read about, the first one after a restart. The
 * helper account's own `~/Library/Logs` is persistent, is where a macOS user
 * already looks for logs, and is owned by the account writing to it.
 */
export function daemonLogPath(home: string): string {
  return path.join(home, 'Library', 'Logs', DAEMON_LOG_NAME);
}

/**
 * Read-only ACL granted on a shared tree.
 *
 * `file_inherit`/`directory_inherit` so new files under it are readable too;
 * no `write`, no `add_file`, no `delete`: `share` never grants write, and the
 * repository stays as read-only to the helper account as a container's
 * read-only mount.
 */
export const SHARE_READ_ACL =
  'read,execute,readattr,readextattr,readsecurity,file_inherit,directory_inherit';

/**
 * Traverse-only ACL on the ancestors of a shared tree. `search` is the
 * directory equivalent of `x`: it makes the path walkable without making the
 * directory listable, so sharing `~/code/app` does not disclose `~`.
 */
export const SHARE_TRAVERSE_ACL = 'search';

/**
 * Write ACL granted on one run's artifacts directory, and only there. The lane
 * owns that directory, so it is the lane's to open; everything the run writes
 * is expected to land in `$OFFSTAGE_ARTIFACTS`.
 */
export const ARTIFACTS_WRITE_ACL =
  'read,write,append,delete,add_file,add_subdirectory,search,readattr,writeattr,readextattr,writeextattr,file_inherit,directory_inherit';

/* -------------------------------------------------------------------------- */
/* The LaunchAgent                                                            */
/* -------------------------------------------------------------------------- */

export interface LaunchAgentOptions {
  /** Absolute path of the installed binary, e.g. `/usr/local/libexec/offstage/offstage-sessiond`. */
  binaryPath: string;
  /** Uid of the helper account; the daemon refuses to run as anyone else. */
  uid: number;
  /** Directory the socket is bound in. */
  socketDir: string;
  /** Helper account home; the daemon logs into its `Library/Logs`. */
  home: string;
  /** launchd label. Defaults to {@link DEFAULT_LABEL}. */
  label?: string;
}

/**
 * Render the LaunchAgent plist that keeps `offstage-sessiond` alive inside the
 * helper account's GUI session.
 *
 * `KeepAlive` is on for failures: the daemon is the lane's only door into that
 * session, and a crashed daemon that stays dead would silently turn every later
 * run into "unavailable". Its stderr goes to the helper account's own
 * `~/Library/Logs`, which survives a reboot: see {@link daemonLogPath}.
 */
export function renderLaunchAgentPlist(options: LaunchAgentOptions): string {
  const label = options.label ?? DEFAULT_LABEL;
  const logPath = daemonLogPath(options.home);
  const document = {
    Label: label,
    ProgramArguments: [
      options.binaryPath,
      '--uid',
      String(options.uid),
      '--socket-dir',
      options.socketDir,
    ],
    RunAtLoad: true,
    /* Restart it when it dies, but not when it exits cleanly: the daemon exits
       0 on purpose when `getuid() != --uid`, and `KeepAlive: true` would turn
       that belt-and-braces check into a respawn loop. */
    KeepAlive: { SuccessfulExit: false },
    /* Aqua only. In a Background or LoginWindow context there is no window
       server for CGMainDisplayID()/CGEventPost to talk to, and a daemon loaded
       there would report a session it cannot actually drive. */
    LimitLoadToSessionType: 'Aqua',
    StandardOutPath: logPath,
    StandardErrorPath: logPath,
  };
  return `${plist.build(document)}\n`;
}

/** `<home>/Library/LaunchAgents/<label>.plist`. */
export function launchAgentPath(home: string, label: string = DEFAULT_LABEL): string {
  return path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
}

/* -------------------------------------------------------------------------- */
/* The helper account's password                                              */
/* -------------------------------------------------------------------------- */

/**
 * Alphabet for generated helper-account passwords. Unambiguous characters
 * only: this string is read aloud from a terminal, typed by hand into a login
 * pane on occasion, and quoted through `/bin/sh`.
 */
export const PASSWORD_ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Length of a generated password. 24 over an 58-character alphabet. */
export const PASSWORD_LENGTH = 24;

/** Where random bytes come from; a seam so tests are deterministic. */
export type RandomBytes = (count: number) => Uint8Array;

const defaultRandomBytes: RandomBytes = (count) => randomBytes(count);

/**
 * Generate a random password for the helper account.
 *
 * Rejection sampling rather than `% alphabet.length`, because `Uint8Array`
 * values are uniform over 0–255 and 256 does not divide by the alphabet size;
 * the bias would be small but it costs nothing to do right.
 */
export function generateSessionPassword(random: RandomBytes = defaultRandomBytes): string {
  const chars: string[] = [];
  while (chars.length < PASSWORD_LENGTH) {
    const bytes = random(Math.max(16, PASSWORD_LENGTH));
    for (const byte of bytes) {
      if (byte >= 256 - (256 % PASSWORD_ALPHABET.length)) continue;
      chars.push(PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length] as string);
      if (chars.length === PASSWORD_LENGTH) break;
    }
  }
  return chars.join('');
}

/* -------------------------------------------------------------------------- */
/* The daemon's Designated Requirement                                        */
/* -------------------------------------------------------------------------- */

export interface CsreqResult {
  ok: boolean;
  /** Lowercase hex of the requirement blob, ready for a sqlite `X''` literal. */
  hex?: string;
  reason?: string;
}

/**
 * Ask the freshly compiled daemon for its own Designated Requirement.
 *
 * `offstage-sessiond --print-csreq <path>` prints the exact BLOB TCC stores in
 * its `csreq` column when a grant is made: verified byte-for-byte against a
 * row System Settings itself wrote. With it, setup can pre-seed both grants
 * (see {@link tccGrantCommands}) instead of asking a human to toggle them
 * inside the helper session.
 *
 * Never throws; a failure comes back as `ok: false` with the daemon's own
 * words.
 */
export async function exportCsreq(binaryPath: string, exec: Exec = defaultExec): Promise<CsreqResult> {
  let outcome: ExecOutcome;
  try {
    outcome = await exec(binaryPath, ['--print-csreq', binaryPath]);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  const hex = outcome.stdout.trim().toLowerCase();
  if (outcome.exitCode !== 0) {
    return { ok: false, reason: outcome.stderr.trim() || outcome.stdout.trim() || `exited ${outcome.exitCode ?? 'without a code'}` };
  }
  /* A requirement blob starts with the 0xFADE0C00 magic and carries its own
     length, so real ones are tens of bytes at minimum. Anything else means the
     binary printed something that is not a requirement. */
  if (!/^[0-9a-f]+$/.test(hex) || hex.length < 32 || hex.length % 2 !== 0 || !hex.startsWith('fade0c')) {
    return { ok: false, reason: `not a code requirement blob: ${JSON.stringify(hex.slice(0, 40))}` };
  }
  return { ok: true, hex };
}

/* -------------------------------------------------------------------------- */
/* Pre-seeding TCC                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The system-level TCC database. Screen Recording and Accessibility are
 * *system* services on every macOS since Catalina: both live here, not in any
 * user's database, which is why one root write can grant them for all
 * sessions.
 */
export const SYSTEM_TCC_DB = '/Library/Application Support/com.apple.TCC/TCC.db';

/** The two services the daemon needs, in the order they are granted. */
export const TCC_SERVICES = ['kTCCServiceAccessibility', 'kTCCServiceScreenCapture'] as const;

/**
 * One sqlite statement per service, shaped exactly like the row System
 * Settings writes when a human toggles the switch: same `auth_value` (2 =
 * allowed), same `auth_reason`, same client_type, `csreq` carrying the binary's
 * Designated Requirement.
 *
 * Pure data, snapshot-tested. The script runs these only after a successful
 * write-probe ({@link TCC_WRITE_PROBE_SQL}), because without Full Disk Access
 * even root cannot open this database for writing under SIP.
 */
export function tccGrantCommands(options: {
  /** Absolute installed path of the daemon: the record's key. */
  clientPath: string;
  /** Hex of the daemon's Designated Requirement, from {@link exportCsreq}. */
  csreqHex: string;
  dbPath?: string;
}): Array<{ file: string; args: string[] }> {
  const db = options.dbPath ?? SYSTEM_TCC_DB;
  if (!/^[0-9a-f]+$/.test(options.csreqHex) || options.csreqHex.length % 2 !== 0) {
    throw new Error('csreq must be lowercase hex');
  }
  return TCC_SERVICES.map((service) => ({
    file: '/usr/bin/sqlite3',
    args: [
      db,
      `INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, policy_id, indirect_object_identifier_type, indirect_object_identifier, indirect_object_code_identity, flags, last_modified) `
        + `VALUES ('${service}', '${options.clientPath.replace(/'/g, "''")}', 1, 2, 4, 1, X'${options.csreqHex}', NULL, 0, 'UNUSED', NULL, 0, strftime('%s','now'));`,
    ],
  }));
}

/**
 * Acquires the database's write lock and gives it straight back. Mutates
 * nothing, but under SIP only a process with Full Disk Access can acquire it,
 * which makes this the honest probe of whether the pre-seed will work before
 * the first INSERT fails mid-script.
 */
export const TCC_WRITE_PROBE_SQL = 'BEGIN IMMEDIATE; ROLLBACK;';

/* -------------------------------------------------------------------------- */
/* The root install script                                                    */
/* -------------------------------------------------------------------------- */

/** Single-quote a value for `/bin/sh`, safely, including embedded quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface InstallScriptOptions {
  /** Freshly compiled binary on the caller's side, to be installed. */
  binarySource: string;
  /** Rendered plist on the caller's side, to be installed. */
  plistSource: string;
  /** Helper account short name: the plist must be owned by it. */
  user: string;
  /** Helper account uid: the launchd domain is `gui/<uid>`. */
  uid: number;
  /** Helper account home, where `Library/LaunchAgents` lives. */
  home: string;
  /** Defaults to {@link installDirFor}(home). */
  installDir?: string;
  /** Defaults to {@link DEFAULT_LABEL}. */
  label?: string;
  /** Defaults to {@link DAEMON_BINARY_NAME}. */
  binaryName?: string;
  /**
   * Socket directory to pre-create, owned by the helper account. Defaults to
   * {@link DEFAULT_SOCKET_DIR}. launchd opens `StandardOutPath` before `exec`
   * and does not create parent directories, so the daemon's first log line
   * would otherwise go nowhere.
   */
  socketDir?: string;
  /**
   * Create the helper account as part of this script, with this password.
   * Non-interactive on purpose: an interactive prompt here would break every
   * scripted install, and the password is machine-local random data. It is
   * visible in `ps` for the moment `sysadminctl` runs: accepted, because it
   * guards only the throwaway helper account.
   */
  createAccount?: { password: string };
  /**
   * Write the first-login suppression files (`.skipbuddy` and the
   * Setup Assistant "already seen" keys) into a home that has never finished a
   * first login, so nobody has to click through region/Apple ID/Siri panes for
   * an account that exists to be driven by a robot.
   */
  skipSetupAssistant?: boolean;
  /**
   * Pre-grant Screen Recording and Accessibility to the installed daemon path,
   * using this Designated Requirement ({@link exportCsreq}). Needs Full Disk
   * Access on the invoking terminal; the script probes first and degrades to a
   * printed explanation instead of failing.
   */
  tcc?: { csreqHex: string };
  /** Show the fast-user-switching menu, so switching is one click when it is needed. */
  enableFastUserSwitching?: boolean;
  /**
   * Arm boot-time auto-login for the helper account with this password.
   * Opt-in: macOS refuses auto-login under FileVault, and arming it changes
   * what appears at boot. `sysadminctl` reports the FileVault refusal itself.
   */
  autoLoginPassword?: string;
}

/**
 * The Setup Assistant panes a fresh local account is shown on first login, as
 * the "already seen" keys of its own `com.apple.SetupAssistant` preferences.
 * Unknown keys are harmless; known-but-missing keys cost one click each inside
 * an account nobody is watching.
 */
export const SETUP_ASSISTANT_SEEN_KEYS = [
  'DidSeeCloudSetupFinished',
  'DidSeePrivacySetup',
  'DidSeeSiriSetup',
  'DidScreenTimeSetup',
  'DidSeeTrueToneSetup',
  'DidSeeAppearanceSetup',
  'DidSeeTouchIDSetup',
  'DidSeeBiometricSetup',
  'DidSeeUnlockWithWatchSetup',
  'DidSeeiCloudStorageSetup',
  'DidSeeDefaultBrowserSetup',
  'DidSeeWelcome',
] as const;

/**
 * The `.skipbuddy` marker plus one `-bool true` per {@link SETUP_ASSISTANT_SEEN_KEYS},
 * written into the helper account's own preferences before its first login.
 *
 * Root writes the plists directly because there is no cfprefsd instance for an
 * account that has never logged in, nothing can race or clobber them, and
 * then hands ownership back so the account's first launch trusts its own
 * preferences.
 */
export function setupAssistantCommands(options: {
  user: string;
  home: string;
}): Array<{ file: string; args: string[] }> {
  const preferences = path.join(options.home, 'Library', 'Preferences');
  const plistPath = path.join(preferences, 'com.apple.SetupAssistant.plist');
  /* Only paths and keys are quoted; flags stay bare so the rendered script
     reads like something a person can proofread before typing their password. */
  const q = shellQuote;
  const commands: Array<{ file: string; args: string[] }> = [
    /* An account that exists in the directory but has never logged in can have
       no home yet; everything below writes into it. */
    {
      file: '/usr/bin/install',
      args: ['-d', '-o', options.user, '-g', 'staff', '-m', '755', q(options.home)],
    },
    /* macbuddy checks this marker at the root of the home directory. */
    { file: '/usr/bin/touch', args: [q(path.join(options.home, '.skipbuddy'))] },
    {
      file: '/usr/sbin/chown',
      args: [options.user, q(path.join(options.home, '.skipbuddy'))],
    },
    {
      file: '/usr/bin/install',
      args: ['-d', '-o', options.user, '-g', 'staff', '-m', '755', q(preferences)],
    },
  ];
  for (const key of SETUP_ASSISTANT_SEEN_KEYS) {
    commands.push({ file: '/usr/bin/defaults', args: ['write', q(plistPath), key, '-bool', 'true'] });
  }
  commands.push({ file: '/usr/sbin/chown', args: [options.user, q(plistPath)] });
  return commands;
}

/**
 * Persist the helper account's password beside its configuration.
 *
 * The password is machine-local random data guarding a throwaway account, and
 * it is the one secret future automation needs (auto-login re-armament, a UI
 * scripted first switch). It is stored at `~/.config/offstage/session.json`,
 * mode 0600, next to the `user` key this file already carries.
 */
export async function persistSessionConfig(
  user: string,
  password: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const home = env['HOME'] ?? os.homedir();
  const configPath = path.join(home, SESSION_CONFIG_RELATIVE_PATH);
  let merged: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null) merged = parsed as Record<string, unknown>;
  } catch {
    /* First write wins; an unreadable or absent file is not an error. */
  }
  merged['user'] = user;
  merged['password'] = password;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(merged, null, 2)}\n`);
  /* writeFile's mode only applies at creation; chmod so a pre-existing,
     wider file is tightened too. */
  await fs.chmod(configPath, 0o600);
}

/**
 * Render the one script that needs root.
 *
 * It is printed before it runs, on purpose: the user is about to type a
 * password, and "trust me" is not an acceptable thing for a tool to say at that
 * moment. Every line is `install(1)`, `launchctl`, `sqlite3`, `defaults`,
 * `sysadminctl` or `chown`, no compilation, no network, no package manager.
 *
 * `bootout` is allowed to fail: on a first install there is nothing to unload,
 * and `launchctl` exits non-zero for that. The TCC pre-seed probe is allowed
 * to fail the same way: without Full Disk Access the inserts are skipped with
 * a printed explanation rather than aborting an otherwise complete install.
 * Everything else is fatal (`set -e`).
 *
 * The three `install -d` lines for the socket directory, `Library/Logs` and
 * `Library/LaunchAgents` are not padding: launchd creates no parent directory
 * for a plist or a log path, and a helper account that has never finished a
 * first login has neither `Library` subdirectory yet.
 */
export function renderInstallScript(options: InstallScriptOptions): string {
  const installDir = options.installDir ?? installDirFor(options.home);
  const label = options.label ?? DEFAULT_LABEL;
  const binaryName = options.binaryName ?? DAEMON_BINARY_NAME;
  const socketDir = options.socketDir ?? DEFAULT_SOCKET_DIR;
  const target = path.join(installDir, binaryName);
  /* Both may be missing on an account that has never finished a first login,
     and launchd creates neither: no LaunchAgents directory means nothing to
     bootstrap, no Logs directory means the daemon's output goes nowhere. */
  const agentsDir = path.join(options.home, 'Library', 'LaunchAgents');
  const logDir = path.dirname(daemonLogPath(options.home));
  const plistTarget = launchAgentPath(options.home, label);
  const service = `gui/${options.uid}/${label}`;

  const lines: string[] = [
    '#!/bin/sh',
    '# offstage session setup: installs offstage-sessiond into the',
    `# ${options.user} account's GUI session. This is the only step that needs root.`,
    'set -eu',
  ];

  if (options.createAccount !== undefined) {
    lines.push(
      '',
      `# Create the "${options.user}" account if it does not exist yet.`,
      '# An empty password would leave the account unable to log in; a real one',
      "# lets a human switch into it once, which is all this lane ever asks.",
      `if ! /usr/bin/dscl . -read ${shellQuote(`/Users/${options.user}`)} UniqueID >/dev/null 2>&1; then`,
      `  /usr/sbin/sysadminctl -addUser ${shellQuote(options.user)} -fullName ${shellQuote('Computer Use')} -password ${shellQuote(options.createAccount.password)} -UID ${options.uid} -home ${shellQuote(options.home)}`,
      'fi',
    );
  }

  if (options.skipSetupAssistant === true) {
    lines.push(
      '',
      '# First-login suppression: this account exists to be driven, and nobody',
      '# will click through Setup Assistant inside it.',
      ...setupAssistantCommands({ user: options.user, home: options.home }).map(
        (command) => `${command.file} ${command.args.join(' ')}`,
      ),
    );
  }

  lines.push(
    '',
    `install -d -o ${shellQuote(options.user)} -g staff -m 755 ${shellQuote(installDir)}`,
    `install -o ${shellQuote(options.user)} -g staff -m 755 ${shellQuote(options.binarySource)} ${shellQuote(target)}`,
    '',
    '# Nothing installs into the old root-owned location any more; drop it so a',
    '# stale binary cannot be bootstrapped by an old plist.',
    `rm -f ${shellQuote(path.join(LEGACY_INSTALL_DIR, binaryName))}`,
    '',
    `install -d -o ${shellQuote(options.user)} -g staff -m 755 ${shellQuote(socketDir)}`,
    `install -d -o ${shellQuote(options.user)} -g staff -m 755 ${shellQuote(logDir)}`,
    '',
    `install -d -o ${shellQuote(options.user)} -g staff -m 755 ${shellQuote(agentsDir)}`,
    `install -o ${shellQuote(options.user)} -g staff -m 644 ${shellQuote(options.plistSource)} ${shellQuote(plistTarget)}`,
    '',
  );

  if (options.tcc !== undefined) {
    const db = shellQuote(SYSTEM_TCC_DB);
    const grants = tccGrantCommands({
      clientPath: target,
      csreqHex: options.tcc.csreqHex,
    });
    lines.push(
      '# Pre-seed both TCC grants so the daemon comes up trusted, with no',
      '# toggles and no prompts inside the helper session. Rows are shaped',
      '# exactly like the ones System Settings writes: same auth values, same',
      '# code requirement the binary already satisfies.',
      `if ! /usr/bin/sqlite3 ${db} ${shellQuote(TCC_WRITE_PROBE_SQL)} >/dev/null 2>&1; then`,
      `  echo 'TCC_PRESEED_SKIPPED: even root could not open the TCC database for writing.'`,
      `  echo '  The terminal that ran this command needs Full Disk Access'`,
      `  echo '  (System Settings > Privacy & Security > Full Disk Access).'`,
      `  echo '  Grant it and re-run this command, or approve Screen Recording and'`,
      `  echo '  Accessibility by hand inside the helper session later.'`,
      `else`,
      ...grants.map(
        (grant) =>
          `  ${grant.file} ${db} ${shellQuote(grant.args[1] ?? '')}`,
      ),
      `  /usr/bin/killall tccd >/dev/null 2>&1 || true`,
      `fi`,
      '',
    );
  }

  if (options.enableFastUserSwitching === true) {
    lines.push(
      '# Show the fast-user-switching menu, so the one manual switch this lane',
      '# asks for is discoverable instead of hidden behind a settings pane.',
      `/usr/bin/defaults write '/Library/Preferences/.GlobalPreferences' MultipleSessionEnabled -bool true`,
      '',
    );
  }

  lines.push(
    `launchctl bootout ${shellQuote(service)} 2>/dev/null || true`,
    `launchctl bootstrap ${shellQuote(`gui/${options.uid}`)} ${shellQuote(plistTarget)}`,
    `launchctl kickstart -k ${shellQuote(service)}`,
  );

  if (options.autoLoginPassword !== undefined) {
    lines.push(
      '',
      '# Arm boot-time auto-login for the helper account (opt-in). Under',
      '# FileVault, sysadminctl reports that auto-login cannot be enabled;',
      '# that refusal is allowed to print without failing the install.',
      `/usr/sbin/sysadminctl -autologin set -userName ${shellQuote(options.user)} -password ${shellQuote(options.autoLoginPassword)} \\`,
      `  || echo 'AUTOLOGIN_NOT_ARMED: sysadminctl refused (FileVault blocks auto-login).'`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* swiftc                                                                     */
/* -------------------------------------------------------------------------- */

/** Frameworks the daemon links: screen capture, event posting, app listing, requirement export. */
export const DAEMON_FRAMEWORKS = [
  'CoreGraphics',
  'AppKit',
  'ApplicationServices',
  'Security',
] as const;

/** The fix for a machine with no Swift compiler. */
export const SWIFTC_INSTALL_FIX = 'xcode-select --install';

export type FindSwiftcResult =
  | { found: true; path: string }
  | { found: false; reason: string; fix: string };

/**
 * Locate `swiftc`.
 *
 * `xcrun --find` first, because it answers correctly for both a full Xcode and
 * the Command Line Tools; `/usr/bin/swiftc` is the fallback for a machine where
 * `xcrun` is present but confused about its active developer directory.
 */
export async function findSwiftc(exec: Exec = defaultExec): Promise<FindSwiftcResult> {
  const found = await exec('/usr/bin/xcrun', ['--find', 'swiftc']);
  const candidate = found.stdout.trim().split('\n')[0]?.trim() ?? '';
  if (found.exitCode === 0 && candidate !== '') return { found: true, path: candidate };

  const which = await exec('/usr/bin/which', ['swiftc']);
  const fallback = which.stdout.trim().split('\n')[0]?.trim() ?? '';
  if (which.exitCode === 0 && fallback !== '') return { found: true, path: fallback };

  return {
    found: false,
    reason:
      'No Swift compiler was found, so the offstage session daemon cannot be built. The daemon is a single Swift binary with no runtime dependencies, because the helper account cannot read your node installation.',
    fix: SWIFTC_INSTALL_FIX,
  };
}

/* -------------------------------------------------------------------------- */
/* Compiling the daemon                                                       */
/* -------------------------------------------------------------------------- */

export interface CompileDaemonOptions {
  /** Directory holding `build.sh` and the `*.swift` sources. */
  sourceDir: string;
  /** Absolute path the compiled binary should land at. */
  outPath: string;
  exec?: Exec;
  /** Existence seam; defaults to `fs.stat`. */
  exists?: (target: string) => Promise<boolean>;
  /** Source listing seam; defaults to reading `sourceDir` for `*.swift`. */
  listSources?: (dir: string) => Promise<string[]>;
}

export interface CompileDaemonResult {
  ok: boolean;
  /** The command that was run, as a printable string. */
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Set when the compile could not even be attempted. */
  reason?: string;
  fix?: string;
  /** Which route was taken: the shipped build script, or a direct `swiftc`. */
  via: 'build.sh' | 'swiftc' | 'none';
}

const defaultExists = async (target: string): Promise<boolean> => {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
};

const defaultListSources = async (dir: string): Promise<string[]> => {
  try {
    const entries = await fs.readdir(dir);
    return entries
      .filter((entry) => entry.endsWith('.swift'))
      .sort()
      .map((entry) => path.join(dir, entry));
  } catch {
    return [];
  }
};

/**
 * Build `offstage-sessiond`.
 *
 * Prefers `native/sessiond/build.sh`: the daemon owns the flags it needs, and
 * a build script that ships beside the source cannot drift from it. When the
 * script is absent, this falls back to invoking `swiftc` over the sources
 * directly, so a partially-published package still yields a working daemon
 * rather than a puzzle.
 *
 * Never throws: a missing compiler, a missing source directory and a failing
 * compile all come back as `ok: false` with the compiler's own output.
 */
export async function compileDaemon(
  options: CompileDaemonOptions,
): Promise<CompileDaemonResult> {
  const exec = options.exec ?? defaultExec;
  const exists = options.exists ?? defaultExists;
  const listSources = options.listSources ?? defaultListSources;

  const buildScript = path.join(options.sourceDir, 'build.sh');
  if (await exists(buildScript)) {
    /* Explicitly bash, not `sh`: the shipped build.sh reads BASH_SOURCE to
       locate its own directory, and invoking it through a POSIX shell would
       break that the day /bin/sh stops being bash. */
    const args = [buildScript, options.outPath];
    const outcome = await exec('/bin/bash', args);
    return {
      ok: outcome.exitCode === 0,
      command: `/bin/bash ${args.map(shellQuote).join(' ')}`,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      exitCode: outcome.exitCode,
      via: 'build.sh',
    };
  }

  const sources = await listSources(options.sourceDir);
  if (sources.length === 0) {
    return {
      ok: false,
      command: '',
      stdout: '',
      stderr: '',
      exitCode: null,
      reason: `No Swift sources were found in ${options.sourceDir}, so the offstage session daemon cannot be built.`,
      fix: 'Reinstall offstage; the daemon source ships in the package under native/sessiond/.',
      via: 'none',
    };
  }

  const swiftc = await findSwiftc(exec);
  if (!swiftc.found) {
    return {
      ok: false,
      command: '',
      stdout: '',
      stderr: '',
      exitCode: null,
      reason: swiftc.reason,
      fix: swiftc.fix,
      via: 'none',
    };
  }

  const args = [
    '-O',
    '-o',
    options.outPath,
    ...sources,
    ...DAEMON_FRAMEWORKS.flatMap((framework) => ['-framework', framework]),
  ];
  const outcome = await exec(swiftc.path, args);
  return {
    ok: outcome.exitCode === 0,
    command: `${swiftc.path} ${args.map(shellQuote).join(' ')}`,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    exitCode: outcome.exitCode,
    via: 'swiftc',
  };
}

/* -------------------------------------------------------------------------- */
/* ACLs                                                                       */
/* -------------------------------------------------------------------------- */

/** One `chmod +a` invocation, as data. */
export interface AclCommand {
  file: string;
  args: string[];
  /** What this entry is for, for `--json` output and diagnostics. */
  kind: 'traverse' | 'read' | 'write';
  /** The path it applies to. */
  target: string;
}

/** Printable form of an {@link AclCommand}. */
export function describeAclCommand(command: AclCommand): string {
  return `${command.file} ${command.args.map(shellQuote).join(' ')}`;
}

/**
 * The ancestors that have to become traversable for `target` to be reachable.
 *
 * Starts at the owner's home directory when `target` is inside it: `/Users`
 * and `/` are already world-traversable, and granting anything on them would be
 * both useless and alarming. For a target outside any home, the walk starts at
 * the first component under `/` for the same reason.
 */
export function shareAncestors(target: string, home: string): string[] {
  const resolved = path.resolve(target);
  const root = path.resolve(home);
  const ancestors: string[] = [];

  let current = path.dirname(resolved);
  const stop = resolved.startsWith(`${root}${path.sep}`) ? path.dirname(root) : path.parse(resolved).root;

  while (current !== stop && current !== path.parse(current).root) {
    ancestors.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

export interface ShareAclOptions {
  /** Tree to share, absolute. */
  target: string;
  /** Helper account short name. */
  user: string;
  /** Home directory of the tree's owner: the caller. Defaults to `os.homedir()`. */
  home?: string;
  exec?: Exec;
}

/**
 * The exact `chmod +a` commands `offstage session share <dir>` runs, and
 * nothing else: traverse-only on each ancestor, read on the tree itself.
 *
 * Pure. Rendering the plan separately from running it is what makes `share`
 * explainable: the CLI can print what it is about to do to a user's home
 * directory before it does it.
 */
export function shareAclCommands(options: Omit<ShareAclOptions, 'exec'>): AclCommand[] {
  const home = options.home ?? os.homedir();
  const target = path.resolve(options.target);
  const commands: AclCommand[] = shareAncestors(target, home).map((ancestor) => ({
    file: '/bin/chmod',
    args: ['+a', `${options.user} allow ${SHARE_TRAVERSE_ACL}`, ancestor],
    kind: 'traverse' as const,
    target: ancestor,
  }));
  commands.push({
    file: '/bin/chmod',
    args: ['-R', '+a', `${options.user} allow ${SHARE_READ_ACL}`, target],
    kind: 'read',
    target,
  });
  return commands;
}

/** What running a set of {@link AclCommand}s produced. */
export interface AclResult {
  ok: boolean;
  commands: string[];
  failures: Array<{ command: string; stderr: string; exitCode: number | null }>;
}

async function runAclCommands(commands: AclCommand[], exec: Exec): Promise<AclResult> {
  const ran: string[] = [];
  const failures: AclResult['failures'] = [];
  for (const command of commands) {
    const printable = describeAclCommand(command);
    ran.push(printable);
    let outcome: ExecOutcome;
    try {
      outcome = await exec(command.file, command.args);
    } catch (error) {
      outcome = {
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: null,
      };
    }
    if (outcome.exitCode !== 0) {
      failures.push({
        command: printable,
        stderr: outcome.stderr.trim() || outcome.stdout.trim(),
        exitCode: outcome.exitCode,
      });
    }
  }
  return { ok: failures.length === 0, commands: ran, failures };
}

/**
 * Grant the helper account read access to one tree. Never throws; a `chmod`
 * that fails comes back in `failures` with its own stderr.
 */
export async function shareAcl(options: ShareAclOptions): Promise<AclResult> {
  return await runAclCommands(shareAclCommands(options), options.exec ?? defaultExec);
}

export interface UnshareAclOptions {
  /** Tree whose read grant should be revoked, absolute. */
  target: string;
  /** Helper account short name. */
  user: string;
  /** Home directory of the tree's owner: the caller. Defaults to `os.homedir()`. */
  home?: string;
  exec?: Exec;
}

/**
 * The exact inverses of {@link shareAclCommands}: remove the read ACL from the
 * tree (recursively, which also strips the entries children inherited while
 * the grant stood) and the traverse-only entry from each ancestor.
 *
 * Pure, snapshot-tested, and deliberately symmetric with the grant: these are
 * only the entries offstage itself added.
 */
export function unshareAclCommands(options: Omit<UnshareAclOptions, 'exec'>): AclCommand[] {
  const home = options.home ?? os.homedir();
  const target = path.resolve(options.target);
  const commands: AclCommand[] = shareAncestors(target, home).map((ancestor) => ({
    file: '/bin/chmod',
    args: ['-a', `${options.user} allow ${SHARE_TRAVERSE_ACL}`, ancestor],
    kind: 'traverse' as const,
    target: ancestor,
  }));
  commands.push({
    file: '/bin/chmod',
    args: ['-R', '-a', `${options.user} allow ${SHARE_READ_ACL}`, target],
    kind: 'read',
    target,
  });
  return commands;
}

/** macOS `chmod` exits 1 with this text when the ACL being removed is not there. */
const NO_ACL_PRESENT = /No ACL present/;

/**
 * Revoke what {@link shareAcl} granted.
 *
 * Removing an ACL entry that is already absent makes `chmod` exit 1 with
 * "No ACL present": measured, not assumed. That is success for an unshare:
 * the goal state is "the grant is gone", however it got there. Any other
 * failure (ENOENT on a deleted tree, a permissions error) is reported as such
 * in `failures`. Never throws.
 */
export async function unshareAcl(options: UnshareAclOptions): Promise<AclResult> {
  const result = await runAclCommands(unshareAclCommands(options), options.exec ?? defaultExec);
  const realFailures = result.failures.filter((failure) => !NO_ACL_PRESENT.test(failure.stderr));
  return { ...result, ok: realFailures.length === 0, failures: realFailures };
}

export interface GrantArtifactsWriteOptions {
  /** The run's artifacts directory. The lane owns it, so the lane may open it. */
  dir: string;
  user: string;
  exec?: Exec;
}

/** The single `chmod +a` that opens one run directory to the helper account. */
export function grantArtifactsWriteCommands(
  options: Omit<GrantArtifactsWriteOptions, 'exec'>,
): AclCommand[] {
  const target = path.resolve(options.dir);
  return [
    {
      file: '/bin/chmod',
      args: ['+a', `${options.user} allow ${ARTIFACTS_WRITE_ACL}`, target],
      kind: 'write',
      target,
    },
  ];
}

/**
 * Let the helper account write into this run's artifacts directory, and only
 * this one. Called by the lane on every run, because the directory is created
 * per run and is owned by the caller, not by the helper account.
 */
export async function grantArtifactsWrite(
  options: GrantArtifactsWriteOptions,
): Promise<AclResult> {
  return await runAclCommands(grantArtifactsWriteCommands(options), options.exec ?? defaultExec);
}
