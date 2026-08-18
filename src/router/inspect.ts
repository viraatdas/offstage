/**
 * offstage — read-only inspection of the repository the command runs against.
 *
 * The router is allowed to *read* a few small, well-known files to sharpen its
 * answer: `package.json` (to resolve `npm test` into the command it actually
 * runs), `playwright.config.*` (which is where `headless: false` usually
 * hides), the vitest config (browser mode), and any local script the command
 * names (`node scripts/scrape.js`, which is how puppeteer normally shows up).
 *
 * Three rules hold for everything in this file:
 *
 * 1. **Read-only, and only inside `cwd`.** Nothing is created, moved, or
 *    executed, and a path that escapes the repository is refused rather than
 *    followed.
 * 2. **Missing is normal.** Every probe returns `undefined` for a file that is
 *    absent, unreadable, malformed, or implausibly large. A repository with no
 *    `package.json` is not an error; it is simply less information.
 * 3. **Bounded.** A handful of `stat`+`readFile` calls on files under a size
 *    cap, memoized per `classify()` call, so classifying is cheap enough to do
 *    on every invocation without thinking about it.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { isInside } from '../contract/index.js';

/** Config files are small; anything larger is generated and not worth reading. */
const MAX_CONFIG_BYTES = 1024 * 1024;

/** A file the router read, with comments already stripped out of `text`. */
export interface InspectedFile {
  /** Repository-relative POSIX path, for printing in a signal. */
  file: string;
  /** Absolute host path that was read. */
  absolutePath: string;
  /** File contents with comments removed, so `// headless: false` is not a lie. */
  text: string;
}

/** What `package.json` tells the router. */
export interface PackageFacts {
  file: string;
  scripts: Record<string, string>;
  /** Every dependency name, across all dependency sections. */
  dependencies: Set<string>;
}

const PLAYWRIGHT_CONFIG_NAMES = [
  'playwright.config.ts',
  'playwright.config.mts',
  'playwright.config.cts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
];

const VITEST_CONFIG_NAMES = [
  'vitest.config.ts',
  'vitest.config.mts',
  'vitest.config.cts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
  'vite.config.ts',
  'vite.config.mts',
  'vite.config.js',
  'vite.config.mjs',
];

const PUPPETEER_CONFIG_NAMES = [
  'puppeteer.config.ts',
  'puppeteer.config.js',
  'puppeteer.config.mjs',
  'puppeteer.config.cjs',
  '.puppeteerrc.cjs',
  '.puppeteerrc.js',
];

/** Extensions the router is willing to open when a command names a local file. */
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx']);

/**
 * Strip `//` and block comments without touching string literals, so a
 * commented-out `// headless: false` does not route someone into a container.
 */
export function stripComments(source: string): string {
  let out = '';
  let quote: '"' | "'" | '`' | null = null;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source.charAt(i);
    const next = source.charAt(i + 1);

    if (quote !== null) {
      out += ch;
      if (ch === '\\' && i + 1 < source.length) {
        i += 1;
        out += source.charAt(i);
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < source.length && source.charAt(i) !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source.charAt(i) === '*' && source.charAt(i + 1) === '/')) i += 1;
      i += 1;
      out += ' ';
      continue;
    }
    out += ch;
  }

  return out;
}

