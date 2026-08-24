/**
 * Container runtime detection for the container lane.
 *
 * On a developer laptop "is Docker available?" has more wrong answers than
 * right ones. The `docker` binary being on PATH means nothing: it is a client,
 * and it happily points at a daemon that is not there. The machine this lane
 * was written on is the canonical example: `docker` 29.4 installed, the active
 * context is OrbStack, and `unix:///Users/…/.orbstack/run/docker.sock` does not
 * exist because OrbStack is not running. Colima is installed too, with a
 * perfectly good stopped VM, which makes "what should the user type?" a real
 * question rather than a lookup: see {@link unavailableFrom} for why the answer
 * is `orb start` and not `colima start`.
 *
 * So detection here answers the only question that matters ("can I run a
 * container **right now**, and if not, what exactly should the human type?")
 * by probing daemons rather than binaries, in this order:
 *
 *   1. **docker**: whatever the active context points at. If `docker info`
 *      answers, we are done; that covers Docker Desktop, OrbStack, Rancher,
 *      a remote DOCKER_HOST, and a Colima whose context is already active.
 *   2. **colima**: a running Colima VM whose socket the active docker context
 *      is *not* pointing at. We probe it directly with `DOCKER_HOST` set to the
 *      profile's socket, so a stale or hijacked docker context cannot hide a
 *      working runtime, and the lane keeps using that explicit `DOCKER_HOST`
 *      for every later call.
 *   3. **podman**: the drop-in alternative, same CLI surface for our purposes.
 *
 * Two rules this module exists to enforce, both from the lane contract:
 *
 * - **It never throws.** Every probe failure (binary missing, daemon dead,
 *   malformed JSON, hung socket) becomes a structured step in the result.
 * - **It never starts anything.** No `colima start`, no `open -a Docker`, no
 *   image pull. It reports the command; the human (or `offstage doctor`) runs
 *   it. Silently booting a 16 GB VM because someone typed `offstage run` would
 *   be a hostile surprise.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execa } from 'execa';

import type { LaneAvailability } from '../../contract/index.js';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** The runtimes the container lane knows how to drive. */
export const CONTAINER_RUNTIME_KINDS = ['docker', 'colima', 'podman'] as const;

export type ContainerRuntimeKind = (typeof CONTAINER_RUNTIME_KINDS)[number];

/**
 * A runtime that answered a probe and can be used right now.
 *
 * `bin` + `env` is everything a caller needs to invoke it: `colima` is not a
 * container CLI, it is a VM manager, so its `bin` is still `docker`, with
 * `DOCKER_HOST` pinned to the profile's socket in `env`.
 */
export interface ContainerRuntime {
  kind: ContainerRuntimeKind;
  /** Executable to invoke: `docker` or `podman`. Never `colima`. */
  bin: string;
  /** Environment additions required to reach this runtime. Often empty. */
  env: Record<string, string>;
  /** Daemon/server version string, when the probe reported one. */
  serverVersion: string | null;
  /** One line for `offstage doctor`, e.g. `Colima (profile "default")`. */
  description: string;
}

/** What happened when one candidate runtime was probed. */
export interface RuntimeProbeStep {
  kind: ContainerRuntimeKind;
  /** Was the CLI found on PATH at all? */
  installed: boolean;
  /** Did it answer with a working daemon? */
  usable: boolean;
  /** Human-readable evidence: the actual reason, not a category. */
  detail: string;
  /**
   * A remediation this step is *sure* about, because the thing it names was
   * found on disk: `orb start` only appears here when OrbStack is actually
   * installed. Its absence is meaningful: it means any fix for this step would
   * be a guess, and {@link unavailableFrom} ranks guesses below certainties.
   */
  fix?: string;
}

/** The full detection outcome: what to use, or precisely why there is nothing. */
export interface ContainerRuntimeProbe {
  /** The runtime to use, or `null` when none is usable. */
  runtime: ContainerRuntime | null;
  /** Contract-shaped availability, with a paste-ready `fix` when unavailable. */
  availability: LaneAvailability;
  /** Every candidate that was considered, in probe order. */
  steps: RuntimeProbeStep[];
}

/* -------------------------------------------------------------------------- */
/* The exec seam                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Result of one probe command. `found: false` means the binary is not on PATH,
 * which is a different fact from "it ran and failed" and drives a different fix.
 */
