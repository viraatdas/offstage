/**
 * Shared setup for the two `offstage session …` suites.
 *
 * Nothing here touches a real daemon, a real account, or `sudo`. Every seam is
 * injected: discovery answers from a literal, the client is a fake, the root
 * script is captured rather than run. That is deliberate and not only for
 * speed: the one thing these tests must never do is inject input into a live
 * macOS session, which on a developer's machine is *their* session.
 *
 * `*.fixtures.ts` is never collected as a suite. See `test-helpers.test.ts`.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Lane, LaneRequest, LaneRunner } from '../src/contract/index.js';
import { createLaneResult } from '../src/contract/index.js';
import type { ApiDeps } from '../src/cli/api.js';
import type { SessionSeams } from '../src/cli/session.js';
import type { CliIo } from '../src/cli/index.js';
import { main } from '../src/cli/index.js';
import type {
  SessionClient,
  SessionDiscovery,
  SessionHello,
} from '../src/session/index.js';

const temps: string[] = [];

/** Remove every directory {@link tempDir} handed out. Call from `afterEach`. */
export async function cleanupTemps(): Promise<void> {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
}

export async function tempDir(prefix = 'offstage-session-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return await fs.realpath(dir);
}

/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

/** A helper account that is logged in, in the background, with the daemon up. */
export function discovery(overrides: Partial<SessionDiscovery> = {}): SessionDiscovery {
  return {
    user: 'computeruse',
    uid: 502,
    home: '/Users/computeruse',
    fullName: 'Computer Use',
    accountExists: true,
    guiSession: { exists: true, loginDone: true, onConsole: false, sessionId: 258 },
    socketPath: '/tmp/offstage-session/502.sock',
    socketPresent: true,
    platform: 'darwin',
    ...overrides,
  };
}

export function hello(overrides: Partial<SessionHello> = {}): SessionHello {
  return {
    ok: true,
    daemon: { version: '1', pid: 4242, protocol: 1 },
    user: { uid: 502, name: 'computeruse', home: '/Users/computeruse' },
    session: { onConsole: false, managerName: 'Aqua' },
    display: { width: 1728, height: 1117, scale: 2 },
    permissions: { screenCapture: true, accessibility: true },
    ...overrides,
  };
}

export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface FakeClient extends SessionClient {
  calls: Array<{ op: string; payload?: unknown }>;
}

export function fakeClient(options: {
  hello?: SessionHello;
  onScreenshot?: () => never;
  onInput?: () => never;
  apps?: Awaited<ReturnType<SessionClient['apps']>>;
  permissions?: { screenCapture: boolean; accessibility: boolean };
} = {}): FakeClient {
  const calls: FakeClient['calls'] = [];
  return {
    calls,
    socketPath: '/tmp/offstage-session/502.sock',
    async hello() {
      calls.push({ op: 'hello' });
      return options.hello ?? hello();
    },
    async access(target) {
      calls.push({ op: 'access', payload: target });
      return { ok: true, exists: true, readable: true, writable: false, directory: true };
    },
    async run(request) {
      calls.push({ op: 'run', payload: request.argv });
      return { exitCode: 0, signal: null, timedOut: false, durationMs: 1, pid: 1 };
    },
    async screenshot(screenshotOptions) {
      calls.push({ op: 'screenshot', payload: screenshotOptions });
      options.onScreenshot?.();
      return { png: PNG, width: 1728, height: 1117, scale: 2 };
    },
    async input(actions) {
      calls.push({ op: 'input', payload: actions });
      options.onInput?.();
      return { performed: actions.length };
    },
    async apps() {
      calls.push({ op: 'apps' });
      return (
        options.apps ?? [
          { pid: 5120, name: 'Safari', bundleId: 'com.apple.Safari', active: true, hidden: false },
        ]
      );
    },
    async requestPermissions() {
      calls.push({ op: 'request-permissions' });
      return options.permissions ?? { screenCapture: true, accessibility: true };
    },
    async restart() {
      calls.push({ op: 'restart' });
      return { restarting: true };
    },
  };
}

/** Build the seams for one scenario, plus a handle on the client the lane got. */
export function seams(overrides: Partial<SessionSeams> & { discovery?: SessionDiscovery; client?: FakeClient } = {}): {
  session: SessionSeams;
  client: FakeClient;
} {
  const client = overrides.client ?? fakeClient();
  const found = overrides.discovery ?? discovery();
  const session: SessionSeams = {
    discover: async () => found,
    createClient: () => client,
    ...overrides,
  };
  delete (session as { discovery?: unknown }).discovery;
  delete (session as { client?: unknown }).client;
  return { session, client };
}

export function fakeLane(lane: Lane): LaneRunner & { calls: LaneRequest[] } {
  const calls: LaneRequest[] = [];
  return {
    lane,
    calls,
    async isAvailable() {
      return { available: true };
    },
    async run(req: LaneRequest) {
      calls.push(req);
      return createLaneResult({ lane, status: 'passed', exitCode: 0, artifactsDir: req.artifactsDir });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* status                                                                     */
/* -------------------------------------------------------------------------- */

export interface Captured {
  code: number;
  out: string;
  err: string;
}

export async function cli(
  argv: string[],
  options: { cwd?: string; deps?: Partial<ApiDeps>; isTty?: boolean } = {},
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    cwd: () => options.cwd ?? process.cwd(),
    env: {},
    isTty: () => options.isTty ?? false,
    ...(options.deps === undefined ? {} : { deps: options.deps }),
  };
  const code = await main(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}
