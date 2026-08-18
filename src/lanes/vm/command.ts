/**
 * Choosing which `tart-runner` subcommand a `LaneRequest` becomes.
 *
 * The runner offers three ways to execute something in a guest, and they are
 * not interchangeable — each one hands the argv to a different helper script:
 *
 * | Subcommand  | Guest helper     | What it does with your argv                     |
 * | ----------- | ---------------- | ----------------------------------------------- |
 * | `xcui-test` | `run-xcode.sh`   | runs `xcodebuild <argv>`, boots a simulator, forces serial testing |
 * | `build`     | `run-xcode.sh`   | runs `xcodebuild <argv>` with ad-hoc signing, no simulator |
 * | `run`       | `run-command.sh` | runs `<argv>` verbatim in the checkout           |
 *
 * Two consequences drive everything below. First, `xcodebuild` itself must be
 * *stripped* from the argv for the two Xcode subcommands — the helper supplies
 * it, so leaving it in produces `xcodebuild xcodebuild …`. Second, a non-Xcode
 * command can never use those subcommands, however simulator-ish it looks:
 * `xcrun simctl boot …` sent to `xcui-test` would become `xcodebuild simctl
 * boot …`. So simulator work that is not an `xcodebuild` invocation goes to
 * `run`, which is the honest home for it.
 */

/** Which `tart-runner` subcommand to invoke. */
export type RunnerSubcommand = 'xcui-test' | 'build' | 'run';

/** A fully-formed plan for invoking the runner. */
export interface RunnerInvocation {
  subcommand: RunnerSubcommand;
  /** Arguments to place after `--`. Never empty. */
  args: string[];
  /** Why this subcommand was chosen, for `diagnostics`. */
  reason: string;
}

/**
 * `xcodebuild` actions that mean "run tests".
 *
 * `build-for-testing` is included deliberately: it is nominally a build, but it
 * needs the same simulator destination that `xcui-test` supplies, and sending
 * it to `build` yields the "no destination" failure every time.
 */
const TEST_ACTIONS = new Set([
  'test',
  'test-without-building',
  'build-for-testing',
]);

/** Flags that only ever appear on a test invocation. */
const TEST_FLAG_RE = /^-(only-testing|skip-testing|testPlan|test-timeouts-enabled|parallel-testing-enabled|resultBundlePath|enableCodeCoverage|retry-tests-on-failure)(?:[:=]|$)/;

/** Wrappers to peel off the front of an argv before inspecting it. */
const WRAPPERS = new Set(['xcrun', 'command', 'env']);

/** `env FOO=1 xcodebuild …` — assignments precede the real command. */
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Strip wrappers and env assignments to find the command actually being run.
 *
 * Returns the index of the real executable in `command`, so the caller can keep
 * the prefix when it matters (for `run`) and drop it when it does not.
 */
export function findExecutableIndex(command: string[]): number {
  let index = 0;
  while (index < command.length) {
    const token = command[index]!;
    if (ASSIGNMENT_RE.test(token)) {
      index += 1;
      continue;
    }
    // `basename` so `/usr/bin/xcrun` and `xcrun` behave identically.
    const base = token.split('/').pop() ?? token;
    if (WRAPPERS.has(base)) {
      index += 1;
      continue;
    }
    return index;
  }
  return command.length;
}

/** True when `command` ultimately invokes `xcodebuild`. */
export function isXcodebuild(command: string[]): boolean {
  const index = findExecutableIndex(command);
  const token = command[index];
  if (!token) return false;
  return (token.split('/').pop() ?? token) === 'xcodebuild';
}

/** True when the argv asks xcodebuild to run tests. */
export function isTestInvocation(xcodebuildArgs: string[]): boolean {
  for (const arg of xcodebuildArgs) {
    if (TEST_ACTIONS.has(arg)) return true;
    if (TEST_FLAG_RE.test(arg)) return true;
  }
  return false;
}

/** True when a `-destination` argument names a simulator. */
export function targetsSimulator(xcodebuildArgs: string[]): boolean {
  return xcodebuildArgs.some((arg) => /platform=[^,]*Simulator/i.test(arg));
}

/**
 * Map a command onto a runner subcommand.
 *
 * `xcodebuild` splits into `xcui-test` or `build` by action; everything else —
 * `swift test`, `xcrun simctl`, launching a built `.app`, a shell script that
 * drives all three — goes to `run`, which executes the argv verbatim inside the
 * guest checkout.
 */
export function planInvocation(command: string[]): RunnerInvocation {
  if (command.length === 0) {
    // The contract's schema forbids this, but the lane must not depend on the
    // caller having validated first.
    return {
      subcommand: 'run',
      args: ['/usr/bin/true'],
      reason: 'Empty command; nothing to run in the guest.',
    };
  }

  if (!isXcodebuild(command)) {
    const executable = command[findExecutableIndex(command)] ?? command[0]!;
    return {
      subcommand: 'run',
      args: [...command],
      reason:
        `\`${executable}\` is not an xcodebuild invocation, so it runs verbatim in the guest ` +
        'via `tart-runner run` rather than being rewritten into an Xcode build.',
    };
  }

  // Drop everything up to and including `xcodebuild`: run-xcode.sh supplies the
  // executable itself, and the guest's copy is the one that must win.
  const xcodebuildArgs = command.slice(findExecutableIndex(command) + 1);

  if (isTestInvocation(xcodebuildArgs)) {
    const simulator = targetsSimulator(xcodebuildArgs);
    return {
      subcommand: 'xcui-test',
      args: xcodebuildArgs,
      reason:
        'xcodebuild is running tests, so `tart-runner xcui-test` handles it: it boots a ' +
        (simulator
          ? 'simulator matching the requested destination'
          : 'simulator and supplies a -destination, since none was given') +
        ' and forces serial testing inside the guest.',
    };
  }

  return {
    subcommand: 'build',
    args: xcodebuildArgs.length > 0 ? xcodebuildArgs : ['build'],
    reason:
      'xcodebuild is building rather than testing, so `tart-runner build` handles it: ' +
      'ad-hoc signing, no simulator, no display.',
  };
}

export interface RunnerArgvOptions {
  /** Absolute path to the `tart-runner` script. */
  runnerPath: string;
  /** Repository root to mount into the guest. */
  cwd: string;
  /** The plan from {@link planInvocation}. */
  invocation: RunnerInvocation;
}

/**
 * Build the full argv for spawning the runner.
 *
 * `--repo` is passed for all three subcommands. `build` and `xcui-test` require
 * it; `run` merely accepts it, but passing it is what makes "launch the `.app`
 * this repo just built" work at all — without it the guest helper `cd`s to the
 * home directory and the checkout is never copied in.
 */
export function buildRunnerArgv(options: RunnerArgvOptions): string[] {
  const { runnerPath, cwd, invocation } = options;
  return [runnerPath, invocation.subcommand, '--repo', cwd, '--', ...invocation.args];
}
