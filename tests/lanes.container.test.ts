/**
 * Container lane tests.
 *
 * The hard requirement: **this file passes on a machine with no container
 * runtime at all.** That is not a convenience, it is the thing most worth
 * testing — the lane's job on such a machine is to refuse to run, say exactly
 * why, and hand back a contract-valid result rather than an exception. The
 * machine this lane was written on is precisely that machine (docker CLI
 * present but pointed at a dead OrbStack socket, Colima installed but stopped,
 * no podman), so the degraded path is asserted here in that exact shape.
 *
 * Everything that would otherwise need a daemon is driven through the lane's
 * two injection points — `detect` and `exec` — so the full happy path, the
 * build path, the timeout path and the failure-parsing path are all covered
 * without one.
 *
 * The single block that does need a real runtime is gated on a live probe and
 * skips cleanly when there is none.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isLaneResult, parseLaneResult } from '../src/contract/index.js';
import type { LaneRequest } from '../src/contract/index.js';
import {
  BUILD_LOG,
  COMMAND_LOG,
  GUEST_ARTIFACTS,
  GUEST_BROWSERS,
  GUEST_WORKSPACE,
  SCREENSHOT,
  buildRunPlan,
  containerLane,
  containerNameFor,
  createContainerLane,
  dockerDirCandidates,
  imageTagFor,
  loadDockerAssets,
  logTail,
  parseFailures,
  unmapGuestPath,
} from '../src/lanes/container/index.js';
import type {
  ContainerRuntime,
  ContainerRuntimeProbe,
  LaneExec,
  LaneExecOptions,
  LaneExecResult,
  ProbeExec,
  ProbeOutcome,
} from '../src/lanes/container/index.js';
import {
  colimaSocketCandidates,
  describeRuntimeProbe,
  detectContainerRuntime,
  parseColimaList,
} from '../src/lanes/container/runtime.js';

const execFileAsync = promisify(execFile);

/* -------------------------------------------------------------------------- */
/* Fixtures and fakes                                                         */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const DOCKER_DIR = path.join(REPO_ROOT, 'docker');

let tmpRoot: string;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-container-'));
});

