/**
 * The container lane: headed browser work on a virtual framebuffer.
 *
 * This is the lane for commands that genuinely need a *headed* browser:
 * `--headed`, `headless: false`, extension loading, WebGL, video capture. It
 * runs them inside a Linux container that has its own X server (Xvfb) and its
 * own window manager, so the browser opens real windows onto memory the host
 * display never sees.
 *
 * ## Shape of a run
 *
 * ```text
 *   host                                   container (offstage-web:<hash>)
 *   ----                                   -------------------------------
 *   <repo>            --ro-->  /workspace            (cwd; never written to)
 *   <artifactsDir>    --rw-->  /offstage/artifacts   (everything the run keeps)
 *   browsers volume   --rw-->  /ms-playwright        (browser cache, reused)
 *                                          Xvfb :NN + fluxbox
 *                                            -- your command
 * ```
 *
 * The repository is mounted **read-only** on purpose: a run that mutates the
 * working tree is a run whose result you cannot trust twice. Everything the
 * command wants to keep goes to `$OFFSTAGE_ARTIFACTS`, which is the run's
 * `artifactsDir` on the host. (`repoMountMode: 'rw'` exists for tools that
 * insist on writing beside their config, and it is opt-in for that reason.)
 *
 * ## What this lane promises
 *
 * - **It never touches your screen.** No X socket is forwarded, no host
 *   `--display` is honoured, and `DISPLAY` in `req.env` is dropped rather than
 *   passed through. If no container runtime is usable, the lane returns
 *   `skipped` with the command to fix it: it does not "helpfully" fall back to
 *   running headed work on your actual desktop.
 * - **It never throws.** Missing runtime, failed build, timeout, a container
 *   that dies mid-run: all of them come back as a valid `LaneResult`.
 * - **It never leaks containers.** Every container is `--rm`, uniquely named,
 *   and force-removed on the timeout path.
 * - **It is safe to run concurrently.** Container names carry a random suffix,
 *   each container gets its own display number in its own namespace, and the
 *   artifacts directory is per-run by construction.
 *
 * ## Image lifecycle
 *
 * The image is tagged with a hash of `docker/offstage-web.Dockerfile` plus its
 * entrypoint, so the expensive build happens once per *content change* rather
 * than once per run, and an edit to either file produces a new tag instead of a
 * stale cached image. The build log lands in the run directory that triggered
 * the build.
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';

import { artifactPath, toRepoRelative } from '../../contract/artifacts.js';
import type {
  LaneArtifact,
  LaneAvailability,
  LaneFailure,
  LaneRequest,
  LaneResult,
  LaneRunner,
} from '../../contract/index.js';
import {
  createLaneResult,
  describeValidationError,
  parseLaneRequest,
  skippedResult,
  statusFromExitCode,
} from '../../contract/index.js';
import type { ContainerRuntime, ContainerRuntimeProbe, DetectRuntimeOptions } from './runtime.js';
import { detectContainerRuntime } from './runtime.js';

export * from './runtime.js';

/* -------------------------------------------------------------------------- */
/* Constants: the guest-side layout the Dockerfile and entrypoint agree on   */
/* -------------------------------------------------------------------------- */

/** Where the repository appears inside the container. */
export const GUEST_WORKSPACE = '/workspace';
/** Where `artifactsDir` appears inside the container. */
export const GUEST_ARTIFACTS = '/offstage/artifacts';
/** Where the persistent Playwright browser cache is mounted. */
export const GUEST_BROWSERS = '/ms-playwright';

/** Combined stdout/stderr of the command, inside `artifactsDir`. */
export const COMMAND_LOG = 'command.log';
/** End-of-run capture of the virtual display, inside `artifactsDir`. */
export const SCREENSHOT = 'screen.png';
/** Docker build output, written only on the runs that actually build. */
export const BUILD_LOG = 'image-build.log';

export const DEFAULT_IMAGE_NAME = 'offstage-web';
export const DEFAULT_SCREEN = '1280x900x24';
export const DEFAULT_BROWSERS_VOLUME = 'offstage-playwright-browsers';
/** 10 minutes: long enough for a real headed suite, short enough to notice. */
export const DEFAULT_RUN_TIMEOUT_MS = 600_000;
/** 30 minutes: a cold build pulls ~850 MB of X and Chromium dependencies. */
export const DEFAULT_BUILD_TIMEOUT_MS = 1_800_000;

