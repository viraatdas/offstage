/**
 * The `offstage` command tree: argv parsing, the `--json` split, and exit codes.
 *
 * The program is driven in-process through `createProgram()` with captured
 * streams, so these tests cover the real commander wiring without spawning a
 * process or requiring `dist/` to exist.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Lane, LaneRequest, LaneRunner } from '../src/contract/index.js';
import { createLaneResult } from '../src/contract/index.js';
import type { ApiDeps } from '../src/cli/api.js';
import { main } from '../src/cli/index.js';
import type { CliIo } from '../src/cli/index.js';

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function tempRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-prog-'));
  temps.push(dir);
  return await fs.realpath(dir);
}

function lane(id: Lane, status: 'passed' | 'failed' = 'passed'): LaneRunner & { calls: LaneRequest[] } {
  const calls: LaneRequest[] = [];
  return {
    lane: id,
    calls,
    async isAvailable() {
      return id === 'headless' ? { available: true } : { available: false, reason: `${id} is not set up`, fix: `install ${id}` };
    },
    async run(req: LaneRequest) {
      calls.push(req);
      return createLaneResult({
        lane: id,
        status,
        exitCode: status === 'passed' ? 0 : 1,
        artifactsDir: req.artifactsDir,
      });
    },
  };
}

interface Captured {
  code: number;
  out: string;
  err: string;
}

async function cli(argv: string[], options: { cwd?: string; deps?: Partial<ApiDeps>; env?: NodeJS.ProcessEnv } = {}): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    cwd: () => options.cwd ?? process.cwd(),
    env: options.env ?? {},
    deps: {
      lanes: { headless: lane('headless'), container: lane('container'), vm: lane('vm') },
      env: options.env ?? {},
      ...options.deps,
    },
  };
  const code = await main(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('offstage route', () => {
  it('prints the lane, the confidence and the reason, and exits 0', async () => {
    const cwd = await tempRepo();
    const result = await cli(['route', '--', 'npx', 'playwright', 'test'], { cwd });

    expect(result.code).toBe(0);
    expect(result.out).toContain('lane:');
    expect(result.out).toContain('headless');
    expect(result.out).toContain('confidence: high');
  });

  it('keeps flags meant for the classified command out of its own option parsing', async () => {
    const cwd = await tempRepo();
    const result = await cli(['route', '--', 'npx', 'playwright', 'test', '--headed'], { cwd });

    expect(result.out).toContain('npx playwright test --headed');
    expect(result.out).toContain('container');
  });

  it('reads offstage’s own --headed before the separator as caller intent', async () => {
    const cwd = await tempRepo();
    const result = await cli(['route', '--headed', '--', 'npx', 'playwright', 'test'], { cwd });
    expect(result.out).toContain('container');
    expect(result.out).toContain('hint: headed = true');
  });
});

describe('--json', () => {
  it('puts the envelope on stdout and every human line on stderr', async () => {
    const cwd = await tempRepo();
    const result = await cli(['route', '--json', '--', 'npx', 'vitest', 'run'], { cwd });

    const parsed = JSON.parse(result.out) as { lane: string };
    expect(parsed.lane).toBe('headless');
    expect(result.err).toContain('lane:');
    // stdout must be parseable on its own — nothing human may leak into it.
    expect(result.out.trimStart().startsWith('{')).toBe(true);
  });

  it('emits the LaneResult envelope for a run, not the outcome wrapper', async () => {
    const cwd = await tempRepo();
    const result = await cli(['run', '--json', '--', 'npm', 'test'], { cwd });

    const parsed = JSON.parse(result.out) as { lane: string; status: string; artifactsDir: string };
    expect(parsed.status).toBe('passed');
    expect(parsed.lane).toBe('headless');
    expect(parsed.artifactsDir.startsWith(cwd)).toBe(true);
  });
});

describe('offstage run', () => {
  it('writes result.json into the run directory and exits with the mapped code', async () => {
    const cwd = await tempRepo();
    const failing = lane('headless', 'failed');
    const result = await cli(['run', '--', 'npm', 'test'], {
      cwd,
      deps: { lanes: { headless: failing, container: lane('container'), vm: lane('vm') } },
    });

    expect(result.code).toBe(1);
    expect(result.out).toContain('FAILED');
    const runs = await fs.readdir(path.join(cwd, '.offstage', 'runs'));
    expect(runs).toHaveLength(1);
    const written = await fs.readFile(path.join(cwd, '.offstage', 'runs', runs[0] as string, 'result.json'), 'utf8');
    expect(JSON.parse(written).status).toBe('failed');
  });

  it('announces the lane on stderr before the run, so stdout stays the document', async () => {
    const cwd = await tempRepo();
    const result = await cli(['run', '--json', '--', 'npm', 'test'], { cwd });
    expect(result.err).toContain('→ headless lane');
    expect(() => JSON.parse(result.out)).not.toThrow();
  });

  it('rejects a lane that is not one of the three, without running anything', async () => {
    const cwd = await tempRepo();
    const headless = lane('headless');
    const result = await cli(['run', '--lane', 'sandbox', '--', 'npm', 'test'], {
      cwd,
      deps: { lanes: { headless, container: lane('container'), vm: lane('vm') } },
    });

    expect(result.code).toBe(64);
    expect(headless.calls).toHaveLength(0);
  });

  it('rejects a non-numeric timeout', async () => {
    const cwd = await tempRepo();
    const result = await cli(['run', '--timeout', 'soon', '--', 'npm', 'test'], { cwd });
    expect(result.code).toBe(64);
  });

  it('exits 70 and executes nothing when --lane headless would undo the routing', async () => {
    const cwd = await tempRepo();
    const headless = lane('headless');
    const result = await cli(['run', '--lane', 'headless', '--', 'xcodebuild', 'test'], {
      cwd,
      deps: { lanes: { headless, container: lane('container'), vm: lane('vm') } },
    });

    expect(result.code).toBe(70);
    expect(headless.calls).toHaveLength(0);
    expect(result.out).toContain('Refused: --lane headless');
  });

  it('reports a missing cwd as a usage error rather than a crash', async () => {
    const result = await cli(['run', '--cwd', path.join(os.tmpdir(), 'offstage-absent'), '--', 'npm', 'test']);
    expect(result.code).toBe(66);
    expect(result.err).toContain('offstage: cwd does not exist');
  });
});

describe('offstage doctor', () => {
  it('renders each lane with its fix and exits 0 even when lanes are unavailable', async () => {
    const result = await cli(['doctor']);

    expect(result.code).toBe(0);
    expect(result.out).toContain('headless');
    expect(result.out).toContain('fix: install container');
    expect(result.out).toContain('fix: install vm');
    expect(result.out).toContain('2 of 3 lanes cannot run right now');
  });

  it('emits a machine-readable report under --json', async () => {
    const result = await cli(['doctor', '--json']);
    const parsed = JSON.parse(result.out) as { ready: string[]; lanes: unknown[] };
    expect(parsed.ready).toEqual(['headless']);
    expect(parsed.lanes).toHaveLength(3);
  });
});

describe('offstage probe', () => {
  it('renders the verdict, its confidence, and the notes behind it', async () => {
    const result = await cli(['probe', 'tests/fixtures/probe/DeclaredProject']);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/adhoc-ok|needs-signing-lane/);
    expect(result.out).toContain('confidence)');
  });

  it('exits 66 when the target does not exist', async () => {
    const result = await cli(['probe', path.join(os.tmpdir(), 'offstage-no-such-app.xcodeproj')]);
    expect(result.code).toBe(66);
    expect(result.err).toContain('offstage:');
  });
});

describe('help and errors', () => {
  it('exits 0 for --help', async () => {
    const result = await cli(['--help']);
    expect(result.code).toBe(0);
  });

  it('exits non-zero for an unknown command', async () => {
    const result = await cli(['teleport']);
    expect(result.code).not.toBe(0);
  });
});
