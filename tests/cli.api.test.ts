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
import { OffstageUsageError, doctor, hintsFromEnv, probe, route, run } from '../src/cli/api.js';

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
      container: lanes.container ?? fakeLane('container'),
      vm: lanes.vm ?? fakeLane('vm'),
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
        vm: fakeLane('vm', { availability: { available: false, reason: 'no tart' } }),
      }),
    );

    expect(report.lanes.map((health) => health.lane)).toEqual(['headless', 'container', 'vm']);
    expect(report.ready).toEqual(['headless']);
    expect(report.lanes[1]?.availability.fix).toBe('colima start');
    expect(report.offstageVersion).toMatch(/^\d+\.\d+\.\d+$|^unknown$/);
  });

  it('survives a lane whose isAvailable() throws, and says which lane broke its contract', async () => {
    const broken: LaneRunner = {
      lane: 'vm',
      async isAvailable(): Promise<LaneAvailability> {
        throw new Error('tart exploded');
      },
      async run(req) {
        return createLaneResult({ lane: 'vm', status: 'errored', artifactsDir: req.artifactsDir });
      },
    };

    const report = await doctor(deps({ vm: broken }));
    const vm = report.lanes.find((health) => health.lane === 'vm');
    expect(vm?.availability.available).toBe(false);
    expect(vm?.availability.reason).toContain('vm.isAvailable() threw');
    expect(vm?.availability.reason).toContain('tart exploded');
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
      expect(persisted.diagnostics.join(' ')).toContain('routed it to the vm lane');
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
