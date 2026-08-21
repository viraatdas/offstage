/**
 * The CLI's programmatic API — the single dispatch path the terminal and the
 * MCP server share.
 *
 * The tests that matter most here are the refusal tests: offstage's whole
 * reason to exist is that no combination of flags puts a window on the user's
 * real screen, so "the lane runner was never called" is asserted directly
 * rather than inferred from a status.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Lane, LaneAvailability, LaneRequest, LaneResult, LaneRunner } from '../src/contract/index.js';
import { createLaneResult } from '../src/contract/index.js';
import { readResult } from '../src/contract/artifacts.js';
import type { ApiDeps } from '../src/cli/api.js';
import {
  OffstageUsageError,
  detectStaleBuild,
  doctor,
  hintsFromEnv,
  offstageInstall,
  probe,
  route,
  run,
} from '../src/cli/api.js';

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-cli-'));
  temps.push(dir);
  return await fs.realpath(dir);
}

/** A lane that records what it was asked to do and returns whatever it is told. */
function fakeLane(
  lane: Lane,
  options: {
    availability?: LaneAvailability;
    result?: (req: LaneRequest) => LaneResult | Promise<LaneResult> | unknown;
  } = {},
): LaneRunner & { calls: LaneRequest[] } {
  const calls: LaneRequest[] = [];
  return {
    lane,
    calls,
    async isAvailable() {
      return options.availability ?? { available: true };
    },
    async run(req: LaneRequest) {
      calls.push(req);
      const produce = options.result;
      if (produce) return (await produce(req)) as LaneResult;
      return createLaneResult({
        lane,
        status: 'passed',
        exitCode: 0,
        artifactsDir: req.artifactsDir,
      });
    },
  };
}

function deps(
  lanes: Partial<Record<Lane, LaneRunner>>,
  overrides: Partial<ApiDeps> = {},
): Partial<ApiDeps> {
  return {
    lanes: {
      headless: lanes.headless ?? fakeLane('headless'),
      session: lanes.session ?? fakeLane('session'),
      container: lanes.container ?? fakeLane('container'),
    },
    env: {},
    ...overrides,
  };
}

describe('hintsFromEnv', () => {
  it('maps PWDEBUG onto the headed hint, because the router reads no environment', () => {
    expect(hintsFromEnv({ PWDEBUG: '1' })).toEqual({ headed: true });
    expect(hintsFromEnv({ PWDEBUG: 'console' })).toEqual({ headed: true });
  });

  it('treats an absent, empty or zero PWDEBUG as no hint at all', () => {
    expect(hintsFromEnv({})).toEqual({});
    expect(hintsFromEnv({ PWDEBUG: '' })).toEqual({});
    expect(hintsFromEnv({ PWDEBUG: '0' })).toEqual({});
  });

  it('lets an explicit flag win over the environment, in both directions', () => {
    expect(hintsFromEnv({ PWDEBUG: '1' }, false)).toEqual({ headed: false });
    expect(hintsFromEnv({}, true)).toEqual({ headed: true });
  });
});

describe('doctor', () => {
  it('reports every lane and lists the ones that could run something', async () => {
    const report = await doctor(
      deps({
        container: fakeLane('container', {
          availability: { available: false, reason: 'no runtime', fix: 'colima start' },
        }),
      }),
    );

    expect(report.lanes.map((health) => health.lane)).toEqual([
      'headless',
      'session',
      'container',
    ]);
    expect(report.ready).toEqual(['headless', 'session']);
    expect(report.lanes[2]?.availability.fix).toBe('colima start');
    expect(report.offstageVersion).toMatch(/^\d+\.\d+\.\d+$|^unknown$/);
  });

  it('names the directory it is running out of, not just the version it claims', async () => {
    const report = await doctor(deps({}));

    // Two installs both reporting the same version are only the same code if
    // they came from the same place. Version alone cannot answer "is this the
    // published package or my checkout?" — which is the question that cost a
    // debugging session when a stale MCP process outlived its build.
    expect(report.install.version).toBe(report.offstageVersion);
    expect(report.install.root).not.toBe('');
    expect(path.isAbsolute(report.install.root)).toBe(true);

    // Running the suite means running out of the checkout, by definition.
    expect(report.install.fromSource).toBe(true);
  });

  it('carries warnings as a list so a clean install has an empty one, not a missing field', async () => {
    const report = await doctor(deps({}));
    expect(Array.isArray(report.warnings)).toBe(true);
  });

  it('survives a lane whose isAvailable() throws, and says which lane broke its contract', async () => {
    const broken: LaneRunner = {
      lane: 'container',
      async isAvailable(): Promise<LaneAvailability> {
        throw new Error('docker exploded');
      },
      async run(req) {
        return createLaneResult({ lane: 'container', status: 'errored', artifactsDir: req.artifactsDir });
      },
    };

    const report = await doctor(deps({ container: broken }));
    const container = report.lanes.find((health) => health.lane === 'container');
    expect(container?.availability.available).toBe(false);
    expect(container?.availability.reason).toContain('container.isAvailable() threw');
    expect(container?.availability.reason).toContain('docker exploded');
  });
});

