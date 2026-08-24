/**
 * offstage: bringing the macOS session lane up, and keeping it up.
 *
 * Everything here is about whether the lane can run at all: which helper
 * account it uses, whether that account has a background GUI session, whether
 * `offstage-sessiond` is installed and answering, and whether TCC has granted
 * it Screen Recording and Accessibility. `sessionSetup` is the one-time root
 * path that creates all of that; `sessionUpdate` replaces the daemon binary
 * afterwards without needing root again.
 *
 * Once the lane is up, `./session-control.ts` is what drives it.
 *
 * The seams live in {@link SessionSeams} and default to the real thing, so the
 * CLI and the MCP server pass none of them and a test passes exactly the ones
 * it needs. Nothing in this file shells out on its own.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { SessionLane, SessionLaneOptions, SessionProbe } from '../lanes/session/index.js';
import { createSessionLane, describeSessionProbe } from '../lanes/session/index.js';
import type {
  CompileDaemonResult,
  DescribeSessionOptions,
  Exec,
  GuiSessionState,
  SessionClient,
  SessionClientFactory,
  SessionDiscovery,
  SessionHello,
  SessionPermissions,
} from '../session/index.js';
import {
  DAEMON_BINARY_NAME,
  DAEMON_SOURCE_RELATIVE_DIR,
  DEFAULT_LABEL,
  DEFAULT_SOCKET_DIR,
  SESSION_CONFIG_RELATIVE_PATH,
  SessionRpcError,
  SessionUnreachableError,
  compileDaemon,
  createSessionClient,
  defaultExec,
  describeSession,
  exportCsreq,
  generateSessionPassword,
  installDirFor,
  persistSessionConfig,
  readFileVaultStatus,
  renderInstallScript,
  renderLaunchAgentPlist,
  sessionUserFullName,
} from '../session/index.js';
import { UpdateError, updateDaemon } from '../session/update.js';
import type { ApiDeps } from './api.js';
import { offstageInstall, withDefaults } from './api.js';

/* -------------------------------------------------------------------------- */
/* session                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The session lane is there, but it cannot do this right now: no helper
 * account, no daemon, or a TCC grant the daemon does not have.
 *
 * Distinct from {@link OffstageUsageError} on purpose: the *call* was fine, the
 * substrate is not. It carries the same `fix` string the lane and the daemon
 * produce, so the CLI, an agent and a script all get the identical repair
 * instruction. Exit code 69 (`EX_UNAVAILABLE`), which is what a `skipped` run
 * exits with too.
 */
export class OffstageSessionError extends Error {
  readonly exitCode = 69;
  readonly fix: string | undefined;
  readonly code: string;

  constructor(message: string, options: { fix?: string; code?: string } = {}) {
    super(message);
    this.name = 'OffstageSessionError';
    this.fix = options.fix;
    this.code = options.code ?? 'session-unavailable';
  }
}

/**
 * Every impure thing the session functions touch. All optional: the CLI and the
 * MCP server pass none of it, and a test passes exactly the seams it needs
 * (they are merged over the defaults one key at a time, not wholesale).
 */
export interface SessionSeams {
  /** A pre-built lane. When absent, one is built from the seams below. */
  lane?: SessionLane;
  discover?: (options: DescribeSessionOptions) => Promise<SessionDiscovery>;
  createClient?: SessionClientFactory;
  /** Exec for `chmod +a`, `dscl` and the Swift compiler. */
  exec?: Exec;
  compileDaemon?: typeof compileDaemon;
  /**
   * Run the printed root script with the terminal attached, so `sudo` and
   * `sysadminctl -password -` can prompt. Resolves with its exit code.
   */
  runRootScript?: (scriptPath: string) => Promise<number | null>;
  sleep?: (ms: number) => Promise<void>;
  /** Directory holding `build.sh` and the daemon's Swift sources. */
  sourceDir?: string;
  socketDir?: string;
  now?: () => number;
  /** Caller's home, used to decide which ancestors `share` must open. */
  home?: string;
  /**
   * Where a generated account password is persisted (default: the real
   * `~/.config/offstage/session.json`, mode 0600). Tests record instead.
   */
  writeSessionConfig?: typeof persistSessionConfig;
}

