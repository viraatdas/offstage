/**
 * Adversarial routing: commands written to defeat the classifier.
 *
 * Every case here is a shape a real repository produces and a naive reader gets
 * wrong. Two of them were genuine defects when this file was written — an
 * `env PWDEBUG=1` prefix and a command hidden inside `sh -c` both routed to the
 * headless lane at *high* confidence, which would have opened a browser window
 * on the user's real screen. They are regression tests now.
 *
 * The standard each case is held to is not "picks the cheap lane". It is:
 * **never route work that opens a window into the lane that has no display.**
 * Being wrong toward the container is a wasted 30 seconds; being wrong toward
 * headless is the bug the whole product exists to prevent.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { classify } from '../src/router/index.js';
import { detectHeadedRequest } from '../src/lanes/headless/index.js';

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function repo(files: Record<string, string> = {}): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-adv-')));
  temps.push(dir);
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}

describe('a headed request hidden in an environment assignment', () => {
  it('routes `env PWDEBUG=1 npx playwright test` to the container lane', async () => {
    // Regression: `env` and `PWDEBUG=1` are peeled off as transparent prefixes,
    // leaving a plain `playwright test` that every flag rule reads as headless.
    // The assignment is the entire signal, so it is read where it actually is.
    const decision = await classify({
      cwd: await repo(),
      command: ['env', 'PWDEBUG=1', 'npx', 'playwright', 'test'],
    });

    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('high');
    expect(decision.signals.join(' ')).toContain('PWDEBUG=1');
    expect(decision.reason).toContain('Playwright Inspector');
  });

  it('routes HEADLESS=false to the container lane and HEADLESS=true back to headless', async () => {
    const cwd = await repo();
    const headed = await classify({ cwd, command: ['env', 'HEADLESS=false', 'node', 'smoke.js'] });
    expect(headed.lane).toBe('container');

    const headless = await classify({ cwd, command: ['env', 'HEADLESS=true', 'node', 'smoke.js'] });
    expect(headless.lane).toBe('headless');
  });

  it('ignores an assignment that says nothing about a display', async () => {
    const decision = await classify({
      cwd: await repo(),
      command: ['env', 'NODE_ENV=test', 'npx', 'vitest', 'run'],
    });
    expect(decision.lane).toBe('headless');
  });

  it('is caught again by the headless lane itself, if a request ever gets that far', async () => {
    // Defense in depth: the router should never produce this request, but the
    // lane must refuse it rather than trust its caller.
    expect(detectHeadedRequest({ command: ['env', 'PWDEBUG=1', 'npx', 'playwright', 'test'] })).toMatch(
      /Playwright Inspector/,
    );
  });
});

describe('a whole command hidden inside a shell string', () => {
  it('reads the string behind `sh -c` instead of seeing only a shell', async () => {
    const decision = await classify({
      cwd: await repo(),
      command: ['sh', '-c', 'npx playwright test --headed'],
    });

    expect(decision.lane).toBe('container');
    expect(decision.signals.join(' ')).toContain('--headed');
  });

  it('handles bash, zsh, and combined short flags like -lc', async () => {
    const cwd = await repo();
    for (const command of [
      ['bash', '-c', 'npx playwright test --headed'],
      ['zsh', '-c', 'npx playwright test --headed'],
      ['bash', '-lc', 'npx playwright test --headed'],
    ]) {
      const decision = await classify({ cwd, command });
      expect(decision.lane, command.join(' ')).toBe('container');
    }
  });

  it('sees macOS-native work inside a shell string too', async () => {
    const decision = await classify({
      cwd: await repo(),
      command: ['sh', '-c', 'xcodebuild test -scheme App'],
    });
    expect(decision.lane).toBe('session');
  });

  it('sees an installer inside a shell string, and refuses', async () => {
    const decision = await classify({
      cwd: await repo(),
      command: ['sh', '-c', 'installer -pkg dist/MyApp.pkg -target /'],
    });
    expect(decision.refuse).toBeDefined();
  });

  it('does not invent a signal from a shell string that has none', async () => {
    const decision = await classify({
      cwd: await repo(),
      command: ['sh', '-c', 'npm run build'],
    });
    expect(decision.lane).toBe('headless');
  });

  it('is caught again by the headless lane itself', async () => {
    expect(detectHeadedRequest({ command: ['sh', '-c', 'npx playwright test --headed'] })).toContain(
      '--headed',
    );
  });
});

describe('configuration that only sometimes opens a window', () => {
  it('routes a project-level headless: false override to the container, at low confidence', async () => {
    // `use: { headless: true }` at the top, `headless: false` in one project.
    // Which one applies depends on --project, chosen at runtime. Container is
    // the cheaper way to be wrong.
    const cwd = await repo({
      'playwright.config.ts': `import { defineConfig } from '@playwright/test';
export default defineConfig({
  use: { headless: true },
  projects: [{ name: 'chromium', use: { headless: false } }],
});`,
    });

    const decision = await classify({ cwd, command: ['npx', 'playwright', 'test'] });
    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('low');
    expect(decision.reason).toMatch(/both ways|runtime/);
  });

  it('keeps a puppeteer script whose headless is computed in the cheap lane, and says it cannot tell', async () => {
    const cwd = await repo({
      'smoke.js': `const puppeteer = require('puppeteer');
const browser = await puppeteer.launch({ headless: process.env.CI ? true : false });`,
      'package.json': JSON.stringify({ scripts: { smoke: 'node smoke.js' } }),
    });

    const decision = await classify({ cwd, command: ['npm', 'run', 'smoke'] });
    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('low');
    expect(decision.reason).toContain('process.env.CI');
    // The reason must quote what it could not evaluate — that is what makes a
    // low-confidence answer actionable rather than a shrug.
    expect(decision.reason).toMatch(/without ever executing|does not evaluate|cannot know/);
  });

  it('lets an explicit flag settle a config it could not read', async () => {
    const cwd = await repo({
      'playwright.config.ts': `export default { use: { headless: process.env.HEADED !== '1' } };`,
    });

    const decision = await classify({
      cwd,
      command: ['npx', 'playwright', 'test', '--headless'],
    });
    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('high');
  });
});

describe('commands wrapped in something else', () => {
  it('follows `npm run` into a script that calls xcodebuild', async () => {
    const cwd = await repo({
      'package.json': JSON.stringify({ scripts: { ios: 'xcodebuild test -scheme App' } }),
    });

    const decision = await classify({ cwd, command: ['npm', 'run', 'ios'] });
    expect(decision.lane).toBe('session');
    expect(decision.signals.join(' ')).toContain('scripts.ios');
  });

  it('reads a --headed passed through `npm run test:e2e --`', async () => {
    const decision = await classify({
      cwd: await repo({ 'package.json': JSON.stringify({ scripts: { 'test:e2e': 'playwright test' } }) }),
      command: ['npm', 'run', 'test:e2e', '--', '--headed'],
    });
    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('high');
  });
});

describe('a repository that is both a web app and a macOS app', () => {
  const both = {
    'playwright.config.ts': `export default { use: { headless: false } };`,
    'App.xcodeproj/project.pbxproj': '// stub',
  };

  it('routes by what the command targets, not by what the repository contains', async () => {
    const cwd = await repo(both);

    const web = await classify({ cwd, command: ['npx', 'playwright', 'test'] });
    expect(web.lane).toBe('container');

    const native = await classify({ cwd, command: ['xcodebuild', 'test'] });
    expect(native.lane).toBe('session');
  });

  it('still records the other half of the repository as context', async () => {
    const cwd = await repo(both);
    const web = await classify({ cwd, command: ['npx', 'playwright', 'test'] });

    // The Xcode project is real and worth reporting; it just does not decide
    // this command's lane. Saying so is what stops the observation from
    // looking like an oversight.
    expect(web.signals.join(' ')).toContain('App.xcodeproj');
    expect(web.signals.join(' ')).toContain('does not target it');
  });
});

describe('commands that hide the deciding flag behind shell syntax', () => {
  // Every case here was found by an adversarial audit of the shipped tree, and
  // every one of them routed to the headless lane — several at HIGH confidence,
  // with the reason affirmatively stating that no display was involved.
  const routedToContainer: Array<[string, string[]]> = [
    ['a -- separator between -c and the script', ['sh', '-c', '--', 'npx playwright test --headed']],
    ['a bare - separator', ['sh', '-c', '-', 'npx playwright test --headed']],
    ['bash with --', ['bash', '-c', '--', 'npx playwright test --headed']],
    ['command substitution', ['sh', '-c', 'npx playwright test $(echo --headed)']],
    ['env -i, which drops the environment', ['env', '-i', 'PWDEBUG=1', 'npx', 'playwright', 'test']],
    ['env -u, which unsets one variable', ['env', '-u', 'FOO', 'PWDEBUG=1', 'npx', 'playwright', 'test']],
    ['env --', ['env', '--', 'PWDEBUG=1', 'npx', 'playwright', 'test']],
    ['env -S, which packs the command into one argument', ['env', '-S', 'PWDEBUG=1 npx playwright test']],
    ['a browser launched from an inline script', ['node', '-e', 'require("puppeteer").launch({headless:false})']],
  ];

  it.each(routedToContainer)('routes %s to the container lane', async (_label, command) => {
    const decision = await classify({ cwd: await repo(), command });
    expect(decision.lane).toBe('container');
  });

  it('reads an inline script the same way it reads one on disk', async () => {
    const decision = await classify({
      cwd: await repo(),
      command: ['node', '-e', 'const p = require("puppeteer"); p.launch({ headless: false });'],
    });
    expect(decision.lane).toBe('container');
    expect(decision.reason).toContain('inline');
  });
});

describe('what offstage cannot resolve, it says it cannot resolve', () => {
  // A shell expansion is the one thing reading cannot settle: only the shell
  // that runs the command knows what `$FLAGS` becomes. The rule is the same as
  // for a config computed at runtime — keep the cheap lane, drop the
  // confidence, quote the thing — and NOT to report the confident default.
  const unresolvable: string[][] = [
    ['npx', 'playwright', 'test', '$FLAGS'],
    ['sh', '-c', 'npx playwright test ${HEADED:+--headed}'],
    ['sh', '-c', 'H=--headed; npx playwright test $H'],
    ['sh', '-c', 'npx playwright test `echo --headed`'],
  ];

  it.each(unresolvable)('reports low confidence for %s %s %s %s', async (...command: string[]) => {
    const decision = await classify({ cwd: await repo(), command });
    expect(decision.confidence).toBe('low');
    expect(decision.reason).toMatch(/shell expansion|cannot resolve|could not resolve/i);
  });

  it('lets an explicit --headless settle an expansion, as it settles a config', async () => {
    const decision = await classify({
      cwd: await repo(),
      command: ['npx', 'playwright', 'test', '--headless', '$FLAGS'],
    });
    expect(decision.confidence).toBe('high');
  });

  it('does not cry wolf over a command with no expansion in it', async () => {
    const decision = await classify({ cwd: await repo(), command: ['npx', 'vitest', 'run'] });
    expect(decision.confidence).toBe('high');
  });
});

describe('the headless lane refuses on the text itself, whatever the shell would do', () => {
  // The last line before a window opens on a real screen. The router should
  // never hand these over, but the lane must not trust its caller.
  const refused: string[][] = [
    ['sh', '-c', 'npx playwright test `echo --headed`'],
    ['sh', '-c', 'H=--headed; npx playwright test $H'],
    ['sh', '-c', 'npx playwright test ${HEADED:+--headed}'],
    ['sh', '-c', "eval 'npx playwright test --headed'"],
    ['sh', '-c', '--', 'npx playwright test --headed'],
    ['env', '-i', 'PWDEBUG=1', 'npx', 'playwright', 'test'],
  ];

  it.each(refused)('refuses %s %s %s', async (...command: string[]) => {
    expect(detectHeadedRequest({ command })).not.toBeNull();
  });

  const allowed: string[][] = [
    ['npx', 'vitest', 'run'],
    ['node', '--uikit-check', 'app.js'],
    ['npx', 'playwright', 'test', '--headless'],
    ['sh', '-c', 'npx playwright test --headless=true'],
    ['node', '-e', 'console.log("--headless=falsey")'],
    ['npm', 'run', 'build'],
  ];

  it.each(allowed)('does not refuse %s %s %s', async (...command: string[]) => {
    // A false refusal blocks a legitimate run, so the boundaries have to hold
    // in both directions: --ui must not match --uikit, and --headless=false
    // must not be read out of --headless=falsey.
    expect(detectHeadedRequest({ command })).toBeNull();
  });
});

describe('the classifier never routes a window onto the real screen', () => {
  const windowOpeners: string[][] = [
    ['npx', 'playwright', 'test', '--headed'],
    ['npx', 'playwright', 'test', '--ui'],
    ['npx', 'playwright', 'test', '--headless=false'],
    ['env', 'PWDEBUG=1', 'npx', 'playwright', 'test'],
    ['sh', '-c', 'npx playwright test --headed'],
    ['bash', '-c', 'HEADLESS=false node smoke.js'],
    ['xcodebuild', 'test', '-scheme', 'App'],
    ['xcrun', 'simctl', 'boot', 'iPhone 15'],
    ['open', 'build/App.app'],
    ['npm', 'run', 'e2e', '--', '--headed'],
  ];

  it.each(windowOpeners)('keeps %s out of the headless lane', async (...command: string[]) => {
    const cwd = await repo({ 'package.json': JSON.stringify({ scripts: { e2e: 'playwright test' } }) });
    const decision = await classify({ cwd, command });
    expect(decision.lane).not.toBe('headless');
  });
});

describe('a wrapper does not hide the command from the router', () => {
  /* `xargs installer -target /` routed to `headless` with no refusal, so
     offstage would have run an installer with no isolation at all. The binary
     was invisible because the peeler stopped at `xargs`. A placeholder like
     `-I{}` makes it worse: the real path only exists at runtime, so there is no
     `.pkg` literal left for a pattern match to catch, and peeling to the binary
     is the only thing that can fire the refusal. */
  const machineChanging: string[][] = [
    ['xargs', 'installer', '-target', '/'],
    ['xargs', '-I{}', 'installer', '-pkg', '{}', '-target', '/'],
    ['xargs', '-I', '{}', 'installer', '-pkg', '{}', '-target', '/'],
    ['xargs', '-n1', '-P4', 'hdiutil', 'attach', '{}'],
    ['parallel', 'installer', '-pkg', '{}', '-target', '/'],
    ['xargs', '--', 'installer', '-target', '/'],
  ];

  it.each(machineChanging)('refuses %s %s %s', async (...command: string[]) => {
    const cwd = await repo({});
    const decision = await classify({ cwd, command });
    expect(decision.refuse).toBeDefined();
  });

  const windowOpeners: string[][] = [
    ['xargs', 'npx', 'playwright', 'test', '--headed'],
    ['xargs', '-I{}', 'xcodebuild', 'test', '-scheme', '{}'],
    ['parallel', 'open', '{}'],
  ];

  it.each(windowOpeners)('keeps %s %s %s out of the headless lane', async (...command: string[]) => {
    const cwd = await repo({});
    const decision = await classify({ cwd, command });
    expect(decision.lane).not.toBe('headless');
  });

  it('still treats a wrapper flag value as a flag, not as the command', async () => {
    /* `-a file` takes a separate value. Reading `file` as the command would
       point the router at the wrong thing entirely. */
    const cwd = await repo({});
    const decision = await classify({
      cwd,
      command: ['xargs', '-a', 'list.txt', 'installer', '-target', '/'],
    });
    expect(decision.refuse).toBeDefined();
  });
});

