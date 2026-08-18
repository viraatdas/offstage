/**
 * offstage — turning a command into something the router can reason about.
 *
 * Everything in this file is pure string work, deliberately. The router's whole
 * promise is that it decides *before* anything runs: it must never execute a
 * command, a package script, or a config file to find out what it is. So a
 * package script like `"e2e": "cross-env CI=1 playwright test --headed"` gets
 * read the way a careful human reads it — split on the shell operators, strip
 * the wrappers, look at what is actually being invoked — and nothing more.
 *
 * The parsing here is intentionally shallow. It does not implement a shell; it
 * implements "enough of a shell to see the binary and the flags". Where that is
 * not enough, the router reports low confidence rather than guessing loudly.
 */

/** Whitespace that separates tokens inside a shell-ish string. */
const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

/** `FOO=bar` style environment assignments that prefix a command. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Split a shell-ish command string into one token list per command.
 *
 * `a && b | c ; d` becomes four token lists. Quotes and backslash escapes are
 * honoured, redirections (`> out.log`, `2>&1`) are dropped along with their
 * targets, and everything else is treated as literal text — including `$(...)`
 * and backticks, which the router simply cannot resolve without running them.
 */
export function tokenizeShellish(text: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | '`' | null = null;

  const endToken = (): void => {
    if (started) {
      tokens.push(current);
      current = '';
      started = false;
    }
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);

    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (quote === '"' && ch === '\\' && i + 1 < text.length) {
        i += 1;
        current += text.charAt(i);
        started = true;
        continue;
      }
      current += ch;
      started = true;
      continue;
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length) {
      i += 1;
      current += text.charAt(i);
      started = true;
      continue;
    }
    if (WHITESPACE.has(ch)) {
      endToken();
      continue;
    }
    if (ch === ';' || ch === '&' || ch === '|') {
      endSegment();
      const next = text.charAt(i + 1);
      if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) i += 1;
      continue;
    }
    if (ch === '>' || ch === '<') {
      // A redirection and its target say nothing about isolation. Drop both —
      // including the leading file descriptor in `2>&1`, which is already
      // sitting in `current` at this point.
      if (started && /^\d+$/.test(current)) {
        current = '';
        started = false;
      }
      endToken();
      i += 1;
      while (i < text.length && (text.charAt(i) === '>' || text.charAt(i) === '&')) i += 1;
      while (i < text.length && WHITESPACE.has(text.charAt(i))) i += 1;
      while (i < text.length && !WHITESPACE.has(text.charAt(i)) && !';&|'.includes(text.charAt(i))) {
        i += 1;
      }
      i -= 1;
      continue;
    }

    current += ch;
    started = true;
  }

  endSegment();
  return segments;
}

/** `./node_modules/.bin/playwright.cmd` → `playwright`. */
export function basenameOf(token: string): string {
  const slash = Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\'));
  const base = slash >= 0 ? token.slice(slash + 1) : token;
  return base.replace(/\.(cmd|exe|bat|ps1)$/i, '');
}

/** A command with its wrappers peeled off. */
export interface Invocation {
  /** Normalized executable name: basename, without a `.cmd`/`.exe` suffix. */
  bin: string;
  /** The executable exactly as it was written, before normalization. */
  binPath: string;
  /** Everything after the executable. */
  args: string[];
  /** `binPath` followed by `args` — the effective command after peeling. */
  tokens: string[];
  /** Wrappers that were peeled off, in the order they appeared. */
  prefixes: string[];
}

/** Wrappers that fetch-and-run a package: `npx playwright test` runs playwright. */
const EXEC_WRAPPERS = new Set(['npx', 'pnpx', 'bunx']);

/** Flags those wrappers own, which belong to the wrapper and not the command. */
const EXEC_WRAPPER_VALUE_FLAGS = new Set(['-p', '--package', '-c', '--call']);
const EXEC_WRAPPER_BOOL_FLAGS = new Set([
  '-y',
  '--yes',
  '--no',
  '--no-install',
  '--quiet',
  '--silent',
  '--prefer-offline',
  '--prefer-online',
  '--ignore-existing',
]);

/** Wrappers that only add environment or timing and then hand off. */
const TRANSPARENT_WRAPPERS = new Set(['env', 'cross-env', 'cross-env-shell', 'time', 'sudo', 'nice']);

/**
 * Peel the wrappers off a command until what is left is the thing that will
 * actually open (or not open) a window.
 *
 * `NODE_ENV=test npx --yes playwright test --headed` → bin `playwright`,
 * args `['test', '--headed']`.
 *
 * `npm run e2e` is deliberately *not* peeled: it names a script that has to be
 * looked up in `package.json`, which is filesystem work and lives in
 * `inspect.ts`. This function leaves it as bin `npm`, args `['run', 'e2e']`.
 */