const defaultRunRootScript = async (scriptPath: string): Promise<number | null> =>
  await new Promise((resolve) => {
    // stdio inherited on purpose: sudo has to be able to prompt for a password
    // on the user's own terminal, and `sysadminctl -password -` prompts too.
    const child = spawn('sudo', ['/bin/sh', scriptPath], { stdio: 'inherit' });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code));
  });

/**
 * Sleep between daemon polls. The timer must stay ref'd: an unref'd timer is
 * the only thing on the event loop between two `hello` attempts, so Node would
 * exit with an "unsettled top-level await" in the middle of `setup`, which is
 * exactly what happened on the first live run.
 */
export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The daemon's Swift sources inside whichever copy of offstage is running. */
export function daemonSourceDir(): string {
  const root = offstageInstall().root;
  return path.join(root === '' ? process.cwd() : root, DAEMON_SOURCE_RELATIVE_DIR);
}

export function seamsOf(deps: ApiDeps): SessionSeams {
  return deps.session ?? {};
}

/**
 * The lane to ask. A caller-supplied one wins; otherwise the shared instance,
 * unless a specific account or seam was named, in which case a lane is built
 * for it. `probeSession()` is the only method used here: the lane owns the
 * availability ladder and nothing re-implements it.
 */
export function sessionLaneFor(deps: ApiDeps, user?: string): SessionLane {
  const seams = seamsOf(deps);
  if (seams.lane !== undefined) return seams.lane;

  const options: SessionLaneOptions = {};
  if (user !== undefined) options.user = user;
  if (seams.socketDir !== undefined) options.socketDir = seams.socketDir;
  if (seams.discover !== undefined) options.discover = seams.discover;
  if (seams.createClient !== undefined) options.createClient = seams.createClient;
  if (seams.exec !== undefined) options.exec = seams.exec;
  if (seams.now !== undefined) options.now = seams.now;

  const shared = deps.lanes.session;
  const canUseShared =
    Object.keys(options).length === 0 && typeof (shared as { probeSession?: unknown }).probeSession === 'function';
  return canUseShared ? (shared as SessionLane) : createSessionLane(options);
}

/** Everything `offstage session status` reports, and what `--json` emits. */
export interface SessionStatus {
  available: boolean;
  reason: string | null;
  fix: string | null;
  user: string;
  fullName: string;
  uid: number | null;
  home: string | null;
  accountExists: boolean;
  guiSession: GuiSessionState;
  socketPath: string;
  socketPresent: boolean;
  daemon: SessionHello['daemon'] | null;
  display: SessionHello['display'] | null;
  permissions: SessionPermissions | null;
  /** Missing TCC grants and anything else worth saying even when available. */
  notes: string[];
  /** The probe rendered the way `offstage doctor` renders it. */
  detail: string[];
}

export function statusFromProbe(probe: SessionProbe): SessionStatus {
  const { availability, discovery, hello, notes } = probe;
  return {
    available: availability.available,
    reason: availability.reason ?? null,
    fix: availability.fix ?? null,
    user: discovery.user,
    fullName: sessionUserFullName(discovery),
    uid: discovery.uid,
    home: discovery.home,
    accountExists: discovery.accountExists,
    guiSession: discovery.guiSession,
    socketPath: discovery.socketPath,
    socketPresent: discovery.socketPresent,
    daemon: hello?.daemon ?? null,
    display: hello?.display ?? null,
    permissions: hello?.permissions ?? null,
    notes,
    detail: describeSessionProbe(probe),
  };
}

/**
 * Report the helper account, its session, the socket, the daemon and both TCC
 * grants, plus the fix for whichever rung failed first.
 *
 * Reads only. It never starts anything, never prompts, and never touches the
 * console session.
 */
export async function sessionStatus(
  input: { user?: string } = {},
  deps?: Partial<ApiDeps>,
): Promise<SessionStatus> {
  const d = withDefaults(deps);
  return statusFromProbe(await sessionLaneFor(d, input.user).probeSession());
}

