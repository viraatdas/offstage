/**
 * Finding the helper account and its GUI session.
 *
 * The session lane's whole premise is that a *second* macOS account is logged
 * in and sitting in the background with its own window server connection. This
 * module is the part that answers "is that true right now?", and it answers it
 * from two pieces of recorded-able text plus one `stat`:
 *
 * 1. `ioreg -n Root -d1 -a` — an XML plist whose `IOConsoleUsers` array is the
 *    kernel's own list of GUI sessions. Each entry carries the uid, the short
 *    name, whether the session finished logging in (`kCGSessionLoginDoneKey`)
 *    and whether it is the one on the screen (`kCGSSessionOnConsoleKey`).
 * 2. `dscl . -read /Users/<name> UniqueID NFSHomeDirectory RealName` — the
 *    account record, which tells us the account exists at all and where its
 *    home is (needed for the LaunchAgent path).
 * 3. `stat` on `<socketDir>/<uid>.sock` — has the daemon ever bound?
 *
 * Everything except the `stat` is a **pure function over captured text**
 * ({@link parseConsoleUsers}, {@link parseDsclRecord}), and the only way this
 * module reaches the world is through the injected {@link Exec} seam. So the
 * whole ladder is unit-tested against output recorded from a real machine in
 * `tests/fixtures/session/`, on hosts that have no helper account at all.
 *
 * Nothing here mutates anything: no account is created, no session is started,
 * no daemon is launched. It reports.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import plist from 'plist';

/* -------------------------------------------------------------------------- */
/* The exec seam                                                              */
/* -------------------------------------------------------------------------- */

/** What {@link Exec} resolves to. `exitCode` is `null` when a signal killed it. */
export interface ExecOutcome {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * The one way this module (and `setup.ts`) touches the outside world.
 *
 * Deliberately narrow — file, args, captured output — so a test can hand back
 * recorded text and drive every branch without `ioreg`, `dscl`, `chmod` or
 * `swiftc` ever running.
 */
export type Exec = (file: string, args: string[]) => Promise<ExecOutcome>;

/** Default {@link Exec}: execa with rejection disabled, so failures are data. */
export const defaultExec: Exec = async (file, args) => {
  const { execa } = await import('execa');
  try {
    const result = await execa(file, args, {
      reject: false,
      timeout: 30_000,
      all: false,
      stripFinalNewline: true,
    });
    return {
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
    };
  } catch (error) {
    /* execa still throws for a binary that does not exist at all. A missing
       `ioreg` is data too — it means "not macOS, or not a usable one". */
    return { stdout: '', stderr: describeError(error), exitCode: null };
  }
};

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** The account offstage logs in as, when nothing says otherwise. */
export const DEFAULT_SESSION_USER = 'computeruse';

/** Where `offstage-sessiond` binds its socket, when nothing says otherwise. */
export const DEFAULT_SOCKET_DIR = '/tmp/offstage-session';

/** Environment variable that overrides the helper account name. */
export const SESSION_USER_ENV_VAR = 'OFFSTAGE_SESSION_USER';

/** Config file consulted when the environment says nothing, relative to `$HOME`. */
export const SESSION_CONFIG_RELATIVE_PATH = '.config/offstage/session.json';

/* -------------------------------------------------------------------------- */
/* Which account                                                              */
/* -------------------------------------------------------------------------- */

/** Reads a config file, or resolves `null` when it is absent/unreadable. */
export type ReadConfig = (configPath: string) => Promise<string | null>;

/** Absolute path of the session config file for a given environment. */
export function sessionConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['HOME'] ?? os.homedir();
  return path.join(home, SESSION_CONFIG_RELATIVE_PATH);
}

const defaultReadConfig: ReadConfig = async (configPath) => {
  try {
    return await fs.readFile(configPath, 'utf8');
  } catch {
    return null;
  }
};

/**
 * Which account the session lane should use.
 *
 * Precedence, per `docs/session-lane.md`: `OFFSTAGE_SESSION_USER` →
 * `~/.config/offstage/session.json` `{"user": "..."}` → `computeruse`.
 *
 * Never throws: a malformed or unreadable config file falls through to the
 * default rather than taking a `doctor` run down with it.
 */
export async function resolveSessionUser(
  env: NodeJS.ProcessEnv = process.env,
  readConfig: ReadConfig = defaultReadConfig,
): Promise<string> {
  const fromEnv = env[SESSION_USER_ENV_VAR]?.trim();
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;

  const raw = await readConfig(sessionConfigPath(env));
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) {
        const user = (parsed as { user?: unknown }).user;
        if (typeof user === 'string' && user.trim() !== '') return user.trim();
      }
    } catch {
      /* A broken config file is not worth failing over; the default is right
         far more often than an exception is useful. */
    }
  }

  return DEFAULT_SESSION_USER;
}

