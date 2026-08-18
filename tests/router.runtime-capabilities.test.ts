/**
 * Capabilities computed at runtime are invisible to the router — by design.
 *
 * The router never executes a line of the repository it classifies. That rule
 * is not a shortcut, it is the safety argument: a router that evaluated your
 * `playwright.config.ts` to discover whether it opens a window could open a
 * window while deciding whether to open a window, and it would do so on the
 * real screen, before any lane had been chosen. `tests/router.purity.test.ts`
 * holds that line; this file is about the bill it comes with.
 *
 * The bill is that `headless: process.env.HEADED !== '1'` is a value offstage
 * cannot know. A boundary like that is only defensible if the router *says* so.
 * Reporting "Playwright runs headless by default: no window opens" about a
 * repository whose config was read but not understood is not a limitation, it
 * is a false statement with `confidence: 'high'` attached — and it is what the
 * router did before this file existed, in five distinct shapes.
 *
 * So the boundary is now a stated contract, and these are its terms:
 *
 *   1. A value the router can read is answered confidently. (unchanged)
 *   2. A value it cannot read produces a signal that says which expression it
 *      could not evaluate, `confidence: 'low'`, and the remedy — never silence,
 *      and never the tool's default dressed up as this repository's answer.
 *   3. It stays in the default lane anyway. "I can't tell" is not a reason to
 *      bill every ambiguous repository for container startup; it is a reason to
 *      say "I can't tell". The one exception is a file that spells out `false`
 *      somewhere, where the container is the cheaper way to be wrong.
 *   4. An explicit `--headed` / `--headless` on argv settles it. Whatever the
 *      config computes, argv is what will actually run.
 *
 * The tests build their own throwaway repositories rather than importing
 * `tests/router.fixtures.ts`, so a sibling relocating that helper cannot break
 * them, and so each repository here reads as the config it is about.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { classify } from '../src/router/index.js';
import { readHeadlessEvidence } from '../src/router/signals.js';

const roots: string[] = [];

/** A throwaway repository, well outside this one. */
async function repo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-runtime-'));
  roots.push(root);
  for (const [name, body] of Object.entries(files)) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body, 'utf8');
  }
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => fs.rm(root, { recursive: true, force: true })));
});

const pwConfig = (use: string): string =>
  [
    "import { defineConfig } from '@playwright/test';",
    '',
    'export default defineConfig({',
    "  testDir: './e2e',",
    `  use: ${use},`,
    '});',
    '',
  ].join('\n');

/* -------------------------------------------------------------------------- */
/* Reading a value without evaluating it                                      */
/* -------------------------------------------------------------------------- */

describe('readHeadlessEvidence', () => {
  it('believes a literal, in either direction', () => {
    expect(readHeadlessEvidence('use: { headless: false }')).toEqual({ shape: 'literal-false' });
    expect(readHeadlessEvidence('use: { headless: true }')).toEqual({ shape: 'literal-true' });
  });

  it("accepts puppeteer's string spellings of headless", () => {
    expect(readHeadlessEvidence("launch({ headless: 'new' })")).toEqual({ shape: 'literal-true' });
    expect(readHeadlessEvidence('launch({ headless: "shell" })')).toEqual({ shape: 'literal-true' });
  });

  it('reports no evidence when there is no headless key at all', () => {
    expect(readHeadlessEvidence('use: { baseURL: "http://localhost:3000" }')).toEqual({
      shape: 'absent',
    });
  });

  it.each([
    ['an env var', 'process.env.HEADED !== "1"'],
    ['a negated env var', '!process.env.CI'],
    ['a local variable', 'headed'],
    ['a ternary', 'mode === "ci" ? true : false'],
    ['a function call', 'shouldRunHeadless()'],
    ['a nullish default', 'options.headless ?? true'],
  ])('calls %s computed, and quotes it back', (_what, expression) => {
    const evidence = readHeadlessEvidence(`use: { headless: ${expression} }`);
    expect(evidence.shape).toBe('computed');
    if (evidence.shape !== 'computed') throw new Error('unreachable');
    expect(evidence.expression).toBe(expression);
  });

  it('treats a value that wrapped onto the next line as computed, not absent', () => {
    const evidence = readHeadlessEvidence('use: {\n  headless:\n    process.env.CI === "1",\n}');
    expect(evidence.shape).toBe('computed');
  });

  it('calls a file that spells out both literals conditional', () => {
    const text = 'use: process.env.CI ? { headless: true } : { headless: false }';
    expect(readHeadlessEvidence(text)).toEqual({ shape: 'conditional' });
  });

  it('calls a literal false conditional once anything else could override it', () => {
    const text = 'const base = { headless: false };\nuse: { ...base, headless: wanted }';
    expect(readHeadlessEvidence(text)).toEqual({ shape: 'conditional' });
  });

  it('notices browser options handed over as a reference', () => {
    expect(readHeadlessEvidence('export default { use: sharedUse };')).toEqual({
      shape: 'delegated',
      key: 'sharedUse',
    });
    expect(readHeadlessEvidence('export default { use: makeUse() };')).toEqual({
      shape: 'delegated',
      key: 'makeUse()',
    });
    expect(readHeadlessEvidence("import { use } from './base.js';\nexport default { use };")).toEqual(
      { shape: 'delegated', key: 'use' },
    );
    expect(readHeadlessEvidence('const b = await puppeteer.launch(opts);')).toEqual({
      shape: 'delegated',
      key: 'opts',
    });
  });

  /* The rule earns its keep only if it stays quiet on the configs everyone
     actually writes. Each of these is fully readable and must report `absent`,
     because `absent` is what keeps the confident, zero-overhead default. */
  it.each([
    ['a device spread', "use: { ...devices['Desktop Chrome'], viewport: null }"],
    ['a plain options object', "use: { baseURL: 'http://localhost:3000', trace: 'on' }"],
    ['launch with no arguments', 'const b = await puppeteer.launch();'],
    ['launch with an object literal', 'const b = await puppeteer.launch({ args: ["--no-sandbox"] });'],
    ['launchOptions written out', 'use: { launchOptions: { slowMo: 50 } }'],
  ])('does not cry runtime over %s', (_what, text) => {
    expect(readHeadlessEvidence(text)).toEqual({ shape: 'absent' });
  });
});