describe('a symlink or a rename does not hide the binary from the router', () => {
  /* `ln -sf /usr/sbin/installer ./totally-safe-tool` and then `./totally-safe-tool
     -pkg payload -target /` — with `payload` carrying no `.pkg` extension —
     routed to `headless` with no refusal. The refusal keyed off the literal
     basename of argv[0], so a symlink under an innocuous name, or a copy
     renamed the same way, walked straight past it while the path-content
     signals (`.pkg`, `.dmg`) stayed silent because nothing in the command
     spelled the extension out. Resolving a path-shaped argv[0] on disk and
     checking the resolved basename too is what closes that. */

  /** A symlink at `<dir>/<linkName>` pointing at a fresh, empty file named
   *  `realName` in the same temp dir. The link is the innocuous name a wrapper
   *  script would use; the target's basename is what the router has to see
   *  through the link to find. */
  async function symlinkedBinary(linkName: string, realName: string): Promise<{ dir: string; link: string }> {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-bypass-')));
    temps.push(dir);
    const target = path.join(dir, realName);
    await fs.writeFile(target, '');
    await fs.chmod(target, 0o755);
    const link = path.join(dir, linkName);
    await fs.symlink(target, link);
    return { dir, link };
  }

  it('refuses a symlink to installer under an innocuous name, with an extension-less package path', async () => {
    const { dir, link } = await symlinkedBinary('totally-safe-tool', 'installer');
    const payload = path.join(dir, 'payload'); // no .pkg extension: the path-content signal cannot catch this alone

    const decision = await classify({
      cwd: await repo({}),
      command: [link, '-pkg', payload, '-target', '/'],
    });

    expect(decision.refuse).toBeDefined();
    expect(decision.refuse).toContain('installer');
  });

  it('refuses a symlink to hdiutil under an innocuous name, with an extension-less image path', async () => {
    const { dir, link } = await symlinkedBinary('also-safe', 'hdiutil');
    const image = path.join(dir, 'image'); // no .dmg extension

    const decision = await classify({
      cwd: await repo({}),
      command: [link, 'attach', image],
    });

    expect(decision.refuse).toBeDefined();
    expect(decision.refuse).toContain('hdiutil');
  });

  it('does not refuse a symlink whose target is harmless', async () => {
    // No false positives: a false refusal blocks legitimate work, so resolving
    // argv[0] must not make every symlinked tool look suspicious.
    const { link } = await symlinkedBinary('my-tool', 'harmless-real-binary');

    const decision = await classify({
      cwd: await repo({}),
      command: [link, '--version'],
    });

    expect(decision.refuse).toBeUndefined();
  });

  it('does not throw and does not refuse when the path does not exist', async () => {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-bypass-')));
    temps.push(dir);
    const missing = path.join(dir, 'never-created');

    const decision = await classify({
      cwd: await repo({}),
      command: [missing, '-pkg', 'payload', '-target', '/'],
    });

    expect(decision.refuse).toBeUndefined();
  });

  it('is still caught behind a wrapper that peels to the resolved binary', async () => {
    const { dir, link } = await symlinkedBinary('renamed-installer', 'installer');
    const payload = path.join(dir, 'payload');

    const decision = await classify({
      cwd: await repo({}),
      command: ['xargs', '-I{}', link, '-pkg', payload, '-target', '/'],
    });

    expect(decision.refuse).toBeDefined();
  });
});

