import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { LaneResult } from '../src/contract/index.js';
import {
  ARTIFACT_KINDS,
  LANES,
  LANE_STATUSES,
  LaneRequestSchema,
  LaneResultSchema,
  createLaneResult,
  describeValidationError,
  exitCodeForResult,
  isInside,
  isLaneResult,
  parseLaneRequest,
  parseLaneResult,
  safeParseLaneResult,
  skippedResult,
  statusFromExitCode,
} from '../src/contract/index.js';

const ARTIFACTS_DIR = path.resolve('/tmp/offstage-test/runs/20260817T180245123Z-3f9a1c');

function validResult(overrides: Partial<LaneResult> = {}): LaneResult {
  return {
    lane: 'container',
    status: 'failed',
    exitCode: 1,
    startedAt: '2026-08-17T18:02:45.123Z',
    durationMs: 8421,
    artifactsDir: ARTIFACTS_DIR,
    logPath: path.join(ARTIFACTS_DIR, 'command.log'),
    artifacts: [
      { kind: 'log', path: path.join(ARTIFACTS_DIR, 'command.log') },
      { kind: 'screenshot', path: path.join(ARTIFACTS_DIR, 'screenshots', 'failure-1.png') },
    ],
    failures: [
      {
        test: 'checkout > applies a discount code',
        message: 'expected 90 to equal 100',
        file: 'tests/checkout.spec.ts',
        line: 42,
      },
    ],
    diagnostics: ['Ran headed Chromium under Xvfb :99 inside offstage-web:latest.'],
    ...overrides,
  };
}

describe('LaneResult round-trip', () => {
  it('parses a fully populated result unchanged', () => {
    const original = validResult();
    expect(parseLaneResult(original)).toEqual(original);
  });

  it('survives a JSON round-trip, which is how result.json is actually used', () => {
    const original = validResult();
    const roundTripped = parseLaneResult(JSON.parse(JSON.stringify(original)));
    expect(roundTripped).toEqual(original);
    expect(JSON.parse(JSON.stringify(roundTripped))).toEqual(JSON.parse(JSON.stringify(original)));
  });

  it('is idempotent: parsing a parsed result changes nothing', () => {
    const once = parseLaneResult(validResult());
    expect(parseLaneResult(once)).toEqual(once);
  });

  it('round-trips a minimal result with every optional field absent', () => {
    const minimal = validResult({
      status: 'passed',
      exitCode: 0,
      logPath: null,
      artifacts: [],
      failures: [{ message: 'no structured failures were parsed' }],
      diagnostics: [],
    });
    expect(parseLaneResult(JSON.parse(JSON.stringify(minimal)))).toEqual(minimal);
  });

  it('round-trips every lane / status / artifact-kind combination', () => {
    for (const lane of LANES) {
      for (const status of LANE_STATUSES) {
        for (const kind of ARTIFACT_KINDS) {
          const result = validResult({
            lane,
            status,
            exitCode: status === 'passed' ? 0 : null,
            artifacts: [{ kind, path: path.join(ARTIFACTS_DIR, `artifact.${kind}`) }],
          });
          expect(parseLaneResult(JSON.parse(JSON.stringify(result)))).toEqual(result);
        }
      }
    }
  });

  it('accepts exitCode null (killed, timed out, or never started)', () => {
    expect(parseLaneResult(validResult({ status: 'errored', exitCode: null })).exitCode).toBeNull();
  });

  it('accepts a negative exit code, which is what a signal death looks like', () => {
    expect(parseLaneResult(validResult({ exitCode: -1 })).exitCode).toBe(-1);
  });
});

