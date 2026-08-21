/**
 * End to end: the whole path, driven the way a user drives it.
 *
 * Everything else in the suite tests one module with the others faked. This
 * file fakes nothing. It runs the real router against a real repository, the
 * real headless lane against a real `vitest` process, and reads the
 * `result.json` that lands on disk — through the real `offstage` command tree.
 *
 * Three properties it exists to hold:
 *
 * 1. `route` → `run` → `result.json` agree with each other. A decision that is
 *    not the lane that ran, or a result that does not match the file, is a bug
 *    no unit test would catch.
 * 2. The build actually emits the entry points `package.json` publishes. That
 *    can only be checked against a built tree, so it is checked here and
 *    skipped (loudly) when `dist/` is absent.
 * 3. Nothing appears on the screen. The headless lane's own suite proves that
 *    for its own calls; this proves it for the path a user takes.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import type { LaneResult } from '../src/contract/index.js';
import { readResult } from '../src/contract/artifacts.js';
import { main } from '../src/cli/index.js';
import type { CliIo } from '../src/cli/index.js';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'headless');

/**
 * vitest by absolute path rather than `npx vitest`: the staged fixture is a
 * bare directory in /tmp, and `npx` would try to fetch the package rather than
 * resolve it. The router classifies this argv exactly as it classifies the
 * `npx` form — `tests/router.classify.test.ts` covers both spellings.
 */
const vitestCommand = (): string[] => [
  process.execPath,
  path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
  'run',
];

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * Copy a fixture repository into a disposable directory outside the repository.
 *
 * Two constraints pull against each other here, and getting them wrong makes
 * this file flaky rather than wrong-looking:
 *
 * 1. The fixtures import `vitest/config`, which node resolves by walking parent
 *    directories to a `node_modules`. Under `os.tmpdir()` there is nothing to
 *    walk up to, and the fixture fails to load its own config before offstage
 *    is involved at all. So the repository's `node_modules` is symlinked in.
 * 2. Staging *inside* the repository fixes (1) for free — and races with the
 *    outer vitest run, which owns that tree. A staged copy would occasionally
 *    be gone by the time the inner vitest read its own config file, failing
 *    this test for a reason that has nothing to do with offstage.
 *
 * The fixture's own `node_modules` (a stale vitest result cache) is excluded
 * from the copy, both so the symlink can be created and so no run inherits
 * another run's cache.
 */
async function stageFixture(name: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-e2e-')));
  temps.push(dir);
  await fs.cp(path.join(FIXTURES, name), dir, {
    recursive: true,
    filter: (source) => path.basename(source) !== 'node_modules',
  });
  await fs.symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  return dir;
}

interface Captured {
  code: number;
  out: string;
  err: string;
}

/**
 * Everything worth knowing about a run, as one string.
 *
 * An end-to-end test that fails with "expected 1 to be 0" is nearly useless:
 * the interesting evidence — what the command actually printed — is sitting in
 * `command.log` in a directory this file deletes on the way out. So it is read
 * back and attached to the assertion instead.
 */
async function describeRun(result: LaneResult, captured: Captured): Promise<string> {
  let log = '(no log)';
  if (result.logPath !== null) {
    log = await fs.readFile(result.logPath, 'utf8').catch((error: Error) => `(unreadable: ${error.message})`);
  }
  return [
    `exit=${captured.code} status=${result.status} exitCode=${String(result.exitCode)}`,
    `diagnostics:\n  ${result.diagnostics.join('\n  ')}`,
    `command.log:\n${log.split('\n').slice(-40).join('\n')}`,
  ].join('\n');
}

