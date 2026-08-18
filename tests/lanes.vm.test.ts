/**
 * VM lane tests.
 *
 * Every one of these runs green on a machine with **no Tart, no tart-runner
 * plugin, and no VM** — which is the machine this lane was written on. That is
 * a deliberate constraint, not a compromise: the not-installed path is the one
 * most users hit first, and the parser is exercised against recorded results
 * directories under `tests/fixtures/vm/` rather than against a live guest.
 *
 * Nothing here spawns `tart`, `tart-runner`, or `xcrun`. The lane takes its
 * `spawn` and `exec` functions as options precisely so tests can supply
 * recorded output instead.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LaneRequest } from '../src/contract/index.js';
import { isLaneResult, parseLaneResult } from '../src/contract/index.js';

import {
  RUNNER_ENV_VAR,
  RUNNER_INSTALL_FIX,
  RUNNER_RELATIVE_PATH,
  TART_INSTALL_FIX,
  checkHost,
  discoverTart,
  discoverTartRunner,
  discoverToolchain,
  toAvailability,
} from '../src/lanes/vm/discover.js';
import {
  buildRunnerArgv,
  findExecutableIndex,
  isTestInvocation,
  isXcodebuild,
  planInvocation,
} from '../src/lanes/vm/command.js';
import {
  MAX_CONCURRENT_VMS,
  VmSlotTimeoutError,
  acquireVmSlot,
  countHeldSlots,
} from '../src/lanes/vm/slots.js';
import {
  extractXcresultFailures,
  findLogName,
  guestPathToRepoRelative,
  isXcresulttoolAvailable,
  mergeFailures,
  parseRunnerStdout,
  parseXcodebuildLog,
  parseXcresultSummary,
  parseXcresultTests,
  readExitStatus,
  translateResultsDir,
} from '../src/lanes/vm/results.js';
import type { Exec } from '../src/lanes/vm/results.js';
import type { Spawn, SpawnOutcome } from '../src/lanes/vm/index.js';
import { RUNNER_LOG, VmLane, parseDoctorOutput } from '../src/lanes/vm/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, 'fixtures', 'vm');

const results = (name: string) => path.join(FIXTURES, `results-${name}`);
const readFixture = (...segments: string[]) =>
  fs.readFile(path.join(FIXTURES, ...segments), 'utf8');
const readJsonFixture = async (...segments: string[]): Promise<unknown> =>
  JSON.parse(await readFixture(...segments));

/** A scratch directory that cleans itself up. */
let scratch: string;

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-vm-'));
});

afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

/** Build a valid LaneRequest rooted in the scratch directory. */
async function makeRequest(overrides: Partial<LaneRequest> = {}): Promise<LaneRequest> {
  const cwd = overrides.cwd ?? path.join(scratch, 'repo');
  const artifactsDir = overrides.artifactsDir ?? path.join(cwd, '.offstage', 'runs', 'test-run');
  await fs.mkdir(artifactsDir, { recursive: true });
  return {
    cwd,
    command: ['xcodebuild', '-scheme', 'SmokeApp', 'test'],
    artifactsDir,
    ...overrides,
  };
}

/** A `Spawn` that returns recorded output and records what it was called with. */
function recordedSpawn(
  outcomes: Partial<SpawnOutcome> | ((file: string, args: string[]) => Partial<SpawnOutcome>),
): Spawn & { calls: Array<{ file: string; args: string[] }> } {
  const calls: Array<{ file: string; args: string[] }> = [];
  const spawn: Spawn = async (file, args) => {
    calls.push({ file, args });
    const outcome = typeof outcomes === 'function' ? outcomes(file, args) : outcomes;
    return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...outcome };
  };
  return Object.assign(spawn, { calls });
}

/** An `Exec` that never runs anything; `xcrun` is simply reported as absent. */
const noXcrun: Exec = async () => ({ exitCode: 1, stdout: '', stderr: 'xcrun: not found' });

/* ========================================================================== */
/* discover.ts                                                                */
/* ========================================================================== */

describe('discoverTartRunner', () => {
  it('names both exact install commands when nothing is installed', async () => {
    const discovery = await discoverTartRunner({
      env: {},
      cwd: scratch,
      homeDir: path.join(scratch, 'empty-home'),
    });

    expect(discovery.found).toBe(false);
    if (discovery.found) return;

    expect(discovery.reason).toContain('not installed');
    expect(discovery.fix).toContain('claude plugin marketplace add novotnyllc/marketplace');
    expect(discovery.fix).toContain('claude plugin install tart-xcode-runner@novotnyllc');
    // The override is offered too: plenty of people have it checked out already.
    expect(discovery.fix).toContain(RUNNER_ENV_VAR);
    // It reports where it looked, so an unusual layout is debuggable.
    expect(discovery.searched.length).toBeGreaterThan(0);
  });

  it('honours the OFFSTAGE_TART_RUNNER override', async () => {
    const runner = path.join(scratch, 'checkout', RUNNER_RELATIVE_PATH);
    await fs.mkdir(path.dirname(runner), { recursive: true });
    await fs.writeFile(runner, '#!/bin/zsh\n');

    const discovery = await discoverTartRunner({
      env: { [RUNNER_ENV_VAR]: runner },
      cwd: scratch,
      homeDir: path.join(scratch, 'empty-home'),
    });

    expect(discovery).toMatchObject({ found: true, path: runner, source: 'env' });
  });

  it('treats a broken override as an error rather than falling through', async () => {
    const discovery = await discoverTartRunner({
      env: { [RUNNER_ENV_VAR]: path.join(scratch, 'nope', 'tart-runner') },
      cwd: scratch,
      homeDir: path.join(scratch, 'empty-home'),
    });

    expect(discovery.found).toBe(false);
    if (discovery.found) return;
    // Specifically about the override, not the generic "plugin missing" text:
    // someone who set this variable needs to know *it* is what is wrong.
    expect(discovery.reason).toContain(RUNNER_ENV_VAR);
    expect(discovery.reason).toContain('no tart-runner script exists there');
  });

  it('finds the plugin through installed_plugins.json', async () => {
    const home = path.join(scratch, 'home');
    const pluginRoot = path.join(
      home,
      '.claude',
      'plugins',
      'cache',
      'novotnyllc',
      'tart-xcode-runner',
      '0.4.11',
    );
    const runner = path.join(pluginRoot, RUNNER_RELATIVE_PATH);
    await fs.mkdir(path.dirname(runner), { recursive: true });
    await fs.writeFile(runner, '#!/bin/zsh\n');
    await fs.writeFile(
      path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'tart-xcode-runner@novotnyllc': [{ scope: 'user', installPath: pluginRoot }],
        },
      }),
    );

    const discovery = await discoverTartRunner({ env: {}, cwd: scratch, homeDir: home });
    expect(discovery).toMatchObject({ found: true, path: runner, source: 'claude-plugin-manifest' });
  });

  it('falls back to scanning the plugin cache when the manifest is unusable', async () => {
    const home = path.join(scratch, 'home');
    const runner = path.join(
      home,
      '.claude',
      'plugins',
      'cache',
      'novotnyllc',
      'tart-xcode-runner',
      '0.4.11',
      RUNNER_RELATIVE_PATH,
    );
    await fs.mkdir(path.dirname(runner), { recursive: true });
    await fs.writeFile(runner, '#!/bin/zsh\n');
    await fs.writeFile(
      path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      '{ this is not json',
    );

    const discovery = await discoverTartRunner({ env: {}, cwd: scratch, homeDir: home });
    expect(discovery).toMatchObject({ found: true, source: 'claude-plugin-cache' });
  });

  it('finds a Codex-installed plugin too', async () => {
    const home = path.join(scratch, 'home');
    const runner = path.join(
      home,
      '.codex',
      'plugins',
      'cache',
      'novotnyllc',
      'tart-xcode-runner',
      RUNNER_RELATIVE_PATH,
    );
    await fs.mkdir(path.dirname(runner), { recursive: true });
    await fs.writeFile(runner, '#!/bin/zsh\n');

    const discovery = await discoverTartRunner({ env: {}, cwd: scratch, homeDir: home });
    expect(discovery).toMatchObject({ found: true, source: 'codex-plugin-cache' });
  });

  it('reads a configured path from .offstage/config.json', async () => {
    const home = path.join(scratch, 'empty-home');
    const runner = path.join(scratch, 'vendor', 'tart-runner');
    await fs.mkdir(path.dirname(runner), { recursive: true });
    await fs.writeFile(runner, '#!/bin/zsh\n');
    await fs.mkdir(path.join(scratch, '.offstage'), { recursive: true });
    await fs.writeFile(
      path.join(scratch, '.offstage', 'config.json'),
      JSON.stringify({ tartRunner: 'vendor/tart-runner' }),
    );

    const discovery = await discoverTartRunner({ env: {}, cwd: scratch, homeDir: home });
    expect(discovery).toMatchObject({ found: true, path: runner, source: 'config-file' });
  });
});