const DOCKERFILE_NAME = 'offstage-web.Dockerfile';
const ENTRYPOINT_NAME = 'offstage-entrypoint.sh';

/* -------------------------------------------------------------------------- */
/* The exec seam                                                              */
/* -------------------------------------------------------------------------- */

export interface LaneExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * One command's outcome. `output` is stdout and stderr interleaved, which is
 * what a human reading `command.log` wants and what test reporters assume.
 */
export interface LaneExecResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  /** Set when the binary could not be spawned at all. */
  spawnError: string | null;
}

export type LaneExec = (
  file: string,
  args: string[],
  options: LaneExecOptions,
) => Promise<LaneExecResult>;

/** The real exec. Converts every failure mode into a value; never throws. */
export const defaultLaneExec: LaneExec = async (file, args, options) => {
  try {
    const result = await execa(file, args, {
      reject: false,
      all: true,
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      stdin: 'ignore',
      // A headed suite can be chatty; 64 MB before we start losing output.
      maxBuffer: 64 * 1024 * 1024,
    });
    const code = (result as { code?: string }).code;
    return {
      exitCode: typeof result.exitCode === 'number' ? result.exitCode : null,
      output: typeof result.all === 'string' ? result.all : '',
      timedOut: Boolean((result as { timedOut?: boolean }).timedOut),
      spawnError:
        code === 'ENOENT' || code === 'EACCES' ? `${file} could not be executed (${code})` : null,
    };
  } catch (error) {
    return {
      exitCode: null,
      output: '',
      timedOut: false,
      spawnError: error instanceof Error ? error.message : String(error),
    };
  }
};

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

export interface ContainerLaneOptions {
  /** Directory holding the Dockerfile and entrypoint. Defaults to `<pkg>/docker`. */
  dockerDir?: string;
  /** Image repository name; the tag is always a content hash. */
  imageName?: string;
  /** Xvfb geometry, `WIDTHxHEIGHTxDEPTH`. */
  screen?: string;
  /** Pin the X display number instead of choosing one per run. */
  displayNumber?: number;
  /** Default wall-clock budget when the request does not set `timeoutMs`. */
  defaultTimeoutMs?: number;
  /** Budget for `docker build`. */
  buildTimeoutMs?: number;
  /** How the repository is mounted. Read-only unless you have a reason. */
  repoMountMode?: 'ro' | 'rw';
  /** Named volume for the Playwright browser cache; `false` disables it. */
  browsersVolume?: string | false;
  /** `uid:gid` to run as, or `null` for the image default. Linux-only by default. */
  user?: string | null;
  /** Injection points for tests. */
  exec?: LaneExec;
  detect?: (options?: DetectRuntimeOptions) => Promise<ContainerRuntimeProbe>;
  now?: () => Date;
  rng?: () => number;
  platform?: NodeJS.Platform;
}

/* -------------------------------------------------------------------------- */
/* Pure helpers (exported so they can be tested without a runtime)            */
/* -------------------------------------------------------------------------- */

/** One file from the build context, as it contributes to the image tag. */
export interface DockerAssetFile {
  name: string;
  text: string;
}

/**
 * Tag the image by the content that defines it.
 *
 * *Every* file in the build context is hashed, not just the Dockerfile: the
 * image also depends on the entrypoint and the fluxbox configuration, and a tag
 * that ignored them would happily serve a stale image after someone fixed the
 * window manager. Names are hashed alongside contents, so renaming a file is a
 * change too.
 *
 * Twelve hex characters is 48 bits: collision-free for a build context that
 * changes a few dozen times in its life, and short enough to read in
 * `docker images`.
 */
export function imageTagFor(imageName: string, files: DockerAssetFile[]): string {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    hash.update(file.name, 'utf8').update('\0').update(file.text, 'utf8').update('\0');
  }
  return `${imageName}:${hash.digest('hex').slice(0, 12)}`;
}

/**
 * A container name that is unique per run and legal for docker/podman
 * (`[a-zA-Z0-9][a-zA-Z0-9_.-]*`).
 *
 * The run id stays in the name (readable in `docker ps`, and it ties a stray
 * container back to the run directory that spawned it) but the random suffix
 * is what actually guarantees two concurrent runs cannot collide, even if a
 * caller reuses an artifacts directory.
 */
export function containerNameFor(artifactsDir: string, unique: string): string {
  const base = path
    .basename(artifactsDir)
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, 40)
    .replace(/^[^a-zA-Z0-9]+/, '');
  return `offstage-${base || 'run'}-${unique}`;
}