/* -------------------------------------------------------------------------- */
/* ioreg: the kernel's list of GUI sessions                                   */
/* -------------------------------------------------------------------------- */

/** One entry of `IOConsoleUsers` — a GUI session as the kernel sees it. */
export interface ConsoleUser {
  /** `kCGSSessionUserIDKey`. */
  uid: number | null;
  /** `kCGSSessionUserNameKey` — the short name. */
  user: string | null;
  /** `kCGSessionLongUserNameKey` — the full name, as the user menu shows it. */
  fullName: string | null;
  /** `kCGSSessionOnConsoleKey` — is this the session on the physical screen? */
  onConsole: boolean;
  /** `kCGSessionLoginDoneKey` — a real Aqua session, not a login window. */
  loginDone: boolean;
  /** `kCGSSessionIDKey`. */
  sessionId: number | null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Pull the GUI session list out of `ioreg -n Root -d1 -a` output.
 *
 * Tolerant on purpose: an ioreg that is not a plist, has no `IOConsoleUsers`,
 * or carries entries in a shape a future macOS invented all come back as `[]`
 * or as entries with `null` fields, never as an exception. "I could not see a
 * session" and "the session is not there" lead to the same honest verdict.
 */
export function parseConsoleUsers(ioregXml: string): ConsoleUser[] {
  /* Cheap pre-check: the XML parser underneath `plist` logs its own complaints
     to stderr before throwing, and "ioreg: command not found" is a perfectly
     ordinary thing to hand this function on a machine without one. */
  if (!ioregXml.trimStart().startsWith('<')) return [];

  let parsed: unknown;
  try {
    parsed = plist.parse(ioregXml);
  } catch {
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];

  const raw = (parsed as Record<string, unknown>)['IOConsoleUsers'];
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      uid: asNumber(entry['kCGSSessionUserIDKey']),
      user: asString(entry['kCGSSessionUserNameKey']),
      fullName: asString(entry['kCGSessionLongUserNameKey']),
      onConsole: entry['kCGSSessionOnConsoleKey'] === true,
      loginDone: entry['kCGSessionLoginDoneKey'] === true,
      sessionId: asNumber(entry['kCGSSessionIDKey']),
    }));
}

/**
 * The GUI session belonging to an account, matched by uid when we know it and
 * by short name otherwise. Returns `undefined` when that account has none.
 */
export function findConsoleUser(
  users: ConsoleUser[],
  match: { uid?: number | null; user?: string | null },
): ConsoleUser | undefined {
  const uid = match.uid ?? null;
  const user = match.user ?? null;
  return users.find((entry) => {
    if (uid !== null && entry.uid !== null) return entry.uid === uid;
    if (user !== null && entry.user !== null) return entry.user === user;
    return false;
  });
}

/* -------------------------------------------------------------------------- */
/* dscl: the account record                                                   */
/* -------------------------------------------------------------------------- */

/** What `dscl . -read /Users/<name> …` told us about an account. */
export interface DsclRecord {
  exists: boolean;
  uid: number | null;
  home: string | null;
  fullName: string | null;
}

/**
 * Parse `dscl . -read /Users/<name> UniqueID NFSHomeDirectory RealName`.
 *
 * dscl prints `Key: value`, and puts the value on the *next* line, indented,
 * when it contains spaces:
 *
 * ```text
 * NFSHomeDirectory: /Users/computeruse
 * RealName:
 *  Computer Use
 * UniqueID: 502
 * ```
 *
 * A missing account prints `<dscl_cmd> DS Error: -14136 (eDSRecordNotFound)`
 * and exits non-zero, which is `exists: false` — see {@link readAccount}.
 */
export function parseDsclRecord(output: string): DsclRecord {
  const values = new Map<string, string>();
  let currentKey: string | null = null;
  let currentValue: string[] = [];

  const flush = (): void => {
    if (currentKey !== null) {
      values.set(currentKey, currentValue.join(' ').trim());
    }
    currentKey = null;
    currentValue = [];
  };

  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    if (/^\s/.test(line)) {
      /* Continuation of the previous key's value. */
      if (currentKey !== null) currentValue.push(line.trim());
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match === null) {
      flush();
      continue;
    }
    flush();
    currentKey = match[1] as string;
    const inline = (match[2] as string).trim();
    if (inline !== '') currentValue.push(inline);
  }
  flush();

  const uidText = values.get('UniqueID');
  const uid = uidText !== undefined && /^-?\d+$/.test(uidText) ? Number(uidText) : null;
  const home = values.get('NFSHomeDirectory') ?? null;
  const fullName = values.get('RealName') ?? null;

  const failed = /DS Error/.test(output);
  return {
    exists: !failed && (uid !== null || home !== null),
    uid,
    home: home === '' ? null : home,
    fullName: fullName === '' ? null : fullName,
  };
}

