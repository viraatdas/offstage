/**
 * The two halves the router is built from: reading a command without running it
 * (`tokenize.ts`), and reading a repository without changing it (`inspect.ts`).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createInspector, stripComments } from '../src/router/inspect.js';
import {
  basenameOf,
  normalizeInvocation,
  parseScriptInvocation,
  tokenizeShellish,
} from '../src/router/tokenize.js';

/* -------------------------------------------------------------------------- */
/* tokenize                                                                   */
/* -------------------------------------------------------------------------- */

describe('tokenizeShellish', () => {
  it('splits on whitespace', () => {
    expect(tokenizeShellish('playwright test --headed')).toEqual([['playwright', 'test', '--headed']]);
  });

  it('keeps quoted arguments together', () => {
    expect(tokenizeShellish('xcrun simctl boot "iPhone 15 Pro"')).toEqual([
      ['xcrun', 'simctl', 'boot', 'iPhone 15 Pro'],
    ]);
    expect(tokenizeShellish("open -a 'Google Chrome'")).toEqual([['open', '-a', 'Google Chrome']]);
  });

  it('honours escapes inside and outside double quotes', () => {
    expect(tokenizeShellish('open My\\ App.app')).toEqual([['open', 'My App.app']]);
    expect(tokenizeShellish('node -e "console.log(\\"hi\\")"')).toEqual([
      ['node', '-e', 'console.log("hi")'],
    ]);
  });

  it('preserves an empty quoted argument', () => {
    expect(tokenizeShellish('node -e ""')).toEqual([['node', '-e', '']]);
  });

  it('splits on every shell operator', () => {
    expect(tokenizeShellish('tsc && vitest run')).toEqual([['tsc'], ['vitest', 'run']]);
    expect(tokenizeShellish('a || b')).toEqual([['a'], ['b']]);
    expect(tokenizeShellish('a ; b')).toEqual([['a'], ['b']]);
    expect(tokenizeShellish('a | b')).toEqual([['a'], ['b']]);
  });

  it('drops redirections and their targets, including 2>&1', () => {
    expect(tokenizeShellish('playwright test --video=on > out.log 2>&1')).toEqual([
      ['playwright', 'test', '--video=on'],
    ]);
    expect(tokenizeShellish('node bot.js < input.txt')).toEqual([['node', 'bot.js']]);
  });

  it('returns nothing for empty or whitespace-only input', () => {
    expect(tokenizeShellish('')).toEqual([]);
    expect(tokenizeShellish('   \n\t ')).toEqual([]);
  });
});

describe('basenameOf', () => {
  it('reduces a path to the executable name', () => {
    expect(basenameOf('./node_modules/.bin/playwright')).toBe('playwright');
    expect(basenameOf('/usr/bin/xcodebuild')).toBe('xcodebuild');
  });

  it('strips windows-style launcher suffixes', () => {
    expect(basenameOf('node_modules\\.bin\\vitest.cmd')).toBe('vitest');
  });
});

describe('normalizeInvocation', () => {
  it('peels npx and its own flags', () => {
    const invocation = normalizeInvocation(['npx', '--yes', '--package=@playwright/test', 'playwright', 'test']);
    expect(invocation.bin).toBe('playwright');
    expect(invocation.args).toEqual(['test']);
    expect(invocation.prefixes).toContain('npx');
  });

  it('peels leading environment assignments', () => {
    const invocation = normalizeInvocation(['CI=1', 'DEBUG=pw:*', 'playwright', 'test']);
    expect(invocation.bin).toBe('playwright');
  });

  it('peels cross-env and its assignments', () => {
    expect(normalizeInvocation(['cross-env', 'CI=1', 'vitest', 'run']).bin).toBe('vitest');
  });

  it('peels dotenv up to the -- separator', () => {
    expect(normalizeInvocation(['dotenv', '-e', '.env.test', '--', 'vitest', 'run']).bin).toBe('vitest');
  });

  it('peels package-manager exec forms', () => {
    expect(normalizeInvocation(['pnpm', 'exec', 'playwright', 'test']).bin).toBe('playwright');
    expect(normalizeInvocation(['yarn', 'dlx', 'playwright', 'test']).bin).toBe('playwright');
    expect(normalizeInvocation(['bun', 'x', 'vitest']).bin).toBe('vitest');
  });

  it('peels sudo, time and nice', () => {
    expect(normalizeInvocation(['sudo', 'nice', '-n', '10', 'xcodebuild', 'build']).bin).toBe('xcodebuild');
  });

  it('does not peel npm run, which names a script instead of a command', () => {
    const invocation = normalizeInvocation(['npm', 'run', 'e2e']);
    expect(invocation.bin).toBe('npm');
    expect(invocation.args).toEqual(['run', 'e2e']);
  });

  it('survives an empty command', () => {
    expect(normalizeInvocation([]).bin).toBe('');
    expect(normalizeInvocation(['npx']).bin).toBe('');
  });
});