describe('discoverTart', () => {
  it('reports the exact brew command when tart is missing', async () => {
    const discovery = await discoverTart({ env: { PATH: path.join(scratch, 'empty-bin') } });

    expect(discovery.found).toBe(false);
    if (discovery.found) return;
    expect(discovery.reason).toContain('Tart is not installed');
    // Verified against the runner's own need_tart message, not from memory.
    expect(discovery.fix).toContain('brew tap openai/tools');
    expect(discovery.fix).toContain('brew install openai/tools/tart');
  });

  it('finds tart on PATH without spawning it', async () => {
    const bin = path.join(scratch, 'bin');
    await fs.mkdir(bin, { recursive: true });
    // Deliberately not executable: discovery must stat, never run.
    await fs.writeFile(path.join(bin, 'tart'), 'not actually a binary');

    const discovery = await discoverTart({ env: { PATH: bin } });
    expect(discovery).toMatchObject({ found: true, path: path.join(bin, 'tart'), source: 'path' });
  });
});

describe('checkHost', () => {
  it('rejects non-macOS hosts without offering an install command', () => {
    const problem = checkHost({ platform: 'linux', arch: 'x64' });
    expect(problem?.reason).toContain('needs macOS');
    expect(problem?.fix).not.toContain('brew install');
  });

  it('rejects Intel Macs, naming Virtualization.framework as the reason', () => {
    const problem = checkHost({ platform: 'darwin', arch: 'x64' });
    expect(problem?.reason).toContain('Apple Silicon');
    expect(problem?.fix).toContain('Virtualization.framework');
  });

  it('passes an Apple Silicon Mac through', () => {
    expect(checkHost({ platform: 'darwin', arch: 'arm64' })).toBeNull();
  });
});

describe('discoverToolchain', () => {
  it('collects both problems at once so the user fixes them in one pass', async () => {
    const toolchain = await discoverToolchain({
      env: { PATH: path.join(scratch, 'empty-bin') },
      cwd: scratch,
      homeDir: path.join(scratch, 'empty-home'),
      platform: 'darwin',
      arch: 'arm64',
    });

    expect(toolchain.tart).toBeNull();
    expect(toolchain.runner).toBeNull();
    expect(toolchain.problems).toHaveLength(2);

    const availability = toAvailability(toolchain);
    expect(availability.available).toBe(false);
    expect(availability.fix).toContain(TART_INSTALL_FIX);
    expect(availability.fix).toContain(RUNNER_INSTALL_FIX);
  });

  it('does not probe for tools on a host that could never run them', async () => {
    const toolchain = await discoverToolchain({ platform: 'linux', arch: 'x64' });
    expect(toolchain.problems).toHaveLength(1);
    expect(toolchain.problems[0]?.reason).toContain('needs macOS');
  });
});

/* ========================================================================== */
/* command.ts                                                                 */
/* ========================================================================== */

describe('planInvocation', () => {
  it('routes an xcodebuild test run to xcui-test and strips the executable', () => {
    const plan = planInvocation(['xcodebuild', '-scheme', 'SmokeAppUITests', 'test']);
    expect(plan.subcommand).toBe('xcui-test');
    // run-xcode.sh supplies /usr/bin/xcodebuild itself; leaving ours in would
    // produce `xcodebuild xcodebuild …`.
    expect(plan.args).toEqual(['-scheme', 'SmokeAppUITests', 'test']);
  });

  it.each([
    ['test'],
    ['test-without-building'],
    ['build-for-testing'],
  ])('treats the %s action as a test invocation', (action) => {
    expect(planInvocation(['xcodebuild', '-scheme', 'App', action]).subcommand).toBe('xcui-test');
  });

  it.each([
    ['-only-testing:AppUITests/LoginTests'],
    ['-skip-testing:AppUITests/SlowTests'],
    ['-testPlan'],
  ])('treats %s as a test invocation even without a test action', (flag) => {
    expect(isTestInvocation([flag])).toBe(true);
  });

  it('routes a plain build to build', () => {
    const plan = planInvocation(['xcodebuild', '-scheme', 'SmokeApp', 'build']);
    expect(plan.subcommand).toBe('build');
    expect(plan.args).toEqual(['-scheme', 'SmokeApp', 'build']);
  });

  it('supplies a build action when bare xcodebuild is asked for', () => {
    // The runner dies on an empty argument list, so an action is substituted.
    expect(planInvocation(['xcodebuild']).args).toEqual(['build']);
  });

  it('peels wrappers off before deciding', () => {
    expect(isXcodebuild(['xcrun', 'xcodebuild', 'test'])).toBe(true);
    expect(isXcodebuild(['env', 'FOO=1', '/usr/bin/xcodebuild', 'build'])).toBe(true);
    expect(findExecutableIndex(['env', 'FOO=1', 'xcrun', 'xcodebuild'])).toBe(3);
    expect(planInvocation(['xcrun', 'xcodebuild', '-scheme', 'A', 'test']).args).toEqual([
      '-scheme',
      'A',
      'test',
    ]);
  });

  it('sends a launched .app to run, verbatim', () => {
    const command = ['./build/Debug/SmokeApp.app/Contents/MacOS/SmokeApp', '--smoke'];
    const plan = planInvocation(command);
    expect(plan.subcommand).toBe('run');
    expect(plan.args).toEqual(command);
  });

  it('sends simctl to run, not xcui-test', () => {
    // `xcui-test` would rewrite this into `xcodebuild simctl boot …`, which is
    // not a command. Simulator-shaped is not the same as xcodebuild-shaped.
    const plan = planInvocation(['xcrun', 'simctl', 'boot', 'iPhone 16']);
    expect(plan.subcommand).toBe('run');
    expect(plan.args).toEqual(['xcrun', 'simctl', 'boot', 'iPhone 16']);
  });

  it('sends non-Xcode test runners to run', () => {
    expect(planInvocation(['swift', 'test']).subcommand).toBe('run');
    expect(planInvocation(['npm', 'run', 'test:mac']).subcommand).toBe('run');
  });

  it('explains its choice in a sentence a human can read', () => {
    expect(planInvocation(['xcodebuild', 'test']).reason).toMatch(/xcui-test/);
    expect(planInvocation(['swift', 'test']).reason).toMatch(/not an xcodebuild invocation/);
  });
});