/**
 * Map a path the container printed back to something the host can resolve.
 *
 * Test reporters print `/workspace/tests/a.spec.ts`; the contract wants
 * `tests/a.spec.ts`. Without this every parsed failure would point at a
 * directory that does not exist on the host.
 */
export function unmapGuestPath(cwd: string, candidate: string): string {
  if (candidate === GUEST_WORKSPACE) return cwd;
  if (candidate.startsWith(`${GUEST_WORKSPACE}/`)) {
    return path.join(cwd, candidate.slice(GUEST_WORKSPACE.length + 1));
  }
  return candidate;
}

/** Playwright list reporter: `  1) tests/a.spec.ts:5:3 > title ----------`. */
const PLAYWRIGHT_FAILURE =
  /^\s*\d+\)\s+(?:\[[^\]]+\]\s*[›>]\s*)?(\S+?):(\d+):(\d+)\s+[›>]\s+(.+?)\s*$/;
/** Vitest/Jest: `FAIL tests/a.test.ts > suite > case`. */
const VITEST_FAILURE = /^\s*(?:FAIL|[✕×])\s+(\S+?)(?:\s+[›>]\s+(.+?))?\s*$/;
const ERROR_LINE = /^\s*(?:Error|AssertionError|TypeError|ReferenceError|expect)\b/;
/** Trailing box-drawing rules Playwright pads its failure headers with. */
const TRAILING_RULE = /[\s─━┄┈-]{4,}$/;

/**
 * Best-effort structured failures from the command's output.
 *
 * Deliberately narrow: it understands Playwright's list reporter and
 * Vitest/Jest `FAIL` lines, and gives up on anything else rather than
 * hallucinating structure. The contract explicitly allows an empty `failures`
 * array next to `status: 'failed'`, when parsing finds nothing, the lane puts
 * the tail of the log in `diagnostics` instead, which is far more useful than a
 * confidently wrong file:line.
 */
export function parseFailures(log: string, cwd: string, limit = 25): LaneFailure[] {
  const lines = log.split('\n');
  const failures: LaneFailure[] = [];
  const seen = new Set<string>();

  const push = (failure: LaneFailure) => {
    const key = `${failure.file ?? ''}:${failure.line ?? ''}:${failure.test ?? ''}`;
    if (seen.has(key) || failures.length >= limit) return;
    seen.add(key);
    failures.push(failure);
  };

  // The message for a failure is the first error-looking line beneath it.
  const messageAfter = (index: number, fallback: string): string => {
    for (let i = index + 1; i < Math.min(index + 12, lines.length); i += 1) {
      const line = lines[i]?.trim();
      if (!line) continue;
      if (ERROR_LINE.test(line)) return line;
    }
    return fallback;
  };

  lines.forEach((rawLine, index) => {
    const playwright = PLAYWRIGHT_FAILURE.exec(rawLine);
    if (playwright) {
      const file = playwright[1] ?? '';
      const line = playwright[2] ?? '';
      const title = (playwright[4] ?? '').replace(TRAILING_RULE, '').trim();
      const relative = toRepoRelative(cwd, unmapGuestPath(cwd, file));
      const failure: LaneFailure = {
        message: messageAfter(index, title || 'test failed'),
      };
      if (title) failure.test = title;
      if (relative) {
        failure.file = relative;
        const parsedLine = Number.parseInt(line, 10);
        if (Number.isFinite(parsedLine) && parsedLine > 0) failure.line = parsedLine;
      }
      push(failure);
      return;
    }

    const vitest = VITEST_FAILURE.exec(rawLine);
    if (vitest) {
      const file = vitest[1] ?? '';
      const title = (vitest[2] ?? '').replace(TRAILING_RULE, '').trim();
      // Only trust it when the first token really looks like a source file, so
      // "FAIL to connect to the daemon" cannot become a test named "to".
      if (!/\.[cm]?[jt]sx?$/.test(file)) return;
      const relative = toRepoRelative(cwd, unmapGuestPath(cwd, file));
      const failure: LaneFailure = {
        message: messageAfter(index, title || `${file} failed`),
      };
      if (title) failure.test = title;
      if (relative) failure.file = relative;
      push(failure);
    }
  });

  return failures;
}

