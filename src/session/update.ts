/**
 * Replacing the daemon binary without root.
 *
 * The daemon used to live in `/usr/local/libexec/offstage`, owned by root, so
 * every update meant `sudo`. That is not a small inconvenience: an admin prompt
 * raised from a background task puts a dialog on the console that captures the
 * keyboard until someone answers it, and an unanswered one has already cost
 * this project a forced reboot. So updates must need no privilege at all.
 *
 * The binary now lives inside the helper account's home, and the account that
 * runs it is the account that owns it. That makes the update a plain file copy
 * performed *by the daemon itself*, over its own socket, followed by a restart
 * that launchd services. Root is needed once, at first setup, and never again.
 *
 * Two details that are easy to get wrong:
 *
 * - A running executable cannot be written in place; the kernel returns ETXTBSY.
 *   It CAN be replaced by `rename(2)`, which swaps the directory entry and
 *   leaves the running process on the old inode. So this copies to a temporary
 *   name in the same directory and `mv -f`s over the target. Same filesystem, so
 *   the rename is atomic: there is no instant at which the path is missing or
 *   half-written.
 * - The restart is not synchronous. The daemon answers, then exits, and launchd
 *   starts the replacement, so the socket is briefly absent. Callers have to
 *   wait for it to come back rather than assume the next connect succeeds.
 */

import path from 'node:path';

import type { SessionClient } from './client.js';

/** How the update ended, in enough detail to print something honest. */
export interface UpdateResult {
  /** Absolute path the binary was installed to. */
  installedTo: string;
  /** Daemon pid before the restart. */
  previousPid: number;
  /** Daemon pid after it came back. Different from `previousPid` on success. */
  currentPid: number;
  /** Whether the daemon answered again within the deadline. */
  cameBack: boolean;
}

export class UpdateError extends Error {}

export interface UpdateOptions {
  /** A client for the daemon that is currently running. */
  client: SessionClient;
  /** Home directory of the helper account. */
  home: string;
  /**
   * Path to the newly built binary, readable by the helper account. The helper
   * is a different uid, so a build sitting in a mode-700 directory is invisible
   * to it; the caller is responsible for staging it somewhere readable.
   */
  source: string;
  /** File name to install as. */
  binaryName?: string;
  /** How long to wait for the daemon to come back. */
  timeoutMs?: number;
  /** Injected so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BINARY_NAME = 'offstage-sessiond';

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Single-quote for `/bin/sh`, including embedded quotes. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Absolute path of the executable behind `pid`, or `null` if it cannot be read.
 *
 * `hello` does not report it, and asking the OS is cheap: `ps -o comm=` prints
 * the full path on macOS. Returning `null` rather than throwing keeps this a
 * safety check that can decline to have an opinion, instead of a new way for
 * the update to fail.
 */
async function runningBinaryPath(client: SessionClient, pid: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  try {
    const probe = await client.run({
      argv: ['/bin/ps', '-p', String(pid), '-o', 'comm='],
      cwd: '/',
      onOutput: (chunk) => {
        chunks.push(chunk);
      },
    });
    if (probe.exitCode !== 0) return null;
  } catch {
    return null;
  }
  const line = Buffer.concat(chunks).toString('utf8').trim();
  return line === '' ? null : line;
}

/**
 * Install `source` as the helper account's daemon binary and restart it.
 *
 * Every step runs as the helper account, through the daemon's own `run` op, so
 * this asks for no privilege the caller does not already have.
 */
export async function updateDaemon(options: UpdateOptions): Promise<UpdateResult> {
  const binaryName = options.binaryName ?? DEFAULT_BINARY_NAME;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const sleep = options.sleep ?? defaultSleep;

  const before = await options.client.hello();
  const previousPid = before.daemon.pid;

  const installDir = path.join(options.home, '.offstage', 'bin');
  const target = path.join(installDir, binaryName);
  const staging = path.join(installDir, `.${binaryName}.incoming`);

  /* Refuse when the LaunchAgent still points somewhere else.
     Installing to `target` and restarting would otherwise look like a success
     while launchd brought the OLD binary back up: the update would silently do
     nothing, which is worse than failing. This happens on any machine set up
     before the binary moved out of /usr/local/libexec. */
  const running = await runningBinaryPath(options.client, previousPid);
  if (running !== null && running !== target) {
    throw new UpdateError(
      `the daemon currently running is ${running}, not ${target}, so replacing ` +
        'that file would have no effect: launchd would start the old one again. ' +
        'Run `offstage session setup` once to move the binary and rewrite the ' +
        'LaunchAgent. That is the last step that needs a password.',
    );
  }

  /* One shell command, so a failure at any step aborts the rest and nothing is
     left half-installed. `mv -f` last: until it runs, the live binary is
     untouched, so a failed copy cannot take the lane down. */
  const script = [
    'set -e',
    `mkdir -p ${quote(installDir)}`,
    `cp ${quote(options.source)} ${quote(staging)}`,
    `chmod 755 ${quote(staging)}`,
    `mv -f ${quote(staging)} ${quote(target)}`,
  ].join('\n');

  /* The run op streams output rather than returning it, and a failure here is
     the one case where the caller needs to see exactly what the shell said. */
  const chunks: Buffer[] = [];
  const install = await options.client.run({
    argv: ['/bin/sh', '-c', script],
    cwd: '/',
    onOutput: (chunk) => {
      chunks.push(chunk);
    },
  });

  if (install.exitCode !== 0) {
    const output = Buffer.concat(chunks).toString('utf8').trim();
    throw new UpdateError(
      `installing the new daemon failed (exit ${String(install.exitCode)}): ${
        output || 'no output'
      }`,
    );
  }

  await options.client.restart();

  /* The socket goes away and comes back. Poll rather than guess a delay: how
     long launchd takes to relaunch is not ours to predict. */
  const deadline = Date.now() + timeoutMs;
  let currentPid = previousPid;
  let cameBack = false;
  while (Date.now() < deadline) {
    await sleep(250);
    try {
      const after = await options.client.hello();
      if (after.daemon.pid !== previousPid) {
        currentPid = after.daemon.pid;
        cameBack = true;
        break;
      }
    } catch {
      /* Expected while it is down. Keep waiting for the deadline. */
    }
  }

  if (!cameBack) {
    throw new UpdateError(
      'the new daemon was installed but did not come back within the deadline. ' +
        'The lane is down until it does. Check the helper account is still logged in ' +
        '(`offstage session status`); launchd only relaunches inside a live GUI session.',
    );
  }

  return { installedTo: target, previousPid, currentPid, cameBack };
}