describe('buildRunnerArgv', () => {
  it('passes --repo and separates arguments with --', () => {
    const argv = buildRunnerArgv({
      runnerPath: '/plugins/tart-runner',
      cwd: '/repo',
      invocation: planInvocation(['xcodebuild', '-scheme', 'A', 'test']),
    });
    expect(argv).toEqual([
      '/plugins/tart-runner',
      'xcui-test',
      '--repo',
      '/repo',
      '--',
      '-scheme',
      'A',
      'test',
    ]);
  });

  it('passes --repo for plain runs too, so the checkout reaches the guest', () => {
    const argv = buildRunnerArgv({
      runnerPath: '/plugins/tart-runner',
      cwd: '/repo',
      invocation: planInvocation(['./App.app/Contents/MacOS/App']),
    });
    expect(argv.slice(1, 5)).toEqual(['run', '--repo', '/repo', '--']);
  });
});

/* ========================================================================== */
/* results.ts — reading the runner's output                                   */
/* ========================================================================== */

describe('parseRunnerStdout', () => {
  it('extracts the results directory and the xcresult path', async () => {
    const stdout = await readFixture('runner-stdout', 'xcui-test.txt');
    const parsed = parseRunnerStdout(stdout);

    expect(parsed.resultsDir).toBe(
      '/Users/viraat/Library/Application Support/Tart Xcode Runner/results/20260817T181500Z-48213',
    );
    expect(parsed.xcresultPath).toContain('Result.xcresult');
  });

  it('returns null when the runner refused before starting a run', async () => {
    const stdout = await readFixture('runner-stdout', 'no-base-image.txt');
    expect(parseRunnerStdout(stdout).resultsDir).toBeNull();
  });

  it('takes the last results line when output contains more than one', () => {
    const parsed = parseRunnerStdout('results: /a/one\nnoise\nresults: /a/two\n');
    expect(parsed.resultsDir).toBe('/a/two');
  });
});

describe('readExitStatus and findLogName', () => {
  it('prefers the guest-written status over the host-written one', async () => {
    const dir = path.join(scratch, 'results');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'guest-exit-status'), '65\n');
    await fs.writeFile(path.join(dir, 'exit-status'), '1\n');
    // tart exec does not reliably propagate the guest status, which is exactly
    // why the guest writes its own. It is the authority on the user's command.
    expect(await readExitStatus(dir)).toBe(65);
  });

  it('falls back to the host status when the guest never wrote one', async () => {
    const dir = path.join(scratch, 'results');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'exit-status'), '70\n');
    expect(await readExitStatus(dir)).toBe(70);
  });

  it('returns null when neither survived, rather than guessing zero', async () => {
    expect(await readExitStatus(results('interrupted'))).toBeNull();
  });

  it('identifies which log the runner wrote', async () => {
    expect(await findLogName(results('xcui-test-failed'))).toBe('xcodebuild.log');
    expect(await findLogName(results('run-command'))).toBe('command.log');
    expect(await findLogName(path.join(scratch, 'nothing-here'))).toBeNull();
  });
});

/* ========================================================================== */
/* results.ts — guest paths                                                   */
/* ========================================================================== */

describe('guestPathToRepoRelative', () => {
  it('strips the guest checkout prefix run-xcode.sh creates', () => {
    // $HOME/tart-runner/<run-id>/src is where the rsync lands inside the VM.
    const guest =
      '/Users/admin/tart-runner/20260817T181500Z-48213/src/SmokeAppUITests/LoginUITests.swift';
    expect(guestPathToRepoRelative(guest, '/anywhere')).toBe(
      'SmokeAppUITests/LoginUITests.swift',
    );
  });

  it('works for any guest user and run id', () => {
    expect(
      guestPathToRepoRelative('/var/root/tart-runner/abc-1/src/Sources/App/Main.swift', '/repo'),
    ).toBe('Sources/App/Main.swift');
  });

  it('makes a host path relative to the repository', () => {
    expect(guestPathToRepoRelative('/repo/src/App.swift', '/repo')).toBe('src/App.swift');
  });

  it('returns null rather than inventing a path it cannot resolve', () => {
    // The contract would rather have no `file` than a wrong one, and a bare
    // basename is not reliably repository-root-relative.
    expect(guestPathToRepoRelative('LoginUITests.swift', '/repo')).toBeNull();
    expect(guestPathToRepoRelative('/opt/homebrew/lib/thing.swift', '/repo')).toBeNull();
    expect(guestPathToRepoRelative('   ', '/repo')).toBeNull();
  });
});

/* ========================================================================== */
/* results.ts — xcodebuild.log                                                */
/* ========================================================================== */

describe('parseXcodebuildLog', () => {
  it('extracts XCTest failures with repository-relative paths', async () => {
    const log = await readFixture('results-xcui-test-failed', 'xcodebuild.log');
    const parsed = parseXcodebuildLog(log, '/repo');

    const login = parsed.failures.find((failure) =>
      failure.test?.includes('testSignInWithValidCredentials'),
    );
    expect(login).toBeDefined();
    expect(login?.test).toBe('LoginUITests.testSignInWithValidCredentials');
    expect(login?.file).toBe('SmokeAppUITests/LoginUITests.swift');
    expect(login?.line).toBe(42);
    expect(login?.message).toContain('XCTAssertTrue failed');
  });

  it('handles the Swift-style test name form as well as the ObjC selector form', async () => {
    const log = await readFixture('results-xcui-test-failed', 'xcodebuild.log');
    const parsed = parseXcodebuildLog(log, '/repo');

    const parser = parsed.failures.find((failure) => failure.test?.includes('testTrimsWhitespace'));
    expect(parser?.test).toBe('ParserTests.testTrimsWhitespace()');
    expect(parser?.file).toBe('SmokeAppTests/ParserTests.swift');
    expect(parser?.line).toBe(88);
  });

  it('records the ** TEST FAILED ** banner', async () => {
    const log = await readFixture('results-xcui-test-failed', 'xcodebuild.log');
    expect(parseXcodebuildLog(log, '/repo').banners).toContain('TEST FAILED');
  });

  it('extracts compiler errors, which no test bundle would ever describe', async () => {
    const log = await readFixture('results-build-failed', 'xcodebuild.log');
    const parsed = parseXcodebuildLog(log, '/repo');

    const compile = parsed.failures.find((failure) =>
      failure.message.includes("cannot find 'viewMdoel' in scope"),
    );
    expect(compile?.file).toBe('SmokeApp/ContentView.swift');
    expect(compile?.line).toBe(17);
    expect(compile?.test).toBeUndefined();
  });

  it('keeps file-less linker errors', async () => {
    const log = await readFixture('results-build-failed', 'xcodebuild.log');
    const parsed = parseXcodebuildLog(log, '/repo');

    const linker = parsed.failures.find((failure) => failure.message.startsWith('ld:'));
    expect(linker).toBeDefined();
    expect(linker?.file).toBeUndefined();
  });

  it('ignores warnings', async () => {
    const log = await readFixture('results-build-failed', 'xcodebuild.log');
    const parsed = parseXcodebuildLog(log, '/repo');
    expect(parsed.failures.some((failure) => failure.message.includes('never mutated'))).toBe(false);
  });

  it('produces only contract-valid failure paths', async () => {
    const log = await readFixture('results-xcui-test-failed', 'xcodebuild.log');
    for (const failure of parseXcodebuildLog(log, '/repo').failures) {
      if (failure.file === undefined) continue;
      expect(path.isAbsolute(failure.file)).toBe(false);
      expect(failure.file.split('/')).not.toContain('..');
      expect(failure.file).not.toContain('\\');
    }
  });

  it('finds nothing to report in a clean build', async () => {
    const log = await readFixture('results-build-passed', 'xcodebuild.log');
    const parsed = parseXcodebuildLog(log, '/repo');
    expect(parsed.failures).toEqual([]);
    expect(parsed.banners).toContain('BUILD SUCCEEDED');
  });

  it('deduplicates identical failures repeated across the log', () => {
    const line =
      '/Users/admin/tart-runner/r1/src/A.swift:3: error: -[T t] : XCTAssertTrue failed\n';
    expect(parseXcodebuildLog(line.repeat(4), '/repo').failures).toHaveLength(1);
  });
});