afterAll(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** A fresh, real directory to use as `artifactsDir`. */
async function makeArtifactsDir(label: string): Promise<string> {
  const dir = path.join(tmpRoot, `${label}-${Math.random().toString(16).slice(2, 8)}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

interface RecordedCall {
  file: string;
  args: string[];
  options: LaneExecOptions;
}

interface FakeExec {
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
function fakeExec(
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

const dockerRuntime: ContainerRuntime = {
  kind: 'docker',
  bin: 'docker',
  env: {},
  serverVersion: '27.1.1',
  description: 'Docker daemon 27.1.1 (context "test")',
};

const availableProbe: ContainerRuntimeProbe = {
  runtime: dockerRuntime,
  availability: { available: true },
  steps: [{ kind: 'docker', installed: true, usable: true, detail: 'docker info answered' }],
};

const unavailableProbe: ContainerRuntimeProbe = {
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
function probeTable(
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
const noDesktopApps = async (): Promise<boolean> => false;
const orbstackInstalled = async (target: string): Promise<boolean> =>
  target === '/Applications/OrbStack.app';

const request = (overrides: Partial<LaneRequest> & Pick<LaneRequest, 'artifactsDir'>): LaneRequest => ({
  cwd: REPO_ROOT,
  command: ['node', '-e', 'console.log(1)'],
  ...overrides,
});

/* -------------------------------------------------------------------------- */
/* Runtime detection                                                          */
/* -------------------------------------------------------------------------- */

describe('detectContainerRuntime', () => {
  it('reports a reachable docker daemon and uses it directly', async () => {
    const probe = await detectContainerRuntime({
      exec: probeTable({
        'docker info': { found: true, exitCode: 0, stdout: '27.1.1' },
        'docker context show': { found: true, exitCode: 0, stdout: 'orbstack' },
      }),
    });

    expect(probe.availability).toEqual({ available: true });
    expect(probe.runtime).toMatchObject({ kind: 'docker', bin: 'docker', serverVersion: '27.1.1' });
    expect(probe.runtime?.env).toEqual({});
    expect(probe.runtime?.description).toContain('context "orbstack"');
  });

  it('falls back to `colima start` when the dead context belongs to no installed app', async () => {
    const probe = await detectContainerRuntime({
      platform: 'darwin',
      fileExists: noDesktopApps,
      exec: probeTable({
        'docker info': {
          found: true,
          exitCode: 1,
          stderr:
            'failed to connect to the docker API at unix:///Users/x/.orbstack/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /Users/x/.orbstack/run/docker.sock: connect: no such file or directory',
        },
        'docker context show': { found: true, exitCode: 0, stdout: 'orbstack' },
        'colima list --json': {
          found: true,
          exitCode: 0,
          stdout: '{"name":"default","status":"Stopped","arch":"aarch64","runtime":"docker"}',
        },
        'podman info': { found: false, exitCode: null },
      }),
    });

    expect(probe.runtime).toBeNull();
    expect(probe.availability.available).toBe(false);
    expect(probe.availability.fix).toBe('colima start');
    expect(probe.availability.reason).toContain('.orbstack/run/docker.sock');
    expect(probe.availability.reason).toContain('"default" is Stopped');
    expect(probe.steps.map((step) => [step.kind, step.installed, step.usable])).toEqual([
      ['docker', true, false],
      ['colima', true, false],
      ['podman', false, false],
    ]);
  });

  it('finds a running colima even when the active docker context points elsewhere', async () => {
    const seen: Array<{ file: string; args: string[]; env?: Record<string, string> }> = [];
    const socket = path.join('/home/tester', '.colima', 'default', 'docker.sock');
    const probe = await detectContainerRuntime({
      homedir: '/home/tester',
      env: {},
      fileExists: noDesktopApps,
      exec: async (file, args, options) => {
        seen.push({ file, args, env: options.env });
        const key = [file, ...args].join(' ');
        // The active context is dead; only the explicit colima socket answers.
        if (key.startsWith('docker info')) {
          const viaColima = options.env?.DOCKER_HOST === `unix://${socket}`;
          return {
            found: true,
            exitCode: viaColima ? 0 : 1,
            stdout: viaColima ? '24.0.7' : '',
            stderr: viaColima ? '' : 'cannot connect to orbstack',
            timedOut: false,
          };
        }
        if (key.startsWith('docker context show')) {
          return { found: true, exitCode: 0, stdout: 'orbstack', stderr: '', timedOut: false };
        }
        if (key.startsWith('colima list')) {
          return {
            found: true,
            exitCode: 0,
            stdout: '{"name":"default","status":"Running","runtime":"docker"}',
            stderr: '',
            timedOut: false,
          };
        }
        return { found: false, exitCode: null, stdout: '', stderr: '', timedOut: false };
      },
    });

    // The colima probe must re-run `docker info` with an explicit DOCKER_HOST,
    // otherwise a hijacked context would hide a perfectly good runtime.
    const colimaProbe = seen.find((call) => call.env?.DOCKER_HOST);
    expect(colimaProbe?.env?.DOCKER_HOST).toBe(`unix://${socket}`);
    expect(probe.runtime).toMatchObject({
      kind: 'colima',
      bin: 'docker',
      env: { DOCKER_HOST: `unix://${socket}` },
    });
    expect(probe.runtime?.description).toContain('profile "default"');
    expect(probe.availability.available).toBe(true);
  });

  it('falls back to colima 0.3-era socket layout when the per-profile socket is dead', async () => {
    const perProfile = `unix://${path.join('/home/tester', '.colima', 'default', 'docker.sock')}`;
    const legacy = `unix://${path.join('/home/tester', '.colima', 'docker.sock')}`;
    const probe = await detectContainerRuntime({
      homedir: '/home/tester',
      env: {},
      exec: async (file, args, options) => {
        const key = [file, ...args].join(' ');
        if (key.startsWith('colima list')) {
          return {
            found: true,
            exitCode: 0,
            stdout: '{"name":"default","status":"Running"}',
            stderr: '',
            timedOut: false,
          };
        }
        if (key.startsWith('docker info')) {
          const ok = options.env?.DOCKER_HOST === legacy;
          return {
            found: true,
            exitCode: ok ? 0 : 1,
            stdout: ok ? '24.0.7' : '',
            stderr: ok ? '' : 'no such file',
            timedOut: false,
          };
        }
        return { found: false, exitCode: null, stdout: '', stderr: '', timedOut: false };
      },
    });

    expect(probe.runtime?.kind).toBe('colima');
    expect(probe.runtime?.env.DOCKER_HOST).toBe(legacy);
    expect(probe.runtime?.env.DOCKER_HOST).not.toBe(perProfile);
  });

  it('names the profile in the fix when the stopped profile is not `default`', async () => {
    const probe = await detectContainerRuntime({
      platform: 'darwin',
      fileExists: noDesktopApps,
      exec: probeTable({
        'docker info': { found: false, exitCode: null },
        'colima list --json': {
          found: true,
          exitCode: 0,
          stdout: '{"name":"web","status":"Stopped"}',
        },
        'podman info': { found: false, exitCode: null },
      }),
    });

    expect(probe.availability.fix).toBe('colima start --profile web');
  });

  it('degrades to `colima status` when the installed colima has no `list --json`', async () => {
    const probe = await detectContainerRuntime({
      homedir: '/home/tester',
      env: {},
      fileExists: noDesktopApps,
      exec: probeTable({
        'docker info': { found: true, exitCode: 1, stderr: 'daemon down' },
        'docker context show': { found: true, exitCode: 1 },
        // Old colima prints a usage error to stderr and exits non-zero.
        'colima list --json': { found: true, exitCode: 1, stderr: 'unknown flag: --json' },
        'colima status': { found: true, exitCode: 1, stderr: 'colima is not running' },
        'podman info': { found: false, exitCode: null },
      }),
    });

    expect(probe.runtime).toBeNull();
    expect(probe.availability.fix).toBe('colima start');
    expect(probe.steps.find((step) => step.kind === 'colima')?.detail).toContain('Stopped');
  });

  it('uses podman when it is the only thing answering', async () => {
    const probe = await detectContainerRuntime({
      exec: probeTable({
        'docker info': { found: false, exitCode: null },
        'colima list': { found: false, exitCode: null },
        'podman info': { found: true, exitCode: 0, stdout: '5.2.0' },
      }),
    });

    expect(probe.runtime).toMatchObject({ kind: 'podman', bin: 'podman', serverVersion: '5.2.0' });
  });

  it('suggests `podman machine start` when podman is installed but its machine is down', async () => {
    const probe = await detectContainerRuntime({
      platform: 'darwin',
      exec: probeTable({
        'docker info': { found: false, exitCode: null },
        'colima list': { found: false, exitCode: null },
        'podman info': { found: true, exitCode: 125, stderr: 'Cannot connect to Podman' },
      }),
    });

    expect(probe.availability.fix).toBe('podman machine start');
    expect(probe.availability.reason).toContain('podman is installed but not usable');
  });

  it('suggests `orb start` for a dead OrbStack, in preference to a stopped colima', async () => {
    const probe = await detectContainerRuntime({
      platform: 'darwin',
      fileExists: orbstackInstalled,
      exec: probeTable({
        'docker info': {
          found: true,
          exitCode: 1,
          stderr: 'dial unix /Users/x/.orbstack/run/docker.sock: connect: no such file',
        },
        'docker context show': { found: true, exitCode: 0, stdout: 'orbstack' },
        // Colima is installed and stopped too — the heavier option must lose.
        'colima list --json': {
          found: true,
          exitCode: 0,
          stdout: '{"name":"default","status":"Stopped"}',
        },
        'podman info': { found: false, exitCode: null },
      }),
    });

    expect(probe.availability.fix).toBe('orb start');
    expect(probe.availability.reason).toContain('OrbStack is installed but not running');
    expect(probe.steps.find((step) => step.kind === 'docker')?.fix).toBe('orb start');
    // The colima step still records what it saw; it is just outranked.
    expect(probe.steps.find((step) => step.kind === 'colima')?.detail).toContain('Stopped');
  });

  it('suggests an install when the machine has nothing at all', async () => {
    const nothing = probeTable({});

    await expect(
      detectContainerRuntime({ platform: 'darwin', exec: nothing, fileExists: noDesktopApps }),
    ).resolves.toMatchObject({
      runtime: null,
      availability: { available: false, fix: 'brew install colima docker && colima start' },
    });

    await expect(
      detectContainerRuntime({ platform: 'linux', exec: nothing, fileExists: noDesktopApps }),
    ).resolves.toMatchObject({
      availability: { fix: 'sudo apt-get install -y docker.io && sudo systemctl start docker' },
    });
  });

  it('reports a hung daemon as a timeout rather than hanging or throwing', async () => {
    const probe = await detectContainerRuntime({
      platform: 'linux',
      timeoutMs: 1_234,
      fileExists: noDesktopApps,
      exec: probeTable({
        'docker info': { found: true, exitCode: null, timedOut: true },
        'docker context show': { found: true, exitCode: 0, stdout: 'default' },
        'colima list': { found: false, exitCode: null },
        'podman info': { found: false, exitCode: null },
      }),
    });

    expect(probe.steps[0]?.detail).toContain('timed out after 1234ms');
    expect(probe.availability.fix).toBe('sudo systemctl start docker');
  });

  it('never throws, even when the probe implementation itself throws', async () => {
    const probe = await detectContainerRuntime({
      platform: 'darwin',
      exec: async () => {
        throw new Error('probe exploded');
      },
    });

    expect(probe.runtime).toBeNull();
    expect(probe.availability.available).toBe(false);
    expect(probe.steps.every((step) => !step.usable)).toBe(true);
  });

  it('probes the real host without throwing and without starting anything', async () => {
    const probe = await detectContainerRuntime();

    expect(Array.isArray(probe.steps)).toBe(true);
    if (probe.runtime) {
      expect(probe.availability.available).toBe(true);
      expect(probe.runtime.bin === 'docker' || probe.runtime.bin === 'podman').toBe(true);
    } else {
      // The degraded contract: a reason a human can act on, and a command.
      expect(probe.availability.available).toBe(false);
      expect(probe.availability.reason?.length ?? 0).toBeGreaterThan(20);
      expect(probe.availability.fix?.length ?? 0).toBeGreaterThan(0);
    }
    expect(describeRuntimeProbe(probe).length).toBeGreaterThan(0);
  });
});