describe('parseScriptInvocation', () => {
  const parse = (tokens: string[]): ReturnType<typeof parseScriptInvocation> =>
    parseScriptInvocation(normalizeInvocation(tokens));

  it('reads npm run <script>', () => {
    expect(parse(['npm', 'run', 'e2e'])).toEqual({ manager: 'npm', script: 'e2e', extraArgs: [] });
  });

  it('reads the npm lifecycle shorthands', () => {
    expect(parse(['npm', 'test'])?.script).toBe('test');
    expect(parse(['npm', 't'])?.script).toBe('test');
    expect(parse(['npm', 'start'])?.script).toBe('start');
  });

  it('reads yarn and pnpm scripts without the run keyword', () => {
    expect(parse(['yarn', 'e2e'])).toEqual({ manager: 'yarn', script: 'e2e', extraArgs: [] });
    expect(parse(['pnpm', 'e2e'])?.script).toBe('e2e');
  });

  it('captures forwarded arguments, with or without the -- separator', () => {
    expect(parse(['npm', 'run', 'e2e', '--', '--headed'])?.extraArgs).toEqual(['--headed']);
    expect(parse(['yarn', 'e2e', '--headed'])?.extraArgs).toEqual(['--headed']);
  });

  it('ignores manager subcommands that are not scripts', () => {
    expect(parse(['yarn', 'add', 'playwright'])).toBeNull();
    expect(parse(['pnpm', 'install'])).toBeNull();
    expect(parse(['npm', 'ci'])).toBeNull();
  });

  it('ignores bun test, which is bun own runner', () => {
    expect(parse(['bun', 'test'])).toBeNull();
  });

  it('ignores bun run of a file path', () => {
    expect(parse(['bun', 'run', './scripts/build.ts'])).toBeNull();
    expect(parse(['bun', 'run', 'build'])?.script).toBe('build');
  });

  it('ignores anything that is not a package manager', () => {
    expect(parse(['playwright', 'test'])).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* inspect                                                                    */
/* -------------------------------------------------------------------------- */

describe('stripComments', () => {
  it('removes line and block comments', () => {
    expect(stripComments('use: { // headless: false\n }')).not.toContain('headless');
    expect(stripComments('use: { /* headless: false */ }')).not.toContain('headless');
  });

  it('leaves comment-looking text inside strings alone', () => {
    expect(stripComments('const url = "http://example.com/a//b";')).toContain('//b');
    expect(stripComments("const s = '/* not a comment */';")).toContain('not a comment');
  });

  it('keeps the real code around a comment', () => {
    const stripped = stripComments('a; // gone\nb;');
    expect(stripped).toContain('a;');
    expect(stripped).toContain('b;');
  });
});

describe('Inspector', () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-inspect-'));
    await fs.mkdir(path.join(root, 'repo', 'scripts'), { recursive: true });
    await fs.mkdir(path.join(root, 'repo', 'App.xcworkspace'), { recursive: true });
    await fs.mkdir(path.join(root, 'repo', 'Legacy.xcodeproj'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'repo', 'package.json'),
      JSON.stringify({
        scripts: { test: 'vitest run', broken: 42 },
        dependencies: { zod: '^4' },
        devDependencies: { vitest: '^4' },
      }),
      'utf8',
    );
    await fs.writeFile(path.join(root, 'repo', 'scripts', 'scrape.js'), '// nothing\n', 'utf8');
    await fs.writeFile(path.join(root, 'repo', 'huge.config.js'), 'x'.repeat(1024 * 1024 + 10), 'utf8');
    await fs.writeFile(path.join(root, 'outside.js'), 'secret\n', 'utf8');
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const repo = (): string => path.join(root, 'repo');

  it('reads scripts and dependencies, skipping non-string script values', async () => {
    const pkg = await createInspector(repo()).packageJson();
    expect(pkg?.scripts).toEqual({ test: 'vitest run' });
    expect(pkg?.dependencies.has('vitest')).toBe(true);
    expect(pkg?.dependencies.has('zod')).toBe(true);
  });

  it('memoizes each file it reads', async () => {
    const inspector = createInspector(repo());
    expect(await inspector.packageJson()).toBe(await inspector.packageJson());
    expect(await inspector.localScript('scripts/scrape.js')).toBe(
      await inspector.localScript('scripts/scrape.js'),
    );
  });

  it('returns undefined for a repository that does not exist', async () => {
    const inspector = createInspector(path.join(root, 'nope'));
    expect(await inspector.packageJson()).toBeUndefined();
    expect(await inspector.playwrightConfig()).toBeUndefined();
    expect(await inspector.xcodeProjects()).toEqual([]);
  });

  it('refuses to read outside the repository', async () => {
    const inspector = createInspector(repo());
    expect(await inspector.localScript('../outside.js')).toBeUndefined();
    expect(await inspector.playwrightConfig('../outside.js')).toBeUndefined();
  });

  it('refuses absolute script references', async () => {
    const inspector = createInspector(repo());
    expect(await inspector.localScript(path.join(root, 'outside.js'))).toBeUndefined();
  });

  it('only opens files that could hold a browser launch', async () => {
    const inspector = createInspector(repo());
    expect(await inspector.localScript('package.json')).toBeUndefined();
    expect(await inspector.localScript('scripts/scrape.js')).toBeDefined();
  });

  it('skips implausibly large config files', async () => {
    const inspector = createInspector(repo());
    expect(await inspector.playwrightConfig('huge.config.js')).toBeUndefined();
  });

  it('lists Xcode bundles at the repository root, sorted', async () => {
    expect(await createInspector(repo()).xcodeProjects()).toEqual(['App.xcworkspace', 'Legacy.xcodeproj']);
  });

  it('reports repository-relative paths with POSIX separators', async () => {
    const file = await createInspector(repo()).localScript('scripts/scrape.js');
    expect(file?.file).toBe('scripts/scrape.js');
    expect(path.isAbsolute(file?.absolutePath ?? '')).toBe(true);
  });
});