/* ========================================================================== */
/* results.ts — Result.xcresult                                               */
/* ========================================================================== */

describe('parseXcresultTests', () => {
  it('extracts failing test cases from the testNodes tree', async () => {
    const failures = parseXcresultTests(await readJsonFixture('xcresulttool', 'tests.json'));

    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({
      test: 'LoginUITests/testSignInWithValidCredentials()',
      line: 42,
    });
    expect(failures[0]?.message).toContain('XCTAssertTrue failed');
    expect(failures[1]?.test).toBe('ParserTests/testTrimsWhitespace()');
  });

  it('ignores passed and skipped cases', async () => {
    const failures = parseXcresultTests(await readJsonFixture('xcresulttool', 'tests.json'));
    expect(failures.some((failure) => failure.test?.includes('testSignOut'))).toBe(false);
    expect(failures.some((failure) => failure.test?.includes('testSkipsOnLinux'))).toBe(false);
  });

  it('returns nothing for an all-green run', async () => {
    expect(parseXcresultTests(await readJsonFixture('xcresulttool', 'tests-passed.json'))).toEqual(
      [],
    );
  });

  it('walks past Repetition and Device layers to reach the failure', async () => {
    // Test plans with repetitions or multiple destinations insert extra levels
    // between Test Case and Failure Message; the walk must not assume a depth.
    const failures = parseXcresultTests(await readJsonFixture('xcresulttool', 'tests-nested.json'));
    const scroll = failures.find((failure) => failure.test?.includes('testScrollsToBottom'));
    expect(scroll?.message).toContain('is not equal to');
  });

  it('reads the line number from a Source Code Reference, converting to 1-based', async () => {
    const failures = parseXcresultTests(await readJsonFixture('xcresulttool', 'tests-nested.json'));
    const scroll = failures.find((failure) => failure.test?.includes('testScrollsToBottom'));
    // The URL says StartingLineNumber=56, which Xcode counts from zero.
    expect(scroll?.line).toBe(57);
  });

  it('still reports a failing case that produced no message', async () => {
    const failures = parseXcresultTests(await readJsonFixture('xcresulttool', 'tests-nested.json'));
    const silent = failures.find((failure) => failure.test?.includes('testSilentlyDies'));
    expect(silent?.message).toContain('exited unexpectedly');
  });

  it('never emits a file path it cannot prove is repo-relative', async () => {
    // Failure Message names carry a bare basename ("LoginUITests.swift:42"),
    // which says nothing about where the file sits in the repository.
    const failures = parseXcresultTests(await readJsonFixture('xcresulttool', 'tests.json'));
    for (const failure of failures) expect(failure.file).toBeUndefined();
    // The basename is not lost, though — it stays in the message.
    expect(failures[0]?.message).toContain('LoginUITests.swift');
  });

  it('tolerates junk without throwing', () => {
    expect(parseXcresultTests(null)).toEqual([]);
    expect(parseXcresultTests({})).toEqual([]);
    expect(parseXcresultTests({ testNodes: 'not an array' })).toEqual([]);
    expect(parseXcresultTests({ testNodes: [{}] })).toEqual([]);
  });
});

describe('parseXcresultSummary', () => {
  it('extracts failures from the flatter summary shape', async () => {
    const failures = parseXcresultSummary(await readJsonFixture('xcresulttool', 'summary.json'));
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({
      test: 'LoginUITests/testSignInWithValidCredentials()',
    });
    expect(failures[0]?.message).toContain('Expected the dashboard');
  });

  it('tolerates junk without throwing', () => {
    expect(parseXcresultSummary(null)).toEqual([]);
    expect(parseXcresultSummary({ testFailures: 'nope' })).toEqual([]);
  });
});

describe('mergeFailures', () => {
  it('gives xcresult failures the file and line only the log knows', () => {
    const merged = mergeFailures(
      [{ test: 'LoginUITests/testSignIn()', message: 'XCTAssertTrue failed' }],
      [
        {
          test: 'LoginUITests.testSignIn',
          message: 'XCTAssertTrue failed',
          file: 'UITests/LoginUITests.swift',
          line: 42,
        },
      ],
    );

    expect(merged).toHaveLength(1);
    // The two naming conventions — ObjC selector and Swift signature — refer to
    // the same test and must be matched across the two sources.
    expect(merged[0]).toMatchObject({
      test: 'LoginUITests/testSignIn()',
      file: 'UITests/LoginUITests.swift',
      line: 42,
    });
  });

  it('keeps log-only failures that no test bundle describes', () => {
    const merged = mergeFailures(
      [{ test: 'A/b()', message: 'assert' }],
      [{ message: 'ld: symbol(s) not found for architecture arm64' }],
    );
    expect(merged).toHaveLength(2);
    expect(merged[1]?.message).toContain('ld:');
  });

  it('falls back entirely to the log when the bundle yielded nothing', () => {
    const logFailures = [{ message: 'boom', file: 'a.swift', line: 1 }];
    expect(mergeFailures([], logFailures)).toBe(logFailures);
  });
});