/** A client for the daemon, or the lane's own reason why there is not one. */
export async function sessionConnect(
  deps: ApiDeps,
  user?: string,
): Promise<{ client: SessionClient; probe: SessionProbe }> {
  const probe = await sessionLaneFor(deps, user).probeSession();
  if (!probe.availability.available) {
    throw new OffstageSessionError(
      probe.availability.reason ?? 'The session lane is not available on this machine.',
      { fix: probe.availability.fix ?? undefined, code: 'session-unavailable' },
    );
  }
  const factory = seamsOf(deps).createClient ?? createSessionClient;
  return { client: factory({ socketPath: probe.discovery.socketPath }), probe };
}

/** Turn a daemon refusal into the one error shape the CLI and MCP both render. */
export function asSessionError(error: unknown): never {
  if (error instanceof OffstageSessionError) throw error;
  if (error instanceof SessionRpcError) {
    throw new OffstageSessionError(error.message, {
      ...(error.fix === undefined ? {} : { fix: error.fix }),
      code: error.code,
    });
  }
  if (error instanceof SessionUnreachableError) {
    throw new OffstageSessionError(
      `The offstage session daemon did not answer on ${error.socketPath}: ${error.message}`,
      { fix: 'offstage session setup', code: 'unreachable' },
    );
  }
  throw error;
}

/* ---------------------------------- setup --------------------------------- */

export interface SessionSetupInput {
  /** Helper account. Defaults to the configured one (env → config → computeruse). */
  user?: string;
  /** Create the account when it does not exist yet, with a generated password. */
  create?: boolean;
  /**
   * Arm boot-time auto-login for the helper account. Opt-in: macOS refuses it
   * under FileVault, and it changes what appears at boot (the helper session
   * comes up first, then you switch back to your own account as usual).
   * Needs a password: a generated one when `create` is also set, `--password`
   * for an existing account, or an interactive prompt inside the root script.
   */
  autoLogin?: boolean;
  /** Password to use for the created account or the auto-login armament. */
  password?: string;
  /**
   * Where the script and the progress lines go. The root script is *printed
   * before it runs*, always: the user is about to type a password, and "trust
   * me" is not an acceptable thing for a tool to say at that moment.
   */
  io?: (line: string) => void;
}

/** One thing setup did, and whether it worked. */
export interface SessionSetupStep {
  step:
    | 'compile'
    | 'codesign'
    | 'account'
    | 'assistant'
    | 'install'
    | 'tcc'
    | 'wait'
    | 'permissions'
    | 'auto-login';
  ok: boolean;
  detail: string;
}

export interface SessionSetupResult {
  ok: boolean;
  user: string;
  uid: number | null;
  /** Exactly what was run as root, so `--json` carries it as well as the terminal. */
  script: string;
  scriptPath: string | null;
  steps: SessionSetupStep[];
  /** The status after the install, when the daemon came up. */
  status: SessionStatus | null;
  permissions: SessionPermissions | null;
  /** What the human still has to do, in order. Empty when nothing is left. */
  nextSteps: string[];
}

/** How long the daemon gets to bind its socket and answer `hello`. */
const SETUP_HELLO_TIMEOUT_MS = 15_000;
const SETUP_HELLO_POLL_MS = 500;

/**
 * Install `offstage-sessiond` into the helper account's GUI session.
 *
 * The only step that needs root is one shell script, and it is printed in full
 * before `sudo` is invoked on it. Everything before that (compiling the daemon,
 * rendering the plist) and everything after (waiting for `hello`, asking for
 * the TCC prompts) runs as you.
 *
 * Never throws for an environment problem: a machine with no Swift compiler, a
 * missing account, or a `sudo` the user cancelled all come back as
 * `ok: false` with the reason in `steps` and the repair in `nextSteps`.
 */
