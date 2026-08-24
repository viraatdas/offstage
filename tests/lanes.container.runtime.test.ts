/**
 * `detectContainerRuntime`: which container runtime can run something right
 * now, and if none can, exactly what the human should type.
 *
 * The machine this was written on is the interesting case (docker CLI present
 * but pointed at a dead OrbStack socket, Colima installed but stopped, no
 * podman), so the degraded path is asserted here in that exact shape. The lane
 * that consumes the answer is tested in `lanes.container.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import path from 'node:path';

import {
  colimaSocketCandidates,
  describeRuntimeProbe,
  detectContainerRuntime,
  parseColimaList,
} from '../src/lanes/container/index.js';
import {
  createTmpRoot,
  noDesktopApps,
  orbstackInstalled,
  probeTable,
  removeTmpRoot,
} from './lanes.container.fixtures.js';

beforeAll(createTmpRoot);
afterAll(removeTmpRoot);

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
        // Colima is installed and stopped too: the heavier option must lose.
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