describe('extractXcresultFailures', () => {
  it('degrades to log-only with an explanation when xcrun is absent', async () => {
    const extraction = await extractXcresultFailures('/tmp/Result.xcresult', noXcrun);

    expect(extraction.failures).toEqual([]);
    // Silence would look like "no failures". Saying why is the whole point.
    expect(extraction.diagnostics.join(' ')).toContain('xcrun xcresulttool is not available');
    expect(extraction.diagnostics.join(' ')).toContain('Install Xcode');
  });

  it('parses the tree command when xcrun is present', async () => {
    const treeJson = await readFixture('xcresulttool', 'tests.json');
    const exec: Exec = async (_file, args) => {
      if (args[0] === '--find') return { exitCode: 0, stdout: '/usr/bin/xcresulttool', stderr: '' };
      if (args.includes('tests')) return { exitCode: 0, stdout: treeJson, stderr: '' };
      return { exitCode: 1, stdout: '', stderr: 'unexpected' };
    };

    const extraction = await extractXcresultFailures('/tmp/Result.xcresult', exec);
    expect(extraction.failures).toHaveLength(2);
    expect(extraction.diagnostics).toEqual([]);
  });

  it('falls back to the summary command when the tree command fails', async () => {
    const summaryJson = await readFixture('xcresulttool', 'summary.json');
    const exec: Exec = async (_file, args) => {
      if (args[0] === '--find') return { exitCode: 0, stdout: '/usr/bin/xcresulttool', stderr: '' };
      if (args.includes('tests')) {
        return { exitCode: 1, stdout: '', stderr: 'Error: unsupported schema version' };
      }
      return { exitCode: 0, stdout: summaryJson, stderr: '' };
    };

    const extraction = await extractXcresultFailures('/tmp/Result.xcresult', exec);
    expect(extraction.failures).toHaveLength(2);
    expect(extraction.diagnostics.join(' ')).toContain('unsupported schema version');
  });

  it('does not throw when xcrun emits unparseable JSON', async () => {
    const exec: Exec = async (_file, args) => {
      if (args[0] === '--find') return { exitCode: 0, stdout: '/usr/bin/xcresulttool', stderr: '' };
      return { exitCode: 0, stdout: '<not json at all>', stderr: '' };
    };

    const extraction = await extractXcresultFailures('/tmp/Result.xcresult', exec);
    expect(extraction.failures).toEqual([]);
    expect(extraction.diagnostics.join(' ')).toContain('unparseable JSON');
  });

  it('does not throw when the spawn itself explodes', async () => {
    const exec: Exec = async () => {
      throw new Error('EACCES');
    };
    await expect(extractXcresultFailures('/tmp/Result.xcresult', exec)).resolves.toMatchObject({
      failures: [],
    });
  });

  it('reports xcrun as unavailable when the probe fails', async () => {
    expect(await isXcresulttoolAvailable(noXcrun)).toBe(false);
    const throwing: Exec = async () => {
      throw new Error('nope');
    };
    expect(await isXcresulttoolAvailable(throwing)).toBe(false);
  });
});

/* ========================================================================== */
/* results.ts — the whole translation                                         */
/* ========================================================================== */

describe('translateResultsDir', () => {
  it('ingests a failing test run into a contract-valid shape', async () => {
    const artifactsDir = path.join(scratch, 'run');
    const translated = await translateResultsDir({
      resultsDir: results('xcui-test-failed'),
      artifactsDir,
      cwd: '/repo',
      exec: noXcrun,
    });

    expect(translated.exitCode).toBe(65);
    // The runner writes into its own data home, which `tart-runner clean` will
    // eventually delete — so the log has to be copied in, not pointed at.
    expect(translated.logPath).toBe(path.join(artifactsDir, 'xcodebuild.log'));
    await expect(fs.readFile(translated.logPath!, 'utf8')).resolves.toContain('TEST FAILED');

    const kinds = translated.artifacts.map((artifact) => artifact.kind);
    expect(kinds).toContain('log');
    expect(kinds).toContain('xcresult');

    const bundle = translated.artifacts.find((artifact) => artifact.kind === 'xcresult');
    await expect(fs.stat(bundle!.path)).resolves.toBeTruthy();

    expect(translated.failures.length).toBeGreaterThanOrEqual(2);
  });

  it('produces a result the contract schema accepts', async () => {
    const artifactsDir = path.join(scratch, 'run');
    const translated = await translateResultsDir({
      resultsDir: results('xcui-test-failed'),
      artifactsDir,
      cwd: '/repo',
      exec: noXcrun,
    });

    const result = parseLaneResult({
      lane: 'vm',
      status: 'failed',
      exitCode: translated.exitCode,
      startedAt: new Date().toISOString(),
      durationMs: 1000,
      artifactsDir,
      logPath: translated.logPath,
      artifacts: translated.artifacts,
      failures: translated.failures,
      diagnostics: translated.diagnostics,
    });
    expect(result.lane).toBe('vm');
  });

  it('handles a clean build', async () => {
    const translated = await translateResultsDir({
      resultsDir: results('build-passed'),
      artifactsDir: path.join(scratch, 'run'),
      cwd: '/repo',
      exec: noXcrun,
    });

    expect(translated.exitCode).toBe(0);
    expect(translated.failures).toEqual([]);
  });

  it('handles a plain `run` with a command.log and no bundle', async () => {
    const artifactsDir = path.join(scratch, 'run');
    const translated = await translateResultsDir({
      resultsDir: results('run-command'),
      artifactsDir,
      cwd: '/repo',
      exec: noXcrun,
    });

    expect(translated.exitCode).toBe(0);
    expect(translated.logPath).toBe(path.join(artifactsDir, 'command.log'));
    expect(translated.artifacts.some((artifact) => artifact.kind === 'xcresult')).toBe(false);
  });

  it('reports a missing exit status rather than assuming success', async () => {
    const translated = await translateResultsDir({
      resultsDir: results('interrupted'),
      artifactsDir: path.join(scratch, 'run'),
      cwd: '/repo',
      exec: noXcrun,
    });

    expect(translated.exitCode).toBeNull();
    expect(translated.diagnostics.join(' ')).toContain('never reported an exit code');
  });

  it('attaches a log tail when a red run yielded no parseable failure', async () => {
    const resultsDir = path.join(scratch, 'opaque');
    await fs.mkdir(resultsDir, { recursive: true });
    await fs.writeFile(path.join(resultsDir, 'command.log'), 'something went wrong, opaquely\n');
    await fs.writeFile(path.join(resultsDir, 'guest-exit-status'), '3\n');

    const translated = await translateResultsDir({
      resultsDir,
      artifactsDir: path.join(scratch, 'run'),
      cwd: '/repo',
      exec: noXcrun,
    });

    expect(translated.failures).toEqual([]);
    // Otherwise the user gets a red status and literally nothing else.
    expect(translated.diagnostics.join('\n')).toContain('something went wrong, opaquely');
  });

  it('does not throw when the results directory is gone', async () => {
    const translated = await translateResultsDir({
      resultsDir: path.join(scratch, 'vanished'),
      artifactsDir: path.join(scratch, 'run'),
      cwd: '/repo',
      exec: noXcrun,
    });

    expect(translated.exitCode).toBeNull();
    expect(translated.logPath).toBeNull();
    expect(translated.artifacts).toEqual([]);
  });
});

/* ========================================================================== */
/* slots.ts — the two-VM ceiling                                              */
/* ========================================================================== */

