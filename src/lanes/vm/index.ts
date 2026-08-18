/**
 * The vm lane — an adapter over `novotnyllc/tart-xcode-runner`.
 *
 * macOS-native work is the one thing offstage cannot keep off your screen by
 * being clever about flags. `xcodebuild test` on a simulator seizes the display;
 * an XCUITest drives the real keyboard. The only honest answer is another
 * machine, and on Apple Silicon that means a Tart guest.
 *
 * offstage does not build that. `tart-xcode-runner` already maintains a golden
 * image, clones it per run, mounts the checkout read-only, copies it to guest
 * APFS, runs the work headless, exports logs and the `.xcresult`, and deletes
 * the clone. This lane's whole job is the seam:
 *
 * - **find** the runner and `tart`, or explain exactly how to install them
 *   (`./discover.js`),
 * - **map** a `LaneRequest` onto the right subcommand (`./command.js`),
 * - **queue** so no more than two guests run at once (`./slots.js`),
 * - **translate** the results directory into a `LaneResult` (`./results.js`).
 *
 * Everything substrate-specific stops here. Callers get the same envelope the
 * headless and container lanes return.
 *
 * The lane is deliberately inert on a machine without Tart: `isAvailable()`
 * reports `available: false` with install commands, `run()` returns `skipped`,
 * and neither throws or touches the display. That is the tested path — the live
 * VM smoke test belongs to the integration node.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  Lane,
  LaneAvailability,
  LaneRequest,
  LaneResult,
  LaneRunner,
} from '../../contract/index.js';
import { createLaneResult, skippedResult, statusFromExitCode } from '../../contract/index.js';
import { artifactPath } from '../../contract/artifacts.js';

import type { DiscoverOptions, VmToolchain } from './discover.js';
import { discoverToolchain, toAvailability } from './discover.js';
import { buildRunnerArgv, planInvocation } from './command.js';
import type { AcquireOptions, VmSlot } from './slots.js';
import { MAX_CONCURRENT_VMS, VmSlotTimeoutError, acquireVmSlot } from './slots.js';
import type { Exec } from './results.js';
import { parseRunnerStdout, translateResultsDir } from './results.js';

/** Combined stdout/stderr of the runner process itself, kept as evidence. */
export const RUNNER_LOG = 'tart-runner.log';

/** Grace period on top of the request timeout, so the runner can clean up. */
const RUNNER_SHUTDOWN_GRACE_MS = 60_000;

/** Cap on how long `tart-runner doctor` may take before we stop waiting. */
const DOCTOR_TIMEOUT_MS = 30_000;

/* -------------------------------------------------------------------------- */
/* Spawning                                                                   */
/* -------------------------------------------------------------------------- */

export interface SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface SpawnOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the process was killed for exceeding its budget. */
  timedOut: boolean;
  /** Set when the process could not be started at all (ENOENT, EACCES, …). */
  spawnError?: string;
}

/** Injection point so tests can drive the lane without a VM anywhere in sight. */
export type Spawn = (file: string, args: string[], options: SpawnOptions) => Promise<SpawnOutcome>;

