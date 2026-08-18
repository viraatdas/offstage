/**
 * Finding the third-party pieces the VM lane delegates to.
 *
 * offstage does not manage macOS VMs. `novotnyllc/tart-xcode-runner` already
 * does that — golden image, disposable clone per run, read-only source share,
 * results export, rollback — and this lane is an adapter over its `tart-runner`
 * script. So the VM lane's first job is simply to locate two things it does not
 * own:
 *
 * 1. `tart` — the hypervisor CLI the runner shells to.
 * 2. `tart-runner` — the zsh script inside the installed plugin.
 *
 * Neither is a dependency offstage can install for the user: Tart is a Homebrew
 * formula and the runner arrives as a Claude Code / Codex plugin. So the whole
 * value of this module is in the *not found* path — saying precisely which of
 * the two is missing and the exact command that fixes it. Everything here is
 * read-only: it stats files and reads a JSON manifest, and never spawns `tart`,
 * boots a VM, or mutates anything.
 *
 * ## Search order for the runner
 *
 * 1. `OFFSTAGE_TART_RUNNER` — explicit override, wins over everything. If it is
 *    set and wrong, that is an error rather than a silent fallback: someone
 *    pointing at a specific runner wants to know their path is broken.
 * 2. The Claude Code plugin install location, preferring the authoritative
 *    `installed_plugins.json` manifest and falling back to scanning the plugin
 *    cache. The Codex plugin cache is searched the same way.
 * 3. A configured path — `tartRunner` in `<repo>/.offstage/config.json`, or a
 *    `configuredPath` passed by the caller.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Env var holding an explicit absolute path to the `tart-runner` script. */
export const RUNNER_ENV_VAR = 'OFFSTAGE_TART_RUNNER';

/** Plugin name, as published on the `novotnyllc` marketplace. */
export const PLUGIN_NAME = 'tart-xcode-runner';

/** Path of the runner script relative to the plugin root. */
export const RUNNER_RELATIVE_PATH = path.join(
  'skills',
  'tart-xcode-runner',
  'references',
  'tart-runner',
);

/** Repository-relative config file the lane reads its configured path from. */
export const CONFIG_RELATIVE_PATH = path.join('.offstage', 'config.json');

/**
 * Install Tart.
 *
 * Verified against the upstream runner's own `need_tart` failure message and
 * the project README (v0.4.11): Tart is consumed from the `openai/tools` tap,
 * which requires an explicit `brew trust` before install. The older
 * `cirruslabs/cli/tart` formula still exists and also produces a working
 * `tart` on PATH, so it is offered as an alternative rather than the headline.
 */
export const TART_INSTALL_FIX =
  'brew tap openai/tools && brew trust --tap openai/tools && brew install openai/tools/tart';

/** The `cirruslabs` formula, still a valid way to get `tart` onto PATH. */
export const TART_INSTALL_FIX_ALTERNATIVE = 'brew install cirruslabs/cli/tart';

/**
 * Install the runner. Two steps, because the plugin lives on a third-party
 * marketplace that has to be registered before the plugin resolves.
 */
export const RUNNER_INSTALL_FIX =
  'claude plugin marketplace add novotnyllc/marketplace && ' +
  'claude plugin install tart-xcode-runner@novotnyllc';

/** Apple Silicon only — Tart is built on Virtualization.framework. */
export const REQUIRED_ARCH = 'arm64';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** Where a discovered path came from, for diagnostics and for tests. */
export type DiscoverySource =
  | 'env'
  | 'claude-plugin-manifest'
  | 'claude-plugin-cache'
  | 'codex-plugin-cache'
  | 'config-file'
  | 'configured-option'
  | 'path';

/** A successful discovery. */
export interface Discovered {
  found: true;
  path: string;
  source: DiscoverySource;
}

/**
 * A failed discovery.
 *
 * `reason` says what is missing in human terms; `fix` is a literal command to
 * paste. `searched` lists every location that was checked, so a user whose
 * plugin lives somewhere unusual can see that offstage looked and where.
 */