/** The real CLI, real lanes, real router — only the output streams are captured. */
async function cli(argv: string[], cwd: string): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    cwd: () => cwd,
    env: { ...process.env },
  };
  const code = await main(argv, io);
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('route → run → result.json, for real', () => {
  it('routes a passing vitest fixture to headless, runs it in place, and writes the envelope', async () => {
    const cwd = await stageFixture('vitest-pass');

    const routed = await cli(['route', '--json', '--', ...vitestCommand()], cwd);
    expect(routed.code).toBe(0);
    const decision = JSON.parse(routed.out) as { lane: string; confidence: string };
    expect(decision.lane).toBe('headless');

    const ran = await cli(['run', '--json', '--', ...vitestCommand()], cwd);
    const result = JSON.parse(ran.out) as LaneResult;

    // The lane that ran is the lane route promised.
    expect(result.lane).toBe(decision.lane);
    expect(result.status, await describeRun(result, ran)).toBe('passed');
    expect(result.exitCode).toBe(0);
    expect(ran.code).toBe(0);

    // …and the file on disk is that same envelope, revalidated on the way in.
    const persisted = await readResult(result.artifactsDir);
    expect(persisted).toEqual(result);

    // The run directory is where the contract says it is, and self-contained.
    const relative = path.relative(cwd, result.artifactsDir);
    expect(relative.startsWith(path.join('.offstage', 'runs'))).toBe(true);
    expect(result.logPath?.startsWith(result.artifactsDir)).toBe(true);

    const log = await fs.readFile(result.logPath as string, 'utf8');
    expect(log).toContain('sum.test.mjs');

    // The lane says out loud that nothing was isolated and nothing appeared.
    expect(result.diagnostics.join('\n')).toContain('No isolation was applied');
    expect(result.diagnostics.join('\n')).toMatch(/Nothing appeared on your screen/);
  });

  it('reports a red test suite as failed — not errored — with the failure parsed out', async () => {
    const cwd = await stageFixture('vitest-fail');

    const ran = await cli(['run', '--json', '--', ...vitestCommand()], cwd);
    const result = JSON.parse(ran.out) as LaneResult;

    // `failed` means the command ran and something was red. An agent must be
    // able to tell that from `errored`, which means "retry might help".
    expect(result.status).toBe('failed');
    expect(ran.code).not.toBe(0);
    expect(ran.code).not.toBe(70);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0]?.file).toBe('sum.test.mjs');
    expect(result.failures.some((failure) => /deliberately red/.test(failure.test ?? ''))).toBe(true);
  });

  it('gives every run its own directory, so concurrent runs cannot collide', async () => {
    const cwd = await stageFixture('vitest-pass');

    const [first, second] = await Promise.all([
      cli(['run', '--json', '--', 'node', '-e', 'process.exit(0)'], cwd),
      cli(['run', '--json', '--', 'node', '-e', 'process.exit(0)'], cwd),
    ]);

    const a = JSON.parse(first.out) as LaneResult;
    const b = JSON.parse(second.out) as LaneResult;
    expect(a.artifactsDir).not.toBe(b.artifactsDir);

    const runs = await fs.readdir(path.join(cwd, '.offstage', 'runs'));
    expect(runs).toHaveLength(2);
    // Run ids are timestamp-prefixed, so the directory listing is chronological.
    expect([...runs].sort()).toEqual(runs.sort());
  });

  it('refuses to run macOS-native work in place, even when asked directly', async () => {
    const cwd = await stageFixture('vitest-pass');

    const ran = await cli(['run', '--json', '--lane', 'headless', '--', 'xcodebuild', 'test'], cwd);
    const result = JSON.parse(ran.out) as LaneResult;

    expect(result.status).toBe('errored');
    expect(ran.code).toBe(70);
    expect(result.diagnostics[0]).toContain('Nothing was executed');
    // No xcodebuild was spawned, so there is nothing in the log — there is no log.
    expect(result.logPath).toBeNull();
  });

  it('skips rather than falls back when the macOS lane is unavailable on this machine', async () => {
    const cwd = await stageFixture('vitest-pass');

    // xcodebuild opens windows but changes nothing about the machine, so it
    // routes to the session lane — the second logged-in account — not to a VM.
    const ran = await cli(['run', '--json', '--', 'xcodebuild', 'test', '-scheme', 'App'], cwd);
    const result = JSON.parse(ran.out) as LaneResult;

    // On a machine with the helper session set up this legitimately tries to
    // run; anywhere else the only acceptable outcome is a skip that says so.
    if (result.status === 'skipped') {
      expect(ran.code).toBe(69);
      expect(result.diagnostics.join(' ')).toContain('nothing was executed');
      expect(result.diagnostics.join(' ')).toMatch(/Fix:/);
    }
    // Whatever happened, it did not happen in the headless lane.
    expect(result.lane).toBe('session');
  });

  it('refuses work that could change the machine, on every lane, with no --lane override', async () => {
    const cwd = await stageFixture('vitest-pass');

    // The split the session lane rests on: session isolation is not machine
    // isolation, and offstage has no lane that is, so an installer is refused
    // outright rather than sent anywhere.
    const ran = await cli(['run', '--json', '--', 'hdiutil', 'attach', 'App.dmg'], cwd);
    const result = JSON.parse(ran.out) as LaneResult;

    expect(result.status).toBe('errored');
    expect(ran.code).toBe(70);
    expect(result.diagnostics[0]).toContain('Refused:');
    expect(result.diagnostics.join(' ')).toContain('Nothing was executed, on any lane');
    // No hdiutil was spawned, so there is nothing in the log: there is no log.
    expect(result.logPath).toBeNull();
  });
});

describe('the built package', () => {
  it('emits every entry point package.json publishes, runnable as a real process', async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
    };
    const cliPath = path.join(ROOT, pkg.bin.offstage as string);

    let built = true;
    try {
      await fs.access(cliPath);
    } catch {
      built = false;
    }
    if (!built) {
      // `npm test` on a clean clone runs before `npm run build`. Say why this
      // was not checked rather than passing silently.
      console.warn(`[e2e] skipped: ${pkg.bin.offstage} is not built. Run \`npm run build\` first.`);
      return;
    }

    for (const relative of Object.values(pkg.bin)) {
      await expect(fs.access(path.join(ROOT, relative))).resolves.toBeUndefined();
    }

    // Spawned through a SYMLINK, the way npm installs a bin. This is not
    // pedantry: `node_modules/.bin/offstage` is a symlink, so `process.argv[1]`
    // is the link while `import.meta.url` is the real file. When the entry
    // point check compared them without resolving, every installed copy of
    // offstage exited 0 having printed nothing — while running perfectly from
    // a clone, which is why nothing else here caught it.
    const linkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-bin-'));
    temps.push(linkDir);
    const link = path.join(linkDir, 'offstage');
    await fs.symlink(cliPath, link);

    const viaLink = await execFileAsync(process.execPath, [link, 'route', '--json', '--', 'npx', 'playwright', 'test', '--headed'], { cwd: ROOT });
    expect(viaLink.stdout.trim(), 'the CLI printed nothing when invoked through a symlink').not.toBe('');
    expect((JSON.parse(viaLink.stdout) as { lane: string }).lane).toBe('container');

    // Spawned as a real process, through the real shebang path, against the
    // real repo — the closest thing to what a user types.
    const { stdout } = await execFileAsync(process.execPath, [cliPath, 'route', '--json', '--', 'npx', 'vitest', 'run'], {
      cwd: ROOT,
    });
    expect((JSON.parse(stdout) as { lane: string }).lane).toBe('headless');
  }, 60_000);
});