/** Run `dscl` for one account and parse the result. Never throws. */
export async function readAccount(user: string, exec: Exec = defaultExec): Promise<DsclRecord> {
  const { stdout, stderr, exitCode } = await exec('/usr/bin/dscl', [
    '.',
    '-read',
    `/Users/${user}`,
    'UniqueID',
    'NFSHomeDirectory',
    'RealName',
  ]);
  const record = parseDsclRecord(`${stdout}\n${stderr}`);
  if (exitCode !== 0) return { ...record, exists: false };
  return record;
}

/** Run `ioreg` and parse the GUI session list. Never throws. */
export async function readConsoleUsers(exec: Exec = defaultExec): Promise<ConsoleUser[]> {
  const { stdout } = await exec('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-a']);
  return parseConsoleUsers(stdout);
}

/* -------------------------------------------------------------------------- */
/* The socket                                                                 */
/* -------------------------------------------------------------------------- */

/** `<socketDir>/<uid>.sock` — where `offstage-sessiond` binds. */
export function sessionSocketPath(uid: number | null, socketDir: string = DEFAULT_SOCKET_DIR): string {
  return path.join(socketDir, `${uid ?? 'unknown'}.sock`);
}

/** Is there a socket at that path right now? Never throws. */
export async function socketExists(socketPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(socketPath);
    return stat.isSocket();
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* The whole picture                                                          */
/* -------------------------------------------------------------------------- */

/** The GUI session half of {@link SessionDiscovery}. */
export interface GuiSessionState {
  /** Is there an `IOConsoleUsers` entry for this account at all? */
  exists: boolean;
  /** `kCGSessionLoginDoneKey`: a full Aqua session rather than a login window. */
  loginDone: boolean;
  /** `kCGSSessionOnConsoleKey`: is it the session on the physical screen? */
  onConsole: boolean;
  /** `kCGSSessionIDKey`, for diagnostics. */
  sessionId: number | null;
}

/** Everything the lane needs to know before it opens a socket. */
export interface SessionDiscovery {
  /** Short name of the helper account this describes. */
  user: string;
  uid: number | null;
  home: string | null;
  fullName: string | null;
  accountExists: boolean;
  guiSession: GuiSessionState;
  socketPath: string;
  socketPresent: boolean;
  /** `process.platform` at the time of the probe. */
  platform: NodeJS.Platform;
}

export interface DescribeSessionOptions {
  /** Account to describe. Defaults to {@link resolveSessionUser}. */
  user?: string;
  /** Where the daemon binds. Defaults to {@link DEFAULT_SOCKET_DIR}. */
  socketDir?: string;
  exec?: Exec;
  env?: NodeJS.ProcessEnv;
  readConfig?: ReadConfig;
  /** Overridden in tests; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Socket presence seam; defaults to {@link socketExists}. */
  statSocket?: (socketPath: string) => Promise<boolean>;
}

/**
 * Describe the helper account and its session, right now.
 *
 * Never throws and never mutates: on a machine with no such account, on Linux,
 * or with `ioreg` missing, this returns a fully-populated record whose flags
 * are simply `false`. The lane turns that record into a reason and a fix.
 */
export async function describeSession(
  options: DescribeSessionOptions = {},
): Promise<SessionDiscovery> {
  const platform = options.platform ?? process.platform;
  const exec = options.exec ?? defaultExec;
  const socketDir = options.socketDir ?? DEFAULT_SOCKET_DIR;
  const statSocket = options.statSocket ?? socketExists;
  const user = options.user ?? (await resolveSessionUser(options.env ?? process.env, options.readConfig));

  if (platform !== 'darwin') {
    return {
      user,
      uid: null,
      home: null,
      fullName: null,
      accountExists: false,
      guiSession: { exists: false, loginDone: false, onConsole: false, sessionId: null },
      socketPath: sessionSocketPath(null, socketDir),
      socketPresent: false,
      platform,
    };
  }

  const account = await readAccount(user, exec);
  const consoleUsers = await readConsoleUsers(exec);
  const entry = findConsoleUser(consoleUsers, { uid: account.uid, user });

  const socketPath = sessionSocketPath(account.uid, socketDir);

  return {
    user,
    uid: account.uid,
    home: account.home,
    fullName: account.fullName ?? entry?.fullName ?? null,
    accountExists: account.exists,
    guiSession: {
      exists: entry !== undefined,
      loginDone: entry?.loginDone ?? false,
      onConsole: entry?.onConsole ?? false,
      sessionId: entry?.sessionId ?? null,
    },
    socketPath,
    socketPresent: account.uid === null ? false : await statSocket(socketPath),
    platform,
  };
}

/**
 * The name to show a human in "switch to this account" instructions: the full
 * name if the directory has one, because that is what the user menu displays.
 */
export function sessionUserFullName(discovery: Pick<SessionDiscovery, 'user' | 'fullName'>): string {
  return discovery.fullName ?? discovery.user;
}
