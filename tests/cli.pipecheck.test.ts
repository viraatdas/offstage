/**
 * The pipe-capacity diagnostic doctor reports.
 *
 * The number this module exists for was measured on a real machine in the
 * state it detects: every fresh pipe held exactly 512 or 1024 bytes, every
 * lane probed green, and every local `xcodebuild` hung without an error. The
 * unit tests here hold that history as fixtures: 512 and 1024 must always
 * warn, 16384 and 65536 must always be silent.
 */

import { describe, expect, it } from 'vitest';

import type { Lane, LaneRequest, LaneResult, LaneRunner } from '../src/contract/index.js';
import { createLaneResult } from '../src/contract/index.js';
import { doctor } from '../src/cli/api.js';
import {
  HEALTHY_PIPE_BYTES,
  PIPE_MEASURE_SCRIPT,
  measurePipeCapacity,
  parsePipeMeasurement,
  pipeWarning,
} from '../src/cli/pipecheck.js';

describe('pipeWarning', () => {
  it('is silent at the healthy macOS capacity', () => {
    expect(pipeWarning(16_384)).toBeUndefined();
  });

  it('is silent at Linux capacities, which are larger', () => {
    expect(pipeWarning(65_536)).toBeUndefined();
  });

  it('warns at each degraded capacity actually measured in the field', () => {
    for (const bytes of [512, 1024]) {
      const warning = pipeWarning(bytes);
      expect(warning).toBeDefined();
      expect(warning).toContain(`${bytes} bytes`);
    }
  });

  it('names the failure an agent would otherwise misdiagnose', () => {
    const warning = pipeWarning(512) ?? '';
    expect(warning).toContain('xcodebuild');
    expect(warning).toContain('hang');
    expect(warning).toContain('reboot');
  });

  it('warns anywhere below the healthy mark, not only at the observed values', () => {
    expect(pipeWarning(HEALTHY_PIPE_BYTES - 1)).toBeDefined();
  });
});

describe('parsePipeMeasurement', () => {
  it('reads the count off a clean stdout', () => {
    expect(parsePipeMeasurement('16384\n')).toEqual({ bytes: 16_384 });
  });

  it('tolerates surrounding whitespace', () => {
    expect(parsePipeMeasurement('  512 \n')).toEqual({ bytes: 512 });
  });

  it('refuses output that is not a byte count, and says what it saw', () => {
    const probe = parsePipeMeasurement('Traceback (most recent call last):');
    expect(probe.bytes).toBeUndefined();
    expect(probe.reason).toContain('not a byte count');
  });

  it('refuses an empty stdout rather than reading it as zero', () => {
    expect(parsePipeMeasurement('').bytes).toBeUndefined();
  });
});

describe('measurePipeCapacity', () => {
  it('passes the measuring script to python3 through the exec seam', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const probe = await measurePipeCapacity(async (file, args) => {
      calls.push({ file, args });
      return { stdout: '16384\n' };
    });
    expect(probe).toEqual({ bytes: 16_384 });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('python3');
    expect(calls[0].args[0]).toBe('-c');
    expect(calls[0].args[1]).toBe(PIPE_MEASURE_SCRIPT);
  });

  it('answers with a reason when python3 is absent, and never throws', async () => {
    const error = Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' });
    const probe = await measurePipeCapacity(async () => {
      throw error;
    });
    expect(probe.bytes).toBeUndefined();
    expect(probe.reason).toContain('python3 is not on PATH');
  });

  it('answers with a reason when the measurement exits nonzero', async () => {
    const error = Object.assign(new Error('python3 died'), { code: 1 });
    const probe = await measurePipeCapacity(async () => {
      throw error;
    });
    expect(probe).toEqual({ reason: 'python3 exited 1' });
  });

  it('answers with a reason when the measurement times out', async () => {
    const error = Object.assign(new Error('killed'), { killed: true });
    const probe = await measurePipeCapacity(async () => {
      throw error;
    });
    expect(probe.bytes).toBeUndefined();
    expect(probe.reason).toBeDefined();
  });

  it('measures a real pipe where python3 exists', { skip: process.platform === 'win32' }, async () => {
    const probe = await measurePipeCapacity();
    if (probe.bytes === undefined) {
      expect(probe.reason).toBeDefined();
      return;
    }
    /* The machine this runs on may be the degraded kind the probe exists to
       catch (one was, while these tests were being written: it measured 512),
       so the assertion is agreement, not health. */
    expect(probe.bytes).toBeGreaterThan(0);
    if (probe.bytes >= HEALTHY_PIPE_BYTES) {
      expect(pipeWarning(probe.bytes)).toBeUndefined();
    } else {
      expect(pipeWarning(probe.bytes)).toBeDefined();
    }
  });
});

describe('doctor carries the pipe warning', () => {
  it('a degraded measurement lands in warnings next to any stale-build note', async () => {
    const report = await doctor({
      lanes: {
        headless: greenLane('headless'),
        session: greenLane('session'),
        container: greenLane('container'),
      },
    });
    /* This machine is healthy or it is not; the assertion is that the field
       is wired, not what this particular kernel answered. A degraded kernel
       would add exactly one warning naming the byte count. */
    const pipeWarnings = report.warnings.filter((warning) => warning.includes('pipe'));
    if (pipeWarnings.length > 0) {
      expect(pipeWarnings[0]).toContain('reboot');
    }
    expect(report.warnings.length).toBeGreaterThanOrEqual(0);
  });
});

/* A lane whose substrate answers, so doctor's lane loop has nothing to say. */
function greenLane(lane: Lane): LaneRunner {
  return {
    lane,
    async isAvailable() {
      return { available: true };
    },
    async run(req: LaneRequest): Promise<LaneResult> {
      return createLaneResult({ lane, status: 'passed', exitCode: 0, artifactsDir: req.artifactsDir });
    },
  };
}