describe('the two-VM ceiling', () => {
  it('is two, because Virtualization.framework says so', () => {
    expect(MAX_CONCURRENT_VMS).toBe(2);
  });

  it('admits exactly two holders and queues the third', async () => {
    const slotDir = path.join(scratch, 'slots');
    const first = await acquireVmSlot({ slotDir });
    const second = await acquireVmSlot({ slotDir });

    expect(new Set([first.index, second.index]).size).toBe(2);
    expect(await countHeldSlots({ slotDir })).toBe(2);

    // A third would boot a guest Virtualization.framework refuses to start.
    await expect(
      acquireVmSlot({ slotDir, timeoutMs: 150, pollIntervalMs: 25 }),
    ).rejects.toBeInstanceOf(VmSlotTimeoutError);

    await first.release();
    const third = await acquireVmSlot({ slotDir, timeoutMs: 1000, pollIntervalMs: 25 });
    expect(third.index).toBe(first.index);
    await Promise.all([second.release(), third.release()]);
    expect(await countHeldSlots({ slotDir })).toBe(0);
  });

  it('explains the ceiling in the timeout message', async () => {
    const slotDir = path.join(scratch, 'slots');
    const held = [await acquireVmSlot({ slotDir }), await acquireVmSlot({ slotDir })];
    try {
      await acquireVmSlot({ slotDir, timeoutMs: 100, pollIntervalMs: 25 });
      expect.unreachable('should have timed out');
    } catch (error) {
      expect((error as Error).message).toContain('2 concurrent guests');
    } finally {
      await Promise.all(held.map((slot) => slot.release()));
    }
  });

  it('reclaims a slot whose owning process is gone', async () => {
    const slotDir = path.join(scratch, 'slots');
    await fs.mkdir(slotDir, { recursive: true });
    // pid 2^22 is above every macOS pid_max; nothing is running there.
    for (const index of [0, 1]) {
      await fs.writeFile(
        path.join(slotDir, `slot-${index}.lock`),
        JSON.stringify({
          pid: 4194303,
          hostname: os.hostname(),
          acquiredAt: new Date().toISOString(),
          token: 'ghost',
        }),
      );
    }

    expect(await countHeldSlots({ slotDir })).toBe(0);
    const slot = await acquireVmSlot({ slotDir, timeoutMs: 500, pollIntervalMs: 25 });
    expect(slot.index).toBe(0);
    await slot.release();
  });

  it('ages out a slot held by a process on another host', async () => {
    const slotDir = path.join(scratch, 'slots');
    await fs.mkdir(slotDir, { recursive: true });
    await fs.writeFile(
      path.join(slotDir, 'slot-0.lock'),
      JSON.stringify({
        pid: process.pid,
        hostname: 'some-other-mac.local',
        acquiredAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        token: 'stale',
      }),
    );

    const slot = await acquireVmSlot({ slotDir, timeoutMs: 500, pollIntervalMs: 25 });
    expect(slot.index).toBe(0);
    await slot.release();
  });

  it('leaves a live holder on another host alone', async () => {
    const slotDir = path.join(scratch, 'slots');
    await fs.mkdir(slotDir, { recursive: true });
    for (const index of [0, 1]) {
      await fs.writeFile(
        path.join(slotDir, `slot-${index}.lock`),
        JSON.stringify({
          pid: process.pid,
          hostname: 'some-other-mac.local',
          acquiredAt: new Date().toISOString(),
          token: `live-${index}`,
        }),
      );
    }
    // Stealing a slot from a running VM is worse than queueing behind a ghost.
    await expect(
      acquireVmSlot({ slotDir, timeoutMs: 100, pollIntervalMs: 25 }),
    ).rejects.toBeInstanceOf(VmSlotTimeoutError);
  });

  it('releases idempotently and never throws', async () => {
    const slotDir = path.join(scratch, 'slots');
    const slot = await acquireVmSlot({ slotDir });
    await slot.release();
    await expect(slot.release()).resolves.toBeUndefined();

    // Even if the file is gone underneath it.
    const another = await acquireVmSlot({ slotDir });
    await fs.rm(another.path, { force: true });
    await expect(another.release()).resolves.toBeUndefined();
  });

  it('does not release a slot that was reclaimed and handed to someone else', async () => {
    const slotDir = path.join(scratch, 'slots');
    const mine = await acquireVmSlot({ slotDir });

    // Simulate a reclaim: someone else now owns this slot file.
    await fs.writeFile(
      mine.path,
      JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        acquiredAt: new Date().toISOString(),
        token: 'someone-else',
      }),
    );

    await mine.release();
    // Removing it would over-subscribe the host by one guest.
    expect(await countHeldSlots({ slotDir })).toBe(1);
  });

  it('gives concurrent acquirers distinct slots', async () => {
    const slotDir = path.join(scratch, 'slots');
    const granted = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        acquireVmSlot({ slotDir, timeoutMs: 120, pollIntervalMs: 20 }),
      ),
    );

    const slots = granted
      .filter((outcome) => outcome.status === 'fulfilled')
      .map((outcome) => (outcome as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireVmSlot>>>).value);

    expect(slots).toHaveLength(2);
    expect(new Set(slots.map((slot) => slot.index)).size).toBe(2);
    await Promise.all(slots.map((slot) => slot.release()));
  });
});

/* ========================================================================== */
/* index.ts — doctor parsing                                                  */
/* ========================================================================== */

describe('parseDoctorOutput', () => {
  it('finds nothing wrong with a ready host', async () => {
    const output = await readFixture('runner-stdout', 'doctor-ready.txt');
    expect(parseDoctorOutput(output, '/plugins/tart-runner', 0)).toEqual([]);
  });

  it('detects a missing golden image and names the prepare command', async () => {
    const output = await readFixture('runner-stdout', 'doctor-no-image.txt');
    const problems = parseDoctorOutput(output, '/plugins/tart-runner', 1);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.reason).toContain('golden VM image has not been built');
    expect(problems[0]?.fix).toContain('prepare');
    expect(problems[0]?.fix).toContain('25 GB');
  });

  it('detects the crash quarantine without telling the user to blow past it', async () => {
    const output = await readFixture('runner-stdout', 'doctor-quarantined.txt');
    const problems = parseDoctorOutput(output, '/plugins/tart-runner', 1);

    expect(problems[0]?.reason).toContain('quarantine');
    // Upstream is explicit that acknowledgement must never be inferred, so the
    // fix leads with inspection and gates the reset on the user's decision.
    expect(problems[0]?.fix).toContain('Inspect');
    expect(problems[0]?.fix).toContain('only if you accept the risk');
  });

  it('detects an interrupted run needing reset', async () => {
    const output = await readFixture('runner-stdout', 'doctor-recovery.txt');
    const problems = parseDoctorOutput(output, '/plugins/tart-runner', 1);

    expect(problems[0]?.reason).toContain('interrupted');
    expect(problems[0]?.fix).toContain('reset');
    expect(problems[0]?.fix).not.toContain('acknowledge-host-crash');
  });

  it('falls back to quoting doctor when it fails for a reason we do not model', () => {
    const problems = parseDoctorOutput('something unfamiliar broke', '/plugins/tart-runner', 3);
    expect(problems[0]?.reason).toContain('exited 3');
    expect(problems[0]?.fix).toContain('something unfamiliar broke');
  });
});

/* ========================================================================== */
/* index.ts — the lane                                                        */
/* ========================================================================== */