describe('a command passed as one quoted string', () => {
  it('splits it, instead of classifying a program whose name contains spaces', async () => {
    // `offstage route -- "npx playwright test --headed"` arrives as one argv
    // entry. Read literally it names no browser, so it classified as headless
    // — a wrong answer that reads as a confident one.
    const cwd = await tempRepo();
    const decision = await route({ cwd, command: ['npx playwright test --headed'] }, deps({}));

    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('high');
  });

  it('passes the split argv to the lane, so run and route agree', async () => {
    const cwd = await tempRepo();
    const headless = fakeLane('headless');
    await run({ cwd, command: ['npx vitest run'] }, deps({ headless }));

    expect(headless.calls[0]?.command).toEqual(['npx', 'vitest', 'run']);
  });

  it('leaves a single token with no whitespace exactly as it is', async () => {
    const cwd = await tempRepo();
    const headless = fakeLane('headless');
    await run({ cwd, command: ['./build.sh'] }, deps({ headless }));

    expect(headless.calls[0]?.command).toEqual(['./build.sh']);
  });

  it('never splits a multi-token command, where the spacing is the caller\'s', async () => {
    // `node -e "console.log('a b')"` has a legitimate argument with spaces in
    // it. Splitting that would corrupt the command.
    const cwd = await tempRepo();
    const headless = fakeLane('headless');
    const command = ['node', '-e', "console.log('a b')"];
    await run({ cwd, command }, deps({ headless }));

    expect(headless.calls[0]?.command).toEqual(command);
  });

  it('refuses a shell script rather than pretending it is a command', async () => {
    const cwd = await tempRepo();
    await expect(
      route({ cwd, command: ['npm run build && npx playwright test'] }, deps({})),
    ).rejects.toThrow(/shell script, not a command/);
  });
});

describe('route', () => {
  it('classifies without running anything', async () => {
    const cwd = await tempRepo();
    const headless = fakeLane('headless');
    const decision = await route({ cwd, command: ['npx', 'playwright', 'test'] }, deps({ headless }));

    expect(decision.lane).toBe('headless');
    expect(headless.calls).toHaveLength(0);
  });

  it('sends PWDEBUG from the ambient environment through as a headed hint', async () => {
    const cwd = await tempRepo();
    const classify = vi.fn(async () => ({
      lane: 'container' as const,
      reason: 'stub',
      confidence: 'high' as const,
      signals: [],
    }));

    await route({ cwd, command: ['npx', 'playwright', 'test'] }, deps({}, { classify, env: { PWDEBUG: '1' } }));

    expect(classify).toHaveBeenCalledWith(expect.objectContaining({ hints: { headed: true } }));
  });

  it('rejects a cwd that does not exist rather than classifying against nothing', async () => {
    await expect(
      route({ cwd: path.join(os.tmpdir(), 'offstage-nope-does-not-exist'), command: ['ls'] }, deps({})),
    ).rejects.toBeInstanceOf(OffstageUsageError);
  });

  it('rejects an empty command, because a silent "headless" would hide the bug', async () => {
    const cwd = await tempRepo();
    await expect(route({ cwd, command: [] }, deps({}))).rejects.toThrow(/No command given/);
  });
});

