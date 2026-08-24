/**
 * Shared setup for the container-lane suites.
 *
 * Everything that would otherwise need a daemon is driven through the lane's
 * two injection points, `detect` and `exec`, so the full happy path, the build
 * path, the timeout path and the failure-parsing path are all covered without
 * one. The fakes that make that possible live here, and both suites import
 * them.
 *
 * `*.fixtures.ts` is never collected as a suite. See `test-helpers.test.ts`.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { LaneRequest } from '../src/contract/index.js';

import type {
  ContainerRuntime,
  ContainerRuntimeProbe,
  LaneExec,
  LaneExecOptions,
  LaneExecResult,
  ProbeExec,
  ProbeOutcome,
} from '../src/lanes/container/index.js';

export const execFileAsync = promisify(execFile);

/* -------------------------------------------------------------------------- */
/* Fixtures and fakes                                                         */
/* -------------------------------------------------------------------------- */

export const REPO_ROOT = path.resolve(import.meta.dirname, '..');
export const DOCKER_DIR = path.join(REPO_ROOT, 'docker');

let tmpRoot: string;

/** Call from `beforeAll`. Everything {@link makeArtifactsDir} hands out lives under it. */
export async function createTmpRoot(): Promise<void> {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-container-'));
}

/** Call from `afterAll`. */
export async function removeTmpRoot(): Promise<void> {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}

/** The root every temp directory in these suites lives under. */
export function tmpRootPath(): string {
  return tmpRoot;
}

/** A fresh, real directory to use as `artifactsDir`. */
export async function makeArtifactsDir(label: string): Promise<string> {
  const dir = path.join(tmpRoot, `${label}-${Math.random().toString(16).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export interface RecordedCall {
  file: string;
  args: string[];
  options: LaneExecOptions;
}

export interface FakeExec {
  exec: LaneExec;
  calls: RecordedCall[];
  /** The `docker run ...` invocation, which is what most assertions are about. */
  runCall(): RecordedCall | undefined;
}

/**
 * A `LaneExec` that records everything and answers from a handler. Anything the
 * handler does not answer is a successful no-op, so a test only spells out the
 * commands it actually cares about.
 */
export function fakeExec(
  handler: (call: RecordedCall) => Partial<LaneExecResult> | Promise<Partial<LaneExecResult>>,
): FakeExec {
  const calls: RecordedCall[] = [];
  const exec: LaneExec = async (file, args, options) => {
    const call = { file, args, options };
    calls.push(call);
    const answer = await handler(call);
    return { exitCode: 0, output: '', timedOut: false, spawnError: null, ...answer };
  };
  return {
    exec,
    calls,
    runCall: () => calls.find((call) => call.args[0] === 'run'),
  };
}

export const dockerRuntime: ContainerRuntime = {
  kind: 'docker',
  bin: 'docker',
  env: {},
  serverVersion: '27.1.1',
  description: 'Docker daemon 27.1.1 (context "test")',
};

export const availableProbe: ContainerRuntimeProbe = {
  runtime: dockerRuntime,
  availability: { available: true },
  steps: [{ kind: 'docker', installed: true, usable: true, detail: 'docker info answered' }],
};

export const unavailableProbe: ContainerRuntimeProbe = {
  runtime: null,
  availability: {
    available: false,
    reason:
      'No usable container runtime, so headed browser work has nowhere safe to run. colima is installed but no profile is running ("default" is Stopped).',
    fix: 'colima start',
  },
  steps: [
    {
      kind: 'docker',
      installed: true,
      usable: false,
      detail: 'the docker CLI is installed but its daemon is unreachable',
    },
    {
      kind: 'colima',
      installed: true,
      usable: false,
      detail: 'colima is installed but no profile is running ("default" is Stopped)',
    },
    { kind: 'podman', installed: false, usable: false, detail: 'podman is not installed' },
  ],
};

/** Build a `ProbeExec` from a table of `"bin arg arg"` prefixes. */
export function probeTable(
  table: Record<string, Partial<ProbeOutcome>>,
  record?: Array<{ file: string; args: string[]; env?: Record<string, string> }>,
): ProbeExec {
  return async (file, args, options) => {
    record?.push({ file, args, env: options.env });
    const key = [file, ...args].join(' ');
    const matched = Object.entries(table)
      .filter(([prefix]) => key.startsWith(prefix))
      // Longest prefix wins, so a specific override beats a general default.
      .sort((a, b) => b[0].length - a[0].length)[0];
    return {
      found: true,
      exitCode: 1,
      stdout: '',
      stderr: '',
      timedOut: false,
      ...(matched?.[1] ?? { found: false, exitCode: null }),
    };
  };
}

/**
 * Desktop-runtime detection reads the filesystem. Tests pin it so a result never
 * depends on whether the machine running them happens to have OrbStack.
 */
export const noDesktopApps = async (): Promise<boolean> => false;
export const orbstackInstalled = async (target: string): Promise<boolean> =>
  target === '/Applications/OrbStack.app';

export const request = (overrides: Partial<LaneRequest> & Pick<LaneRequest, 'artifactsDir'>): LaneRequest => ({
  cwd: REPO_ROOT,
  command: ['node', '-e', 'console.log(1)'],
  ...overrides,
});

/* -------------------------------------------------------------------------- */
/* Runtime detection                                                          */
/* -------------------------------------------------------------------------- */