export interface NotDiscovered {
  found: false;
  reason: string;
  fix: string;
  searched: string[];
}

export type Discovery = Discovered | NotDiscovered;

export interface DiscoverOptions {
  /** Environment to read overrides from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Repository root, used to find `.offstage/config.json`. */
  cwd?: string;
  /** Explicit configured path, e.g. supplied by the CLI. */
  configuredPath?: string;
  /** Home directory override, so tests can point at a synthetic layout. */
  homeDir?: string;
  /** Platform override, for testing the non-macOS message. */
  platform?: NodeJS.Platform;
  /** Architecture override, for testing the Intel-Mac message. */
  arch?: string;
}

/* -------------------------------------------------------------------------- */
/* Filesystem probes                                                          */
/* -------------------------------------------------------------------------- */

/** True when `candidate` is an existing regular file (following symlinks). */
async function isFile(candidate: string): Promise<boolean> {
  try {
    const stats = await fs.stat(candidate);
    return stats.isFile();
  } catch {
    return false;
  }
}

/** Directory entries of `dir`, or `[]` when it does not exist. Never throws. */
async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* tart                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Locate the `tart` binary by walking `PATH` ourselves.
 *
 * Deliberately not `which tart` or `tart --version`: `isAvailable()` must not
 * spawn anything, and a `stat` is both faster and impossible to misinterpret.
 */
export async function discoverTart(options: DiscoverOptions = {}): Promise<Discovery> {
  const env = options.env ?? process.env;
  const searched: string[] = [];

  const explicit = env.OFFSTAGE_TART_BIN?.trim();
  if (explicit) {
    searched.push(explicit);
    if (await isFile(explicit)) return { found: true, path: explicit, source: 'env' };
    return {
      found: false,
      reason: `OFFSTAGE_TART_BIN points at ${explicit}, which is not a file.`,
      fix: `Unset OFFSTAGE_TART_BIN or point it at a real tart binary. To install Tart: ${TART_INSTALL_FIX}`,
      searched,
    };
  }

  const pathEntries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, 'tart');
    searched.push(candidate);
    if (await isFile(candidate)) return { found: true, path: candidate, source: 'path' };
  }

  return {
    found: false,
    reason: 'Tart is not installed: no `tart` binary on PATH.',
    fix: `${TART_INSTALL_FIX} (alternative formula: ${TART_INSTALL_FIX_ALTERNATIVE})`,
    searched,
  };
}

/* -------------------------------------------------------------------------- */
/* tart-runner                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Plugin roots recorded in Claude Code's `installed_plugins.json`.
 *
 * This is the authoritative answer — it carries the exact `installPath`,
 * including the version segment that the cache layout appends
 * (`cache/<marketplace>/<plugin>/<version>`). Any marketplace is accepted:
 * the plugin is published on `novotnyllc`, but a fork or a local marketplace
 * is just as valid a place to install it from.
 */
async function pluginRootsFromManifest(homeDir: string): Promise<string[]> {
  const manifest = path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
  let raw: string;
  try {
    raw = await fs.readFile(manifest, 'utf8');
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A corrupt manifest is not this lane's problem to report; scanning the
    // cache directly still finds the plugin.
    return [];
  }

  const plugins = (parsed as { plugins?: Record<string, unknown> } | null)?.plugins;
  if (!plugins || typeof plugins !== 'object') return [];

  const roots: string[] = [];
  for (const [key, value] of Object.entries(plugins)) {
    if (key !== PLUGIN_NAME && !key.startsWith(`${PLUGIN_NAME}@`)) continue;
    for (const install of Array.isArray(value) ? value : [value]) {
      const installPath = (install as { installPath?: unknown } | null)?.installPath;
      if (typeof installPath === 'string' && installPath.length > 0) roots.push(installPath);
    }
  }
  return roots;
}