describe('run', () => {
  it('dispatches to the router-chosen lane and persists a readable result.json', async () => {
    const cwd = await tempRepo();
    const headless = fakeLane('headless');
    const outcome = await run({ cwd, command: ['npx', 'vitest', 'run'] }, deps({ headless }));

    expect(outcome.lane).toBe('headless');
    expect(outcome.laneSource).toBe('router');
    expect(outcome.exitCode).toBe(0);
    expect(headless.calls[0]?.command).toEqual(['npx', 'vitest', 'run']);
    expect(headless.calls[0]?.artifactsDir).toBe(outcome.artifactsDir);

    expect(outcome.resultPath).not.toBeNull();
    const persisted = await readResult(outcome.resultPath as string);
    expect(persisted.status).toBe('passed');
    expect(outcome.relativeDir.startsWith('.offstage/runs/')).toBe(true);
  });

  it('records the routing decision and its signals in the result, so the run explains itself', async () => {
    const cwd = await tempRepo();
    const outcome = await run({ cwd, command: ['npx', 'playwright', 'test'] }, deps({}));

    expect(outcome.result.diagnostics.some((line) => line.startsWith('Routed to headless'))).toBe(true);
    expect(outcome.result.diagnostics.some((line) => line.startsWith('Signal: '))).toBe(true);
  });

  it('maps status onto the process exit code the contract specifies', async () => {
    const cwd = await tempRepo();
    const cases: Array<[LaneResult['status'], number, number | null]> = [
      ['passed', 0, 0],
      ['failed', 3, 3],
      ['errored', 70, null],
      ['skipped', 69, null],
    ];

    for (const [status, expected, exitCode] of cases) {
      const lane = fakeLane('headless', {
        result: (req) =>
          createLaneResult({ lane: 'headless', status, exitCode, artifactsDir: req.artifactsDir }),
      });
      const outcome = await run({ cwd, command: ['npm', 'test'] }, deps({ headless: lane }));
      expect([status, outcome.exitCode]).toEqual([status, expected]);
    }
  });

  describe('the one refusal', () => {
    it('refuses --lane headless when the router routed away from headless, and runs nothing', async () => {
      const cwd = await tempRepo();
      const headless = fakeLane('headless');
      const container = fakeLane('container');

      const outcome = await run(
        { cwd, command: ['npx', 'playwright', 'test'], headed: true, lane: 'headless' },
        deps({ headless, container }),
      );

      // The point of the whole product: nothing executed anywhere.
      expect(headless.calls).toHaveLength(0);
      expect(container.calls).toHaveLength(0);
      expect(outcome.result.status).toBe('errored');
      expect(outcome.exitCode).toBe(70);
      expect(outcome.result.diagnostics[0]).toContain('Refused: --lane headless');
      expect(outcome.result.diagnostics.join(' ')).toContain('There is no flag that bypasses this');
    });

    it('still persists the refusal, so the run directory records what was asked and denied', async () => {
      const cwd = await tempRepo();
      const outcome = await run(
        { cwd, command: ['xcodebuild', 'test'], lane: 'headless' },
        deps({}),
      );

      const persisted = await readResult(outcome.resultPath as string);
      expect(persisted.status).toBe('errored');
      expect(persisted.diagnostics.join(' ')).toContain('routed it to the session lane');
    });

    it('allows --lane headless when the router agreed, because that is not a downgrade', async () => {
      const cwd = await tempRepo();
      const headless = fakeLane('headless');
      const outcome = await run(
        { cwd, command: ['npx', 'vitest', 'run'], lane: 'headless' },
        deps({ headless }),
      );

      expect(headless.calls).toHaveLength(1);
      expect(outcome.result.status).toBe('passed');
      expect(outcome.laneSource).toBe('explicit');
    });

    it('allows over-isolating, and says the override was honoured', async () => {
      const cwd = await tempRepo();
      const container = fakeLane('container');
      const outcome = await run(
        { cwd, command: ['npx', 'vitest', 'run'], lane: 'container' },
        deps({ container }),
      );

      expect(container.calls).toHaveLength(1);
      expect(outcome.result.diagnostics[0]).toContain('Lane forced to "container"');
      expect(outcome.result.diagnostics[0]).toContain('router would have chosen "headless"');
    });
  });

  it('turns a lane that throws out of run() into an errored result naming the lane', async () => {
    const cwd = await tempRepo();
    const lane = fakeLane('headless', {
      result: () => {
        throw new Error('spawn ENOENT');
      },
    });

    const outcome = await run({ cwd, command: ['npm', 'test'] }, deps({ headless: lane }));
    expect(outcome.result.status).toBe('errored');
    expect(outcome.result.diagnostics[0]).toContain('headless lane threw out of run()');
    expect(outcome.result.diagnostics[0]).toContain('spawn ENOENT');
  });

  it('turns a contract-violating lane result into an errored result listing every violation', async () => {
    const cwd = await tempRepo();
    const lane = fakeLane('headless', {
      result: () => ({ lane: 'headless', status: 'passed' }),
    });

    const outcome = await run({ cwd, command: ['npm', 'test'] }, deps({ headless: lane }));
    expect(outcome.result.status).toBe('errored');
    expect(outcome.result.diagnostics[0]).toContain('violates the lane contract');
    expect(outcome.result.diagnostics.some((line) => line.includes('artifactsDir'))).toBe(true);
  });

  it('keeps the verdict when result.json cannot be written, and says the file is missing', async () => {
    const cwd = await tempRepo();
    const outcome = await run(
      { cwd, command: ['npm', 'test'] },
      deps({}, {
        writeResult: async () => {
          throw new Error('disk full');
        },
      }),
    );

    expect(outcome.result.status).toBe('passed');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.resultPath).toBeNull();
    expect(outcome.result.diagnostics.join(' ')).toContain('Could not write result.json');
  });

  it('announces the decision before dispatching, so a long run is not silent', async () => {
    const cwd = await tempRepo();
    const seen: string[] = [];
    const lane = fakeLane('headless', {
      result: (req) => {
        seen.push('ran');
        return createLaneResult({ lane: 'headless', status: 'passed', exitCode: 0, artifactsDir: req.artifactsDir });
      },
    });

    await run(
      {
        cwd,
        command: ['npm', 'test'],
        onDecision: (event) => seen.push(`decided:${event.lane}`),
      },
      deps({ headless: lane }),
    );

    expect(seen).toEqual(['decided:headless', 'ran']);
  });

  it('does not let a throwing onDecision callback fail the run', async () => {
    const cwd = await tempRepo();
    const outcome = await run(
      {
        cwd,
        command: ['npm', 'test'],
        onDecision: () => {
          throw new Error('printer on fire');
        },
      },
      deps({}),
    );
    expect(outcome.result.status).toBe('passed');
  });

  it('rejects an unknown lane and a non-positive timeout before anything runs', async () => {
    const cwd = await tempRepo();
    const headless = fakeLane('headless');
    await expect(
      run({ cwd, command: ['npm', 'test'], lane: 'sandbox' as Lane }, deps({ headless })),
    ).rejects.toThrow(/Unknown lane/);
    await expect(
      run({ cwd, command: ['npm', 'test'], timeoutMs: 0 }, deps({ headless })),
    ).rejects.toThrow(/--timeout/);
    expect(headless.calls).toHaveLength(0);
  });

  it('passes the timeout through to the lane untouched', async () => {
    const cwd = await tempRepo();
    const headless = fakeLane('headless');
    await run({ cwd, command: ['npm', 'test'], timeoutMs: 1234 }, deps({ headless }));
    expect(headless.calls[0]?.timeoutMs).toBe(1234);
  });
});