async function readSmallFile(absolutePath: string): Promise<string | undefined> {
  try {
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile() || stats.size > MAX_CONFIG_BYTES) return undefined;
    return await fs.readFile(absolutePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * A memoized, read-only view of one repository.
 *
 * Every method is safe to call repeatedly and safe to call on a directory that
 * does not exist; each distinct file is read at most once per inspector.
 */
export interface Inspector {
  readonly cwd: string;
  packageJson(): Promise<PackageFacts | undefined>;
  /** The playwright config, or the one named by `--config`, if it is readable. */
  playwrightConfig(explicitPath?: string): Promise<InspectedFile | undefined>;
  vitestConfig(explicitPath?: string): Promise<InspectedFile | undefined>;
  puppeteerConfig(): Promise<InspectedFile | undefined>;
  /** A local source file named by the command, e.g. `node scripts/scrape.js`. */
  localScript(reference: string): Promise<InspectedFile | undefined>;
  /** `.xcodeproj` / `.xcworkspace` bundles sitting at the repository root. */
  xcodeProjects(): Promise<string[]>;
}

export function createInspector(cwd: string): Inspector {
  const files = new Map<string, Promise<InspectedFile | undefined>>();
  let packageJsonPromise: Promise<PackageFacts | undefined> | undefined;
  let xcodePromise: Promise<string[]> | undefined;

  /** Resolve a repo-relative reference, refusing anything outside the repo. */
  const resolveInside = (reference: string): string | undefined => {
    if (reference.length === 0) return undefined;
    const absolute = path.resolve(cwd, reference);
    return isInside(cwd, absolute) ? absolute : undefined;
  };

  const readInspected = (reference: string): Promise<InspectedFile | undefined> => {
    const cached = files.get(reference);
    if (cached !== undefined) return cached;

    const pending = (async (): Promise<InspectedFile | undefined> => {
      const absolute = resolveInside(reference);
      if (absolute === undefined) return undefined;
      const raw = await readSmallFile(absolute);
      if (raw === undefined) return undefined;
      return {
        file: path.relative(cwd, absolute).split(path.sep).join('/'),
        absolutePath: absolute,
        text: stripComments(raw),
      };
    })();

    files.set(reference, pending);
    return pending;
  };

  const firstReadable = async (names: string[]): Promise<InspectedFile | undefined> => {
    for (const name of names) {
      const found = await readInspected(name);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  return {
    cwd,

    packageJson(): Promise<PackageFacts | undefined> {
      packageJsonPromise ??= (async () => {
        const absolute = resolveInside('package.json');
        if (absolute === undefined) return undefined;
        const raw = await readSmallFile(absolute);
        if (raw === undefined) return undefined;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // A malformed package.json is the project's problem, not the router's.
          return undefined;
        }
        if (typeof parsed !== 'object' || parsed === null) return undefined;
        const record = parsed as Record<string, unknown>;

        const scripts: Record<string, string> = {};
        const rawScripts = record.scripts;
        if (typeof rawScripts === 'object' && rawScripts !== null) {
          for (const [name, value] of Object.entries(rawScripts as Record<string, unknown>)) {
            if (typeof value === 'string') scripts[name] = value;
          }
        }

        const dependencies = new Set<string>();
        for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          const value = record[section];
          if (typeof value === 'object' && value !== null) {
            for (const name of Object.keys(value as Record<string, unknown>)) dependencies.add(name);
          }
        }

        return { file: 'package.json', scripts, dependencies };
      })();
      return packageJsonPromise;
    },

    playwrightConfig(explicitPath?: string): Promise<InspectedFile | undefined> {
      if (explicitPath !== undefined && explicitPath.length > 0) return readInspected(explicitPath);
      return firstReadable(PLAYWRIGHT_CONFIG_NAMES);
    },

    vitestConfig(explicitPath?: string): Promise<InspectedFile | undefined> {
      if (explicitPath !== undefined && explicitPath.length > 0) return readInspected(explicitPath);
      return firstReadable(VITEST_CONFIG_NAMES);
    },

    puppeteerConfig(): Promise<InspectedFile | undefined> {
      return firstReadable(PUPPETEER_CONFIG_NAMES);
    },

    localScript(reference: string): Promise<InspectedFile | undefined> {
      if (path.isAbsolute(reference)) return Promise.resolve(undefined);
      if (!SCRIPT_EXTENSIONS.has(path.extname(reference).toLowerCase())) {
        return Promise.resolve(undefined);
      }
      return readInspected(reference);
    },

    xcodeProjects(): Promise<string[]> {
      xcodePromise ??= (async () => {
        try {
          const entries = await fs.readdir(cwd, { withFileTypes: true });
          return entries
            .filter((entry) => /\.(xcodeproj|xcworkspace)$/.test(entry.name))
            .map((entry) => entry.name)
            .sort();
        } catch {
          return [];
        }
      })();
      return xcodePromise;
    },
  };
}
