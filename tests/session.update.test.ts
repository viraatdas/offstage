import { describe, expect, it } from 'vitest';

import type { SessionClient, SessionHello, SessionRunRequest } from '../src/session/client.js';
import { UpdateError, updateDaemon } from '../src/session/update.js';

/**
 * A daemon that answers `hello` with the pid it is currently pretending to be,
 * records every command it was asked to run, and can be told to "restart" by
 * changing that pid.
 */
function stubClient(options: {
  pid: number;
  /** Exit code the install shell script should report. */
  installExit?: number;
  /** Output the install script emits. */
  installOutput?: string;
  /** Pid after the restart. `null` means it never comes back. */
  pidAfterRestart?: number | null;
  /** What `ps` should say the running daemon's executable is. */
  runningBinary?: string;
}): { client: SessionClient; commands: string[][]; restarts: number } {
  const commands: string[][] = [];
  const state = { pid: options.pid, restarts: 0 };

  const hello = (): SessionHello => ({
    ok: true,
    daemon: { version: '1', pid: state.pid, protocol: 1 },
    user: { uid: 502, name: 'computeruse', home: '/Users/computeruse' },
    session: { onConsole: false, managerName: 'Aqua' },
    display: { width: 1728, height: 1117, scale: 2 },
    permissions: { screenCapture: true, accessibility: true },
  });

  const client = {
    socketPath: '/tmp/offstage-session/502.sock',
    async hello() {
      return hello();
    },
    async access() {
      throw new Error('not used');
    },
    async run(request: SessionRunRequest) {
      commands.push(request.argv);
      /* The pre-flight `ps -o comm=` check, answered with whatever path this
         stub is pretending launchd started. */
      if (request.argv[0] === '/bin/ps') {
        const running =
          options.runningBinary ?? '/Users/computeruse/.offstage/bin/offstage-sessiond';
        request.onOutput?.(Buffer.from(`${running}\n`, 'utf8'));
        return { exitCode: 0, signal: null, timedOut: false, durationMs: 1, pid: 1 };
      }
      const output = options.installOutput ?? '';
      if (output) request.onOutput?.(Buffer.from(output, 'utf8'));
      return {
        exitCode: options.installExit ?? 0,
        signal: null,
        timedOut: false,
        durationMs: 1,
        pid: 4242,
      };
    },
    async screenshot() {
      throw new Error('not used');
    },
    async input() {
      throw new Error('not used');
    },
    async apps() {
      throw new Error('not used');
    },
    async requestPermissions() {
      throw new Error('not used');
    },
    async restart() {
      state.restarts += 1;
      const next = options.pidAfterRestart === undefined ? state.pid + 1 : options.pidAfterRestart;
      if (next !== null) state.pid = next;
      return { restarting: true };
    },
  } as unknown as SessionClient;

  return {
    client,
    commands,
    get restarts() {
      return state.restarts;
    },
  };
}

const noSleep = async (): Promise<void> => {};

describe('updateDaemon', () => {
  it('installs the new binary and reports the pid it came back as', async () => {
    const stub = stubClient({ pid: 100, pidAfterRestart: 200 });

    const result = await updateDaemon({
      client: stub.client,
      home: '/Users/computeruse',
      source: '/tmp/offstage-sessiond-new',
      sleep: noSleep,
    });

    expect(result.previousPid).toBe(100);
    expect(result.currentPid).toBe(200);
    expect(result.cameBack).toBe(true);
    expect(result.installedTo).toBe('/Users/computeruse/.offstage/bin/offstage-sessiond');
  });

  it('replaces the binary by rename, never by writing over it in place', async () => {
    /* A running executable cannot be written in place: the kernel returns
       ETXTBSY. Copying to a temporary name and renaming over the target is the
       only way that both works and is atomic, so the shape of this script is
       load bearing rather than incidental. */
    const stub = stubClient({ pid: 1 });

    await updateDaemon({
      client: stub.client,
      home: '/Users/computeruse',
      source: '/tmp/new-daemon',
      sleep: noSleep,
    });

    const script = stub.commands.find((argv) => argv[0] === '/bin/sh')?.[2] ?? '';
    expect(script).toContain("cp '/tmp/new-daemon' '/Users/computeruse/.offstage/bin/.offstage-sessiond.incoming'");
    expect(script).toContain(
      "mv -f '/Users/computeruse/.offstage/bin/.offstage-sessiond.incoming' '/Users/computeruse/.offstage/bin/offstage-sessiond'",
    );
    /* Never a direct copy onto the live target. */
    expect(script).not.toContain("cp '/tmp/new-daemon' '/Users/computeruse/.offstage/bin/offstage-sessiond'");
  });

  it('needs no privilege: every command goes through the daemon, none through sudo', async () => {
    const stub = stubClient({ pid: 1 });

    await updateDaemon({
      client: stub.client,
      home: '/Users/computeruse',
      source: '/tmp/new-daemon',
      sleep: noSleep,
    });

    for (const argv of stub.commands) {
      expect(argv[0]).not.toBe('sudo');
      expect(argv.join(' ')).not.toContain('osascript');
      expect(argv.join(' ')).not.toContain('administrator privileges');
    }
  });

  it('reports what the shell said when the install fails, and does not restart', async () => {
    const stub = stubClient({
      pid: 1,
      installExit: 1,
      installOutput: 'cp: /tmp/new-daemon: Permission denied',
    });

    await expect(
      updateDaemon({
        client: stub.client,
        home: '/Users/computeruse',
        source: '/tmp/new-daemon',
        sleep: noSleep,
      }),
    ).rejects.toThrow(/Permission denied/);

    /* A failed install must leave the running daemon alone. */
    expect(stub.restarts).toBe(0);
  });

  it('fails loudly when the daemon does not come back', async () => {
    const stub = stubClient({ pid: 7, pidAfterRestart: null });

    await expect(
      updateDaemon({
        client: stub.client,
        home: '/Users/computeruse',
        source: '/tmp/new-daemon',
        timeoutMs: 5,
        sleep: noSleep,
      }),
    ).rejects.toThrow(UpdateError);
  });
  it('refuses when launchd would bring the old binary back instead', async () => {
    /* A machine set up before the binary moved still has a LaunchAgent pointing
       at /usr/local/libexec. Installing to the new path and restarting would
       look like it worked while changing nothing at all. */
    const stub = stubClient({
      pid: 3,
      runningBinary: '/usr/local/libexec/offstage/offstage-sessiond',
    });

    await expect(
      updateDaemon({
        client: stub.client,
        home: '/Users/computeruse',
        source: '/tmp/new-daemon',
        sleep: noSleep,
      }),
    ).rejects.toThrow(/offstage session setup/);

    expect(stub.restarts).toBe(0);
    expect(stub.commands.some((argv) => argv[0] === '/bin/sh')).toBe(false);
  });
});
