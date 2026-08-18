/**
 * Recording video is not a reason to isolate anything.
 *
 * The router used to lump `--video=on` in with the desktop-capture switches and
 * send both to the container lane, on the theory that a recording needs "a
 * compositor actually drawing frames". That is true of capturing a *screen* and
 * false of recording *the page a runner is already driving*: Playwright asks
 * the browser for its own frames over CDP (`Page.startScreencast`) and muxes
 * the `screencastFrame` stream with the ffmpeg it ships, so the renderer
 * produces the video whether or not anything is presenting it. Routing that to
 * a container bought nothing and charged container startup for it.
 *
 * This file is in two halves, and the second is the one that matters:
 *
 * - **The rules** — `--video` and `--record-video` stay headless, the five
 *   desktop/tab capture switches still go to the container, and neither one
 *   outranks an actual `--headed`.
 * - **The proof** — a real Chromium, headless, with `DISPLAY` and
 *   `WAYLAND_DISPLAY` stripped out of its environment, writing a real `.webm`.
 *   Gated on a browser already being on disk, exactly like the headless lane's
 *   Playwright block: nothing here ever downloads one.
 */

import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RouteDecision } from '../src/contract/index.js';
import { classify } from '../src/router/index.js';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* -------------------------------------------------------------------------- */
/* The rules                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Two throwaway repositories, built here rather than borrowed from
 * `router.fixtures.ts`: that helper is being moved by another change, and a
 * suite that proves a routing rule should not break because a fixture file
 * changed address.
 */
let plainRepo: string;
let scriptRepo: string;
let scratch: string;

beforeAll(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-router-video-'));
  plainRepo = path.join(scratch, 'plain');
  scriptRepo = path.join(scratch, 'scripts');
  await fs.mkdir(plainRepo, { recursive: true });
  await fs.mkdir(scriptRepo, { recursive: true });
  await fs.writeFile(
    path.join(scriptRepo, 'package.json'),
    `${JSON.stringify(
      {
        name: 'fixture-video-scripts',
        scripts: {
          record: 'cross-env CI=1 playwright test --video=on > out.log 2>&1',
          'record:headed': 'playwright test --headed --video=on',
        },
      },
      null,
      2,
    )}\n`,
  );
});

afterAll(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

const route = (cwd: string, command: string[]): Promise<RouteDecision> => classify({ cwd, command });

const signalText = (decision: RouteDecision): string => decision.signals.join('\n');

describe('recording the page needs no display, so it stays headless', () => {
  it('keeps --video=on in the headless lane', async () => {
    const decision = await route(plainRepo, ['npx', 'playwright', 'test', '--video=on']);

    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('high');
  });

  it('still quotes the flag it saw, rather than quietly ignoring it', async () => {
    const decision = await route(plainRepo, ['npx', 'playwright', 'test', '--video=on']);

    expect(signalText(decision)).toContain('argv: --video=on');
  });

  it('says why recording is not a head, in the reason a human reads', async () => {
    const decision = await route(plainRepo, ['npx', 'playwright', 'test', '--video=on']);

    expect(decision.reason).toMatch(/captures frames from the browser/i);
    expect(decision.reason).toMatch(/desktop or another window/i);
  });

  it.each(['on', 'retain-on-failure', 'on-first-retry'])(
    'keeps --video=%s headless',
    async (mode) => {
      const decision = await route(plainRepo, ['npx', 'playwright', 'test', `--video=${mode}`]);
      expect(decision.lane).toBe('headless');
    },
  );

  it('keeps the bare --video form headless', async () => {
    const decision = await route(plainRepo, ['npx', 'playwright', 'test', '--video']);
    expect(decision.lane).toBe('headless');
  });

  it('keeps --record-video headless too', async () => {
    const decision = await route(plainRepo, ['node', 'drive.js', '--record-video=./out']);

    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).toContain('argv: --record-video=./out');
  });

  it('finds it inside a package script and still stays headless', async () => {
    const decision = await route(scriptRepo, ['npm', 'run', 'record']);

    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).toContain('package.json scripts.record: --video=on');
    expect(decision.reason).toMatch(/captures frames from the browser/i);
  });

  it('treats --video=off as no recording request at all', async () => {
    const decision = await route(plainRepo, ['npx', 'playwright', 'test', '--video=off']);

    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).not.toContain('--video=off');
    expect(decision.reason).not.toMatch(/captures frames from the browser/i);
  });

  it('does not volunteer the recording note when nothing asked to record', async () => {
    const decision = await route(plainRepo, ['npx', 'playwright', 'test']);

    expect(decision.reason).not.toMatch(/captures frames from the browser/i);
  });

  it('is honest about an unknown binary that only asks to record', async () => {
    const decision = await route(plainRepo, ['./bin/capture-everything', '--video=on']);

    /* A recording request says nothing about whether this thing opens a window,
       so it must not manufacture confidence it has not earned. */
    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('low');
    expect(decision.reason).toMatch(/re-run with --headed/i);
  });
});