describe('VmLane.isAvailable', () => {
  it('reports unavailable with exact install steps, and does not throw', async () => {
    // This is the real state of the machine this lane was developed on.
    const lane = new VmLane({
      env: { PATH: path.join(scratch, 'empty-bin') },
      cwd: scratch,
      homeDir: path.join(scratch, 'empty-home'),
      platform: 'darwin',
      arch: 'arm64',
    });

    const availability = await lane.isAvailable();

    expect(availability.available).toBe(false);
    expect(availability.fix).toContain('brew');
    expect(availability.fix).toContain('claude plugin install tart-xcode-runner@novotnyllc');
  });

  it('never spawns anything when the tools are missing', async () => {
    const spawn = recordedSpawn({});
    const lane = new VmLane({
      env: { PATH: path.join(scratch, 'empty-bin') },
      cwd: scratch,
      homeDir: path.join(scratch, 'empty-home'),
      platform: 'darwin',
      arch: 'arm64',
      spawn,
    });

    await lane.isAvailable();
    expect(spawn.calls).toEqual([]);
  });

  it('consults tart-runner doctor once both tools are present', async () => {
    const { env, homeDir } = await fakeInstall(scratch);
    const doctor = await readFixture('runner-stdout', 'doctor-ready.txt');
    const spawn = recordedSpawn({ stdout: doctor, exitCode: 0 });

    const lane = new VmLane({
      env,
      cwd: scratch,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      spawn,
    });

    expect(await lane.isAvailable()).toEqual({ available: true });
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0]?.args).toEqual(['doctor']);
  });

  it('surfaces a missing golden image, which no file check could find', async () => {
    const { env, homeDir } = await fakeInstall(scratch);
    const doctor = await readFixture('runner-stdout', 'doctor-no-image.txt');

    const lane = new VmLane({
      env,
      cwd: scratch,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      spawn: recordedSpawn({ stdout: doctor, exitCode: 1 }),
    });

    const availability = await lane.isAvailable();
    expect(availability.available).toBe(false);
    expect(availability.fix).toContain('prepare');
  });

  it('can skip the doctor probe entirely', async () => {
    const { env, homeDir } = await fakeInstall(scratch);
    const spawn = recordedSpawn({});
    const lane = new VmLane({
      env,
      cwd: scratch,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      spawn,
      probeDoctor: false,
    });

    expect(await lane.isAvailable()).toEqual({ available: true });
    expect(spawn.calls).toEqual([]);
  });

  it('turns an unexpected internal failure into a value, not an exception', async () => {
    const lane = new VmLane({
      env: {},
      cwd: scratch,
      homeDir: path.join(scratch, 'home'),
      platform: 'darwin',
      arch: 'arm64',
      spawn: () => {
        throw new Error('kaboom');
      },
    });
    await expect(lane.isAvailable()).resolves.toMatchObject({ available: false });
  });
});

