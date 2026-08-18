import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LaneResult } from '../src/contract/index.js';
import { createLaneResult, parseLaneResult } from '../src/contract/index.js';
import {
  OFFSTAGE_DIR,
  RESULT_FILENAME,
  RUNS_DIR,
  allocateRunDir,
  artifactPath,
  listRunIds,
  makeRunId,
  readResult,
  toRepoRelative,
  writeResult,
} from '../src/contract/artifacts.js';

let repo: string;

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-artifacts-'));
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe('makeRunId', () => {
  it('encodes the timestamp so ids sort chronologically', () => {
    const early = makeRunId(new Date('2026-08-17T18:02:45.123Z'), 'aaaaaa');
    const late = makeRunId(new Date('2026-08-17T18:02:45.124Z'), 'aaaaaa');
    expect(early).toBe('20260817T180245123Z-aaaaaa');
    expect([late, early].sort()).toEqual([early, late]);
  });

  it('contains no path separators or characters that need escaping', () => {
    expect(makeRunId(new Date('2026-08-17T18:02:45.123Z'))).toMatch(/^[0-9A-Za-z]+Z-[0-9a-f]{6}$/);
  });

  it('does not collide for runs started in the same millisecond', () => {
    const now = new Date('2026-08-17T18:02:45.123Z');
    const ids = new Set(Array.from({ length: 200 }, () => makeRunId(now)));
    expect(ids.size).toBe(200);
  });
});

