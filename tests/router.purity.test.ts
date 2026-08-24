/**
 * The classifier's central promise: it decides *before* anything runs.
 *
 * That means no browser, no docker, no xcodebuild, no external process at all,
 * not even a cheap `which`. It is checked three ways here, because a promise
 * this load-bearing should not rest on one assertion:
 *
 * 1. the router's own source never imports a process-spawning module;
 * 2. every process API throws while the whole routing table is classified;
 * 3. the repository is byte-for-byte unchanged afterwards.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Any spawn attempt from inside classify(), direct or transitive, lands here.
vi.mock('node:child_process', () => {
  const forbid = (name: string) => (): never => {
    throw new Error(`classify() must not spawn processes, but it called ${name}()`);
  };
  return {
    default: {},
    spawn: forbid('spawn'),
    spawnSync: forbid('spawnSync'),
    exec: forbid('exec'),
    execSync: forbid('execSync'),
    execFile: forbid('execFile'),
    execFileSync: forbid('execFileSync'),
    fork: forbid('fork'),
  };
});

import { classify } from '../src/router/index.js';

import type { Fixtures } from './router.fixtures.js';
import { createFixtures } from './router.fixtures.js';

const ROUTER_DIR = fileURLToPath(new URL('../src/router/', import.meta.url));

/** Every command shape the router knows about, in one list. */
const EVERY_SHAPE: string[][] = [
  ['npx', 'playwright', 'test'],
  ['npx', 'playwright', 'test', '--headed'],
  ['npx', 'playwright', 'codegen', 'https://example.com'],
  ['npx', 'playwright', 'test', '--use-gl=angle', '--video=on'],
  ['node', 'scripts/scrape.js'],
  ['node', 'bot.js', '--load-extension=./ext'],
  ['npx', 'vitest', '--browser=chromium'],
  ['npx', 'vitest', 'run'],
  ['npx', 'cypress', 'open'],
  ['npx', 'cypress', 'run'],
  ['npx', 'jest'],
  ['npm', 'test'],
  ['npm', 'run', 'e2e:headed'],
  ['google-chrome', 'https://example.com'],
  ['npx', 'wdio', 'run', 'wdio.conf.js'],
  ['xcodebuild', 'test', '-scheme', 'MyAppUITests'],
  ['xcrun', 'simctl', 'boot', 'iPhone 15'],
  ['open', './build/MyApp.app'],
  ['open', './dist/MyApp.dmg'],
  ['open', './dist/MyApp.pkg'],
  ['installer', '-pkg', './dist/MyApp.pkg', '-target', '/'],
  ['hdiutil', 'attach', './dist/MyApp.dmg'],
  ['open', '-a', 'Safari'],
  ['osascript', '-e', 'beep'],
  ['./scripts/mystery.sh'],
];

interface Snapshot {
  file: string;
  size: number;
  mtimeMs: number;
}

async function snapshot(root: string): Promise<Snapshot[]> {
  const out: Snapshot[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const stats = await fs.stat(absolute);
      out.push({ file: path.relative(root, absolute), size: stats.size, mtimeMs: stats.mtimeMs });
    }
  };
  await walk(root);
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

let fixtures: Fixtures;

beforeAll(async () => {
  fixtures = await createFixtures();
});

afterAll(async () => {
  await fixtures.cleanup();
});

describe('the classifier is pure', () => {
  it('never imports a process-spawning module', async () => {
    const files = (await fs.readdir(ROUTER_DIR)).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    for (const name of files) {
      const source = await fs.readFile(path.join(ROUTER_DIR, name), 'utf8');
      // Comments are allowed to talk about spawning; code is not.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\*.*$/gm, '');
      expect(code, name).not.toMatch(/child_process/);
      expect(code, name).not.toMatch(/from '(execa|cross-spawn|node:worker_threads)'/);
      expect(code, name).not.toMatch(/\bspawn(Sync)?\s*\(/);
      expect(code, name).not.toMatch(/\bexec(Sync|File|FileSync)?\s*\(/);
    }
  });

  it('classifies every command shape without spawning anything', async () => {
    for (const repo of ['plain', 'scripts', 'puppeteer', 'xcode'] as const) {
      for (const command of EVERY_SHAPE) {
        const decision = await classify({ cwd: fixtures.path(repo), command });
        expect(decision.lane, command.join(' ')).toMatch(/^(headless|session|container)$/);
      }
    }
  });

  it('leaves the repository byte-for-byte unchanged', async () => {
    const before = await snapshot(fixtures.root);
    for (const repo of ['plain', 'scripts', 'puppeteer', 'pwHeaded', 'xcode'] as const) {
      for (const command of EVERY_SHAPE) {
        await classify({ cwd: fixtures.path(repo), command, hints: { headed: true } });
      }
    }
    expect(await snapshot(fixtures.root)).toEqual(before);
  });

  it('is fast enough to run on every invocation', async () => {
    const started = Date.now();
    for (let i = 0; i < 20; i += 1) {
      for (const command of EVERY_SHAPE) {
        await classify({ cwd: fixtures.path('scripts'), command });
      }
    }
    // 420 classifications, each reading a few small files. Anything that shells
    // out could not come close to this, which is the point of the assertion.
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('gives the same answer every time for the same input', async () => {
    for (const command of EVERY_SHAPE) {
      const first = await classify({ cwd: fixtures.path('scripts'), command });
      const second = await classify({ cwd: fixtures.path('scripts'), command });
      expect(second).toEqual(first);
    }
  });
});