/**
 * Plugin roots found by scanning a plugin cache directory.
 *
 * The layout is `cache/<marketplace>/<plugin>/<version>`, but older installs
 * omit the version segment, so both depths are tried. Used when the manifest is
 * absent, unreadable, or stale.
 */
async function pluginRootsFromCache(cacheDir: string): Promise<string[]> {
  const roots: string[] = [];
  for (const marketplace of await listDirs(cacheDir)) {
    const pluginDir = path.join(cacheDir, marketplace, PLUGIN_NAME);
    // Older layout: the plugin root is the plugin directory itself.
    roots.push(pluginDir);
    // Current layout: one directory per installed version underneath it.
    for (const version of await listDirs(pluginDir)) {
      roots.push(path.join(pluginDir, version));
    }
  }
  return roots;
}

/** Read `tartRunner` out of `<cwd>/.offstage/config.json`. Never throws. */
async function configuredRunnerPath(cwd: string): Promise<string | null> {
  const configFile = path.join(cwd, CONFIG_RELATIVE_PATH);
  let raw: string;
  try {
    raw = await fs.readFile(configFile, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { tartRunner?: unknown } | null;
    const value = parsed?.tartRunner;
    return typeof value === 'string' && value.length > 0 ? path.resolve(cwd, value) : null;
  } catch {
    return null;
  }
}

/**
 * Locate the `tart-runner` script.
 *
 * Order: `OFFSTAGE_TART_RUNNER`, then the plugin install location, then a
 * configured path. The override comes first because it is the only one of the
 * three that someone typed on purpose for this specific run.
 */
export async function discoverTartRunner(options: DiscoverOptions = {}): Promise<Discovery> {
  const env = options.env ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const homeDir = options.homeDir ?? os.homedir();
  const searched: string[] = [];

  /* 1. Explicit env override. A wrong value here is an error, never a
        fallback — a user who set this wants to know it did not resolve. */
  const override = env[RUNNER_ENV_VAR]?.trim();
  if (override) {
    const resolved = path.resolve(override);
    searched.push(resolved);
    if (await isFile(resolved)) return { found: true, path: resolved, source: 'env' };
    return {
      found: false,
      reason: `${RUNNER_ENV_VAR} is set to ${override}, but no tart-runner script exists there.`,
      fix:
        `Point ${RUNNER_ENV_VAR} at <plugin-root>/${RUNNER_RELATIVE_PATH}, ` +
        `or unset it and install the plugin: ${RUNNER_INSTALL_FIX}`,
      searched,
    };
  }

  /* 2. The plugin install location — manifest first, then cache scans. */
  const claudeCache = path.join(homeDir, '.claude', 'plugins', 'cache');
  const codexCache = path.join(homeDir, '.codex', 'plugins', 'cache');
  const sources: Array<{ source: DiscoverySource; scanned: string; roots: string[] }> = [
    {
      source: 'claude-plugin-manifest',
      scanned: path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'),
      roots: await pluginRootsFromManifest(homeDir),
    },
    {
      source: 'claude-plugin-cache',
      scanned: claudeCache,
      roots: await pluginRootsFromCache(claudeCache),
    },
    {
      source: 'codex-plugin-cache',
      scanned: codexCache,
      roots: await pluginRootsFromCache(codexCache),
    },
  ];

  for (const { source, scanned, roots } of sources) {
    // Record the location even when it yielded no candidates: "we looked in
    // your plugin cache and it is empty" is the useful half of the message.
    searched.push(scanned);
    for (const root of roots) {
      const candidate = path.join(root, RUNNER_RELATIVE_PATH);
      searched.push(candidate);
      if (await isFile(candidate)) return { found: true, path: candidate, source };
    }
  }

  /* 3. A configured path: the caller's explicit option, then the repo config. */
  if (options.configuredPath) {
    const resolved = path.resolve(cwd, options.configuredPath);
    searched.push(resolved);
    if (await isFile(resolved)) return { found: true, path: resolved, source: 'configured-option' };
  }

  const fromConfig = await configuredRunnerPath(cwd);
  if (fromConfig) {
    searched.push(fromConfig);
    if (await isFile(fromConfig)) return { found: true, path: fromConfig, source: 'config-file' };
  }

  return {
    found: false,
    reason:
      'The tart-xcode-runner plugin is not installed: no tart-runner script found in the ' +
      'Claude Code or Codex plugin caches.',
    fix:
      `${RUNNER_INSTALL_FIX} — or, if it is already installed somewhere else, set ` +
      `${RUNNER_ENV_VAR}=<plugin-root>/${RUNNER_RELATIVE_PATH}`,
    searched,
  };
}

/* -------------------------------------------------------------------------- */
/* Host capability                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Whether this machine could ever run the VM lane.
 *
 * Tart is built on Apple's Virtualization.framework, so it is Apple Silicon
 * macOS only. On anything else the answer is not "install something" — there is
 * nothing to install — and saying so plainly is more useful than a brew command
 * that cannot help.
 */
export function checkHost(options: DiscoverOptions = {}): NotDiscovered | null {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  if (platform !== 'darwin') {
    return {
      found: false,
      reason: `The vm lane needs macOS; this host is ${platform}.`,
      fix: 'Run macOS-native work on an Apple Silicon Mac. There is no Tart build for this platform.',
      searched: [],
    };
  }
  if (arch !== REQUIRED_ARCH) {
    return {
      found: false,
      reason: `The vm lane needs an Apple Silicon Mac; this host is ${arch}.`,
      fix: "Run macOS-native work on an Apple Silicon Mac. Tart uses Apple's Virtualization.framework, which Intel Macs cannot host macOS guests on.",
      searched: [],
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Combined                                                                   */
/* -------------------------------------------------------------------------- */

/** Everything the lane needs in order to run, resolved in one pass. */
export interface VmToolchain {
  /** Absolute path to `tart`, or `null` when it is missing. */
  tart: string | null;
  /** Absolute path to `tart-runner`, or `null` when it is missing. */
  runner: string | null;
  /** Every problem found, in the order a user should fix them. */
  problems: NotDiscovered[];
  /** Where each found tool came from, for diagnostics. */
  sources: { tart?: DiscoverySource; runner?: DiscoverySource };
}

/**
 * Resolve host, `tart` and `tart-runner` together.
 *
 * All problems are collected rather than short-circuited: a machine with
 * neither Tart nor the plugin should be told both, once, instead of learning
 * about the second only after fixing the first.
 */
export async function discoverToolchain(options: DiscoverOptions = {}): Promise<VmToolchain> {
  const problems: NotDiscovered[] = [];
  const sources: VmToolchain['sources'] = {};

  const hostProblem = checkHost(options);
  if (hostProblem) {
    // A non-Apple-Silicon host cannot be fixed by installing anything, so
    // probing for tools would only add noise to the report.
    return { tart: null, runner: null, problems: [hostProblem], sources };
  }

  const [tart, runner] = await Promise.all([
    discoverTart(options),
    discoverTartRunner(options),
  ]);

  if (tart.found) sources.tart = tart.source;
  else problems.push(tart);

  if (runner.found) sources.runner = runner.source;
  else problems.push(runner);

  return {
    tart: tart.found ? tart.path : null,
    runner: runner.found ? runner.path : null,
    problems,
    sources,
  };
}

/**
 * Collapse a toolchain into the contract's `LaneAvailability` shape.
 *
 * Multiple problems are joined rather than truncated: `offstage doctor` renders
 * this verbatim, and a user with a bare machine needs both commands.
 */
export function toAvailability(toolchain: VmToolchain): {
  available: boolean;
  reason?: string;
  fix?: string;
} {
  if (toolchain.problems.length === 0) return { available: true };
  return {
    available: false,
    reason: toolchain.problems.map((problem) => problem.reason).join(' '),
    fix: toolchain.problems.map((problem) => problem.fix).join('\n'),
  };
}