export interface ProbeOutcome {
  found: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type ProbeExec = (
  file: string,
  args: string[],
  options: { timeoutMs: number; env?: Record<string, string> },
) => Promise<ProbeOutcome>;

export interface DetectRuntimeOptions {
  /** Injection point for tests; defaults to a real, non-throwing `execa` call. */
  exec?: ProbeExec;
  /** Defaults to `process.platform`. Only affects the wording of `fix`. */
  platform?: NodeJS.Platform;
  /** Defaults to `os.homedir()`. Used to locate Colima's socket. */
  homedir?: string;
  /** Defaults to `process.env`. Read for `COLIMA_HOME` only. */
  env?: Record<string, string | undefined>;
  /** Per-probe budget. A wedged daemon must not wedge `offstage doctor`. */
  timeoutMs?: number;
  /**
   * Existence check used to confirm a desktop runtime really is installed
   * before recommending its start command. Defaults to `fs.access`.
   */
  fileExists?: (target: string) => Promise<boolean>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

/**
 * The real exec: runs a probe and converts every possible failure into a
 * {@link ProbeOutcome}. Nothing thrown here ever escapes.
 */
export const defaultProbeExec: ProbeExec = async (file, args, options) => {
  try {
    const result = await execa(file, args, {
      reject: false,
      timeout: options.timeoutMs,
      all: false,
      env: options.env,
      // Probes are read-only and must never inherit a TTY or block on input.
      stdin: 'ignore',
    });
    const enoent =
      (result as { code?: string }).code === 'ENOENT' ||
      (result as { code?: string }).code === 'EACCES';
    return {
      found: !enoent,
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
      stdout: typeof result.stdout === 'string' ? result.stdout.trim() : '',
      stderr: typeof result.stderr === 'string' ? result.stderr.trim() : '',
      timedOut: Boolean((result as { timedOut?: boolean }).timedOut),
    };
  } catch (error) {
    // execa with reject:false should not throw, but a probe is exactly the
    // wrong place to find out otherwise.
    return {
      found: false,
      exitCode: null,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
    };
  }
};

/** Default existence check: does this path exist at all? Never throws. */
export const defaultFileExists = async (target: string): Promise<boolean> => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

/* -------------------------------------------------------------------------- */
/* Desktop runtimes                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The macOS runtimes that own a docker context, keyed by how their socket path
 * or context name gives them away.
 *
 * This table exists because of a real failure: the first version of this module
 * ranked `colima start` above everything, so on a machine with a stopped
 * OrbStack (already the active docker context) and a stopped Colima profile, it
 * told the user to boot a 16 GB Lima VM instead of the two-second daemon they
 * had already chosen. Starting the runtime the user configured is both lighter
 * and less surprising, but only when we can see that it is really installed,
 * which is what `app` is checked for.
 */
const DESKTOP_RUNTIMES: Array<{
  name: string;
  matches: RegExp;
  apps: string[];
  fix: string;
}> = [
  {
    name: 'OrbStack',
    matches: /orbstack/i,
    apps: ['/Applications/OrbStack.app', '~/Applications/OrbStack.app'],
    fix: 'orb start',
  },
  {
    name: 'Docker Desktop',
    matches: /com\.docker|desktop-linux|\.docker[/\\]run[/\\]docker\.sock/i,
    apps: ['/Applications/Docker.app', '~/Applications/Docker.app'],
    fix: 'open -a Docker',
  },
  {
    name: 'Rancher Desktop',
    matches: /rancher-desktop|\.rd[/\\]docker\.sock/i,
    apps: ['/Applications/Rancher Desktop.app', '~/Applications/Rancher Desktop.app'],
    fix: 'open -a "Rancher Desktop"',
  },
];

/**
 * Identify the desktop runtime behind a dead docker endpoint, and only return
 * its start command once its application bundle has been found on disk.
 */
async function identifyDesktopRuntime(
  evidence: string,
  options: { homedir: string; fileExists: (target: string) => Promise<boolean> },
): Promise<{ name: string; fix: string } | null> {
  for (const candidate of DESKTOP_RUNTIMES) {
    if (!candidate.matches.test(evidence)) continue;
    for (const app of candidate.apps) {
      const resolved = app.startsWith('~/') ? path.join(options.homedir, app.slice(2)) : app;
      if (await options.fileExists(resolved)) {
        return { name: candidate.name, fix: candidate.fix };
      }
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** First non-empty line of a stream, clipped: daemon errors can be paragraphs. */
function firstLine(text: string, max = 240): string {
  const line = text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  if (!line) return '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Where a Colima profile's docker socket lives, most-likely first.
 *
 * Modern Colima uses `$COLIMA_HOME/<profile>/docker.sock` (with `COLIMA_HOME`
 * defaulting to `~/.colima`); versions before 0.4 put the default profile's
 * socket straight in `~/.colima/docker.sock`. Both are cheap to try, and trying
 * beats guessing from a version string.
 */
export function colimaSocketCandidates(
  profile: string,
  options: { homedir?: string; env?: Record<string, string | undefined> } = {},
): string[] {
  const home = options.homedir ?? os.homedir();
  const colimaHome = options.env?.COLIMA_HOME ?? path.join(home, '.colima');
  const candidates = [path.join(colimaHome, profile, 'docker.sock')];
  if (profile === 'default') candidates.push(path.join(colimaHome, 'docker.sock'));
  return candidates;
}

interface ColimaProfile {
  name: string;
  status: string;
  runtime?: string;
  arch?: string;
}

/**
 * Parse `colima list --json`, which emits one JSON object per line rather than
 * an array. Unparseable lines are dropped: a Colima that prints a deprecation
 * banner should not make the whole lane look broken.
 */
export function parseColimaList(stdout: string): ColimaProfile[] {
  const profiles: ColimaProfile[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<ColimaProfile>;
      if (typeof parsed.name === 'string' && typeof parsed.status === 'string') {
        profiles.push({
          name: parsed.name,
          status: parsed.status,
          runtime: typeof parsed.runtime === 'string' ? parsed.runtime : undefined,
          arch: typeof parsed.arch === 'string' ? parsed.arch : undefined,
        });
      }
    } catch {
      // Not JSON. Ignore the line rather than the runtime.
    }
  }
  return profiles;
}

const isRunning = (status: string): boolean => status.toLowerCase() === 'running';

/* -------------------------------------------------------------------------- */
/* Detection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Probe for a usable container runtime.
 *
 * Never throws, never starts anything, never mutates the machine. Safe to call
 * from `isAvailable()`, from `offstage doctor`, and on every run.
 */
export async function detectContainerRuntime(
  options: DetectRuntimeOptions = {},
): Promise<ContainerRuntimeProbe> {
  const configured = options.exec ?? defaultProbeExec;
  // Even an injected exec must not be able to make detection throw: this
  // function is the one thing `isAvailable()` is built on, and the contract
  // says that never throws.
  const exec: ProbeExec = async (file, args, execOptions) => {
    try {
      return await configured(file, args, execOptions);
    } catch (error) {
      return {
        found: false,
        exitCode: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
      };
    }
  };
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir();
  const fileExists = options.fileExists ?? defaultFileExists;
  const steps: RuntimeProbeStep[] = [];

  const found = (
    runtime: ContainerRuntime,
    detail: string,
    kind: ContainerRuntimeKind,
  ): ContainerRuntimeProbe => {
    steps.push({ kind, installed: true, usable: true, detail });
    return { runtime, availability: { available: true }, steps };
  };

  /* --- 1. docker, via whatever context is active -------------------------- */

  const dockerInfo = await exec('docker', ['info', '--format', '{{.ServerVersion}}'], {
    timeoutMs,
  });

  if (dockerInfo.found && dockerInfo.exitCode === 0) {
    const version = firstLine(dockerInfo.stdout) || null;
    const context = await exec('docker', ['context', 'show'], { timeoutMs });
    const contextName = context.exitCode === 0 ? firstLine(context.stdout) : '';
    const where = contextName ? ` (context "${contextName}")` : '';
    return found(
      {
        kind: 'docker',
        bin: 'docker',
        env: {},
        serverVersion: version,
        description: `Docker daemon${version ? ` ${version}` : ''}${where}`,
      },
      `docker info answered${version ? `: server ${version}` : ''}${where}`,
      'docker',
    );
  }

  if (!dockerInfo.found) {
    steps.push({
      kind: 'docker',
      installed: false,
      usable: false,
      detail: 'the docker CLI is not on PATH',
    });
  } else {
    // The CLI exists and the daemon does not answer. The endpoint it tried is
    // the single most useful thing to show the user, and it is already in the
    // error text, no extra probe needed.
    const contextProbe = await exec('docker', ['context', 'show'], { timeoutMs });
    const contextName = contextProbe.exitCode === 0 ? firstLine(contextProbe.stdout) : '';
    const why = dockerInfo.timedOut
      ? `docker info timed out after ${timeoutMs}ms: the daemon is not answering`
      : firstLine(dockerInfo.stderr) || `docker info exited ${String(dockerInfo.exitCode)}`;
    // The endpoint it failed to reach is in the error text, and the context
    // name is the other half of the fingerprint. Together they identify which
    // desktop runtime is installed-but-stopped.
    const desktop = await identifyDesktopRuntime(`${contextName} ${why}`, { homedir, fileExists });
    steps.push({
      kind: 'docker',
      installed: true,
      usable: false,
      detail: `the docker CLI is installed but its daemon is unreachable${
        contextName ? ` (context "${contextName}")` : ''
      }: ${why}${desktop ? `: ${desktop.name} is installed but not running` : ''}`,
      ...(desktop ? { fix: desktop.fix } : {}),
    });
  }

  /* --- 2. colima, probed directly at its own socket ----------------------- */

  const colimaList = await exec('colima', ['list', '--json'], { timeoutMs });

  if (!colimaList.found) {
    steps.push({
      kind: 'colima',
      installed: false,
      usable: false,
      detail: 'colima is not installed',
    });
  } else {
    let profiles = parseColimaList(colimaList.stdout);

    // Older colima has no `list --json`. Fall back to the exit code of
    // `colima status`, which is 0 only when the default profile is running.
    if (profiles.length === 0) {
      const status = await exec('colima', ['status'], { timeoutMs });
      profiles = [{ name: 'default', status: status.exitCode === 0 ? 'Running' : 'Stopped' }];
    }

    const running = profiles.filter((profile) => isRunning(profile.status));
    let colimaDetail: string;

    if (running.length === 0) {
      colimaDetail =
        profiles.length === 0
          ? 'colima is installed but has no profiles'
          : `colima is installed but no profile is running (${profiles
              .map((profile) => `"${profile.name}" is ${profile.status}`)
              .join(', ')})`;
      steps.push({ kind: 'colima', installed: true, usable: false, detail: colimaDetail });
    } else {
      // A running profile still has to answer. Probe each candidate socket with
      // an explicit DOCKER_HOST so a stale active context cannot mask it.
      const tried: string[] = [];
      for (const profile of running) {
        for (const socket of colimaSocketCandidates(profile.name, { homedir, env })) {
          const dockerHost = `unix://${socket}`;
          const probe = await exec('docker', ['info', '--format', '{{.ServerVersion}}'], {
            timeoutMs,
            env: { DOCKER_HOST: dockerHost },
          });
          if (probe.found && probe.exitCode === 0) {
            const version = firstLine(probe.stdout) || null;
            return found(
              {
                kind: 'colima',
                bin: 'docker',
                env: { DOCKER_HOST: dockerHost },
                serverVersion: version,
                description: `Colima profile "${profile.name}"${
                  version ? ` (Docker ${version})` : ''
                } at ${socket}`,
              },
              `colima profile "${profile.name}" answered at ${socket}`,
              'colima',
            );
          }
          tried.push(socket);
        }
      }
      steps.push({
        kind: 'colima',
        installed: true,
        usable: false,
        detail: `colima reports ${running
          .map((profile) => `"${profile.name}"`)
          .join(', ')} running, but no docker socket answered (tried ${tried.join(', ')})`,
      });
    }
  }

  /* --- 3. podman ---------------------------------------------------------- */

  const podmanInfo = await exec('podman', ['info', '--format', '{{.Version.Version}}'], {
    timeoutMs,
  });

  if (podmanInfo.found && podmanInfo.exitCode === 0) {
    const version = firstLine(podmanInfo.stdout) || null;
    return found(
      {
        kind: 'podman',
        bin: 'podman',
        env: {},
        serverVersion: version,
        description: `Podman${version ? ` ${version}` : ''}`,
      },
      `podman info answered${version ? `: ${version}` : ''}`,
      'podman',
    );
  }

  steps.push({
    kind: 'podman',
    installed: podmanInfo.found,
    usable: false,
    detail: podmanInfo.found
      ? `podman is installed but not usable: ${
          podmanInfo.timedOut
            ? `podman info timed out after ${timeoutMs}ms`
            : firstLine(podmanInfo.stderr) || `podman info exited ${String(podmanInfo.exitCode)}`
        }`
      : 'podman is not installed',
  });

  return { runtime: null, availability: unavailableFrom(steps, platform), steps };
}

/* -------------------------------------------------------------------------- */
/* Turning "nothing works" into one command to type                           */
/* -------------------------------------------------------------------------- */

/**
 * Pick the single command most likely to make this machine usable, from what
 * the probes actually observed.
 *
 * Ranking, and why:
 *
 * 1. **A desktop runtime we found on disk wins**: OrbStack, Docker Desktop,
 *    Rancher. It is already the user's active docker context, so it is the
 *    runtime they chose; it is typically seconds to start; and we have *seen*
 *    the application, so the command is not a guess. This outranks Colima
 *    deliberately: recommending `colima start` to someone whose OrbStack is
 *    merely stopped tells them to boot a second, much heavier VM to replace a
 *    working one they already have.
 * 2. **Otherwise a stopped Colima profile**, which is the next most certain
 *    thing we can know: a complete, already-provisioned Linux VM that one verb
 *    starts. It also repairs a stale docker context for free, because the lane
 *    talks to Colima's socket directly rather than through the active context.
 * 3. **Otherwise a docker CLI with a dead daemon**, where we can only guess at
 *    which daemon it was: hence the rank below the two certainties.
 * 4. **Otherwise podman**, if it is installed but its machine is down.
 * 5. **Otherwise, install something.**
 */
export function unavailableFrom(
  steps: RuntimeProbeStep[],
  platform: NodeJS.Platform = process.platform,
): LaneAvailability {
  const step = (kind: ContainerRuntimeKind) => steps.find((entry) => entry.kind === kind);
  const docker = step('docker');
  const colima = step('colima');
  const podman = step('podman');

  const reason = `No usable container runtime, so headed browser work has nowhere safe to run. ${steps
    .map((entry) => entry.detail)
    .join('; ')}.`;

  // 1. A desktop runtime whose application bundle we actually found.
  const verified = steps.find((entry) => typeof entry.fix === 'string' && entry.fix.length > 0);
  if (verified?.fix) {
    return { available: false, reason, fix: verified.fix };
  }

  // 2. Colima installed but nothing running.
  if (colima?.installed) {
    const profile = /"([^"]+)" is (?!Running)/i.exec(colima.detail)?.[1];
    const fix =
      profile && profile !== 'default' ? `colima start --profile ${profile}` : 'colima start';
    return { available: false, reason, fix };
  }

  // 3. A docker CLI whose daemon is down and whose owner we could not identify.
  if (docker?.installed) {
    if (platform === 'darwin') {
      return { available: false, reason, fix: 'open -a Docker' };
    }
    if (platform === 'linux') {
      return { available: false, reason, fix: 'sudo systemctl start docker' };
    }
    return { available: false, reason, fix: 'start your Docker daemon' };
  }

  // 4. Podman installed, machine down.
  if (podman?.installed) {
    return {
      available: false,
      reason,
      fix: platform === 'linux' ? 'systemctl --user start podman.socket' : 'podman machine start',
    };
  }

  // 4. Nothing at all.
  return {
    available: false,
    reason,
    fix:
      platform === 'darwin'
        ? 'brew install colima docker && colima start'
        : 'sudo apt-get install -y docker.io && sudo systemctl start docker',
  };
}

/**
 * Render a probe as the lines `offstage doctor` prints. Kept here so the CLI
 * never has to know the shape of a probe step.
 */
export function describeRuntimeProbe(probe: ContainerRuntimeProbe): string[] {
  if (probe.runtime) {
    return [`container runtime: ${probe.runtime.description}`];
  }
  const lines = probe.steps.map((step) => `  - ${step.detail}`);
  return [
    'container runtime: none usable',
    ...lines,
    ...(probe.availability.fix ? [`  fix: ${probe.availability.fix}`] : []),
  ];
}