/** Default {@link Spawn}: execa, with rejection off so failures are data. */
export const defaultSpawn: Spawn = async (file, args, options) => {
  const { execa } = await import('execa');
  try {
    const result = await execa(file, args, {
      cwd: options.cwd,
      env: options.env,
      extendEnv: true,
      reject: false,
      all: false,
      stripFinalNewline: false,
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
    return {
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      timedOut: result.timedOut === true,
    };
  } catch (error) {
    // execa still throws for failures that are not the child's exit status —
    // most importantly ENOENT when the runner path is wrong.
    return {
      exitCode: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      spawnError: (error as Error).message,
    };
  }
};

/* -------------------------------------------------------------------------- */
/* Lane options                                                               */
/* -------------------------------------------------------------------------- */

export interface VmLaneOptions extends DiscoverOptions {
  /** Spawns the runner. Defaults to execa. */
  spawn?: Spawn;
  /** Spawns `xcrun` for `.xcresult` parsing. Defaults to execa. */
  exec?: Exec;
  /** Overrides for the two-VM semaphore. */
  slots?: AcquireOptions;
  /**
   * Whether `isAvailable()` may shell to `tart-runner doctor`.
   *
   * On by default: it is the only way to learn that the golden image has not
   * been built yet, which is the most common "everything is installed and
   * nothing works" state. Turn it off for a purely filesystem-level probe.
   */
  probeDoctor?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Doctor                                                                     */
/* -------------------------------------------------------------------------- */

/** A problem `tart-runner doctor` reported that file discovery cannot see. */
interface DoctorProblem {
  reason: string;
  fix: string;
}

/**
 * Read `tart-runner doctor` output for the states that block a run.
 *
 * Doctor prints a fixed set of `key: value` lines and exits non-zero when any
 * check fails. Only the failures offstage can explain a fix for are lifted out;
 * everything else falls back to a generic message carrying doctor's own output,
 * which is more useful than a guess.
 */
export function parseDoctorOutput(
  output: string,
  runnerPath: string,
  exitCode: number | null,
): DoctorProblem[] {
  const problems: DoctorProblem[] = [];
  const quoted = JSON.stringify(runnerPath);

  if (/^\s*base VM:.*\(missing; run prepare\)/m.test(output)) {
    problems.push({
      reason:
        'The golden VM image has not been built yet, so there is nothing to clone a run from.',
      fix: `${quoted} prepare  # first build downloads ~25 GB and takes a while`,
    });
  }
  if (/^\s*host safety:\s*QUARANTINED/m.test(output)) {
    problems.push({
      reason:
        'tart-xcode-runner is in host-crash quarantine: a host failure followed an interrupted ' +
        'run, and it will not start Tart again until that is inspected and acknowledged.',
      fix:
        'Inspect the panic or login-session crash report named in `' +
        `${quoted} doctor\`, then — only if you accept the risk — ` +
        `${quoted} reset --acknowledge-host-crash`,
    });
  } else if (/^\s*host safety:\s*recovery required/m.test(output)) {
    problems.push({
      reason: 'A previous run was interrupted and left disposable VM state behind.',
      fix: `${quoted} reset  # removes the disposable clone; the golden image is untouched`,
    });
  }
  if (/^\s*host:\s*unsupported/m.test(output)) {
    problems.push({
      reason: 'tart-runner doctor reports this host architecture is unsupported.',
      fix: 'Run macOS-native work on an Apple Silicon Mac.',
    });
  }

  if (problems.length === 0 && exitCode !== null && exitCode !== 0) {
    const summary = output.trim().split('\n').slice(0, 12).join('\n');
    problems.push({
      reason: `tart-runner doctor exited ${exitCode}.`,
      fix: `Run ${quoted} doctor and address what it reports:\n${summary}`,
    });
  }
  return problems;
}

/* -------------------------------------------------------------------------- */
/* The lane                                                                   */
/* -------------------------------------------------------------------------- */

export class VmLane implements LaneRunner {
  readonly lane: Lane = 'vm';

  private readonly options: VmLaneOptions;

  constructor(options: VmLaneOptions = {}) {
    this.options = options;
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Is the VM substrate usable right now?
   *
   * Never throws and never boots anything. Filesystem discovery answers the
   * common cases (no Tart, no plugin, wrong architecture); `tart-runner doctor`
   * answers the ones only the runner knows about (no golden image yet, crash
   * quarantine, interrupted run).
   */
  async isAvailable(): Promise<LaneAvailability> {
    try {
      const toolchain = await discoverToolchain(this.options);
      const base = toAvailability(toolchain);
      if (!base.available) return base;

      if (this.options.probeDoctor === false) return { available: true };
      return await this.probeWithDoctor(toolchain);
    } catch (error) {
      // Rule 1 of the contract: an unusable substrate is a value, not a throw.
      return {
        available: false,
        reason: `Could not determine whether the vm lane is usable: ${(error as Error).message}`,
        fix: 'Re-run `offstage doctor`; if this persists it is an offstage bug, not a setup problem.',
      };
    }
  }

  private async probeWithDoctor(toolchain: VmToolchain): Promise<LaneAvailability> {
    const runnerPath = toolchain.runner;
    if (!runnerPath) return { available: true };

    const spawn = this.options.spawn ?? defaultSpawn;
    let outcome: SpawnOutcome;
    try {
      outcome = await spawn(runnerPath, ['doctor'], {
        cwd: path.resolve(this.options.cwd ?? process.cwd()),
        env: this.buildEnv(),
        timeoutMs: DOCTOR_TIMEOUT_MS,
      });
    } catch (error) {
      return {
        available: false,
        reason: `tart-runner doctor could not be run: ${(error as Error).message}`,
        fix: `Check that ${JSON.stringify(runnerPath)} is executable (chmod +x).`,
      };
    }

    if (outcome.spawnError) {
      return {
        available: false,
        reason: `tart-runner doctor could not be started: ${outcome.spawnError}`,
        fix: `Check that ${JSON.stringify(runnerPath)} exists and is executable (chmod +x).`,
      };
    }
    if (outcome.timedOut) {
      return {
        available: false,
        reason: `tart-runner doctor did not finish within ${DOCTOR_TIMEOUT_MS / 1000}s.`,
        fix: `Run ${JSON.stringify(runnerPath)} doctor by hand to see where it hangs.`,
      };
    }

    const problems = parseDoctorOutput(
      `${outcome.stdout}\n${outcome.stderr}`,
      runnerPath,
      outcome.exitCode,
    );
    if (problems.length === 0) return { available: true };

    return {
      available: false,
      reason: problems.map((problem) => problem.reason).join(' '),
      fix: problems.map((problem) => problem.fix).join('\n'),
    };
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Run a command in a disposable macOS guest.
   *
   * Never throws, and never falls back to the host: if the substrate is not
   * usable the result is `skipped` with the fix, and if the runner itself
   * misbehaves the result is `errored` with everything it printed. A `failed`
   * result means the guest really ran the command and the command was red.
   */
  async run(req: LaneRequest): Promise<LaneResult> {
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    let slot: VmSlot | null = null;

    try {
      const toolchain = await discoverToolchain(this.options);
      const availability = toAvailability(toolchain);
      if (!availability.available || !toolchain.runner) {
        return skippedResult(this.lane, req.artifactsDir, availability);
      }

      const invocation = planInvocation(req.command);
      const diagnostics: string[] = [
        `vm lane: delegating to tart-xcode-runner at ${toolchain.runner}.`,
        invocation.reason,
      ];

      /* Queue behind the two-guest ceiling before touching the runner. */
      try {
        slot = await acquireVmSlot({
          cwd: req.cwd,
          env: this.options.env ?? process.env,
          label: path.basename(req.artifactsDir),
          ...this.options.slots,
        });
        diagnostics.push(
          slot.waitedMs > 1000
            ? `Waited ${Math.round(slot.waitedMs / 1000)}s for VM slot ${slot.index} of ` +
              `${MAX_CONCURRENT_VMS}; macOS hosts at most ${MAX_CONCURRENT_VMS} concurrent guests.`
            : `Took VM slot ${slot.index} of ${MAX_CONCURRENT_VMS}.`,
        );
      } catch (error) {
        if (error instanceof VmSlotTimeoutError) {
          return this.errored(req, startedAt, startedMs, [
            error.message,
            'Nothing was executed. Finish or cancel the running VM work and try again, or raise ' +
              'the wait with a longer timeout.',
          ]);
        }
        throw error;
      }

      const argv = buildRunnerArgv({
        runnerPath: toolchain.runner,
        cwd: req.cwd,
        invocation,
      });

      const outcome = await this.spawnRunner(req, argv);
      await this.persistRunnerLog(req, argv, outcome);

      if (outcome.spawnError) {
        return this.errored(req, startedAt, startedMs, [
          ...diagnostics,
          `Could not start the runner: ${outcome.spawnError}`,
          `Check that ${JSON.stringify(toolchain.runner)} exists and is executable (chmod +x).`,
        ]);
      }

      const { resultsDir } = parseRunnerStdout(outcome.stdout);

      if (!resultsDir) {
        /* The runner prints `results: …` before it clones anything, so getting
           here means it refused before starting — a missing golden image, a
           quarantine, an oversized repo. Its own stderr carries the fix. */
        return this.errored(req, startedAt, startedMs, [
          ...diagnostics,
          outcome.timedOut
            ? `The runner was killed after ${req.timeoutMs}ms without starting a run.`
            : `The runner exited ${outcome.exitCode ?? 'without a status'} before starting a run, ` +
              'so no results directory was created.',
          ...describeOutput(outcome),
        ]);
      }

      diagnostics.push(`Runner results directory: ${resultsDir}`);

      const translated = await translateResultsDir({
        resultsDir,
        artifactsDir: req.artifactsDir,
        cwd: req.cwd,
        ...(this.options.exec ? { exec: this.options.exec } : {}),
      });
      diagnostics.push(...translated.diagnostics);

      /* A timeout is never a verdict on the user's code. */
      if (outcome.timedOut) {
        return this.assemble(req, startedAt, startedMs, {
          status: 'errored',
          exitCode: null,
          logPath: translated.logPath,
          artifacts: translated.artifacts,
          failures: translated.failures,
          diagnostics: [
            ...diagnostics,
            `The run exceeded its ${req.timeoutMs}ms budget and the guest was stopped. Partial ` +
              'output was still collected, but the result says nothing about the code under test.',
          ],
        });
      }

      const exitCode = translated.exitCode;
      const status = statusFromExitCode(exitCode);
      if (status === 'errored') {
        diagnostics.push(
          `The runner process itself exited ${outcome.exitCode ?? 'without a status'}.`,
          ...describeOutput(outcome),
        );
      }

      return this.assemble(req, startedAt, startedMs, {
        status,
        exitCode,
        logPath: translated.logPath,
        artifacts: translated.artifacts,
        failures: translated.failures,
        diagnostics,
      });
    } catch (error) {
      // Rule 2: run() never throws. Anything that reaches here is an offstage
      // bug, and the user still gets a valid envelope describing it.
      return this.errored(req, startedAt, startedMs, [
        `The vm lane failed unexpectedly: ${(error as Error).message}`,
        ...((error as Error).stack ? [(error as Error).stack!] : []),
      ]);
    } finally {
      // Released on every path — success, failure, timeout, and the throw above.
      // A leaked slot silently halves the host's VM capacity until it ages out.
      await slot?.release();
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Environment for the runner process.
   *
   * `req.env` is layered on top, which is what makes the `TART_XCUI_*` knobs
   * (base image, CPU, memory, results dir) reachable from a `LaneRequest`.
   * Note that these reach the *host* runner, not the guest: `run-command.sh`
   * executes the argv with the guest's own environment.
   */
  private buildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
    return { ...(this.options.env ?? process.env), ...extra };
  }

  private async spawnRunner(req: LaneRequest, argv: string[]): Promise<SpawnOutcome> {
    const spawn = this.options.spawn ?? defaultSpawn;
    const [file, ...args] = argv;

    /* Give the runner's own watchdog the deadline, and keep a grace period for
       ourselves. Its watchdog stops the guest and still writes exit-status,
       which yields a far better result than us killing it mid-export. */
    const env = this.buildEnv({
      ...req.env,
      ...(req.timeoutMs
        ? { TART_XCUI_RUN_TIMEOUT: String(Math.max(1, Math.ceil(req.timeoutMs / 1000))) }
        : {}),
    });

    return spawn(file!, args, {
      cwd: req.cwd,
      env,
      ...(req.timeoutMs ? { timeoutMs: req.timeoutMs + RUNNER_SHUTDOWN_GRACE_MS } : {}),
    });
  }

  /** Keep the runner's own chatter as an artifact; it is the only record of a refusal. */
  private async persistRunnerLog(
    req: LaneRequest,
    argv: string[],
    outcome: SpawnOutcome,
  ): Promise<void> {
    try {
      await fs.mkdir(req.artifactsDir, { recursive: true });
      const body = [
        `$ ${argv.map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ')}`,
        '',
        outcome.stdout,
        outcome.stderr,
        '',
        `# exit: ${outcome.exitCode ?? 'none'}${outcome.timedOut ? ' (timed out)' : ''}`,
        ...(outcome.spawnError ? [`# spawn error: ${outcome.spawnError}`] : []),
      ].join('\n');
      await fs.writeFile(artifactPath(req.artifactsDir, RUNNER_LOG), body, 'utf8');
    } catch {
      // Best effort. Failing to write a convenience log must not fail the run.
    }
  }

  /** Assemble a validated envelope, degrading to a minimal one if that fails. */
  private assemble(
    req: LaneRequest,
    startedAt: string,
    startedMs: number,
    fields: Pick<LaneResult, 'status' | 'exitCode' | 'logPath' | 'artifacts' | 'failures' | 'diagnostics'>,
  ): LaneResult {
    try {
      return createLaneResult({
        lane: this.lane,
        artifactsDir: req.artifactsDir,
        startedAt,
        durationMs: Date.now() - startedMs,
        ...fields,
      });
    } catch (error) {
      // The envelope we built violates the contract — an offstage bug. Report
      // it as one rather than throwing out of run().
      return createLaneResult({
        lane: this.lane,
        status: 'errored',
        artifactsDir: req.artifactsDir,
        startedAt,
        durationMs: Date.now() - startedMs,
        diagnostics: [
          'The vm lane assembled a result that violates the offstage contract. This is a bug in ' +
            `offstage, not in your setup: ${(error as Error).message}`,
          ...fields.diagnostics,
        ],
      });
    }
  }

  private errored(
    req: LaneRequest,
    startedAt: string,
    startedMs: number,
    diagnostics: string[],
  ): LaneResult {
    return this.assemble(req, startedAt, startedMs, {
      status: 'errored',
      exitCode: null,
      logPath: null,
      artifacts: [],
      failures: [],
      diagnostics,
    });
  }
}

/** Runner stdout/stderr, trimmed to the lines worth putting in diagnostics. */
function describeOutput(outcome: SpawnOutcome, maxLines = 20): string[] {
  const lines: string[] = [];
  for (const [label, text] of [
    ['stdout', outcome.stdout],
    ['stderr', outcome.stderr],
  ] as const) {
    const trimmed = text.trim();
    if (!trimmed) continue;
    const kept = trimmed.split(/\r?\n/).slice(-maxLines);
    lines.push(`runner ${label}:`, ...kept);
  }
  return lines;
}

/** Convenience instance for callers that need no injection. */
export const vmLane = new VmLane();

export { discoverTart, discoverTartRunner, discoverToolchain } from './discover.js';
export { planInvocation, buildRunnerArgv } from './command.js';
export { acquireVmSlot, countHeldSlots, MAX_CONCURRENT_VMS } from './slots.js';
export { translateResultsDir } from './results.js';