describe('LaneResult schema rejection', () => {
  const rejects = (overrides: Record<string, unknown>, expectedPath: string) => {
    const parsed = safeParseLaneResult({ ...validResult(), ...overrides });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.some((issue) => issue.path.join('.') === expectedPath)).toBe(true);
  };

  it('rejects an unknown lane', () => {
    rejects({ lane: 'kubernetes' }, 'lane');
  });

  it('rejects an unknown status', () => {
    rejects({ status: 'flaky' }, 'status');
  });

  it('rejects an unknown artifact kind', () => {
    rejects({ artifacts: [{ kind: 'trace', path: path.join(ARTIFACTS_DIR, 'x') }] }, 'artifacts.0.kind');
  });

  it('rejects a missing required field', () => {
    const { durationMs: _omitted, ...withoutDuration } = validResult();
    const parsed = safeParseLaneResult(withoutDuration);
    expect(parsed.success).toBe(false);
  });

  it('rejects a non-integer exit code', () => {
    rejects({ exitCode: 1.5 }, 'exitCode');
  });

  it('rejects a negative duration', () => {
    rejects({ durationMs: -1 }, 'durationMs');
  });

  it('rejects a startedAt that is not ISO-8601 UTC', () => {
    rejects({ startedAt: '17 August 2026' }, 'startedAt');
    rejects({ startedAt: '2026-08-17' }, 'startedAt');
    rejects({ startedAt: '2026-08-17T18:02:45+02:00' }, 'startedAt');
    rejects({ startedAt: '2026-13-99T99:99:99.999Z' }, 'startedAt');
  });

  it('rejects a relative artifactsDir — it must be an absolute host path', () => {
    rejects({ artifactsDir: '.offstage/runs/abc' }, 'artifactsDir');
  });

  it('rejects a relative logPath', () => {
    rejects({ logPath: 'command.log' }, 'logPath');
  });

  it('rejects a logPath outside artifactsDir — run dirs must be self-contained', () => {
    rejects({ logPath: '/var/log/system.log' }, 'logPath');
    rejects({ logPath: path.resolve(ARTIFACTS_DIR, '..', 'other-run', 'command.log') }, 'logPath');
  });

  it('rejects an artifact outside artifactsDir', () => {
    rejects(
      { artifacts: [{ kind: 'video', path: '/Users/someone/Movies/capture.webm' }] },
      'artifacts.0.path',
    );
  });

  it('rejects an absolute failures[].file — those are repository-relative', () => {
    rejects(
      { failures: [{ message: 'boom', file: '/Users/someone/repo/tests/checkout.spec.ts' }] },
      'failures.0.file',
    );
  });

  it('rejects a failures[].file that escapes the repository', () => {
    rejects({ failures: [{ message: 'boom', file: '../elsewhere/a.ts' }] }, 'failures.0.file');
  });

  it('rejects a failures[].file with Windows separators', () => {
    rejects({ failures: [{ message: 'boom', file: 'tests\\checkout.spec.ts' }] }, 'failures.0.file');
  });

  it('rejects a failure with no message', () => {
    rejects({ failures: [{ test: 'a test', file: 'tests/a.ts' }] }, 'failures.0.message');
  });

  it('rejects a zero or negative failure line number', () => {
    rejects({ failures: [{ message: 'boom', line: 0 }] }, 'failures.0.line');
  });

  it('rejects diagnostics that are not strings', () => {
    rejects({ diagnostics: [{ note: 'structured' }] }, 'diagnostics.0');
  });

  it('rejects a completely wrong shape without throwing', () => {
    for (const value of [null, undefined, 42, 'result', [], { lane: 'session' }]) {
      expect(safeParseLaneResult(value).success).toBe(false);
      expect(isLaneResult(value)).toBe(false);
    }
  });

  it('throws a ZodError from parseLaneResult and describes every violation', () => {
    let caught: unknown;
    try {
      parseLaneResult({ ...validResult(), lane: 'nope', durationMs: -5 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();

    const parsed = safeParseLaneResult({ ...validResult(), lane: 'nope', durationMs: -5 });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const described = describeValidationError(parsed.error);
    expect(described.length).toBeGreaterThanOrEqual(2);
    expect(described.join('\n')).toContain('lane');
    expect(described.join('\n')).toContain('durationMs');
  });

  it('strips unknown keys rather than smuggling them downstream', () => {
    const parsed = parseLaneResult({ ...validResult(), containerId: 'abc123' });
    expect(parsed).not.toHaveProperty('containerId');
  });
});

describe('LaneRequest schema', () => {
  const validRequest = {
    cwd: path.resolve('/Users/someone/repo'),
    command: ['npx', 'playwright', 'test', '--headed'],
    env: { CI: '1' },
    timeoutMs: 120_000,
    artifactsDir: ARTIFACTS_DIR,
  };

  it('round-trips a valid request', () => {
    expect(parseLaneRequest(validRequest)).toEqual(validRequest);
  });

  it('accepts a request with only the required fields', () => {
    const minimal = { cwd: validRequest.cwd, command: ['vitest', 'run'], artifactsDir: ARTIFACTS_DIR };
    expect(parseLaneRequest(minimal)).toEqual(minimal);
  });

  it('rejects an empty command — there is nothing to route', () => {
    expect(LaneRequestSchema.safeParse({ ...validRequest, command: [] }).success).toBe(false);
  });

  it('rejects a shell string instead of an argv array', () => {
    expect(
      LaneRequestSchema.safeParse({ ...validRequest, command: 'npx playwright test' }).success,
    ).toBe(false);
  });

  it('rejects a relative cwd', () => {
    expect(LaneRequestSchema.safeParse({ ...validRequest, cwd: './repo' }).success).toBe(false);
  });

  it('rejects a non-positive timeout', () => {
    expect(LaneRequestSchema.safeParse({ ...validRequest, timeoutMs: 0 }).success).toBe(false);
  });

  it('rejects non-string env values', () => {
    expect(LaneRequestSchema.safeParse({ ...validRequest, env: { PORT: 3000 } }).success).toBe(false);
  });
});

describe('isInside', () => {
  it('treats the directory itself as inside', () => {
    expect(isInside(ARTIFACTS_DIR, ARTIFACTS_DIR)).toBe(true);
  });

  it('accepts nested paths', () => {
    expect(isInside(ARTIFACTS_DIR, path.join(ARTIFACTS_DIR, 'a', 'b.png'))).toBe(true);
  });

  it('rejects siblings and parents', () => {
    expect(isInside(ARTIFACTS_DIR, path.resolve(ARTIFACTS_DIR, '..'))).toBe(false);
    expect(isInside(ARTIFACTS_DIR, path.resolve(ARTIFACTS_DIR, '..', 'sibling'))).toBe(false);
  });

  it('is not fooled by a shared name prefix', () => {
    expect(isInside('/tmp/run', '/tmp/run-2/file.log')).toBe(false);
  });

  it('normalizes traversal before deciding', () => {
    expect(isInside(ARTIFACTS_DIR, path.join(ARTIFACTS_DIR, 'a', '..', 'b.log'))).toBe(true);
    expect(isInside(ARTIFACTS_DIR, path.join(ARTIFACTS_DIR, '..', 'escape.log'))).toBe(false);
  });
});

describe('statusFromExitCode', () => {
  it('maps 0 to passed, non-zero to failed, null to errored', () => {
    expect(statusFromExitCode(0)).toBe('passed');
    expect(statusFromExitCode(1)).toBe('failed');
    expect(statusFromExitCode(137)).toBe('failed');
    expect(statusFromExitCode(null)).toBe('errored');
  });
});

describe('exitCodeForResult', () => {
  it('passes through 0 for a passing run', () => {
    expect(exitCodeForResult(validResult({ status: 'passed', exitCode: 0 }))).toBe(0);
  });

  it("propagates the command's own code for a failing run", () => {
    expect(exitCodeForResult(validResult({ status: 'failed', exitCode: 3 }))).toBe(3);
  });

  it('falls back to 1 when a failing run has no exit code to propagate', () => {
    expect(exitCodeForResult(validResult({ status: 'failed', exitCode: null }))).toBe(1);
    expect(exitCodeForResult(validResult({ status: 'failed', exitCode: 0 }))).toBe(1);
  });

  it('distinguishes "offstage broke" (70) from "your tests are red"', () => {
    expect(exitCodeForResult(validResult({ status: 'errored', exitCode: null }))).toBe(70);
  });

  it('distinguishes "substrate unavailable" (69) from both', () => {
    expect(exitCodeForResult(validResult({ status: 'skipped', exitCode: null }))).toBe(69);
  });
});

describe('createLaneResult', () => {
  it('fills in the boring fields and produces a contract-valid envelope', () => {
    const result = createLaneResult({ lane: 'headless', status: 'passed', artifactsDir: ARTIFACTS_DIR });
    expect(isLaneResult(result)).toBe(true);
    expect(result).toMatchObject({
      lane: 'headless',
      status: 'passed',
      exitCode: null,
      durationMs: 0,
      logPath: null,
      artifacts: [],
      failures: [],
      diagnostics: [],
    });
    expect(new Date(result.startedAt).toISOString()).toBe(result.startedAt);
  });

  it('lets the caller override any defaulted field', () => {
    const result = createLaneResult({
      lane: 'session',
      status: 'failed',
      artifactsDir: ARTIFACTS_DIR,
      exitCode: 65,
      durationMs: 91_000,
      logPath: path.join(ARTIFACTS_DIR, 'xcodebuild.log'),
    });
    expect(result.exitCode).toBe(65);
    expect(result.durationMs).toBe(91_000);
    expect(result.logPath).toBe(path.join(ARTIFACTS_DIR, 'xcodebuild.log'));
  });

  it('rejects an envelope the lane got wrong, at the lane’s own call site', () => {
    expect(() =>
      createLaneResult({
        lane: 'container',
        status: 'failed',
        artifactsDir: ARTIFACTS_DIR,
        artifacts: [{ kind: 'screenshot', path: '/elsewhere/shot.png' }],
      }),
    ).toThrow();
  });
});

describe('skippedResult', () => {
  it('records the reason and the fix, and says nothing was executed', () => {
    const result = skippedResult('container', ARTIFACTS_DIR, {
      available: false,
      reason: 'No container runtime is reachable (colima is installed but not running).',
      fix: 'colima start',
    });

    expect(isLaneResult(result)).toBe(true);
    expect(result.status).toBe('skipped');
    expect(result.exitCode).toBeNull();
    expect(result.diagnostics.join('\n')).toContain('does not fall back to your real screen');
    expect(result.diagnostics.join('\n')).toContain('colima is installed but not running');
    expect(result.diagnostics.join('\n')).toContain('Fix: colima start');
  });

  it('works when the availability probe offered no reason', () => {
    const result = skippedResult('session', ARTIFACTS_DIR, { available: false });
    expect(LaneResultSchema.safeParse(result).success).toBe(true);
    expect(result.diagnostics).toHaveLength(1);
  });
});