describe('allocateRunDir', () => {
  it('makes .offstage ignore itself, so a run leaves the user\'s git status clean', async () => {
    // The first thing offstage does for a new user is write into their
    // repository. Nothing it writes should ever show up as untracked.
    await allocateRunDir({ cwd: repo });

    const marker = await fs.readFile(path.join(repo, '.offstage', '.gitignore'), 'utf8');
    expect(marker).toContain('*');
    expect(marker).toContain('offstage');
  });

  it('does not overwrite an existing .offstage/.gitignore', async () => {
    await fs.mkdir(path.join(repo, '.offstage'), { recursive: true });
    await fs.writeFile(path.join(repo, '.offstage', '.gitignore'), 'mine\n');

    await allocateRunDir({ cwd: repo });

    expect(await fs.readFile(path.join(repo, '.offstage', '.gitignore'), 'utf8')).toBe('mine\n');
  });

  it('creates .offstage/runs/<id>/ and reports every form of the path', async () => {
    const run = await allocateRunDir({ cwd: repo, runId: 'run-1' });

    expect(run.runId).toBe('run-1');
    expect(run.artifactsDir).toBe(path.join(repo, OFFSTAGE_DIR, 'runs', 'run-1'));
    expect(run.resultPath).toBe(path.join(run.artifactsDir, RESULT_FILENAME));
    expect(run.relativeDir).toBe(`${RUNS_DIR}/run-1`);
    expect(path.isAbsolute(run.artifactsDir)).toBe(true);

    const stat = await fs.stat(run.artifactsDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('generates a fresh directory per run', async () => {
    const a = await allocateRunDir({ cwd: repo });
    const b = await allocateRunDir({ cwd: repo });
    expect(a.artifactsDir).not.toBe(b.artifactsDir);
  });

  it('resolves a relative cwd against the process, so artifactsDir is always absolute', async () => {
    const run = await allocateRunDir({ cwd: '.', runId: 'relative-cwd' });
    try {
      expect(path.isAbsolute(run.artifactsDir)).toBe(true);
      expect(run.artifactsDir.startsWith(path.resolve('.'))).toBe(true);
    } finally {
      await fs.rm(path.join(path.resolve('.'), OFFSTAGE_DIR), { recursive: true, force: true });
    }
  });
});

describe('artifactPath', () => {
  it('produces absolute paths inside the run directory', () => {
    const dir = path.join(repo, 'run');
    expect(artifactPath(dir, 'command.log')).toBe(path.join(dir, 'command.log'));
    expect(artifactPath(dir, 'screenshots', 'a.png')).toBe(path.join(dir, 'screenshots', 'a.png'));
  });

  it('refuses to build a path that escapes the run directory', () => {
    const dir = path.join(repo, 'run');
    expect(() => artifactPath(dir, '..', 'escape.log')).toThrow(/escapes the run directory/);
    expect(() => artifactPath(dir, '/etc/passwd')).toThrow(/escapes the run directory/);
  });
});

describe('toRepoRelative', () => {
  it('relativizes an absolute path under the repo, with POSIX separators', () => {
    expect(toRepoRelative(repo, path.join(repo, 'tests', 'checkout.spec.ts'))).toBe(
      'tests/checkout.spec.ts',
    );
  });

  it('normalizes an already-relative path', () => {
    expect(toRepoRelative(repo, './src/a.ts')).toBe('src/a.ts');
    expect(toRepoRelative(repo, 'src/./b/../a.ts')).toBe('src/a.ts');
  });

  it('returns null for a path outside the repository, so callers omit `file`', () => {
    expect(toRepoRelative(repo, '/usr/lib/node_modules/x.js')).toBeNull();
    expect(toRepoRelative(repo, '../sibling/a.ts')).toBeNull();
  });

  it('returns null for the repository root itself', () => {
    expect(toRepoRelative(repo, repo)).toBeNull();
  });

  it('produces values the contract accepts', () => {
    const file = toRepoRelative(repo, path.join(repo, 'tests', 'a.spec.ts'));
    expect(file).not.toBeNull();
    const result = createLaneResult({
      lane: 'headless',
      status: 'failed',
      artifactsDir: path.join(repo, '.offstage', 'runs', 'r'),
      exitCode: 1,
      failures: [{ message: 'nope', file: file as string, line: 7 }],
    });
    expect(result.failures[0]?.file).toBe('tests/a.spec.ts');
  });
});

describe('writeResult / readResult', () => {
  const buildResult = (artifactsDir: string, overrides: Partial<LaneResult> = {}): LaneResult =>
    createLaneResult({
      lane: 'headless',
      status: 'failed',
      artifactsDir,
      exitCode: 1,
      startedAt: '2026-08-17T18:02:45.123Z',
      durationMs: 1234,
      logPath: artifactPath(artifactsDir, 'command.log'),
      artifacts: [{ kind: 'log', path: artifactPath(artifactsDir, 'command.log') }],
      failures: [{ test: 'a', message: 'expected 1 to equal 2', file: 'tests/a.spec.ts', line: 7 }],
      diagnostics: ['No isolation was applied: the command is already headless.'],
      ...overrides,
    });

  it('writes result.json into the run directory and reads it back identically', async () => {
    const run = await allocateRunDir({ cwd: repo, runId: 'run-rt' });
    const result = buildResult(run.artifactsDir);

    const written = await writeResult(result);
    expect(written).toBe(run.resultPath);

    expect(await readResult(written)).toEqual(result);
    expect(await readResult(run.artifactsDir)).toEqual(result);
  });

  it('writes human-readable, newline-terminated JSON', async () => {
    const run = await allocateRunDir({ cwd: repo, runId: 'run-fmt' });
    await writeResult(buildResult(run.artifactsDir));
    const raw = await fs.readFile(run.resultPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw).toContain('\n  "lane": "headless"');
    expect(parseLaneResult(JSON.parse(raw))).toEqual(buildResult(run.artifactsDir));
  });

  it('creates the run directory if a lane never did', async () => {
    const artifactsDir = path.join(repo, '.offstage', 'runs', 'never-created');
    const written = await writeResult(buildResult(artifactsDir));
    expect(written).toBe(path.join(artifactsDir, RESULT_FILENAME));
    expect((await fs.stat(artifactsDir)).isDirectory()).toBe(true);
  });

  it('refuses to persist an envelope that violates the contract', async () => {
    const run = await allocateRunDir({ cwd: repo, runId: 'run-bad' });
    const broken = { ...buildResult(run.artifactsDir), status: 'flaky' } as unknown as LaneResult;
    await expect(writeResult(broken)).rejects.toThrow();
    await expect(fs.stat(run.resultPath)).rejects.toThrow();
  });

  it('reports which rules a hand-edited result.json violates', async () => {
    const run = await allocateRunDir({ cwd: repo, runId: 'run-tampered' });
    await fs.writeFile(
      run.resultPath,
      JSON.stringify({ ...buildResult(run.artifactsDir), lane: 'kubernetes', durationMs: -1 }),
      'utf8',
    );
    await expect(readResult(run.resultPath)).rejects.toThrow(/lane[\s\S]*durationMs|durationMs/);
  });

  it('reports unparseable JSON as such', async () => {
    const run = await allocateRunDir({ cwd: repo, runId: 'run-garbage' });
    await fs.writeFile(run.resultPath, '{ not json', 'utf8');
    await expect(readResult(run.resultPath)).rejects.toThrow(/not valid JSON/);
  });

  it('surfaces a missing result.json as ENOENT', async () => {
    await expect(readResult(path.join(repo, 'nowhere'))).rejects.toThrow(/ENOENT/);
  });
});

describe('listRunIds', () => {
  it('returns [] before anything has been run', async () => {
    expect(await listRunIds(repo)).toEqual([]);
  });

  it('lists run directories oldest-first', async () => {
    await allocateRunDir({ cwd: repo, runId: '20260817T180245123Z-aaaaaa' });
    await allocateRunDir({ cwd: repo, runId: '20260817T190245123Z-bbbbbb' });
    await allocateRunDir({ cwd: repo, runId: '20260816T090000000Z-cccccc' });

    expect(await listRunIds(repo)).toEqual([
      '20260816T090000000Z-cccccc',
      '20260817T180245123Z-aaaaaa',
      '20260817T190245123Z-bbbbbb',
    ]);
  });

  it('ignores stray files next to the run directories', async () => {
    const run = await allocateRunDir({ cwd: repo, runId: 'run-1' });
    await fs.writeFile(path.join(path.dirname(run.artifactsDir), '.DS_Store'), '', 'utf8');
    expect(await listRunIds(repo)).toEqual(['run-1']);
  });
});