/* -------------------------------------------------------------------------- */
/* What the router says about what it cannot see                              */
/* -------------------------------------------------------------------------- */

describe('a capability computed at runtime', () => {
  it('is admitted, not papered over with the tool default', async () => {
    const cwd = await repo({
      'playwright.config.ts': pwConfig('{ headless: process.env.HEADED !== "1" }'),
    });

    const decision = await classify({ cwd, command: ['npx', 'playwright', 'test'] });

    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('low');
    // The reason names the expression, so the user can check the router's
    // homework rather than take "low confidence" on faith.
    expect(decision.reason).toContain('process.env.HEADED !== "1"');
    expect(decision.reason).toMatch(/without ever executing them/);
    // And it must not claim the thing it cannot know.
    expect(decision.reason).not.toMatch(/no window opens/);
    expect(decision.signals[0]).toBe(
      'playwright.config.ts: headless is computed at runtime (headless: process.env.HEADED !== "1")',
    );
  });

  it('names the remedy, because "low confidence" alone is not actionable', async () => {
    const cwd = await repo({ 'playwright.config.ts': pwConfig('{ headless: wanted }') });

    const decision = await classify({ cwd, command: ['npx', 'playwright', 'test'] });

    expect(decision.reason).toContain('--headed');
  });

  it('still stays in the default lane rather than billing a container for a guess', async () => {
    const cwd = await repo({ 'playwright.config.ts': pwConfig('{ headless: !DEBUG }') });

    const decision = await classify({ cwd, command: ['npx', 'playwright', 'test'] });

    expect(decision.lane).toBe('headless');
  });

  it('is admitted in a script the command names, too', async () => {
    const cwd = await repo({
      'scrape.js': [
        "const puppeteer = require('puppeteer');",
        'const browser = await puppeteer.launch({ headless: !process.env.DEBUG });',
      ].join('\n'),
    });

    const decision = await classify({ cwd, command: ['node', 'scrape.js'] });

    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('low');
    expect(decision.reason).toContain('!process.env.DEBUG');
    // The old answer asserted the opposite of what this script does under DEBUG.
    expect(decision.signals).not.toContain('scrape.js: uses puppeteer, headless not disabled');
  });

  it('is admitted in vitest browser mode, which already took the safe lane but misdescribed it', async () => {
    const cwd = await repo({
      'vitest.config.ts': [
        'export default {',
        '  test: { browser: { enabled: true, headless: process.env.CI === "true" } },',
        '};',
      ].join('\n'),
    });

    const decision = await classify({ cwd, command: ['npx', 'vitest', 'run'] });

    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('low');
    expect(decision.signals[0]).toContain('headless is computed at runtime');
    // It used to report "headless not set" about a config that sets it.
    expect(decision.signals[0]).not.toContain('headless not set');
    expect(decision.reason).toMatch(/never evaluates/);
  });
});

describe('a capability that lives in another file', () => {
  it('is admitted, and the imported file is not read to find it', async () => {
    const cwd = await repo({
      'playwright.config.ts': [
        "import { use } from './pw.use.js';",
        'export default { use };',
      ].join('\n'),
      // A real `headless: false` sitting one import away. The router routes the
      // same way whether or not this file exists, which is the whole point: it
      // reads the config it was pointed at and follows nothing out of it.
      'pw.use.ts': 'export const use = { headless: false };',
    });

    const decision = await classify({ cwd, command: ['npx', 'playwright', 'test'] });

    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('low');
    expect(decision.reason).toMatch(/one file away/);
    expect(decision.signals[0]).toContain('browser options come from `use`');
  });

  it('reads exactly one config, and the answer does not change when the import does', async () => {
    const files = {
      'playwright.config.ts': pwConfig('sharedUse'),
    };
    const withoutImport = await classify({
      cwd: await repo(files),
      command: ['npx', 'playwright', 'test'],
    });
    const withHeadedImport = await classify({
      cwd: await repo({ ...files, 'shared.ts': 'export const sharedUse = { headless: false };' }),
      command: ['npx', 'playwright', 'test'],
    });

    // Identical, because the second file was never opened. If this ever differs,
    // the router grew a module resolver and this file's premise is void.
    expect(withHeadedImport).toEqual(withoutImport);
    expect(withoutImport.confidence).toBe('low');
  });
});