describe('colima helpers', () => {
  it('parses colima list --json line by line and ignores noise', () => {
    const parsed = parseColimaList(
      [
        'WARN some deprecation notice',
        '{"name":"default","status":"Stopped","arch":"aarch64","runtime":"docker"}',
        'not json at all',
        '{"name":"web","status":"Running"}',
        '{"malformed":true}',
      ].join('\n'),
    );

    expect(parsed).toEqual([
      { name: 'default', status: 'Stopped', arch: 'aarch64', runtime: 'docker' },
      { name: 'web', status: 'Running', arch: undefined, runtime: undefined },
    ]);
  });

  it('honours COLIMA_HOME and only offers the legacy socket for the default profile', () => {
    expect(colimaSocketCandidates('default', { homedir: '/h', env: {} })).toEqual([
      '/h/.colima/default/docker.sock',
      '/h/.colima/docker.sock',
    ]);
    expect(colimaSocketCandidates('web', { homedir: '/h', env: {} })).toEqual([
      '/h/.colima/web/docker.sock',
    ]);
    expect(colimaSocketCandidates('default', { homedir: '/h', env: { COLIMA_HOME: '/elsewhere' } })).toEqual(
      ['/elsewhere/default/docker.sock', '/elsewhere/docker.sock'],
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The degraded path — the point of the whole exercise                        */
/* -------------------------------------------------------------------------- */

describe('container lane without a runtime', () => {
  it('isAvailable() reports unavailable with the exact fix command, and never throws', async () => {
    const lane = createContainerLane({ detect: async () => unavailableProbe });
    const availability = await lane.isAvailable();

    expect(availability).toEqual({
      available: false,
      reason: unavailableProbe.availability.reason,
      fix: 'colima start',
    });
  });

  it('run() returns a contract-valid `skipped` result and executes nothing', async () => {
    const artifactsDir = await makeArtifactsDir('skipped');
    const spy = fakeExec(() => ({}));
    const lane = createContainerLane({ detect: async () => unavailableProbe, exec: spy.exec });

    const result = await lane.run(request({ artifactsDir }));

    expect(isLaneResult(result)).toBe(true);
    expect(parseLaneResult(result)).toEqual(result);
    expect(result.lane).toBe('container');
    expect(result.status).toBe('skipped');
    expect(result.exitCode).toBeNull();
    expect(result.durationMs).toBe(0);
    expect(result.logPath).toBeNull();
    expect(result.artifacts).toEqual([]);
    expect(result.failures).toEqual([]);

    // Nothing was run anywhere — not in a container, and emphatically not on
    // the real display.
    expect(spy.calls).toEqual([]);

    const diagnostics = result.diagnostics.join('\n');
    expect(diagnostics).toContain('does not fall back to your real screen');
    expect(diagnostics).toContain('Fix: colima start');
    expect(diagnostics).toContain('colima is installed but no profile is running');
    expect(diagnostics).toContain('podman is not installed');
  });

  it('run() reports `errored` rather than throwing when detection itself blows up', async () => {
    const artifactsDir = await makeArtifactsDir('detect-throws');
    const lane = createContainerLane({
      detect: async () => {
        throw new Error('probe exploded');
      },
    });

    const result = await lane.run(request({ artifactsDir }));

    expect(isLaneResult(result)).toBe(true);
    expect(result.status).toBe('errored');
    expect(result.diagnostics.join('\n')).toContain('probe exploded');
  });

  it('isAvailable() survives a detect() that throws', async () => {
    const lane = createContainerLane({
      detect: async () => {
        throw new Error('probe exploded');
      },
    });

    await expect(lane.isAvailable()).resolves.toMatchObject({ available: false });
  });

  it('rejects a malformed request as `errored`, with the contract violations spelled out', async () => {
    const artifactsDir = await makeArtifactsDir('bad-request');
    const lane = createContainerLane({ detect: async () => availableProbe });

    const result = await lane.run({
      cwd: 'not/absolute',
      command: [],
      artifactsDir,
    } as unknown as LaneRequest);

    expect(isLaneResult(result)).toBe(true);
    expect(result.status).toBe('errored');
    const diagnostics = result.diagnostics.join('\n');
    expect(diagnostics).toContain('does not satisfy the lane contract');
    expect(diagnostics).toContain('cwd');
    expect(diagnostics).toContain('command');
  });

  it('the real lane on this host answers isAvailable() without throwing', async () => {
    const availability = await containerLane.isAvailable();

    if (!availability.available) {
      expect(typeof availability.reason).toBe('string');
      expect(typeof availability.fix === 'string' || availability.reason?.includes('image sources')).toBe(
        true,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* The full run, driven through the exec seam                                 */
/* -------------------------------------------------------------------------- */

describe('container lane run wiring', () => {
  /** A fake docker that behaves like a cached image and a clean, headed run. */
  function happyExec(artifactsDir: string, overrides: Partial<LaneExecResult> = {}) {
    return fakeExec(async (call) => {
      if (call.args[0] === 'image' && call.args[1] === 'inspect') return { exitCode: 0 };
      if (call.args[0] === 'run') {
        // Stand in for the entrypoint's end-of-run capture.
        await fs.writeFile(path.join(artifactsDir, SCREENSHOT), 'PNGDATA', 'utf8');
        return { exitCode: 0, output: '[offstage] DISPLAY=:120\nall good\n', ...overrides };
      }
      return {};
    });
  }

  it('mounts the repo read-only, the artifacts dir writable, and runs under Xvfb', async () => {
    const artifactsDir = await makeArtifactsDir('happy');
    const spy = happyExec(artifactsDir);
    const lane = createContainerLane({
      detect: async () => availableProbe,
      exec: spy.exec,
      dockerDir: DOCKER_DIR,
      rng: () => 0.5,
    });

    const result = await lane.run(
      request({ artifactsDir, command: ['npx', 'playwright', 'test', '--headed'] }),
    );

    expect(parseLaneResult(result)).toEqual(result);
    expect(result.status).toBe('passed');
    expect(result.exitCode).toBe(0);
    expect(result.lane).toBe('container');

    const run = spy.runCall();
    expect(run).toBeDefined();
    const args = run?.args ?? [];
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '--init']);
    expect(args).toContain(`${REPO_ROOT}:${GUEST_WORKSPACE}:ro`);
    expect(args).toContain(`${artifactsDir}:${GUEST_ARTIFACTS}`);
    expect(args).toContain(`offstage-playwright-browsers:${GUEST_BROWSERS}`);
    expect(args).toContain('OFFSTAGE_DISPLAY_NUM=140');
    expect(args).toContain('OFFSTAGE_SCREEN=1280x900x24');
    expect(args).toContain(`OFFSTAGE_SCREENSHOT=${GUEST_ARTIFACTS}/${SCREENSHOT}`);
    // The command is last, after the image tag, verbatim.
    expect(args.slice(-4)).toEqual(['npx', 'playwright', 'test', '--headed']);
    expect(args[args.length - 5]).toMatch(/^offstage-web:[0-9a-f]{12}$/);

    // ...and the log and screenshot came back as artifacts inside artifactsDir.
    expect(result.logPath).toBe(path.join(artifactsDir, COMMAND_LOG));
    await expect(fs.readFile(path.join(artifactsDir, COMMAND_LOG), 'utf8')).resolves.toContain(
      'all good',
    );
    expect(result.artifacts).toContainEqual({
      kind: 'screenshot',
      path: path.join(artifactsDir, SCREENSHOT),
    });
    expect(result.diagnostics.join('\n')).toContain('host display was never opened');
  });

  it('drops DISPLAY from the request env instead of forwarding it', async () => {
    const artifactsDir = await makeArtifactsDir('display');
    const spy = happyExec(artifactsDir);
    const lane = createContainerLane({
      detect: async () => availableProbe,
      exec: spy.exec,
      dockerDir: DOCKER_DIR,
    });

    const result = await lane.run(
      request({
        artifactsDir,
        env: { DISPLAY: ':0', CI: '1', OFFSTAGE_SCREENSHOT: '/tmp/evil.png' },
      }),
    );

    const args = spy.runCall()?.args ?? [];
    expect(args).toContain('CI=1');
    expect(args).not.toContain('DISPLAY=:0');
    expect(args.filter((arg) => arg.startsWith('OFFSTAGE_SCREENSHOT='))).toEqual([
      `OFFSTAGE_SCREENSHOT=${GUEST_ARTIFACTS}/${SCREENSHOT}`,
    ]);
    expect(result.diagnostics.join('\n')).toContain('dropped from env: DISPLAY');
  });

  it('carries the runtime env (colima DOCKER_HOST) into every docker call', async () => {
    const artifactsDir = await makeArtifactsDir('colima-env');
    const spy = happyExec(artifactsDir);
    const colima: ContainerRuntime = {
      kind: 'colima',
      bin: 'docker',
      env: { DOCKER_HOST: 'unix:///home/tester/.colima/default/docker.sock' },
      serverVersion: '24.0.7',
      description: 'Colima profile "default"',
    };
    const lane = createContainerLane({
      detect: async () => ({ runtime: colima, availability: { available: true }, steps: [] }),
      exec: spy.exec,
      dockerDir: DOCKER_DIR,
    });

    await lane.run(request({ artifactsDir }));

    expect(spy.calls.length).toBeGreaterThan(0);
    for (const call of spy.calls) {
      expect(call.options.env?.DOCKER_HOST).toBe(colima.env.DOCKER_HOST);
    }
  });

  it('builds the image when it is absent, and keeps the build log as an artifact', async () => {
    const artifactsDir = await makeArtifactsDir('build');
    const spy = fakeExec(async (call) => {
      if (call.args[0] === 'image') return { exitCode: 1, output: 'No such image' };
      if (call.args[0] === 'build') return { exitCode: 0, output: 'Successfully tagged\n' };
      if (call.args[0] === 'run') {
        await fs.writeFile(path.join(artifactsDir, SCREENSHOT), 'PNGDATA', 'utf8');
        return { exitCode: 0, output: 'ok' };
      }
      return {};
    });
    const lane = createContainerLane({
      detect: async () => availableProbe,
      exec: spy.exec,
      dockerDir: DOCKER_DIR,
    });

    const result = await lane.run(request({ artifactsDir }));

    const build = spy.calls.find((call) => call.args[0] === 'build');
    expect(build?.args.slice(0, 2)).toEqual(['build', '-f']);
    expect(build?.args[2]).toBe(path.join(DOCKER_DIR, 'offstage-web.Dockerfile'));
    expect(build?.args[3]).toBe('-t');
    expect(build?.args[4]).toMatch(/^offstage-web:[0-9a-f]{12}$/);
    // The build context is `docker/`, not the repo — a full repo upload here
    // would be slow and would invalidate the cache on every source edit.
    expect(build?.args[5]).toBe(DOCKER_DIR);

    expect(result.status).toBe('passed');
    expect(result.artifacts).toContainEqual({
      kind: 'log',
      path: path.join(artifactsDir, BUILD_LOG),
    });
    expect(result.diagnostics.join('\n')).toMatch(/image: offstage-web:[0-9a-f]{12} \(built in/);
  });

  it('reuses the image on the second run instead of rebuilding', async () => {
    const artifactsDir = await makeArtifactsDir('reuse');
    const spy = happyExec(artifactsDir);
    const lane = createContainerLane({
      detect: async () => availableProbe,
      exec: spy.exec,
      dockerDir: DOCKER_DIR,
    });

    const result = await lane.run(request({ artifactsDir }));

    expect(spy.calls.some((call) => call.args[0] === 'build')).toBe(false);
    expect(result.diagnostics.join('\n')).toContain('already present, no build needed');
  });

  it('turns a failed build into `errored` with the tail of the build log', async () => {
    const artifactsDir = await makeArtifactsDir('build-fail');
    const spy = fakeExec(async (call) => {
      if (call.args[0] === 'image') return { exitCode: 1 };
      if (call.args[0] === 'build') {
        return { exitCode: 1, output: 'Step 2/9 : RUN apt-get update\nE: Unable to fetch\n' };
      }
      return {};
    });
    const lane = createContainerLane({
      detect: async () => availableProbe,
      exec: spy.exec,
      dockerDir: DOCKER_DIR,
    });

    const result = await lane.run(request({ artifactsDir }));

    expect(parseLaneResult(result)).toEqual(result);
    expect(result.status).toBe('errored');
    expect(spy.calls.some((call) => call.args[0] === 'run')).toBe(false);
    expect(result.diagnostics.join('\n')).toContain('E: Unable to fetch');
    await expect(fs.readFile(path.join(artifactsDir, BUILD_LOG), 'utf8')).resolves.toContain(
      'Unable to fetch',
    );
  });

  it('parses Playwright failures out of a failing run, with repo-relative paths', async () => {
    const artifactsDir = await makeArtifactsDir('failures');
    const output = [
      'Running 2 tests using 1 worker',
      '  1) /workspace/tests/e2e/home.spec.ts:12:5 > homepage renders the hero',
      '',
      '    Error: expect(received).toBeVisible()',
      '',
      '  2) [chromium] > tests/e2e/nav.spec.ts:31:3 > navigation opens the menu',
      '    Error: locator.click: Timeout 5000ms exceeded',
      '',
      '  2 failed',
    ].join('\n');
    const spy = fakeExec(async (call) => {
      if (call.args[0] === 'image') return { exitCode: 0 };
      if (call.args[0] === 'run') return { exitCode: 1, output };
      return {};
    });
    const lane = createContainerLane({
      detect: async () => availableProbe,
      exec: spy.exec,
      dockerDir: DOCKER_DIR,
    });

    const result = await lane.run(request({ artifactsDir }));

    expect(parseLaneResult(result)).toEqual(result);
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(1);
    expect(result.failures).toEqual([
      {
        file: 'tests/e2e/home.spec.ts',
        line: 12,
        test: 'homepage renders the hero',
        message: 'Error: expect(received).toBeVisible()',
      },
      {
        file: 'tests/e2e/nav.spec.ts',
        line: 31,
        test: 'navigation opens the menu',
        message: 'Error: locator.click: Timeout 5000ms exceeded',
      },
    ]);
    // No screenshot was produced by this fake run, and the lane says so rather
    // than claiming an artifact that is not there.
    expect(result.artifacts.some((artifact) => artifact.kind === 'screenshot')).toBe(false);
    expect(result.diagnostics.join('\n')).toContain('screenshot: not captured');
  });

  it('kills and removes the container on timeout, and reports `errored`', async () => {
    const artifactsDir = await makeArtifactsDir('timeout');
    const spy = fakeExec(async (call) => {
      if (call.args[0] === 'image') return { exitCode: 0 };
      if (call.args[0] === 'run') {
        return { exitCode: null, output: 'starting the suite\n', timedOut: true };
      }
      if (call.args[0] === 'rm') return { exitCode: 0 };
      return {};
    });
    const lane = createContainerLane({
      detect: async () => availableProbe,
      exec: spy.exec,
      dockerDir: DOCKER_DIR,
    });

    const result = await lane.run(request({ artifactsDir, timeoutMs: 1_500 }));

    expect(parseLaneResult(result)).toEqual(result);
    expect(result.status).toBe('errored');
    expect(result.exitCode).toBeNull();

    const runArgs = spy.runCall()?.args ?? [];
    const name = runArgs[runArgs.indexOf('--name') + 1];
    const removal = spy.calls.find((call) => call.args[0] === 'rm');
    expect(removal?.args).toEqual(['rm', '-f', name]);

    const diagnostics = result.diagnostics.join('\n');
    expect(diagnostics).toContain('Timed out after 1500ms');
    expect(diagnostics).toContain(`Removed container ${name}`);
    // The partial log is still kept: a hung headed run is exactly when you
    // want to see how far it got.
    await expect(fs.readFile(path.join(artifactsDir, COMMAND_LOG), 'utf8')).resolves.toContain(
      'starting the suite',
    );
  });

  it('reports `errored` when the docker binary cannot be spawned', async () => {
    const artifactsDir = await makeArtifactsDir('spawn');
    const spy = fakeExec(async (call) => {
      if (call.args[0] === 'image') return { exitCode: 0 };
      if (call.args[0] === 'run') {
        return { exitCode: null, spawnError: 'docker could not be executed (ENOENT)' };
      }
      return {};
    });
    const lane = createContainerLane({
      detect: async () => availableProbe,
      exec: spy.exec,
      dockerDir: DOCKER_DIR,
    });

    const result = await lane.run(request({ artifactsDir }));

    expect(result.status).toBe('errored');
    expect(result.diagnostics.join('\n')).toContain('ENOENT');
  });

  it('reports `errored` when the image sources are missing', async () => {
    const artifactsDir = await makeArtifactsDir('no-dockerfile');
    const lane = createContainerLane({
      detect: async () => availableProbe,
      exec: fakeExec(() => ({})).exec,
      dockerDir: path.join(tmpRoot, 'nowhere'),
    });

    const result = await lane.run(request({ artifactsDir }));

    expect(result.status).toBe('errored');
    expect(result.diagnostics.join('\n')).toContain('offstage-web.Dockerfile');
  });

  it('keeps concurrent runs from colliding on container names', async () => {
    const shared = await makeArtifactsDir('concurrent');
    const names = await Promise.all(
      Array.from({ length: 8 }, async (_unused, index) => {
        const artifactsDir = path.join(shared, `run-${index}`);
        await fs.mkdir(artifactsDir, { recursive: true });
        const spy = happyExec(artifactsDir);
        const lane = createContainerLane({
          detect: async () => availableProbe,
          exec: spy.exec,
          dockerDir: DOCKER_DIR,
        });
        await lane.run(request({ artifactsDir }));
        const args = spy.runCall()?.args ?? [];
        return args[args.indexOf('--name') + 1] ?? '';
      }),
    );

    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

describe('imageTagFor', () => {
  const context = [
    { name: 'offstage-web.Dockerfile', text: 'FROM node:20' },
    { name: 'offstage-entrypoint.sh', text: '#!/bin/sh\nexec "$@"' },
    { name: 'fluxbox-init', text: 'session.styleFile: /etc/offstage/fluxbox/style' },
  ];

  it('is stable for identical content and changes for any edit', () => {
    expect(imageTagFor('offstage-web', context)).toBe(imageTagFor('offstage-web', context));
    expect(imageTagFor('offstage-web', context)).toMatch(/^offstage-web:[0-9a-f]{12}$/);

    // Every file in the build context counts — including the window-manager
    // config, which an earlier version of this hash ignored.
    for (const index of [0, 1, 2]) {
      const edited = context.map((file, position) =>
        position === index ? { ...file, text: `${file.text} ` } : file,
      );
      expect(imageTagFor('offstage-web', edited)).not.toBe(imageTagFor('offstage-web', context));
    }

    // Renaming a file is a change; reordering the same files is not.
    const renamed = [{ ...context[0]!, name: 'other.Dockerfile' }, ...context.slice(1)];
    expect(imageTagFor('offstage-web', renamed)).not.toBe(imageTagFor('offstage-web', context));
    expect(imageTagFor('offstage-web', [...context].reverse())).toBe(
      imageTagFor('offstage-web', context),
    );

    // Names and contents are delimited, so text cannot migrate between fields.
    expect(imageTagFor('x', [{ name: 'ab', text: 'c' }])).not.toBe(
      imageTagFor('x', [{ name: 'a', text: 'bc' }]),
    );
  });

  it('hashes the real build context, which includes the fluxbox config', async () => {
    const found = await loadDockerAssets(DOCKER_DIR);
    expect('assets' in found).toBe(true);
    if (!('assets' in found)) return;

    expect(found.assets.files.map((file) => file.name)).toEqual([
      'fluxbox-init',
      'offstage-entrypoint.sh',
      'offstage-web.Dockerfile',
    ]);
  });
});

describe('containerNameFor', () => {
  it('produces a legal docker name from any run directory', () => {
    expect(containerNameFor('/runs/20260817T180245123Z-3f9a1c', 'ab12cd34')).toBe(
      'offstage-20260817T180245123Z-3f9a1c-ab12cd34',
    );
    expect(containerNameFor('/runs/weird name (2)!', 'ff')).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
    expect(containerNameFor('/runs/...', 'ff')).toBe('offstage-run-ff');
    expect(containerNameFor(`/runs/${'x'.repeat(200)}`, 'ff').length).toBeLessThanOrEqual(60);
  });
});

describe('parseFailures', () => {
  const cwd = '/repo';

  it('maps container paths back to repository-relative ones', () => {
    expect(unmapGuestPath(cwd, `${GUEST_WORKSPACE}/tests/a.spec.ts`)).toBe('/repo/tests/a.spec.ts');
    expect(unmapGuestPath(cwd, 'tests/a.spec.ts')).toBe('tests/a.spec.ts');
    expect(unmapGuestPath(cwd, GUEST_WORKSPACE)).toBe(cwd);
  });

  it('understands Vitest FAIL lines', () => {
    const failures = parseFailures(
      ['FAIL tests/unit/math.test.ts > adds numbers', ' AssertionError: expected 3 to be 4'].join(
        '\n',
      ),
      cwd,
    );

    expect(failures).toEqual([
      {
        file: 'tests/unit/math.test.ts',
        test: 'adds numbers',
        message: 'AssertionError: expected 3 to be 4',
      },
    ]);
  });

  it('does not invent failures out of prose that starts with FAIL', () => {
    expect(parseFailures('FAIL to connect to the daemon\nFAILED: nothing here', cwd)).toEqual([]);
    expect(parseFailures('', cwd)).toEqual([]);
    expect(parseFailures('everything passed', cwd)).toEqual([]);
  });

  it('omits `file` rather than emitting a path outside the repository', () => {
    const failures = parseFailures('  1) /elsewhere/a.spec.ts:3:1 > escapes\n    Error: nope', cwd);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.file).toBeUndefined();
    expect(failures[0]?.line).toBeUndefined();
    expect(failures[0]?.message).toBe('Error: nope');
  });

  it('caps how many failures it reports', () => {
    const log = Array.from(
      { length: 60 },
      (_unused, index) => `  ${index + 1}) tests/a${index}.spec.ts:1:1 > case ${index}`,
    ).join('\n');

    expect(parseFailures(log, cwd, 25)).toHaveLength(25);
  });
});

describe('logTail', () => {
  it('keeps the last lines, drops blanks, and respects the character budget', () => {
    expect(logTail('a\n\nb\n\nc\n', 2)).toEqual(['b', 'c']);
    expect(logTail(`${'x'.repeat(50)}\n${'y'.repeat(50)}`, 10, 60)).toEqual(['x'.repeat(50)]);
    expect(logTail('', 5)).toEqual([]);
  });
});

describe('buildRunPlan', () => {
  const base = {
    runtime: dockerRuntime,
    tag: 'offstage-web:abc123abc123',
    cwd: '/repo',
    artifactsDir: '/repo/.offstage/runs/r1',
    command: ['npm', 'test'],
    env: {},
    containerName: 'offstage-r1-aa',
    displayNumber: 99,
    screen: '800x600x24',
    repoMountMode: 'ro' as const,
    browsersVolume: 'offstage-playwright-browsers' as string | false,
    user: null as string | null,
  };

  it('emits the image tag immediately before the command', () => {
    const plan = buildRunPlan(base);
    const tagIndex = plan.args.indexOf(base.tag);

    expect(plan.bin).toBe('docker');
    expect(plan.args.slice(tagIndex)).toEqual([base.tag, 'npm', 'test']);
  });

  it('honours rw repo mounts, a disabled browser volume, and an explicit user', () => {
    const plan = buildRunPlan({
      ...base,
      repoMountMode: 'rw',
      browsersVolume: false,
      user: '501:20',
    });

    expect(plan.args).toContain(`/repo:${GUEST_WORKSPACE}:rw`);
    expect(plan.args.some((arg) => arg.includes(GUEST_BROWSERS))).toBe(false);
    expect(plan.args).toContain('--user');
    expect(plan.args).toContain('501:20');
    expect(plan.args).toContain('HOME=/tmp');
  });
});

/* -------------------------------------------------------------------------- */
/* The image sources                                                          */
/* -------------------------------------------------------------------------- */

describe('docker/ image sources', () => {
  it('are found from the module itself, not just from the repo root', async () => {
    expect(dockerDirCandidates('/pkg/dist/lanes/container')[0]).toBe('/pkg/docker');

    const found = await loadDockerAssets();
    expect('assets' in found).toBe(true);
    if ('assets' in found) {
      expect(found.assets.dir).toBe(DOCKER_DIR);
    }
  });

  it('build an Xvfb image: virtual display, window manager, screenshots, Node 20', async () => {
    const dockerfile = await fs.readFile(path.join(DOCKER_DIR, 'offstage-web.Dockerfile'), 'utf8');

    expect(dockerfile).toMatch(/^FROM node:20-bookworm-slim$/m);
    for (const pkg of ['xvfb', 'fluxbox', 'x11-utils', 'imagemagick']) {
      expect(dockerfile).toMatch(new RegExp(`^\\s+${pkg} \\\\$`, 'm'));
    }
    // Chromium cannot start without these; Playwright installs the same set.
    for (const lib of ['libnss3', 'libgbm1', 'libgtk-3-0', 'libatk-bridge2.0-0', 'libxkbcommon0']) {
      expect(dockerfile).toContain(lib);
    }
    expect(dockerfile).toContain('rm -rf /var/lib/apt/lists/*');
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/offstage-entrypoint"]');
    // The guest layout the lane assumes has to be the one the image provides.
    expect(dockerfile).toContain(GUEST_ARTIFACTS);
    expect(dockerfile).toContain(GUEST_BROWSERS);
    expect(dockerfile).toContain(GUEST_WORKSPACE);
    // The size claim is a measurement, and says so.
    expect(dockerfile).toMatch(/MEASURED SIZE/);
  });

  it('ship an entrypoint that starts Xvfb, exports DISPLAY, and screenshots the run', async () => {
    const file = path.join(DOCKER_DIR, 'offstage-entrypoint.sh');
    const script = await fs.readFile(file, 'utf8');
    const stat = await fs.stat(file);

    expect(stat.mode & 0o111).toBeTruthy();
    expect(script.startsWith('#!/bin/sh')).toBe(true);
    expect(script).toContain('Xvfb ":${DISPLAY_NUM}"');
    expect(script).toContain('export DISPLAY');
    expect(script).toContain('fluxbox');
    // Readiness is polled, never slept on.
    expect(script).toContain('xdpyinfo -display "$DISPLAY"');
    // Two independent capture paths, and a signal handler so a killed run is
    // still photographed.
    expect(script).toContain('import -display');
    expect(script).toContain('xwd -display');
    expect(script).toContain('trap on_signal TERM INT');
    // The command's own exit status is what the container exits with.
    expect(script).toContain('exit "$status"');
  });

  it('disable the wallpaper that would otherwise pop an error dialog into every screenshot', async () => {
    const dockerfile = await fs.readFile(path.join(DOCKER_DIR, 'offstage-web.Dockerfile'), 'utf8');
    const init = await fs.readFile(path.join(DOCKER_DIR, 'fluxbox-init'), 'utf8');
    const entrypoint = await fs.readFile(path.join(DOCKER_DIR, 'offstage-entrypoint.sh'), 'utf8');

    // Debian's stock fluxbox paints a JPEG wallpaper it cannot load inside a
    // container, and the resulting xmessage dialog both pollutes the screenshot
    // and steals focus from the browser under test. The config has to land in
    // the system-wide location: neither `fluxbox -rc` nor ~/.fluxbox/init
    // overrides it. This test exists so nobody "tidies" that path away.
    expect(dockerfile).toContain('COPY fluxbox-init /etc/X11/fluxbox/init');
    expect(init).toContain('session.styleFile: /etc/offstage/fluxbox/style');

    // The style is derived from Debian's at build time, and the build fails
    // loudly if the derivation ever stops removing the wallpaper.
    expect(dockerfile).toContain('background: none');
    expect(dockerfile).toContain("grep -q '^background: none$' /etc/offstage/fluxbox/style");
    expect(dockerfile).toContain("! grep -q 'debian-squared' /etc/offstage/fluxbox/style");

    // fluxbox clears the root window when it starts, so the deliberate
    // background colour has to be painted after it, not before.
    const wmStart = entrypoint.indexOf('fluxbox >');
    const paint = entrypoint.indexOf('xsetroot -solid');
    expect(wmStart).toBeGreaterThan(0);
    expect(paint).toBeGreaterThan(wmStart);
  });

  it('is valid POSIX shell', async () => {
    if (process.platform === 'win32') return;
    await expect(
      execFileAsync('sh', ['-n', path.join(DOCKER_DIR, 'offstage-entrypoint.sh')]),
    ).resolves.toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* The real thing — only when this machine can actually run a container        */
/* -------------------------------------------------------------------------- */

const hostProbe = await detectContainerRuntime();
const hostRuntime = hostProbe.runtime;

describe.skipIf(!hostRuntime)('against a real container runtime', () => {
  let repoDir: string;

  beforeAll(async () => {
    repoDir = path.join(tmpRoot, 'headed-fixture');
    await fs.mkdir(repoDir, { recursive: true });
    // A headed fixture with no dependencies: prove the X server is real, put a
    // window on it, and let the entrypoint photograph the result.
    await fs.writeFile(
      path.join(repoDir, 'headed-fixture.cjs'),
      [
        "const { execFileSync, spawn } = require('node:child_process');",
        "const info = execFileSync('xdpyinfo').toString();",
        "if (!/dimensions:/.test(info)) { console.error(info); process.exit(2); }",
        "console.log('display ok ' + process.env.DISPLAY);",
        "console.log(info.split('\\n').find((l) => l.includes('dimensions:')).trim());",
        "spawn('xclock', ['-digital'], { stdio: 'ignore', detached: true }).unref();",
        "setTimeout(() => console.log('headed fixture done'), 1500);",
      ].join('\n'),
      'utf8',
    );
  });

  it(
    'builds the image and runs a headed fixture on the virtual display',
    async () => {
      const artifactsDir = await makeArtifactsDir('real-run');
      const lane = createContainerLane({ dockerDir: DOCKER_DIR, screen: '1024x768x24' });

      const result = await lane.run({
        cwd: repoDir,
        command: ['node', 'headed-fixture.cjs'],
        artifactsDir,
        timeoutMs: 300_000,
      });

      expect(parseLaneResult(result)).toEqual(result);
      expect(result.status).toBe('passed');
      expect(result.exitCode).toBe(0);

      const log = await fs.readFile(path.join(artifactsDir, COMMAND_LOG), 'utf8');
      expect(log).toContain('display ok :');
      expect(log).toContain('headed fixture done');
      expect(log).toContain('dimensions:    1024x768');

      const shot = await fs.readFile(path.join(artifactsDir, SCREENSHOT));
      expect(shot.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(result.artifacts).toContainEqual({
        kind: 'screenshot',
        path: path.join(artifactsDir, SCREENSHOT),
      });
    },
    // A cold build pulls the base image and ~850 MB of packages.
    1_800_000,
  );

  it(
    'reports a non-zero command as `failed`, not `errored`, and leaves no container behind',
    async () => {
      const artifactsDir = await makeArtifactsDir('real-fail');
      const lane = createContainerLane({ dockerDir: DOCKER_DIR });

      const result = await lane.run({
        cwd: repoDir,
        command: ['node', '-e', 'console.error("boom"); process.exit(3)'],
        artifactsDir,
        timeoutMs: 300_000,
      });

      expect(result.status).toBe('failed');
      expect(result.exitCode).toBe(3);

      const running = await execFileAsync(
        hostRuntime?.bin ?? 'docker',
        ['ps', '-a', '--filter', 'name=offstage-', '--format', '{{.Names}}'],
        { env: { ...process.env, ...(hostRuntime?.env ?? {}) } },
      );
      expect(running.stdout.trim()).toBe('');
    },
    600_000,
  );
});