/** Last `count` non-empty lines of a log, clipped, for `diagnostics`. */
export function logTail(log: string, count = 20, maxChars = 4_000): string[] {
  const lines = log
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.length > 0);
  const tail = lines.slice(-count);
  let budget = maxChars;
  const kept: string[] = [];
  for (const line of tail) {
    if (budget - line.length < 0) break;
    budget -= line.length;
    kept.push(line);
  }
  return kept;
}

/* -------------------------------------------------------------------------- */
/* The run plan                                                               */
/* -------------------------------------------------------------------------- */

export interface RunPlanInput {
  runtime: ContainerRuntime;
  tag: string;
  cwd: string;
  artifactsDir: string;
  command: string[];
  env: Record<string, string>;
  containerName: string;
  displayNumber: number;
  screen: string;
  repoMountMode: 'ro' | 'rw';
  browsersVolume: string | false;
  user: string | null;
}

export interface RunPlan {
  bin: string;
  args: string[];
  /** Environment for the *client* process (e.g. Colima's `DOCKER_HOST`). */
  env: Record<string, string>;
  /** Environment variables that were refused. */
  dropped: string[];
}

/**
 * Turn a request into the exact argv for `docker run`.
 *
 * Split out from `run()` so the wiring can be asserted without a daemon, which
 * matters, because the machine this lane was written on has none, and "the
 * mounts and the display are right" is the part most worth pinning down.
 */
export function buildRunPlan(input: RunPlanInput): RunPlan {
  const dropped: string[] = [];
  const guestScreenshot = path.posix.join(GUEST_ARTIFACTS, SCREENSHOT);

  const envArgs: string[] = [];
  for (const [key, value] of Object.entries(input.env)) {
    // The lane owns the display and the screenshot destination. Honouring a
    // caller-supplied DISPLAY is precisely how headed work escapes onto a real
    // screen, so it is dropped rather than forwarded.
    if (key === 'DISPLAY' || key === 'OFFSTAGE_SCREENSHOT' || key === 'OFFSTAGE_ARTIFACTS') {
      dropped.push(key);
      continue;
    }
    envArgs.push('-e', `${key}=${value}`);
  }

  const args = [
    'run',
    '--rm',
    '--init',
    '--name',
    input.containerName,
    '-v',
    `${input.cwd}:${GUEST_WORKSPACE}:${input.repoMountMode}`,
    '-v',
    `${input.artifactsDir}:${GUEST_ARTIFACTS}`,
    '-w',
    GUEST_WORKSPACE,
  ];

  if (input.browsersVolume) {
    args.push('-v', `${input.browsersVolume}:${GUEST_BROWSERS}`);
    args.push('-e', `PLAYWRIGHT_BROWSERS_PATH=${GUEST_BROWSERS}`);
  }

  if (input.user) {
    // Keeps artifacts owned by the human on Linux, where bind mounts do not
    // remap ownership the way the macOS runtimes do.
    args.push('--user', input.user, '-e', 'HOME=/tmp');
  }

  args.push(
    '-e',
    'OFFSTAGE_LANE=container',
    '-e',
    `OFFSTAGE_DISPLAY_NUM=${input.displayNumber}`,
    '-e',
    `OFFSTAGE_SCREEN=${input.screen}`,
    '-e',
    `OFFSTAGE_ARTIFACTS=${GUEST_ARTIFACTS}`,
    '-e',
    `OFFSTAGE_SCREENSHOT=${guestScreenshot}`,
  );

  args.push(...envArgs, input.tag, ...input.command);

  return { bin: input.runtime.bin, args, env: input.runtime.env, dropped };
}

/* -------------------------------------------------------------------------- */
/* Locating the image sources                                                 */
/* -------------------------------------------------------------------------- */