describe('probe', () => {
  it('resolves the target to an absolute path and forwards the external-tools switch', async () => {
    const probeEntitlements = vi.fn(async () => ({ verdict: 'adhoc-ok' }) as never);
    await probe({ path: 'MyApp.xcodeproj', allowExternalTools: false }, deps({}, { probeEntitlements }));

    expect(probeEntitlements).toHaveBeenCalledWith(
      path.resolve('MyApp.xcodeproj'),
      { allowExternalTools: false },
    );
  });

  it('rejects an empty path', async () => {
    await expect(probe({ path: '' }, deps({}))).rejects.toBeInstanceOf(OffstageUsageError);
  });
});

describe('offstageInstall', () => {
  it('is stable across calls, because the MCP server reads it while constructing itself', () => {
    // Sync and cached on purpose: the server must name its version before
    // anything can be awaited. Two different answers would mean the CLI and
    // the server could disagree about what is running — they did once.
    expect(offstageInstall()).toBe(offstageInstall());
  });

  it('resolves to a directory that actually holds the package.json it read', async () => {
    const install = offstageInstall();
    const manifest = JSON.parse(await fs.readFile(path.join(install.root, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(manifest.version).toBe(install.version);
  });

  it('does not call a source checkout stale while the suite runs from source', () => {
    // Under vitest the module IS the source, so there is no compiled output to
    // be behind it. Flagging this case would make the warning noise.
    expect(offstageInstall().staleBuild).toBeUndefined();
  });
});

describe('stale build detection', () => {
  /** A checkout-shaped temp tree: package.json, src/, and a built dist/. */
  async function checkout(): Promise<{ root: string; module: string; source: string }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-stale-'));
    await fs.mkdir(path.join(root, 'src', 'cli'), { recursive: true });
    await fs.mkdir(path.join(root, 'dist', 'cli'), { recursive: true });
    const source = path.join(root, 'src', 'cli', 'api.ts');
    const module = path.join(root, 'dist', 'cli', 'api.js');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
    await fs.writeFile(source, 'export const x = 1;');
    await fs.writeFile(module, 'export const x = 1;');
    return { root, module, source };
  }

  /** mtimes have coarse resolution on some filesystems; set them explicitly. */
  const setMtime = (target: string, msAgo: number) =>
    fs.utimes(target, new Date(), new Date(Date.now() - msAgo));

  it('says nothing when the build is newer than its sources', async () => {
    const { root, module, source } = await checkout();
    // Set every input explicitly. Creation order is not a reliable ordering:
    // the filesystem records sub-millisecond mtimes that `utimes` cannot write.
    await setMtime(path.join(root, 'package.json'), 60_000);
    await setMtime(source, 60_000);
    await setMtime(module, 0);

    expect(detectStaleBuild(root, module, '9.9.9')).toBeUndefined();
  });

  it('ignores a sub-second difference, which is timestamp noise rather than a stale build', async () => {
    const { root, module, source } = await checkout();
    await setMtime(path.join(root, 'package.json'), 0);
    await setMtime(module, 100);
    await setMtime(source, 0);

    // The source is 100ms ahead of the build. A tool that rewrites package.json
    // as it finishes lands exactly here, and it is not what stale means.
    expect(detectStaleBuild(root, module, '9.9.9')).toBeUndefined();
  });

  it('names the directory and the version when the sources have moved on', async () => {
    const { root, module, source } = await checkout();
    await setMtime(module, 3 * 60 * 60_000);
    await setMtime(source, 0);

    const warning = detectStaleBuild(root, module, '9.9.9');
    expect(warning).toContain('3 hours older');
    expect(warning).toContain(root);
    expect(warning).toContain('9.9.9');
    // The fix has two halves and the second is the one people miss.
    expect(warning).toContain('npm run build');
    expect(warning).toContain('restart');
  });

  it('counts a version bump as a source change, which is how the 0.2.1/0.2.2 confusion happened', async () => {
    const { root, module, source } = await checkout();
    await setMtime(module, 60 * 60_000);
    await setMtime(source, 2 * 60 * 60_000);
    await setMtime(path.join(root, 'package.json'), 0);

    expect(detectStaleBuild(root, module, '9.9.9')).toContain('older than its sources');
  });

  it('stays quiet when the running module is not a build at all', async () => {
    const { root, source } = await checkout();
    await setMtime(source, 0);

    // Running under tsx: the module IS the source. Nothing can be stale.
    expect(detectStaleBuild(root, source, '9.9.9')).toBeUndefined();
  });
});