describe('capturing a screen is a different thing, and still needs a head', () => {
  it.each([
    '--auto-select-desktop-capture-source=Entire screen',
    '--auto-select-tab-capture-source-by-title=Dashboard',
    '--auto-accept-this-tab-capture',
    '--enable-usermedia-screen-capturing',
    '--allow-http-screen-capture',
  ])('routes %s to the container lane', async (flag) => {
    const decision = await route(plainRepo, ['node', 'record.js', flag]);

    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('high');
    expect(decision.reason).toMatch(/desktop-capture APIs/);
  });

  it('does not read a falsey desktop-capture switch as capture', async () => {
    const decision = await route(plainRepo, [
      'node',
      'record.js',
      '--enable-usermedia-screen-capturing=false',
    ]);

    expect(decision.lane).toBe('headless');
  });
});

describe('recording never overrides the signals that do decide', () => {
  it('lets --headed win over --video=on', async () => {
    const decision = await route(plainRepo, ['npx', 'playwright', 'test', '--headed', '--video=on']);

    expect(decision.lane).toBe('container');
    expect(decision.reason).toMatch(/headed browser/i);
    /* Still reported — it is just not the reason. */
    expect(signalText(decision)).toContain('argv: --video=on');
    expect(decision.reason).not.toMatch(/captures frames from the browser/i);
  });

  it('lets a headed package script win over the recording in the same script', async () => {
    const decision = await route(scriptRepo, ['npm', 'run', 'record:headed']);

    expect(decision.lane).toBe('container');
  });

  it('lets a desktop capture switch alongside --video=on win', async () => {
    const decision = await route(plainRepo, [
      'node',
      'record.js',
      '--video=on',
      '--auto-select-desktop-capture-source=Entire screen',
    ]);

    expect(decision.lane).toBe('container');
  });

  it('lets macOS-native work win over --video=on', async () => {
    const decision = await route(plainRepo, ['xcodebuild', 'test', '-scheme', 'App', '--video=on']);

    expect(decision.lane).toBe('vm');
  });
});

/* -------------------------------------------------------------------------- */
/* The proof — gated on a browser that is already on disk                     */
/* -------------------------------------------------------------------------- */

const VIDEO_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'router', 'video');

/**
 * The same gate the headless lane uses, restated here rather than imported: it
 * lives inside a `.test.ts` in another lane, and importing that module would
 * re-run its suite as a side effect of this one.
 */
function resolvePlaywrightCli(): string | null {
  try {
    const requireFromFixture = createRequire(path.join(VIDEO_FIXTURE, 'noop.cjs'));
    const cli = path.join(
      path.dirname(requireFromFixture.resolve('@playwright/test/package.json')),
      'cli.js',
    );
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

/** Where Playwright keeps downloaded browsers, when it is not told otherwise. */
function browsersPath(): string | null {
  const configured = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  /* '0' means "next to the package", which the check below cannot inspect. */
  if (configured === '0') return null;
  if (configured !== undefined && configured !== '') return configured;

  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Local', 'ms-playwright');
  return path.join(home, '.cache', 'ms-playwright');
}

/** True only when a Chromium build is *already* on disk. Never downloads one. */
function hasChromium(): boolean {
  const base = browsersPath();
  if (base === null) return false;
  try {
    return readdirSync(base).some(
      (entry) =>
        /^chromium(?:_headless_shell)?-\d+$/.test(entry) &&
        existsSync(path.join(base, entry, 'INSTALLATION_COMPLETE')),
    );
  } catch {
    return false;
  }
}

const PLAYWRIGHT_CLI = resolvePlaywrightCli();
const PLAYWRIGHT_READY = PLAYWRIGHT_CLI !== null && hasChromium();

/** First four bytes of any Matroska/WebM file. */
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

function findFile(dir: string, extension: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(full, extension);
      if (nested !== null) return nested;
    } else if (entry.name.endsWith(extension)) {
      return full;
    }
  }
  return null;
}

describe.skipIf(!PLAYWRIGHT_READY)('a headless browser really does record video', () => {
  let outputDir: string;
  let stdout: string;

  beforeAll(async () => {
    outputDir = path.join(scratch, 'playwright-video-output');
    await fs.mkdir(outputDir, { recursive: true });

    /* No DISPLAY, no WAYLAND_DISPLAY: on Linux this leaves the process with no
       display server to fall back on, which is the whole claim under test. On
       macOS and Windows there is nothing to strip, and headless Chromium does
       not attach to the window server anyway. */
    const env = { ...process.env };
    delete env['DISPLAY'];
    delete env['WAYLAND_DISPLAY'];

    const run = await execFileAsync(
      process.execPath,
      [PLAYWRIGHT_CLI!, 'test', `--output=${outputDir}`],
      { cwd: VIDEO_FIXTURE, env, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );
    stdout = run.stdout;
  }, 180_000);

  it('passes the spec with headless: true and video: on', () => {
    expect(stdout).toContain('1 passed');
  });

  it('writes a .webm that is a real, non-empty WebM file', async () => {
    const video = findFile(outputDir, '.webm');
    expect(video).not.toBeNull();

    const bytes = await fs.readFile(video!);
    expect(bytes.subarray(0, 4)).toEqual(EBML_MAGIC);
    /* An empty container is a few hundred bytes; encoded frames are not. */
    expect(bytes.byteLength).toBeGreaterThan(2_000);
  });

  it('agrees with the router: this exact command is headless work', async () => {
    const decision = await route(VIDEO_FIXTURE, ['npx', 'playwright', 'test', '--video=on']);
    expect(decision.lane).toBe('headless');
  });
});