export interface DockerAssets {
  dir: string;
  /** Absolute path to the Dockerfile. */
  dockerfile: string;
  /** Absolute path to the entrypoint script. */
  entrypoint: string;
  /** Every file in the build context, sorted: this is what the tag hashes. */
  files: DockerAssetFile[];
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Candidate locations for `docker/`, in confidence order.
 *
 * `src/lanes/container/` and `dist/lanes/container/` are both three levels
 * below the package root, so the first candidate is right whether the code runs
 * from TypeScript or from a build. The rest cover an unusual layout and being
 * invoked from a checkout.
 */
export function dockerDirCandidates(fromDir: string = moduleDir): string[] {
  return [
    path.resolve(fromDir, '..', '..', '..', 'docker'),
    path.resolve(fromDir, '..', '..', '..', '..', 'docker'),
    path.resolve(process.cwd(), 'docker'),
  ];
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Find and read the Dockerfile + entrypoint, or explain where we looked. */
export async function loadDockerAssets(
  explicitDir?: string,
): Promise<{ assets: DockerAssets } | { error: string }> {
  const candidates = explicitDir ? [path.resolve(explicitDir)] : dockerDirCandidates();
  for (const dir of candidates) {
    const dockerfile = path.join(dir, DOCKERFILE_NAME);
    const entrypoint = path.join(dir, ENTRYPOINT_NAME);
    if ((await readIfPresent(dockerfile)) === null) continue;
    if ((await readIfPresent(entrypoint)) === null) {
      return {
        error: `${dockerfile} exists but ${ENTRYPOINT_NAME} is missing beside it; the image cannot be built.`,
      };
    }

    // The whole directory is the build context, so the whole directory decides
    // the tag. Anything unreadable is recorded as empty rather than skipped, so
    // it still participates in the hash by name.
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const files: DockerAssetFile[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      files.push({ name: entry.name, text: (await readIfPresent(path.join(dir, entry.name))) ?? '' });
    }
    files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    return { assets: { dir, dockerfile, entrypoint, files } };
  }
  return { error: `Could not find ${DOCKERFILE_NAME}. Looked in: ${candidates.join(', ')}.` };
}

/* -------------------------------------------------------------------------- */
/* The lane                                                                   */
/* -------------------------------------------------------------------------- */

export interface ContainerLane extends LaneRunner {
  readonly lane: 'container';
  /** The probe behind `isAvailable()`, with every step it considered. */
  probe(): Promise<ContainerRuntimeProbe>;
}

export function createContainerLane(options: ContainerLaneOptions = {}): ContainerLane {
  const exec = options.exec ?? defaultLaneExec;
  const detect = options.detect ?? detectContainerRuntime;
  const now = options.now ?? (() => new Date());
  const rng = options.rng ?? Math.random;
  const platform = options.platform ?? process.platform;
  const imageName = options.imageName ?? DEFAULT_IMAGE_NAME;
  const screen = options.screen ?? DEFAULT_SCREEN;
  const repoMountMode = options.repoMountMode ?? 'ro';
  const browsersVolume =
    options.browsersVolume === undefined ? DEFAULT_BROWSERS_VOLUME : options.browsersVolume;
  const buildTimeoutMs = options.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;

  const resolveUser = (): string | null => {
    if (options.user !== undefined) return options.user;
    if (platform !== 'linux') return null;
    const getuid = process.getuid?.bind(process);
    const getgid = process.getgid?.bind(process);
    if (!getuid || !getgid) return null;
    return `${getuid()}:${getgid()}`;
  };

  const probe = (): Promise<ContainerRuntimeProbe> => detect();

  async function isAvailable(): Promise<LaneAvailability> {
    try {
      const result = await probe();
      if (!result.runtime) return result.availability;

      // A runtime with no image sources is still an unusable lane, and saying
      // so here is much kinder than failing at build time.
      const assets = await loadDockerAssets(options.dockerDir);
      if ('error' in assets) {
        return {
          available: false,
          reason: `${result.runtime.description} is usable, but the container lane's image sources are missing. ${assets.error}`,
        };
      }
      return { available: true };
    } catch (error) {
      // isAvailable() must not throw, even if an injected probe does.
      // No `fix` here on purpose: this is a bug in the probe, not a state of
      // the machine, so any command we named would be a guess.
      return {
        available: false,
        reason: `Probing for a container runtime failed unexpectedly: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /** `docker image inspect` to reuse, else build. Returns diagnostics either way. */
  async function ensureImage(
    runtime: ContainerRuntime,
    assets: DockerAssets,
    artifactsDir: string,
  ): Promise<
    | { ok: true; tag: string; built: boolean; diagnostics: string[]; artifacts: LaneArtifact[] }
    | { ok: false; tag: string; diagnostics: string[]; artifacts: LaneArtifact[] }
  > {
    const tag = imageTagFor(imageName, assets.files);
    const inspect = await exec(runtime.bin, ['image', 'inspect', tag], {
      env: runtime.env,
      timeoutMs: 60_000,
    });
    if (inspect.exitCode === 0) {
      return {
        ok: true,
        tag,
        built: false,
        diagnostics: [`image: ${tag} (already present, no build needed)`],
        artifacts: [],
      };
    }

    const buildStartedMs = now().getTime();
    const build = await exec(
      runtime.bin,
      ['build', '-f', assets.dockerfile, '-t', tag, assets.dir],
      { env: runtime.env, timeoutMs: buildTimeoutMs },
    );
    const buildLogPath = artifactPath(artifactsDir, BUILD_LOG);
    await fs.writeFile(buildLogPath, build.output, 'utf8').catch(() => undefined);
    const artifacts: LaneArtifact[] = [{ kind: 'log', path: buildLogPath }];
    const seconds = Math.max(0, Math.round((now().getTime() - buildStartedMs) / 1000));

    if (build.exitCode !== 0) {
      const why = build.timedOut
        ? `the build exceeded its ${Math.round(buildTimeoutMs / 1000)}s budget`
        : (build.spawnError ?? `${runtime.bin} build exited ${String(build.exitCode)}`);
      return {
        ok: false,
        tag,
        artifacts,
        diagnostics: [
          `Building ${tag} failed: ${why}.`,
          `Full build log: ${buildLogPath}`,
          ...logTail(build.output, 20),
        ],
      };
    }

    return {
      ok: true,
      tag,
      built: true,
      diagnostics: [`image: ${tag} (built in ${seconds}s from ${assets.dockerfile})`],
      artifacts,
    };
  }

  async function run(request: LaneRequest): Promise<LaneResult> {
    const started = now();
    const startedAt = started.toISOString();
    const startedMs = started.getTime();
    // Resolved defensively first: even a malformed request has to come back as
    // a *valid* LaneResult, and every LaneResult needs an absolute artifactsDir.
    const artifactsDir = path.resolve(
      typeof request?.artifactsDir === 'string' && request.artifactsDir.length > 0
        ? request.artifactsDir
        : path.join(process.cwd(), '.offstage', 'runs', 'unknown'),
    );

    const errored = (diagnostics: string[], extra: Partial<LaneResult> = {}): LaneResult =>
      createLaneResult({
        lane: 'container',
        status: 'errored',
        artifactsDir,
        startedAt,
        durationMs: Math.max(0, now().getTime() - startedMs),
        diagnostics,
        ...extra,
      });

    try {
      let validated: LaneRequest;
      try {
        validated = parseLaneRequest(request);
      } catch (error) {
        const issues =
          error && typeof error === 'object' && 'issues' in error
            ? describeValidationError(error as Parameters<typeof describeValidationError>[0])
            : [error instanceof Error ? error.message : String(error)];
        return errored(['The request does not satisfy the lane contract.', ...issues]);
      }

      const cwd = path.resolve(validated.cwd);
      await fs.mkdir(artifactsDir, { recursive: true });

      /* --- substrate ------------------------------------------------------ */

      const runtimeProbe = await probe();
      if (!runtimeProbe.runtime) {
        const result = skippedResult('container', artifactsDir, runtimeProbe.availability);
        return createLaneResult({
          ...result,
          startedAt,
          diagnostics: [
            ...result.diagnostics,
            'Probed, in order:',
            ...runtimeProbe.steps.map((step) => `  - ${step.detail}`),
          ],
        });
      }
      const runtime = runtimeProbe.runtime;

      const found = await loadDockerAssets(options.dockerDir);
      if ('error' in found) return errored([found.error]);
      const assets = found.assets;

      /* --- image ---------------------------------------------------------- */

      const image = await ensureImage(runtime, assets, artifactsDir);
      if (!image.ok) {
        return errored([`runtime: ${runtime.description}`, ...image.diagnostics], {
          artifacts: image.artifacts,
        });
      }

      /* --- run ------------------------------------------------------------ */

      const unique = randomBytes(4).toString('hex');
      const containerName = containerNameFor(artifactsDir, unique);
      // Namespacing already isolates :99 in one container from :99 in another;
      // varying it anyway keeps a run safe if someone shares an IPC or PID
      // namespace, or reuses a container.
      const displayNumber = options.displayNumber ?? 90 + Math.min(99, Math.floor(rng() * 100));
      const timeoutMs = validated.timeoutMs ?? defaultTimeoutMs;

      const plan = buildRunPlan({
        runtime,
        tag: image.tag,
        cwd,
        artifactsDir,
        command: validated.command,
        env: validated.env ?? {},
        containerName,
        displayNumber,
        screen,
        repoMountMode,
        browsersVolume,
        user: resolveUser(),
      });

      const execution = await exec(plan.bin, plan.args, { env: plan.env, timeoutMs, cwd });

      const logPath = artifactPath(artifactsDir, COMMAND_LOG);
      await fs.writeFile(logPath, execution.output, 'utf8').catch(() => undefined);

      const artifacts: LaneArtifact[] = [...image.artifacts, { kind: 'log', path: logPath }];
      const diagnostics: string[] = [
        `runtime: ${runtime.description}`,
        ...image.diagnostics,
        `container: ${containerName} (--rm, --init)`,
        `display: :${displayNumber} at ${screen} on Xvfb inside the container - the host display was never opened`,
        `mounts: ${cwd} -> ${GUEST_WORKSPACE} (${repoMountMode}), ${artifactsDir} -> ${GUEST_ARTIFACTS} (rw)${
          browsersVolume ? `, volume ${browsersVolume} -> ${GUEST_BROWSERS} (rw)` : ''
        }`,
      ];
      if (plan.dropped.length > 0) {
        diagnostics.push(
          `dropped from env: ${plan.dropped.join(', ')} - the container lane owns the display and the screenshot path.`,
        );
      }

      /* --- screenshot ----------------------------------------------------- */

      const screenshotPath = artifactPath(artifactsDir, SCREENSHOT);
      const shot = await fs.stat(screenshotPath).catch(() => null);
      if (shot && shot.size > 0) {
        artifacts.push({ kind: 'screenshot', path: screenshotPath });
        diagnostics.push(`screenshot: ${screenshotPath} (${shot.size} bytes)`);
      } else {
        diagnostics.push(
          'screenshot: not captured - the container was killed before the entrypoint could grab the framebuffer, or the capture failed (see command.log).',
        );
      }

      /* --- timeout -------------------------------------------------------- */

      if (execution.timedOut) {
        // `docker run` normally tears the container down on SIGTERM, but the
        // lane promises never to leak one, so make sure of it.
        const removal = await exec(plan.bin, ['rm', '-f', containerName], {
          env: plan.env,
          timeoutMs: 30_000,
        });
        diagnostics.push(
          `Timed out after ${timeoutMs}ms. The command was killed; nothing can be concluded about the code under test.`,
          removal.exitCode === 0
            ? `Removed container ${containerName}.`
            : `Cleanup of ${containerName} reported: ${
                logTail(removal.output, 2).join(' ') || `exit ${String(removal.exitCode)}`
              } (it was started with --rm, so it should already be gone).`,
          ...logTail(execution.output, 20),
        );
        return createLaneResult({
          lane: 'container',
          status: 'errored',
          artifactsDir,
          startedAt,
          durationMs: Math.max(0, now().getTime() - startedMs),
          exitCode: null,
          logPath,
          artifacts,
          diagnostics,
        });
      }

      if (execution.spawnError) {
        diagnostics.push(`Could not start ${plan.bin}: ${execution.spawnError}`);
        return createLaneResult({
          lane: 'container',
          status: 'errored',
          artifactsDir,
          startedAt,
          durationMs: Math.max(0, now().getTime() - startedMs),
          logPath,
          artifacts,
          diagnostics,
        });
      }

      /* --- normalize ------------------------------------------------------ */

      const status = statusFromExitCode(execution.exitCode);
      const failures = status === 'failed' ? parseFailures(execution.output, cwd) : [];
      if (status === 'failed' && failures.length === 0) {
        diagnostics.push(
          'No structured failures were recognised in the output; the tail of the log follows.',
          ...logTail(execution.output, 20),
        );
      }
      if (status === 'errored') {
        diagnostics.push(
          'The container exited without an exit code (killed by a signal).',
          ...logTail(execution.output, 20),
        );
      }

      return createLaneResult({
        lane: 'container',
        status,
        artifactsDir,
        startedAt,
        durationMs: Math.max(0, now().getTime() - startedMs),
        exitCode: execution.exitCode,
        logPath,
        artifacts,
        failures,
        diagnostics,
      });
    } catch (error) {
      // The contract says run() never throws. This is the net under everything
      // above: an unexpected EACCES on mkdir, a full disk, anything.
      return errored([
        'The container lane failed unexpectedly and nothing was executed.',
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      ]);
    }
  }

  return { lane: 'container', isAvailable, run, probe };
}

/** The lane, wired to the real world. */
export const containerLane: ContainerLane = createContainerLane();

export default containerLane;