export function normalizeInvocation(input: string[]): Invocation {
  let tokens = input.filter((token) => token.length > 0);
  const prefixes: string[] = [];

  for (;;) {
    if (tokens.length === 0) break;
    const head = tokens[0] as string;

    if (ENV_ASSIGNMENT.test(head)) {
      prefixes.push(head);
      tokens = tokens.slice(1);
      continue;
    }

    const bin = basenameOf(head);

    if (TRANSPARENT_WRAPPERS.has(bin)) {
      prefixes.push(bin);
      tokens = tokens.slice(1);
      if (bin === 'nice') {
        while (tokens.length > 0 && (tokens[0] as string).startsWith('-')) {
          const flag = tokens[0] as string;
          tokens = tokens.slice(1);
          if (flag === '-n' && tokens.length > 0) tokens = tokens.slice(1);
        }
      }
      continue;
    }

    if (bin === 'dotenv') {
      // `dotenv -e .env -- vitest run`: everything up to `--` configures dotenv.
      const separator = tokens.indexOf('--');
      prefixes.push(bin);
      tokens = separator >= 0 ? tokens.slice(separator + 1) : tokens.slice(1);
      continue;
    }

    if (EXEC_WRAPPERS.has(bin)) {
      prefixes.push(bin);
      tokens = tokens.slice(1);
      while (tokens.length > 0) {
        const flag = tokens[0] as string;
        if (flag === '--') {
          tokens = tokens.slice(1);
          break;
        }
        if (EXEC_WRAPPER_VALUE_FLAGS.has(flag)) {
          tokens = tokens.slice(2);
          continue;
        }
        if (EXEC_WRAPPER_BOOL_FLAGS.has(flag) || /^--package=/.test(flag)) {
          tokens = tokens.slice(1);
          continue;
        }
        break;
      }
      continue;
    }

    if (['npm', 'pnpm', 'yarn', 'bun'].includes(bin) && tokens.length > 1) {
      const sub = tokens[1] as string;
      const isExec =
        sub === 'exec' || sub === 'dlx' || (bin === 'bun' && sub === 'x') || (bin === 'npm' && sub === 'x');
      if (isExec) {
        prefixes.push(`${bin} ${sub}`);
        tokens = tokens.slice(2);
        if (tokens[0] === '--') tokens = tokens.slice(1);
        continue;
      }
    }

    break;
  }

  const binPath = tokens.length > 0 ? (tokens[0] as string) : '';
  return {
    bin: binPath === '' ? '' : basenameOf(binPath),
    binPath,
    args: tokens.slice(1),
    tokens,
    prefixes,
  };
}

/** A package-manager invocation that runs a script out of `package.json`. */
export interface ScriptInvocation {
  manager: 'npm' | 'pnpm' | 'yarn' | 'bun';
  /** The `scripts` key being run. */
  script: string;
  /** Arguments forwarded to the script (`npm run e2e -- --headed`). */
  extraArgs: string[];
}

/** Subcommands of yarn/pnpm that are the tool's own, never a user script. */
const MANAGER_SUBCOMMANDS = new Set([
  'add',
  'audit',
  'bin',
  'cache',
  'config',
  'create',
  'dedupe',
  'dlx',
  'exec',
  'why',
  'help',
  'info',
  'init',
  'install',
  'licenses',
  'link',
  'list',
  'ls',
  'node',
  'outdated',
  'pack',
  'patch',
  'publish',
  'rebuild',
  'remove',
  'setup',
  'store',
  'unlink',
  'up',
  'update',
  'upgrade',
  'version',
  'workspace',
  'workspaces',
]);

/** `npm test` is `npm run test`; the same shorthand exists for a few keys. */
const LIFECYCLE_SCRIPTS = new Map<string, string>([
  ['test', 'test'],
  ['t', 'test'],
  ['tst', 'test'],
  ['start', 'start'],
  ['stop', 'stop'],
  ['restart', 'restart'],
]);

/**
 * Recognise `npm run e2e`, `npm test`, `yarn e2e`, `pnpm run e2e`, `bun run e2e`
 * and report which `package.json` script they name.
 *
 * Manager-level flags are skipped by shape (anything starting with `-`), which
 * is a heuristic: `yarn --cwd packages/app test` would leave `packages/app`
 * looking like the script name. The router treats an unresolvable script as
 * "no information" rather than as evidence, so the failure mode is a low
 * confidence answer, never a wrong lane.
 */
export function parseScriptInvocation(invocation: Invocation): ScriptInvocation | null {
  const manager = invocation.bin;
  if (manager !== 'npm' && manager !== 'pnpm' && manager !== 'yarn' && manager !== 'bun') return null;

  const args = invocation.args.filter((token) => !token.startsWith('-'));
  if (args.length === 0) return null;

  const head = args[0] as string;
  let script: string | null = null;
  let rest: string[] = [];

  if (head === 'run' || head === 'run-script') {
    if (args.length < 2) return null;
    script = args[1] as string;
    rest = args.slice(2);
    // `bun run ./scripts/thing.ts` runs a file, not a package script.
    if (manager === 'bun' && (script.includes('/') || /\.[cm]?[jt]sx?$/.test(script))) return null;
  } else if (manager === 'bun' && head === 'test') {
    // `bun test` is bun's own test runner, not the `test` script.
    return null;
  } else if (LIFECYCLE_SCRIPTS.has(head)) {
    script = LIFECYCLE_SCRIPTS.get(head) as string;
    rest = args.slice(1);
  } else if ((manager === 'yarn' || manager === 'pnpm') && !MANAGER_SUBCOMMANDS.has(head)) {
    script = head;
    rest = args.slice(1);
  }

  if (script === null || script.length === 0) return null;

  // Forwarded arguments: everything after the script name in the original argv,
  // minus the `--` separator npm requires and yarn does not.
  const scriptIndex = invocation.args.indexOf(script);
  const tail = scriptIndex >= 0 ? invocation.args.slice(scriptIndex + 1) : rest;
  const extraArgs = tail[0] === '--' ? tail.slice(1) : tail;

  return { manager, script, extraArgs };
}