describe('a file that spells out both answers', () => {
  it('takes the container, because that is the cheaper way to be wrong', async () => {
    const cwd = await repo({
      'playwright.config.ts': pwConfig('process.env.CI ? { headless: true } : { headless: false }'),
    });

    const decision = await classify({ cwd, command: ['npx', 'playwright', 'test'] });

    expect(decision.lane).toBe('container');
    // Safe lane, but not a confident one: half the time this run is headless
    // and the container was pure overhead.
    expect(decision.confidence).toBe('low');
    expect(decision.reason).toMatch(/picks between them at runtime/);
    expect(decision.reason).not.toBe(
      'playwright.config.ts sets headless: false, so this run would open a real browser window on your desktop; the container lane gives it an Xvfb display to open into instead.',
    );
  });

  it('does the same for a script, and says which script', async () => {
    const cwd = await repo({
      'crawl.mjs': [
        "import puppeteer from 'puppeteer';",
        'const opts = process.env.CI ? { headless: true } : { headless: false };',
        'await puppeteer.launch(opts);',
      ].join('\n'),
    });

    const decision = await classify({ cwd, command: ['node', 'crawl.mjs'] });

    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('low');
    expect(decision.reason).toContain('crawl.mjs');
    expect(decision.reason).toMatch(/without running it/);
  });
});

/* -------------------------------------------------------------------------- */
/* argv settles what a config only computes                                   */
/* -------------------------------------------------------------------------- */

describe('an explicit flag settles what the router could not read', () => {
  it('restores confidence when the command pins headless itself', async () => {
    const cwd = await repo({
      'playwright.config.ts': pwConfig('{ headless: process.env.HEADED !== "1" }'),
    });

    const decision = await classify({
      cwd,
      command: ['npx', 'playwright', 'test', '--headless'],
    });

    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('high');
    // The observation is kept and marked settled, not deleted — the config
    // still says what it says.
    expect(decision.signals.some((line) => line.includes('settled by'))).toBe(true);
  });

  it('does the same for the caller hint the CLI and MCP server pass down', async () => {
    const cwd = await repo({ 'playwright.config.ts': pwConfig('{ headless: computeIt() }') });

    const decision = await classify({
      cwd,
      command: ['npx', 'playwright', 'test'],
      hints: { headed: false },
    });

    expect(decision.confidence).toBe('high');
  });

  it('routes to the container on --headed without pretending it read the config', async () => {
    const cwd = await repo({
      'playwright.config.ts': pwConfig('{ headless: process.env.HEADED !== "1" }'),
    });

    const decision = await classify({
      cwd,
      command: ['npx', 'playwright', 'test', '--headed'],
    });

    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('high');
  });
});

/* -------------------------------------------------------------------------- */
/* The readable cases keep the confident answers they had                     */
/* -------------------------------------------------------------------------- */

describe('the boundary is narrow', () => {
  it('leaves a literal headless: false exactly where it was', async () => {
    const cwd = await repo({ 'playwright.config.ts': pwConfig('{ headless: false }') });

    const decision = await classify({ cwd, command: ['npx', 'playwright', 'test'] });

    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('high');
    expect(decision.signals).toContain('playwright.config.ts: headless: false');
  });

  it('leaves a literal headless: true exactly where it was', async () => {
    const cwd = await repo({ 'playwright.config.ts': pwConfig('{ headless: true }') });

    const decision = await classify({ cwd, command: ['npx', 'playwright', 'test'] });

    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('high');
  });

  it('leaves the ordinary no-config repository confident and cheap', async () => {
    const cwd = await repo({ 'package.json': '{ "name": "app" }' });

    const decision = await classify({ cwd, command: ['npx', 'playwright', 'test'] });

    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('high');
  });

  it('leaves the config shape everyone actually writes confident', async () => {
    const cwd = await repo({
      'playwright.config.ts': [
        "import { defineConfig, devices } from '@playwright/test';",
        '',
        'export default defineConfig({',
        "  testDir: './e2e',",
        "  use: { baseURL: 'http://localhost:3000', trace: 'on-first-retry' },",
        '  projects: [',
        "    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },",
        '  ],',
        '});',
      ].join('\n'),
    });

    const decision = await classify({ cwd, command: ['npx', 'playwright', 'test'] });

    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('high');
  });

  it('still ignores a commented-out headless: false', async () => {
    const cwd = await repo({
      'playwright.config.js': [
        'module.exports = {',
        '  use: {',
        '    // headless: false, // handy when debugging locally',
        "    baseURL: 'http://localhost:3000',",
        '  },',
        '};',
      ].join('\n'),
    });

    const decision = await classify({ cwd, command: ['npx', 'playwright', 'test'] });

    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('high');
  });
});
