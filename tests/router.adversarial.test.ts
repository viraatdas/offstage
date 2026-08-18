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
    expect(decision.lane).toBe('vm');
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
    expect(decision.lane).toBe('vm');
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
    expect(native.lane).toBe('vm');
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