export async function sessionSetup(
  input: SessionSetupInput = {},
  deps?: Partial<ApiDeps>,
): Promise<SessionSetupResult> {
  const d = withDefaults(deps);
  const seams = seamsOf(d);
  const say = input.io ?? ((): void => {});
  const exec = seams.exec ?? defaultExec;
  const socketDir = seams.socketDir ?? DEFAULT_SOCKET_DIR;
  const discoverFn = seams.discover ?? describeSession;
  const steps: SessionSetupStep[] = [];

  const discoverOptions: DescribeSessionOptions = { socketDir };
  if (input.user !== undefined) discoverOptions.user = input.user;
  if (seams.exec !== undefined) discoverOptions.exec = seams.exec;
  let discovery = await discoverFn(discoverOptions);

  const bail = (nextSteps: string[]): SessionSetupResult => ({
    ok: false,
    user: discovery.user,
    uid: discovery.uid,
    script: '',
    scriptPath: null,
    steps,
    status: null,
    permissions: null,
    nextSteps,
  });

  if (discovery.platform !== 'darwin') {
    return bail([
      `The session lane is macOS-only; this host is ${discovery.platform}. Nothing was installed.`,
    ]);
  }

  /* The plist names a uid and a home, and launchd's domain is `gui/<uid>`, so
     both have to be known before the script is written, which means an account
     that does not exist yet has to be created with a uid we chose rather than
     one sysadminctl picked for us. */
  let createAccount = false;
  let uid = discovery.uid;
  let home = discovery.home;
  if (!discovery.accountExists) {
    if (input.create !== true) {
      return bail([
        `There is no "${discovery.user}" account on this Mac.`,
        `Create it: offstage session setup --create${input.user === undefined ? '' : ` --user ${input.user}`}`,
      ]);
    }
    createAccount = true;
    uid = await nextFreeUid(exec);
    home = `/Users/${discovery.user}`;
    if (uid === null) {
      return bail([
        'Could not read the existing uids from the directory service, so no free uid could be chosen for the new account.',
        'Create the account yourself in System Settings → Users & Groups, then run `offstage session setup` again.',
      ]);
    }
  }
  if (uid === null || home === null) {
    return bail([
      `The "${discovery.user}" account exists but the directory service reports no uid or home directory for it.`,
      `Check it with: dscl . -read /Users/${discovery.user} UniqueID NFSHomeDirectory`,
    ]);
  }

  /* A created account needs a real password from the start: an empty one gets
     no AuthenticationAuthority and cannot log in under FileVault. Generated
     unless the caller named one, and persisted so the human can look it up
     later: the helper account is only ever switched into on purpose. */
  let accountPassword: string | null = null;
  if (createAccount) {
    accountPassword = input.password ?? generateSessionPassword();
    say(`Password for the new "${discovery.user}" account: ${accountPassword}`);
  }

  /* Auto-login is armed with the same secret. An existing account without a
     named password falls back to sysadminctl's own interactive prompt inside
     the root script (`-password -`), which works because setup always runs
     attached to a terminal. */
  let autoLoginPassword: string | '-' | null = null;
  let fileVault: boolean | null = null;
  if (input.autoLogin === true) {
    autoLoginPassword = accountPassword ?? input.password ?? '-';
    const vault = await readFileVaultStatus(exec);
    fileVault = vault.active;
    if (fileVault === true) {
      say('Note: FileVault is on. macOS refuses auto-login while it is enabled;');
      say('the account will have to be logged in once by hand after each boot.');
    }
  }

  /* 1. Compile the daemon, as you, into a temp directory. */
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-session-setup-'));
  const binaryPath = path.join(workDir, DAEMON_BINARY_NAME);
  const sourceDir = seams.sourceDir ?? daemonSourceDir();
  say(`Compiling ${DAEMON_BINARY_NAME} from ${sourceDir}…`);
  const compile: CompileDaemonResult = await (seams.compileDaemon ?? compileDaemon)({
    sourceDir,
    outPath: binaryPath,
    ...(seams.exec === undefined ? {} : { exec: seams.exec }),
  });
  steps.push({
    step: 'compile',
    ok: compile.ok,
    detail: compile.ok
      ? `built ${binaryPath} via ${compile.via}`
      : (compile.reason ?? `${compile.command} exited ${compile.exitCode ?? 'without a code'}`),
  });
  if (!compile.ok) {
    const tail = (compile.stderr || compile.stdout).trim().split('\n').slice(-8);
    return bail([
      compile.reason ?? 'The offstage session daemon did not compile, so nothing was installed.',
      ...(compile.fix === undefined ? [] : [`Fix: ${compile.fix}`]),
      ...tail,
    ]);
  }

  /* 1b. Export the binary's Designated Requirement. This is what makes both
     TCC grants pre-seedable: the rows setup writes carry exactly the blob a
     human's toggle would have written, verified byte-for-byte against rows
     System Settings produced. */
  const csreq = await exportCsreq(binaryPath, exec);
  steps.push({
    step: 'codesign',
    ok: csreq.ok,
    detail: csreq.ok
      ? `designated requirement exported (${(csreq.hex?.length ?? 0) / 2} bytes)`
      : `could not export a code requirement: ${csreq.reason}`,
  });

  /* First-login suppression matters until the account has finished one login;
     after that its cfprefsd owns those preferences and root must leave them
     alone. */
  const suppressAssistant =
    createAccount ||
    !(discovery.guiSession.exists && discovery.guiSession.loginDone);

  /* 2. Render the LaunchAgent and the one script that needs root. */
  const plistPath = path.join(workDir, `${DEFAULT_LABEL}.plist`);
  await fs.writeFile(
    plistPath,
    renderLaunchAgentPlist({
      binaryPath: path.join(installDirFor(home), DAEMON_BINARY_NAME),
      uid,
      socketDir,
      home,
    }),
    'utf8',
  );

  const script = renderInstallScript({
    binarySource: binaryPath,
    plistSource: plistPath,
    user: discovery.user,
    uid,
    home,
    socketDir,
    ...(createAccount && accountPassword !== null
      ? { createAccount: { password: accountPassword } }
      : {}),
    ...(suppressAssistant ? { skipSetupAssistant: true } : {}),
    ...(csreq.hex !== undefined ? { tcc: { csreqHex: csreq.hex } } : {}),
    /* The user menu is what makes the one remaining manual step discoverable,
       and with auto-login armed it is how you get back to your own account. */
    enableFastUserSwitching: true,
    ...(autoLoginPassword !== null ? { autoLoginPassword } : {}),
  });
  const scriptPath = path.join(workDir, 'install.sh');
  await fs.writeFile(scriptPath, script, { mode: 0o700 });

  /* Record what the script is being asked to do, so `--json` carries the
     intent even though the work itself happens inside sudo. */
  if (createAccount) {
    steps.push({
      step: 'account',
      ok: true,
      detail: `create "${discovery.user}" (uid ${uid}) included in the root script`,
    });
  }
  if (suppressAssistant) {
    steps.push({
      step: 'assistant',
      ok: true,
      detail: 'first-login Setup Assistant suppression included in the root script',
    });
  }
  if (csreq.hex !== undefined) {
    steps.push({
      step: 'tcc',
      ok: true,
      detail:
        'pre-seed Screen Recording + Accessibility for the installed path (needs Full Disk Access on this terminal)',
    });
  } else {
    steps.push({
      step: 'tcc',
      ok: false,
      detail: `skipped: ${csreq.reason ?? 'no code requirement'}`,
    });
  }
  if (autoLoginPassword !== null) {
    steps.push({
      step: 'auto-login',
      ok: fileVault !== true,
      detail:
        fileVault === true
          ? 'requested but FileVault is on; sysadminctl will refuse and the script continues'
          : 'arm boot-time auto-login for the helper account',
    });
  }

  say('');
  say('This is the only step that needs root. It is printed here in full before it runs:');
  say('');
  for (const line of script.split('\n')) say(`    ${line}`);
  say('');
  say(`Running: sudo /bin/sh ${scriptPath}`);

  const exitCode = await (seams.runRootScript ?? defaultRunRootScript)(scriptPath);
  steps.push({
    step: 'install',
    ok: exitCode === 0,
    detail: exitCode === 0 ? 'the root script completed' : `sudo /bin/sh ${scriptPath} exited ${exitCode ?? 'without a code'}`,
  });

  /* The generated secret outlives this command only if it is written down.
     Non-fatal by design: a failed write must not undo a completed install. */
  if (accountPassword !== null && exitCode === 0) {
    try {
      await (seams.writeSessionConfig ?? persistSessionConfig)(discovery.user, accountPassword);
    } catch {
      say(`Note: could not persist the account password to ~/${SESSION_CONFIG_RELATIVE_PATH}.`);
    }
  }

  if (exitCode !== 0) {
    return {
      ...bail([
        'The install script did not complete, so the daemon was not bootstrapped.',
        `Re-run it yourself to see the failure: sudo /bin/sh ${scriptPath}`,
      ]),
      script,
      scriptPath,
      uid,
    };
  }

  /* 3. Wait for the daemon to bind and answer. launchd bootstraps
        asynchronously, so the socket is not there the instant sudo returns. */
  discovery = await discoverFn({ ...discoverOptions, user: discovery.user });
  const socketPath = discovery.socketPath;
  const clientFactory = seams.createClient ?? createSessionClient;
  const sleep = seams.sleep ?? defaultSleep;
  const now = seams.now ?? Date.now;
  const deadline = now() + SETUP_HELLO_TIMEOUT_MS;
  let hello: SessionHello | null = null;
  let lastError = '';
  say(`Waiting for the daemon on ${socketPath}…`);
  for (;;) {
    try {
      hello = await clientFactory({ socketPath }).hello();
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (now() >= deadline) break;
      await sleep(SETUP_HELLO_POLL_MS);
    }
  }
  steps.push({
    step: 'wait',
    ok: hello !== null,
    detail:
      hello === null
        ? `no answer on ${socketPath} within ${SETUP_HELLO_TIMEOUT_MS / 1000}s: ${lastError}`
        : `hello from pid ${hello.daemon.pid}, onConsole ${hello.session.onConsole}`,
  });

  if (hello === null) {
    return {
      ...bail([
        `The daemon did not answer on ${socketPath} within ${SETUP_HELLO_TIMEOUT_MS / 1000} seconds.`,
        !discovery.guiSession.exists || !discovery.guiSession.loginDone
          ? `The "${discovery.user}" account has no logged-in GUI session yet, and a LaunchAgent only starts inside one. Log ${discovery.user} in once with fast user switching (user menu → ${sessionUserFullName(discovery)}), then switch back and run \`offstage session status\`.`
          : `Check the daemon's log: ${path.join(home, 'Library', 'Logs', 'offstage-sessiond.log')}`,
      ]),
      script,
      scriptPath,
      uid,
    };
  }

  /* 4. Raise the TCC prompts. They appear inside the helper session, where the
        user sees them on their next switch, nothing pops up on this screen. */
  let permissions: SessionPermissions | null = null;
  try {
    permissions = await clientFactory({ socketPath }).requestPermissions();
    steps.push({
      step: 'permissions',
      ok: permissions.screenCapture && permissions.accessibility,
      detail: `Screen Recording ${permissions.screenCapture ? 'granted' : 'not granted'}, Accessibility ${
        permissions.accessibility ? 'granted' : 'not granted'
      }`,
    });
  } catch (error) {
    steps.push({
      step: 'permissions',
      ok: false,
      detail: `could not raise the permission prompts: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const status = statusFromProbe(await sessionLaneFor(d, discovery.user).probeSession());

  /* What is actually left for a human, given everything the script could do
     on its own. The TCC pre-seed removes the permission toggles entirely when
     it ran; auto-login turns "switch once after every boot" into "log into
     your own account like you always do". */
  const nextSteps: string[] = [];
  if (createAccount) {
    nextSteps.push(
      `The "${discovery.user}" account (uid ${uid}) was created. Its password: ${accountPassword ?? '(the one you supplied)'}. It is also stored at ~/${SESSION_CONFIG_RELATIVE_PATH}.`,
    );
  }
  if (!status.guiSession.loginDone) {
    if (input.autoLogin === true && fileVault !== true) {
      nextSteps.push(
        `Reboot once. ${sessionUserFullName(status)} will be logged in automatically; when its desktop appears, switch back to your own account from the user menu (top-right). From then on every boot brings the helper session up by itself.`,
      );
    } else {
      nextSteps.push(
        `Log ${discovery.user} in once with fast user switching (user menu → ${status.fullName}), then switch back; the session keeps running in the background.${
          input.autoLogin === true && fileVault === true
            ? ' Auto-login was requested but FileVault blocks it, so this switch is needed after each boot.'
            : ''
        }`,
      );
    }
  }
  const missing = [
    ...(permissions?.screenCapture === false ? ['Screen Recording'] : []),
    ...(permissions?.accessibility === false ? ['Accessibility'] : []),
  ];
  if (missing.length > 0) {
    nextSteps.push(
      csreq.ok
        ? `The grants were pre-seeded but the daemon reports ${missing.join(' and ')} missing. Switch to ${discovery.user}, approve them in System Settings → Privacy & Security for ${DAEMON_BINARY_NAME}, then switch back and run \`offstage session status\`.`
        : `Switch to the ${discovery.user} account once and allow ${missing.join(' and ')} for ${DAEMON_BINARY_NAME} in System Settings → Privacy & Security, then switch back.`,
    );
  } else if (permissions === null && !csreq.ok) {
    nextSteps.push(
      `Screen Recording and Accessibility still need a human switch: log into ${discovery.user}, approve both for ${DAEMON_BINARY_NAME} in System Settings → Privacy & Security, and switch back. (Pre-seeding them needs Full Disk Access on the terminal running setup.)`,
    );
  }
  nextSteps.push(
    'Give the helper account read access to a repository before running anything in it: offstage session share <dir>',
  );

  return {
    ok: true,
    user: discovery.user,
    uid,
    script,
    scriptPath,
    steps,
    status,
    permissions,
    nextSteps,
  };
}

/**
 * The lowest free uid at or above 502: 501 is the first human account on a
 * Mac, and 502 is the conventional second one.
 *
 * Returns `null` when the directory service could not be read at all, which is
 * the one case where guessing would be wrong.
 */
async function nextFreeUid(exec: Exec): Promise<number | null> {
  const outcome = await exec('/usr/bin/dscl', ['.', '-list', '/Users', 'UniqueID']);
  if (outcome.exitCode !== 0) return null;
  const taken = new Set<number>();
  for (const line of outcome.stdout.split('\n')) {
    const value = Number(line.trim().split(/\s+/).pop());
    if (Number.isInteger(value)) taken.add(value);
  }
  if (taken.size === 0) return null;
  let candidate = 502;
  while (taken.has(candidate)) candidate += 1;
  return candidate;
}

/* --------------------------------- update --------------------------------- */

export interface SessionUpdateResult {
  /** Where the new binary now lives, inside the helper account's home. */
  installedTo: string;
  previousPid: number;
  currentPid: number;
}

/**
 * Rebuild the daemon and install it, without asking for any privilege.
 *
 * Setup needs root once. Nothing after it does, and that is deliberate: an
 * admin prompt raised from a background task puts a dialog on the console that
 * captures the keyboard until it is answered. The binary lives in the helper
 * account's own home, so the daemon can replace it over its own socket.
 */
export async function sessionUpdate(
  input: { user?: string } = {},
  deps?: Partial<ApiDeps>,
): Promise<SessionUpdateResult> {
  const d = withDefaults(deps);
  const seams = seamsOf(d);
  const { client } = await sessionConnect(d, input.user);

  let home: string;
  try {
    home = (await client.hello()).user.home;
  } catch (error) {
    return asSessionError(error);
  }

  /* Staging has to be somewhere the HELPER account can read, and os.tmpdir()
     is not it: on macOS that resolves to a per-user /var/folders tree whose
     parent is mode 700, so another uid cannot traverse into it however the leaf
     is chmod'd. Verified the hard way, as `cp: Permission denied`. /tmp is the
     shared, world-traversable one. mkdtemp still gives an unpredictable name,
     and the directory is widened only to r-x. */
  const workDir = await fs.mkdtemp('/tmp/offstage-session-update-');
  await fs.chmod(workDir, 0o755);
  const binaryPath = path.join(workDir, DAEMON_BINARY_NAME);
  const sourceDir = seams.sourceDir ?? daemonSourceDir();

  const compile: CompileDaemonResult = await (seams.compileDaemon ?? compileDaemon)({
    sourceDir,
    outPath: binaryPath,
    ...(seams.exec === undefined ? {} : { exec: seams.exec }),
  });
  if (!compile.ok) {
    throw new OffstageSessionError(
      `Could not build ${DAEMON_BINARY_NAME} from ${sourceDir}: ${
        compile.reason ?? `${compile.command} exited ${compile.exitCode ?? 'without a code'}`
      }`,
      { code: 'session-build-failed' },
    );
  }
  await fs.chmod(binaryPath, 0o755);

  try {
    const result = await updateDaemon({ client, home, source: binaryPath });
    return {
      installedTo: result.installedTo,
      previousPid: result.previousPid,
      currentPid: result.currentPid,
    };
  } catch (error) {
    if (error instanceof UpdateError) {
      throw new OffstageSessionError(error.message, { code: 'session-update-failed' });
    }
    return asSessionError(error);
  }
}
