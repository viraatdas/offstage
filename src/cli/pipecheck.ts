/**
 * A doctor diagnostic for degraded kernel pipe buffers.
 *
 * A macOS pipe holds 16384 bytes. Under an as-yet-unexplained kernel condition
 * (observed 2026-08-24 on a machine with 2.5 days of uptime under heavy
 * multi-agent load) the kernel starts handing out 512- or 1024-byte pipes
 * instead, and keeps doing so for every new pipe. Nothing errors: the machine
 * simply stops being able to run local Xcode builds, because Xcode's
 * `CreateBuildDescription` probes the toolchain with
 * `clang -v -E -dM -arch arm64 -isysroot <sdk> -x objective-c -c /dev/null`,
 * which emits about 16 KB that Xcode does not drain concurrently. In a
 * 512-byte pipe that write blocks forever: clang sits in `write()`,
 * SWBBuildService waits in `mach_msg`, xcodebuild waits on the service, and a
 * build that printed its banner produces nothing else, ever.
 *
 * `doctor` said all lanes green on exactly such a machine, because the lanes
 * were fine: the kernel was not. This probe measures what a fresh pipe can
 * actually hold, so doctor can say so. Measuring needs a nonblocking write
 * loop against a real pipe, which Node's stream buffering makes unreliable in
 * pure JS; the reference implementation shells to python3 (shipped with the
 * Xcode Command Line Tools offstage's session lane already requires). Where
 * python3 is absent the probe answers "could not measure" and doctor says
 * nothing: an absent diagnostic must never become a false alarm.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The one impure call this module makes, injected so tests can fake it. */
export type ExecMeasure = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean },
) => Promise<{ stdout: string }>;

/** Pipe capacity a healthy macOS hands out. Linux defaults to 65536. */
export const HEALTHY_PIPE_BYTES = 16_384;

/** What one pipe-capacity measurement found. */
export interface PipeProbe {
  /** Bytes a fresh pipe accepted before EAGAIN, when it could be measured. */
  bytes?: number;
  /** Why there is no number, when there is no number. */
  reason?: string;
}

/** The python3 program that does the measuring, as its own fact for tests. */
export const PIPE_MEASURE_SCRIPT = [
  'import os,fcntl',
  'r,w=os.pipe()',
  'fcntl.fcntl(w,fcntl.F_SETFL,os.O_NONBLOCK)',
  'n=0',
  'try:',
  '    while n < (1<<20): n += os.write(w,b"x"*4096)',
  'except OSError:',
  '    pass',
  'print(n)',
].join('\n');

/**
 * Measure how many bytes a fresh pipe accepts before the kernel would block
 * the writer. Read-only: the pipe belongs to this process and is closed
 * immediately after. Never throws; an unmeasurable machine answers with a
 * reason instead.
 */
export async function measurePipeCapacity(exec: ExecMeasure = execFileAsync): Promise<PipeProbe> {
  try {
    const { stdout } = await exec('python3', ['-c', PIPE_MEASURE_SCRIPT], {
      timeout: 10_000,
      windowsHide: true,
    });
    return parsePipeMeasurement(stdout);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') return { reason: 'python3 is not on PATH' };
    if (typeof code === 'number') {
      return { reason: `python3 exited ${code}` };
    }
    return {
      reason: error instanceof Error ? error.message : 'the measurement did not complete',
    };
  }
}

/** Read the byte count out of the measurement's stdout. Pure, exported for tests. */
export function parsePipeMeasurement(stdout: string): PipeProbe {
  const trimmed = stdout.trim();
  const bytes = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(bytes) || bytes < 0) {
    return { reason: `python3 printed ${trimmed.slice(0, 80) || 'nothing'}, which is not a byte count` };
  }
  return { bytes };
}

/**
 * The doctor warning for a measured capacity, or `undefined` when the kernel
 * is behaving. Pure, exported for tests.
 *
 * Anything at or above {@link HEALTHY_PIPE_BYTES} is healthy, including
 * Linux's 65536. Below that, the wording names the failure mode an agent
 * would otherwise misread as an EAS, signing, or project problem, and the
 * action that cleared it on the machine where it was measured.
 */
export function pipeWarning(bytes: number): string | undefined {
  if (bytes >= HEALTHY_PIPE_BYTES) return undefined;
  return (
    `a fresh pipe on this machine holds ${bytes} bytes; a healthy macOS pipe holds ` +
    `${HEALTHY_PIPE_BYTES}. The kernel is handing out tiny pipe buffers, which deadlocks ` +
    `Xcode's toolchain probe: local \`xcodebuild\` builds print their banner and then hang ` +
    `forever without an error. This is a kernel condition, so every lane on this machine ` +
    `shares it; cloud builds are unaffected. Freeing memory, clearing caches and \`purge\` ` +
    `do not clear it. A reboot has been the only observed fix.`
  );
}