describe('VmLane.run', () => {
  it('returns a valid skipped result when nothing is installed', async () => {
    const req = await makeRequest();
    const lane = new VmLane({
      env: { PATH: path.join(scratch, 'empty-bin') },
      cwd: scratch,
      homeDir: path.join(scratch, 'empty-home'),
      platform: 'darwin',
      arch: 'arm64',
    });

    const result = await lane.run(req);

    expect(isLaneResult(result)).toBe(true);
    expect(result.lane).toBe('vm');
    expect(result.status).toBe('skipped');
    expect(result.exitCode).toBeNull();
    // Rule 3: never fall back to the real screen.
    expect(result.diagnostics.join(' ')).toContain('does not fall back to your real screen');
    expect(result.diagnostics.join(' ')).toContain('brew');
    expect(result.diagnostics.join(' ')).toContain('claude plugin install');
  });

  it('translates a failing test run end to end', async () => {
    const { env, homeDir, runner } = await fakeInstall(scratch);
    const req = await makeRequest({ command: ['xcodebuild', '-scheme', 'SmokeAppUITests', 'test'] });

    const spawn = recordedSpawn((_file, args) =>
      args[0] === 'doctor'
        ? { stdout: 'host safety: ready\nbase VM:    tart-xcui-base (ready)\n', exitCode: 0 }
        : { stdout: `results: ${results('xcui-test-failed')}\n`, exitCode: 65 },
    );

    const lane = new VmLane({
      env,
      cwd: scratch,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      spawn,
      exec: noXcrun,
      slots: { slotDir: path.join(scratch, 'slots') },
    });

    const result = await lane.run(req);

    expect(isLaneResult(result)).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.exitCode).toBe(65);
    expect(result.failures.length).toBeGreaterThanOrEqual(2);
    expect(result.logPath).toBe(path.join(req.artifactsDir, 'xcodebuild.log'));
    expect(result.artifacts.some((artifact) => artifact.kind === 'xcresult')).toBe(true);

    // It picked xcui-test, dropped our `xcodebuild`, and passed --repo.
    const runCall = spawn.calls.find((call) => call.args[0] !== 'doctor');
    expect(runCall?.file).toBe(runner);
    expect(runCall?.args).toEqual([
      'xcui-test',
      '--repo',
      req.cwd,
      '--',
      '-scheme',
      'SmokeAppUITests',
      'test',
    ]);
  });

  it('reports a passing build as passed', async () => {
    const { env, homeDir } = await fakeInstall(scratch);
    const req = await makeRequest({ command: ['xcodebuild', '-scheme', 'SmokeApp', 'build'] });

    const lane = new VmLane({
      env,
      cwd: scratch,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      spawn: recordedSpawn((_file, args) =>
        args[0] === 'doctor'
          ? { stdout: 'host safety: ready\n', exitCode: 0 }
          : { stdout: `results: ${results('build-passed')}\n`, exitCode: 0 },
      ),
      exec: noXcrun,
      slots: { slotDir: path.join(scratch, 'slots') },
    });

    const result = await lane.run(req);
    expect(result.status).toBe('passed');
    expect(result.exitCode).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it('errors — never fails — when the runner refuses before starting a run', async () => {
    const { env, homeDir } = await fakeInstall(scratch);
    const req = await makeRequest();
    const refusal = await readFixture('runner-stdout', 'no-base-image.txt');

    const lane = new VmLane({
      env,
      cwd: scratch,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      spawn: recordedSpawn((_file, args) =>
        args[0] === 'doctor'
          ? { stdout: 'host safety: ready\n', exitCode: 0 }
          : { stdout: '', stderr: refusal, exitCode: 1 },
      ),
      slots: { slotDir: path.join(scratch, 'slots') },
    });

    const result = await lane.run(req);

    // `failed` would mean the user's tests are red. Nothing ran at all.
    expect(result.status).toBe('errored');
    expect(result.exitCode).toBeNull();
    expect(result.diagnostics.join(' ')).toContain('base VM is missing');
  });

  it('errors when the runner cannot be spawned at all', async () => {
    const { env, homeDir } = await fakeInstall(scratch);
    const req = await makeRequest();

    const lane = new VmLane({
      env,
      cwd: scratch,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      spawn: recordedSpawn((_file, args) =>
        args[0] === 'doctor'
          ? { stdout: 'host safety: ready\n', exitCode: 0 }
          : { spawnError: 'spawn ENOENT', exitCode: null },
      ),
      slots: { slotDir: path.join(scratch, 'slots') },
    });

    const result = await lane.run(req);
    expect(result.status).toBe('errored');
    expect(result.diagnostics.join(' ')).toContain('ENOENT');
  });

  it('calls a timeout errored, not failed, even with partial output', async () => {
    const { env, homeDir } = await fakeInstall(scratch);
    const req = await makeRequest({ timeoutMs: 1000 });

    const lane = new VmLane({
      env,
      cwd: scratch,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      spawn: recordedSpawn((_file, args) =>
        args[0] === 'doctor'
          ? { stdout: 'host safety: ready\n', exitCode: 0 }
          : { stdout: `results: ${results('xcui-test-failed')}\n`, exitCode: null, timedOut: true },
      ),
      exec: noXcrun,
      slots: { slotDir: path.join(scratch, 'slots') },
    });

    const result = await lane.run(req);

    expect(result.status).toBe('errored');
    expect(result.exitCode).toBeNull();
    expect(result.diagnostics.join(' ')).toContain('says nothing about the code under test');
    // Partial evidence is still kept.
    expect(result.logPath).not.toBeNull();
  });

  it('errors when neither exit-status file survived', async () => {
    const { env, homeDir } = await fakeInstall(scratch);
    const req = await makeRequest();

    const lane = new VmLane({
      env,
      cwd: scratch,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      spawn: recordedSpawn((_file, args) =>
        args[0] === 'doctor'
          ? { stdout: 'host safety: ready\n', exitCode: 0 }
          : { stdout: `results: ${results('interrupted')}\n`, exitCode: 1 },
      ),
      exec: noXcrun,
      slots: { slotDir: path.join(scratch, 'slots') },
    });

    const result = await lane.run(req);
    expect(result.status).toBe('errored');
    expect(result.diagnostics.join(' ')).toContain('never reported an exit code');
  });

  it('gives up with an errored result when the VM slots stay busy', async () => {
    const { env, homeDir } = await fakeInstall(scratch);
    const req = await makeRequest();
    const slotDir = path.join(scratch, 'slots');
    const held = [await acquireVmSlot({ slotDir }), await acquireVmSlot({ slotDir })];

    const spawn = recordedSpawn((_file, args) =>
      args[0] === 'doctor' ? { stdout: 'host safety: ready\n', exitCode: 0 } : { exitCode: 0 },
    );
    const lane = new VmLane({
      env,
      cwd: scratch,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      spawn,
      slots: { slotDir, timeoutMs: 100, pollIntervalMs: 25 },
    });

    const result = await lane.run(req);

    expect(result.status).toBe('errored');
    expect(result.diagnostics.join(' ')).toContain('2 concurrent guests');
    // Crucially, it did not go ahead and boot a third guest anyway.
    expect(spawn.calls.some((call) => call.args[0] !== 'doctor')).toBe(false);

    await Promise.all(held.map((slot) => slot.release()));
  });

  it('releases its slot on every path, including failures', async () => {
    const { env, homeDir } = await fakeInstall(scratch);
    const slotDir = path.join(scratch, 'slots');

    const makeLane = (outcome: Partial<SpawnOutcome>) =>
      new VmLane({
        env,
        cwd: scratch,
        homeDir,
        platform: 'darwin',
        arch: 'arm64',
        spawn: recordedSpawn((_file, args) =>
          args[0] === 'doctor' ? { stdout: 'host safety: ready\n', exitCode: 0 } : outcome,
        ),
        exec: noXcrun,
        slots: { slotDir },
      });

    for (const outcome of [
      { stdout: `results: ${results('build-passed')}\n`, exitCode: 0 },
      { stdout: '', stderr: 'error: base VM is missing', exitCode: 1 },
      { spawnError: 'spawn EACCES', exitCode: null },
      { stdout: `results: ${results('interrupted')}\n`, exitCode: null, timedOut: true },
    ] satisfies Array<Partial<SpawnOutcome>>) {
      const result = await makeLane(outcome).run(await makeRequest());
      expect(isLaneResult(result)).toBe(true);
      // A leaked slot silently halves the host's capacity for every later run.
      expect(await countHeldSlots({ slotDir })).toBe(0);
    }
  });

  it('keeps the runner transcript as an artifact even when the run never started', async () => {
    const { env, homeDir } = await fakeInstall(scratch);
    const req = await makeRequest();

    const lane = new VmLane({
      env,
      cwd: scratch,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      spawn: recordedSpawn((_file, args) =>
        args[0] === 'doctor'
          ? { stdout: 'host safety: ready\n', exitCode: 0 }
          : { stdout: '', stderr: 'error: base VM is missing; run prepare', exitCode: 1 },
      ),
      slots: { slotDir: path.join(scratch, 'slots') },
    });

    await lane.run(req);

    const transcript = await fs.readFile(path.join(req.artifactsDir, RUNNER_LOG), 'utf8');
    expect(transcript).toContain('base VM is missing');
    expect(transcript).toContain('# exit: 1');
  });

  it('hands the runner its own deadline so the guest can be stopped cleanly', async () => {
    const { env, homeDir } = await fakeInstall(scratch);
    const req = await makeRequest({ timeoutMs: 90_000 });
    const seen: NodeJS.ProcessEnv[] = [];

    const spawn: Spawn = async (_file, args, options) => {
      seen.push(options.env);
      return args[0] === 'doctor'
        ? { exitCode: 0, stdout: 'host safety: ready\n', stderr: '', timedOut: false }
        : {
            exitCode: 0,
            stdout: `results: ${results('build-passed')}\n`,
            stderr: '',
            timedOut: false,
          };
    };

    const lane = new VmLane({
      env,
      cwd: scratch,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      spawn,
      exec: noXcrun,
      slots: { slotDir: path.join(scratch, 'slots') },
    });
    await lane.run(req);

    // The runner's own watchdog stops the guest and still writes exit-status,
    // which is a far better outcome than us killing it mid-export.
    expect(seen.at(-1)?.TART_XCUI_RUN_TIMEOUT).toBe('90');
  });

  it('passes request env through to the runner, reaching the TART_XCUI_* knobs', async () => {
    const { env, homeDir } = await fakeInstall(scratch);
    const req = await makeRequest({ env: { TART_XCUI_BASE_VM: 'tart-xcui-27beta' } });
    const seen: NodeJS.ProcessEnv[] = [];

    const spawn: Spawn = async (_file, args, options) => {
      seen.push(options.env);
      return args[0] === 'doctor'
        ? { exitCode: 0, stdout: 'host safety: ready\n', stderr: '', timedOut: false }
        : {
            exitCode: 0,
            stdout: `results: ${results('build-passed')}\n`,
            stderr: '',
            timedOut: false,
          };
    };

    await new VmLane({
      env,
      cwd: scratch,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      spawn,
      exec: noXcrun,
      slots: { slotDir: path.join(scratch, 'slots') },
    }).run(req);

    expect(seen.at(-1)?.TART_XCUI_BASE_VM).toBe('tart-xcui-27beta');
  });

  it('never throws, whatever the runner does', async () => {
    const { env, homeDir } = await fakeInstall(scratch);
    const req = await makeRequest();

    const lane = new VmLane({
      env,
      cwd: scratch,
      homeDir,
      platform: 'darwin',
      arch: 'arm64',
      spawn: (_file, args) => {
        if (args[0] === 'doctor') {
          return Promise.resolve({
            exitCode: 0,
            stdout: 'host safety: ready\n',
            stderr: '',
            timedOut: false,
          });
        }
        throw new Error('the runner exploded');
      },
      slots: { slotDir: path.join(scratch, 'slots') },
    });

    const result = await lane.run(req);
    expect(isLaneResult(result)).toBe(true);
    expect(result.status).toBe('errored');
    expect(result.diagnostics.join(' ')).toContain('the runner exploded');
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Lay down a plugin tree and a `tart` binary that exist as *files* only.
 *
 * Enough for discovery to succeed, and deliberately not enough to run anything:
 * no test in this file may boot a VM, and none does.
 */
async function fakeInstall(
  root: string,
): Promise<{ env: NodeJS.ProcessEnv; homeDir: string; runner: string }> {
  const homeDir = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const runner = path.join(
    homeDir,
    '.claude',
    'plugins',
    'cache',
    'novotnyllc',
    'tart-xcode-runner',
    '0.4.11',
    RUNNER_RELATIVE_PATH,
  );

  await fs.mkdir(path.dirname(runner), { recursive: true });
  await fs.writeFile(runner, '#!/bin/zsh\n# recorded fixture stand-in; never executed by tests\n');
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, 'tart'), 'recorded fixture stand-in; never executed by tests');

  return { env: { PATH: bin }, homeDir, runner };
}