const SYSTEM_INSTALLER = '/usr/sbin/installer';

async function exists(p: string): Promise<boolean> {
  return await fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

describe('a byte-identical copy does not hide the binary from the router', () => {
  /* The one hole name resolution cannot close: `cp /usr/sbin/installer
     ./totally-safe-tool` leaves no symlink, no shared basename, no filesystem
     link of any kind — realpath points at the copy itself. Identical bytes do
     identical things, so the resolved file's SHA-256 is matched against the
     known machine-changing tools' own digests. */

  it('refuses a copy of installer under an innocuous name, with an extension-less payload', async () => {
    if (process.platform !== 'darwin' || !(await exists(SYSTEM_INSTALLER))) return;

    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-copy-')));
    temps.push(dir);
    const copy = path.join(dir, 'totally-safe-tool');
    await fs.copyFile(SYSTEM_INSTALLER, copy);
    await fs.chmod(copy, 0o755);
    const payload = path.join(dir, 'payload'); // no .pkg extension

    const decision = await classify({
      cwd: await repo({}),
      command: [copy, '-pkg', payload, '-target', '/'],
    });

    expect(decision.refuse).toBeDefined();
    expect(decision.refuse).toContain('installer');
  });

  it('does not refuse a copy of a harmless binary', async () => {
    if (process.platform !== 'darwin' || !(await exists('/bin/echo'))) return;
    // No false positives: matching by content must stay pinned to the tools
    // that actually change the machine.
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-copy-')));
    temps.push(dir);
    const copy = path.join(dir, 'my-echo');
    await fs.copyFile('/bin/echo', copy);
    await fs.chmod(copy, 0o755);

    const decision = await classify({
      cwd: await repo({}),
      command: [copy, 'hello'],
    });

    expect(decision.refuse).toBeUndefined();
  });
});

describe('a machine-changing binary cannot hide on PATH under a friendly name', () => {
  /* argv[0] resolution originally declined bare names, on the reasoning that a
     PATH lookup was slow and a purity risk. The consequence was a live bypass:
     a symlink or copy of the installer placed on PATH and invoked BY NAME was
     invisible to the name check, the resolved-basename check and the content
     check simultaneously, while the very same file invoked as `./thing` was
     refused. `run` execs through PATH, so this was executable, not academic. */

  const withPath = async (dir: string, command: string[]) => {
    const original = process.env['PATH'];
    process.env['PATH'] = `${dir}${path.delimiter}${original ?? ''}`;
    try {
      return await classify({ cwd: await repo({}), command });
    } finally {
      if (original === undefined) delete process.env['PATH'];
      else process.env['PATH'] = original;
    }
  };

  it('refuses a symlinked installer invoked by its bare PATH name', async () => {
    if (process.platform !== 'darwin' || !(await exists(SYSTEM_INSTALLER))) return;
    const dir = await repo({});
    const link = path.join(dir, 'setup-tool');
    await fs.symlink('/usr/sbin/installer', link);
    const decision = await withPath(dir, ['setup-tool', '-pkg', '/tmp/payload', '-target', '/']);
    expect(decision.refuse).toBeDefined();
  });

  it('refuses a copied installer invoked by its bare PATH name', async () => {
    if (process.platform !== 'darwin' || !(await exists(SYSTEM_INSTALLER))) return;
    const dir = await repo({});
    await fs.copyFile('/usr/sbin/installer', path.join(dir, 'helper-tool'));
    await fs.chmod(path.join(dir, 'helper-tool'), 0o755);
    const decision = await withPath(dir, ['helper-tool', '-pkg', '/tmp/payload', '-target', '/']);
    expect(decision.refuse).toBeDefined();
  });

  it('does not refuse an ordinary binary found on PATH', async () => {
    if (process.platform !== 'darwin' || !(await exists('/bin/echo'))) return;
    /* The gate must not fire on every command that happens to resolve. */
    const dir = await repo({});
    await fs.copyFile('/bin/echo', path.join(dir, 'friendly-tool'));
    await fs.chmod(path.join(dir, 'friendly-tool'), 0o755);
    const decision = await withPath(dir, ['friendly-tool', 'hello']);
    expect(decision.refuse).toBeUndefined();
  });

  it('does not refuse when the bare name is on no PATH entry at all', async () => {
    const dir = await repo({});
    const decision = await withPath(dir, ['not-installed-anywhere', '--version']);
    expect(decision.refuse).toBeUndefined();
  });
});

describe('an interpreter cannot smuggle a machine change in a string', () => {
  /* `sh -c` was tokenized and re-inspected; nothing else was. So
     `python3 -c "os.execv('/usr/sbin/installer', ...)"` routed to the headless
     lane with HIGH confidence, and that lane runs its command as a direct child
     with no isolation at all. `osascript -e 'do shell script ...'` was worse: it
     routed to the session lane, which shares the user's OS and disk and was
     never isolation from a machine change. */
  const smuggled: string[][] = [
    ['python3', '-c', 'import os; os.execv("/usr/sbin/installer", ["installer", "-pkg", "/tmp/x.pkg"])'],
    ['node', '-e', 'require("child_process").execFileSync("/usr/sbin/installer", ["-pkg", "/tmp/x.pkg"])'],
    ['ruby', '-e', 'exec("/usr/sbin/installer", "-pkg", "/tmp/x.pkg")'],
    ['perl', '-e', 'exec("/usr/bin/hdiutil", "attach", "/tmp/x.img")'],
    ['osascript', '-e', 'do shell script "/usr/sbin/installer -pkg /tmp/x.pkg -target /"'],
  ];

  it.each(smuggled)('refuses %s %s', async (...command: string[]) => {
    const decision = await classify({ cwd: await repo({}), command });
    expect(decision.refuse).toBeDefined();
  });

  const ordinary: string[][] = [
    ['python3', '-c', 'print("hello")'],
    ['node', '-e', 'console.log(process.version)'],
    ['ruby', '-e', 'puts 1 + 1'],
  ];

  it.each(ordinary)('does not refuse ordinary inline code: %s %s', async (...command: string[]) => {
    /* A refusal that fires on every inline script would block real work. */
    const decision = await classify({ cwd: await repo({}), command });
    expect(decision.refuse).toBeUndefined();
  });

  it('is documented as unable to see inside a script FILE', async () => {
    /* Not a bug, a boundary: no static classifier can know what deploy.sh does.
       This test exists so the limit is deliberate and visible, and so anyone who
       later claims the refusal is a sandbox has to change a test to do it. */
    const cwd = await repo({ 'deploy.sh': 'installer -pkg /tmp/x.pkg -target /\n' });
    const decision = await classify({ cwd, command: ['sh', 'deploy.sh'] });
    expect(decision.refuse).toBeUndefined();
  });
});

describe('a trailing slash does not blank the basename', () => {
  const shapes: string[][] = [
    ['installer/', '-pkg', '/tmp/x.pkg', '-target', '/'],
    ['/usr/sbin/installer/', '-pkg', '/tmp/x.pkg', '-target', '/'],
    ['/usr/bin/hdiutil/', 'attach', '/tmp/x.img'],
  ];

  it.each(shapes)('refuses %s', async (...command: string[]) => {
    const decision = await classify({ cwd: await repo({}), command });
    expect(decision.refuse).toBeDefined();
  });
});
