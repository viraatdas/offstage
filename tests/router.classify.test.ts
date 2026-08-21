/**
 * The routing table.
 *
 * The first suite is the product claim in executable form: a table of real
 * commands, the lane each one gets, and the observation that decided it. If the
 * thesis ("headless is the default, isolate only what genuinely needs a head")
 * is ever quietly abandoned, this table is where it shows up.
 *
 * The suites after it walk every branch of the classifier one at a time.
 */

import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Lane, RouteDecision } from '../src/contract/index.js';
import { RouteDecisionSchema } from '../src/contract/index.js';
import { classify } from '../src/router/index.js';
import type { ClassifyHints } from '../src/router/index.js';

import type { FixtureName, Fixtures } from './router.fixtures.js';
import { createFixtures } from './router.fixtures.js';

let fixtures: Fixtures;

beforeAll(async () => {
  fixtures = await createFixtures();
});

afterAll(async () => {
  await fixtures.cleanup();
});

interface Row {
  /** What a human would call this case. */
  what: string;
  repo: FixtureName;
  command: string[];
  hints?: ClassifyHints;
  lane: Lane;
  confidence: 'high' | 'low';
  /** A substring that must appear in `signals`, i.e. the deciding observation. */
  signal: string;
  /** A substring that must appear in the human-readable `reason`. */
  reason: string;
}

/* -------------------------------------------------------------------------- */
/* The table                                                                  */
/* -------------------------------------------------------------------------- */

const TABLE: Row[] = [
  /* ------------------------------- headless ------------------------------- */
  {
    what: 'playwright, which is headless by default',
    repo: 'plain',
    command: ['npx', 'playwright', 'test'],
    lane: 'headless',
    confidence: 'high',
    signal: 'playwright (headless by default)',
    reason: 'no window opens',
  },
  {
    what: 'playwright with a config that pins headless: true',
    repo: 'pwHeadless',
    command: ['npx', 'playwright', 'test'],
    lane: 'headless',
    confidence: 'high',
    signal: 'playwright.config.ts: headless: true',
    reason: 'headless: true',
  },
  {
    what: 'a commented-out headless: false does not count',
    repo: 'pwCommented',
    command: ['npx', 'playwright', 'test'],
    lane: 'headless',
    confidence: 'high',
    signal: 'playwright (headless by default)',
    reason: 'Playwright runs headless',
  },
  {
    what: 'puppeteer in a script, launched with defaults',
    repo: 'puppeteer',
    command: ['node', 'scripts/scrape.js'],
    lane: 'headless',
    confidence: 'high',
    signal: 'uses puppeteer',
    reason: 'opens no window',
  },
  {
    what: 'vitest with no browser mode',
    repo: 'plain',
    command: ['npx', 'vitest', 'run'],
    lane: 'headless',
    confidence: 'high',
    signal: 'vitest (no browser mode)',
    reason: 'No display is involved at all',
  },
  {
    what: 'vitest browser mode pinned headless',
    repo: 'plain',
    command: ['npx', 'vitest', '--browser=chromium', '--browser.headless'],
    lane: 'headless',
    confidence: 'high',
    signal: '--browser.headless',
    reason: 'pinned headless',
  },
  {
    what: 'a plain unit-test command',
    repo: 'scripts',
    command: ['npm', 'test'],
    lane: 'headless',
    confidence: 'high',
    signal: 'package.json scripts.test: vitest (no browser mode)',
    reason: 'No display is involved at all',
  },
  {
    what: 'jest, which has never seen a display',
    repo: 'plain',
    command: ['npx', 'jest', '--runInBand'],
    lane: 'headless',
    confidence: 'high',
    signal: 'argv: jest',
    reason: 'No display is involved at all',
  },
  {
    what: 'cypress run, which is headless unless told otherwise',
    repo: 'plain',
    command: ['npx', 'cypress', 'run'],
    lane: 'headless',
    confidence: 'high',
    signal: 'cypress run (headless by default)',
    reason: 'opens no window',
  },
  {
    what: 'a unit test in a repo that also happens to be an Xcode project',
    repo: 'xcode',
    command: ['npm', 'test'],
    lane: 'headless',
    confidence: 'high',
    signal: 'App.xcodeproj present, but this command does not target it',
    reason: 'No display is involved at all',
  },
  {
    what: 'an unrecognised command, answered honestly',
    repo: 'plain',
    command: ['./scripts/do-the-thing.sh', '--fast'],
    lane: 'headless',
    confidence: 'low',
    signal: 'no browser, GPU or macOS-native signal found',
    reason: 're-run with --headed',
  },
  {
    /* Recording is not a head. Playwright takes the frames from the browser it
       already drives and encodes them itself, so this writes a real .webm with
       nothing on screen — see `tests/router.video.test.ts`, which proves it by
       running Chromium rather than by asserting it. */
    what: 'video recording, which a headless browser does perfectly well',
    repo: 'plain',
    command: ['npx', 'playwright', 'test', '--video=on'],
    lane: 'headless',
    confidence: 'high',
    signal: 'argv: --video=on',
    reason: 'captures frames from the browser it is already driving',
  },

  /* ------------------------------- container ------------------------------ */
  {
    what: 'playwright --headed',
    repo: 'plain',
    command: ['npx', 'playwright', 'test', '--headed'],
    lane: 'container',
    confidence: 'high',
    signal: 'argv: --headed',
    reason: 'Xvfb virtual display',
  },
  {
    what: 'a playwright config that sets headless: false',
    repo: 'pwHeaded',
    command: ['npx', 'playwright', 'test'],
    lane: 'container',
    confidence: 'high',
    signal: 'playwright.config.ts: headless: false',
    reason: 'headless: false',
  },
  {
    what: 'puppeteer launched with headless: false',
    repo: 'puppeteerHeaded',
    command: ['node', 'scripts/scrape.js'],
    lane: 'container',
    confidence: 'high',
    signal: 'launches puppeteer with headless: false',
    reason: 'headless: false',
  },
  {
    what: 'WebGL / GPU switches',
    repo: 'plain',
    command: ['npx', 'playwright', 'test', '--use-gl=angle'],
    lane: 'container',
    confidence: 'high',
    signal: 'argv: --use-gl=angle',
    reason: 'real graphics stack',
  },
  {
    what: 'a Chrome extension being loaded',
    repo: 'plain',
    command: ['node', 'run-bot.js', '--load-extension=./dist/extension'],
    lane: 'container',
    confidence: 'high',
    signal: 'argv: --load-extension=./dist/extension',
    reason: 'headed browser profile',
  },
  {
    what: 'desktop capture, which has no surfaces to offer without a display',
    repo: 'plain',
    command: ['node', 'record.js', '--auto-select-desktop-capture-source=Screen 1'],
    lane: 'container',
    confidence: 'high',
    signal: 'argv: --auto-select-desktop-capture-source=Screen 1',
    reason: 'desktop-capture APIs',
  },
  {
    what: 'vitest browser mode, which is headed outside CI',
    repo: 'plain',
    command: ['npx', 'vitest', '--browser=chromium'],
    lane: 'container',
    confidence: 'high',
    signal: 'argv: --browser=chromium',
    reason: 'browser.headless false outside CI',
  },
  {
    what: 'cypress open, a desktop app',
    repo: 'plain',
    command: ['npx', 'cypress', 'open'],
    lane: 'container',
    confidence: 'high',
    signal: 'argv: cypress open',
    reason: 'Cypress desktop app',
  },
  {
    what: 'a headed package script, reached through npm run',
    repo: 'scripts',
    command: ['npm', 'run', 'e2e:headed'],
    lane: 'container',
    confidence: 'high',
    signal: 'package.json scripts.e2e:headed: --headed',
    reason: 'headed browser',
  },
  {
    what: 'the caller asking for a headed run',
    repo: 'plain',
    command: ['npx', 'playwright', 'test'],
    hints: { headed: true },
    lane: 'container',
    confidence: 'high',
    signal: 'hint: headed = true',
    reason: 'You asked for a headed run',
  },

  /* -------------------------------- session -------------------------------- */
  {
    what: 'xcodebuild',
    repo: 'xcode',
    command: ['xcodebuild', '-project', 'App.xcodeproj', '-scheme', 'App', 'build'],
    lane: 'session',
    confidence: 'high',
    signal: 'argv: xcodebuild',
    reason: 'only exists on macOS',
  },
  {
    what: 'xcrun simctl',
    repo: 'plain',
    command: ['xcrun', 'simctl', 'boot', 'iPhone 15'],
    lane: 'session',
    confidence: 'high',
    signal: 'argv: xcrun simctl',
    reason: 'iOS Simulator',
  },
  {
    what: 'an XCUITest scheme',
    repo: 'xcode',
    command: [
      'xcodebuild',
      'test',
      '-scheme',
      'MyAppUITests',
      '-destination',
      'platform=iOS Simulator,name=iPhone 15',
    ],
    lane: 'session',
    confidence: 'high',
    signal: 'argv: -scheme MyAppUITests',
    reason: 'macOS',
  },
  {
    what: 'launching a built .app',
    repo: 'plain',
    command: ['open', './build/Release/MyApp.app'],
    lane: 'session',
    confidence: 'high',
    signal: 'open ./build/Release/MyApp.app',
    reason: 'window',
  },
  {
    what: 'the executable inside an .app bundle',
    repo: 'plain',
    command: ['./build/MyApp.app/Contents/MacOS/MyApp', '--smoke-test'],
    lane: 'session',
    confidence: 'high',
    signal: '.app/Contents/MacOS/MyApp',
    reason: '.app bundle',
  },
  {
    what: 'launching Safari by name',
    repo: 'plain',
    command: ['open', '-a', 'Safari'],
    lane: 'session',
    confidence: 'high',
    signal: 'argv: open Safari',
    reason: 'session lane',
  },

  /* ---------------------------------- vm ---------------------------------- */
  {
    what: 'a .dmg path anywhere in the command',
    repo: 'plain',
    command: ['hdiutil', 'attach', './dist/MyApp-1.2.0.dmg'],
    lane: 'vm',
    confidence: 'high',
    signal: 'argv: ./dist/MyApp-1.2.0.dmg',
    reason: 'disk-image',
  },
  {
    what: 'a .pkg path anywhere in the command',
    repo: 'plain',
    command: ['sudo', 'installer', '-pkg', './dist/MyApp.pkg', '-target', '/'],
    lane: 'vm',
    confidence: 'high',
    signal: 'argv: ./dist/MyApp.pkg',
    reason: 'installer package',
  },
  {
    what: 'opening a disk image',
    repo: 'plain',
    command: ['open', './dist/MyApp-1.2.0.dmg'],
    lane: 'vm',
    confidence: 'high',
    signal: 'argv: ./dist/MyApp-1.2.0.dmg',
    reason: 'disk-image',
  },
];

describe('classify() routing table', () => {
  it('covers at least fifteen commands across all four lanes', () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(15);
    expect(new Set(TABLE.map((row) => row.lane))).toEqual(
      new Set(['headless', 'session', 'container', 'vm']),
    );
  });

  for (const row of TABLE) {
    it(`${row.lane}: ${row.what}`, async () => {
      const decision = await classify({
        cwd: fixtures.path(row.repo),
        command: row.command,
        ...(row.hints === undefined ? {} : { hints: row.hints }),
      });

      expect(decision.lane, row.what).toBe(row.lane);
      expect(decision.confidence, row.what).toBe(row.confidence);
      expect(decision.signals.join(' | '), row.what).toContain(row.signal);
      expect(decision.reason, row.what).toContain(row.reason);
    });
  }

  it('always returns a decision the contract accepts', async () => {
    for (const row of TABLE) {
      const decision = await classify({
        cwd: fixtures.path(row.repo),
        command: row.command,
        ...(row.hints === undefined ? {} : { hints: row.hints }),
      });
      expect(() => RouteDecisionSchema.parse(decision)).not.toThrow();
    }
  });

  it('always returns a reason a human can read', async () => {
    for (const row of TABLE) {
      const decision = await classify({
        cwd: fixtures.path(row.repo),
        command: row.command,
        ...(row.hints === undefined ? {} : { hints: row.hints }),
      });
      // A sentence, not a token: prose, ending in a full stop, with no newlines.
      expect(decision.reason.length, row.what).toBeGreaterThan(40);
      expect(decision.reason.trimEnd().endsWith('.'), row.what).toBe(true);
      expect(decision.reason, row.what).not.toContain('\n');
      expect(decision.signals.length, row.what).toBeGreaterThan(0);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Branches                                                                   */
/* -------------------------------------------------------------------------- */

async function route(repo: FixtureName, command: string[], hints?: ClassifyHints): Promise<RouteDecision> {
  return classify({
    cwd: fixtures.path(repo),
    command,
    ...(hints === undefined ? {} : { hints }),
  });
}

const signalText = (decision: RouteDecision): string => decision.signals.join(' | ');

describe('headless is the default', () => {
  it('says isolating an already-headless run buys nothing', async () => {
    const decision = await route('plain', ['npx', 'playwright', 'test']);
    expect(decision.lane).toBe('headless');
    expect(decision.reason).toMatch(/container startup/i);
  });

  it('treats an explicit --headless as decisive', async () => {
    const decision = await route('plain', ['chromium', '--headless=new', '--screenshot=out.png']);
    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).toContain('--headless=new');
  });

  it('reads --headed=false as a request for headless', async () => {
    const decision = await route('plain', ['npx', 'playwright', 'test', '--headed=false']);
    expect(decision.lane).toBe('headless');
  });

  it('records --disable-gpu without letting it decide anything', async () => {
    const decision = await route('plain', ['npx', 'playwright', 'test', '--disable-gpu']);
    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).toContain('--disable-gpu');
  });

  it('does not treat --video=off as capture', async () => {
    const decision = await route('plain', ['npx', 'playwright', 'test', '--video=off']);
    expect(decision.lane).toBe('headless');
  });

  it('does not mistake playwright --browser=firefox for vitest browser mode', async () => {
    const decision = await route('plain', ['npx', 'playwright', 'test', '--browser=firefox']);
    expect(decision.lane).toBe('headless');
  });

  it('drops the "headless by default" framing when the lane is not headless', async () => {
    const decision = await route('plain', ['npx', 'playwright', 'test', '--headed']);
    expect(signalText(decision)).not.toContain('headless by default');
  });

  it('is honest, not confident, about a command it does not recognise', async () => {
    const decision = await route('plain', ['./bin/run-everything']);
    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('low');
  });
});

describe('container is for web work that genuinely needs a head', () => {
  it('routes --headed', async () => {
    expect((await route('plain', ['npx', 'playwright', 'test', '--headed'])).lane).toBe('container');
  });

  it('routes --no-headless', async () => {
    expect((await route('plain', ['node', 'bot.js', '--no-headless'])).lane).toBe('container');
  });

  it('routes playwright UI mode and the inspector', async () => {
    expect((await route('plain', ['npx', 'playwright', 'test', '--ui'])).lane).toBe('container');
    expect((await route('plain', ['npx', 'playwright', 'test', '--debug'])).lane).toBe('container');
  });

  it('routes playwright codegen', async () => {
    const decision = await route('plain', ['npx', 'playwright', 'codegen', 'https://example.com']);
    expect(decision.lane).toBe('container');
    expect(signalText(decision)).toContain('playwright codegen');
  });

  it('routes --disable-extensions-except', async () => {
    const decision = await route('plain', [
      'node',
      'bot.js',
      '--disable-extensions-except=./ext',
      '--load-extension=./ext',
    ]);
    expect(decision.lane).toBe('container');
  });

  it('routes screen capture switches', async () => {
    const decision = await route('plain', [
      'node',
      'record.js',
      '--auto-select-desktop-capture-source=Entire screen',
    ]);
    expect(decision.lane).toBe('container');
    expect(decision.reason).toMatch(/desktop-capture APIs/);
  });

  it('routes GPU flags hidden in a playwright config', async () => {
    const decision = await route('pwGpu', ['npx', 'playwright', 'test']);
    expect(decision.lane).toBe('container');
    expect(signalText(decision)).toContain('playwright.config.ts: --use-gl=egl');
  });

  it('routes an extension loaded from a playwright config, even when it says headless: true', async () => {
    const decision = await route('pwExtension', ['npx', 'playwright', 'test']);
    expect(decision.lane).toBe('container');
    expect(signalText(decision)).toContain('playwright.config.ts: --load-extension=./ext');
  });

  it('routes flags found inside the script a command names', async () => {
    const decision = await route('puppeteerExtension', ['node', 'scripts/scrape.js']);
    expect(decision.lane).toBe('container');
    expect(signalText(decision)).toContain('scripts/scrape.js: --load-extension=./dist/extension');
    expect(signalText(decision)).toContain('scripts/scrape.js: --use-gl=egl');
  });

  it('routes a GPU feature switch', async () => {
    const decision = await route('plain', ['node', 'render.js', '--enable-features=Vulkan']);
    expect(decision.lane).toBe('container');
  });

  it('routes cypress with no subcommand at all', async () => {
    expect((await route('plain', ['npx', 'cypress'])).lane).toBe('container');
  });

  it('reads the short -c form of the config flag', async () => {
    const decision = await route('plain', ['npx', 'playwright', 'test', '-c', 'nope.config.ts']);
    expect(signalText(decision)).toContain('nope.config.ts could not be read');
  });

  it('routes vitest browser mode when only --browser.enabled is given', async () => {
    expect((await route('plain', ['npx', 'vitest', '--browser.enabled'])).lane).toBe('container');
  });

  it('ignores --browser=false', async () => {
    expect((await route('plain', ['npx', 'vitest', '--browser=false'])).lane).toBe('headless');
  });

  it('routes vitest browser mode enabled only in the config, with low confidence', async () => {
    const decision = await route('vitestBrowser', ['npx', 'vitest']);
    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('low');
    expect(signalText(decision)).toContain('browser mode enabled, headless not set');
  });

  it('leaves vitest alone when the config pins browser.headless', async () => {
    const decision = await route('vitestBrowserHeadless', ['npx', 'vitest']);
    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).toContain('headless: true');
  });

  it('routes a browser binary launched directly', async () => {
    const decision = await route('plain', ['google-chrome', 'https://example.com']);
    expect(decision.lane).toBe('container');
    expect(decision.reason).toMatch(/unless --headless is passed/);
  });

  it('routes WebDriver-shaped tools with low confidence', async () => {
    const decision = await route('plain', ['npx', 'wdio', 'run', 'wdio.conf.js']);
    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('low');
  });

  it('honours a headed hint even when the command looks headless', async () => {
    const decision = await route('plain', ['npx', 'vitest', 'run'], { headed: true });
    expect(decision.lane).toBe('container');
  });
});

describe('session is for macOS-native GUI work', () => {
  it('routes bare xcrun', async () => {
    const decision = await route('plain', ['xcrun', 'xcresulttool', 'get', '--path', 'out.xcresult']);
    expect(decision.lane).toBe('session');
    expect(signalText(decision)).toContain('xcrun xcresulttool');
  });

  it('routes -only-testing on a UITests target', async () => {
    const decision = await route('plain', ['xcodebuild', 'test', '-only-testing:MyAppUITests/LoginTests']);
    expect(decision.lane).toBe('session');
    expect(signalText(decision)).toContain('-only-testing:MyAppUITests/LoginTests');
  });

  it('routes an XCUITest scheme', async () => {
    const decision = await route('plain', ['xcodebuild', 'test', '-scheme', 'AppUITests']);
    expect(decision.lane).toBe('session');
    expect(signalText(decision)).toContain('-scheme AppUITests');
  });

  it('routes a targeted .xcworkspace', async () => {
    const decision = await route('plain', ['xcodebuild', '-workspace', 'App.xcworkspace', '-scheme', 'App']);
    expect(signalText(decision)).toContain('App.xcworkspace');
    expect(decision.lane).toBe('session');
  });

  it('routes open -a', async () => {
    const decision = await route('plain', ['open', '-a', 'Simulator']);
    expect(decision.lane).toBe('session');
  });

  it('routes open -a Safari', async () => {
    const decision = await route('plain', ['open', '-a', 'Safari']);
    expect(decision.lane).toBe('session');
    expect(decision.confidence).toBe('high');
  });

  it('routes open of anything else, with low confidence', async () => {
    const decision = await route('plain', ['open', 'http://localhost:3000']);
    expect(decision.lane).toBe('session');
    expect(decision.confidence).toBe('low');
  });

  it('routes simctl invoked directly', async () => {
    const decision = await route('plain', ['simctl', 'list', 'devices']);
    expect(decision.lane).toBe('session');
    expect(signalText(decision)).toContain('xcrun simctl');
  });

  it('routes macOS GUI tooling', async () => {
    const decision = await route('plain', ['osascript', '-e', 'tell application "Finder" to activate']);
    expect(decision.lane).toBe('session');
    expect(signalText(decision)).toContain('osascript');
  });

  it('routes instruments', async () => {
    const decision = await route('plain', ['instruments', '-t', 'Time Profiler', 'MyApp']);
    expect(decision.lane).toBe('session');
    expect(signalText(decision)).toContain('instruments');
  });

  it('confirms the decision with the repository when it is an Xcode project', async () => {
    const decision = await route('xcode', ['xcodebuild', '-scheme', 'App', 'build']);
    expect(signalText(decision)).toContain('App.xcodeproj present, and this command targets it');
  });

  it('tells the reader how to ask for a disposable machine instead', async () => {
    for (const command of [
      ['xcodebuild', 'test', '-scheme', 'AppUITests'],
      ['open', '-a', 'Safari'],
      ['osascript', '-e', 'beep'],
      ['safaridriver', '--port', '4444'],
    ]) {
      const decision = await route('plain', command);
      expect(decision.lane, command.join(' ')).toBe('session');
      expect(decision.reason, command.join(' ')).toContain('--lane vm');
      expect(decision.reason, command.join(' ')).toContain('second, logged-in macOS account');
    }
  });

  it('wins over a headed web signal, and says so', async () => {
    const decision = await route('plain', ['xcodebuild', 'test', '-scheme', 'App', '--headed']);
    expect(decision.lane).toBe('session');
    expect(decision.confidence).toBe('low');
    expect(decision.reason).toMatch(/a Linux container cannot run macOS apps/);
  });

  it('wins over a headed web signal when the app is opened by name too', async () => {
    const decision = await route('plain', ['open', '-a', 'Safari', '--args', '--headed']);
    expect(decision.lane).toBe('session');
    expect(decision.confidence).toBe('low');
    expect(decision.reason).toContain(
      'This also carries headed-browser signals; the session lane wins because a Linux container cannot run macOS apps.',
    );
  });
});

describe('vm is for macOS work that can change the machine', () => {
  it('routes a .pkg path', async () => {
    const decision = await route('plain', ['open', './dist/MyApp.pkg']);
    expect(decision.lane).toBe('vm');
    expect(signalText(decision)).toContain('argv: ./dist/MyApp.pkg');
  });

  it('routes the installer command', async () => {
    const decision = await route('plain', ['installer', '-pkg', 'MyApp.pkg', '-target', '/']);
    expect(decision.lane).toBe('vm');
    expect(decision.confidence).toBe('high');
    expect(signalText(decision)).toContain('argv: installer');
    expect(decision.reason).toMatch(/installer package to a target volume/);
  });

  it('routes hdiutil attach', async () => {
    const decision = await route('plain', ['hdiutil', 'attach', 'MyApp.dmg']);
    expect(decision.lane).toBe('vm');
    expect(signalText(decision)).toContain('argv: MyApp.dmg');
  });

  it('routes open of a .dmg', async () => {
    const decision = await route('plain', ['open', 'Foo.dmg']);
    expect(decision.lane).toBe('vm');
  });

  it('beats a session signal on the same command line, and says why', async () => {
    const decision = await route('plain', ['sh', '-c', 'xcodebuild build && open ./dist/MyApp.dmg']);
    expect(decision.lane).toBe('vm');
    expect(decision.reason).toContain(
      'The command also carries macOS GUI signals that the session lane could run, but an installer/disk image needs a disposable machine, so the VM lane wins.',
    );
  });

  it('still beats a headed web signal, and says why', async () => {
    const decision = await route('plain', ['hdiutil', 'attach', 'MyApp.dmg', '--headed']);
    expect(decision.lane).toBe('vm');
    expect(decision.confidence).toBe('low');
    expect(decision.reason).toMatch(/Linux container cannot run macOS tooling/);
  });
});

describe('package scripts are followed, never run', () => {
  it('resolves npm test to the command it expands to', async () => {
    const decision = await route('scripts', ['npm', 'test']);
    expect(signalText(decision)).toContain('package.json scripts.test');
  });

  it('resolves yarn <script> without the run keyword', async () => {
    const decision = await route('scripts', ['yarn', 'e2e:headed']);
    expect(decision.lane).toBe('container');
  });

  it('resolves pnpm run <script>', async () => {
    const decision = await route('scripts', ['pnpm', 'run', 'e2e:headed']);
    expect(decision.lane).toBe('container');
  });

  it('applies arguments forwarded after --', async () => {
    const decision = await route('scripts', ['npm', 'run', 'e2e', '--', '--headed']);
    expect(decision.lane).toBe('container');
    expect(signalText(decision)).toContain('package.json scripts.e2e: --headed');
  });

  it('follows a script that runs another script', async () => {
    const decision = await route('scripts', ['npm', 'run', 'e2e:chain']);
    expect(decision.lane).toBe('container');
  });

  it('terminates on a script that runs itself', async () => {
    const decision = await route('scripts', ['npm', 'run', 'loop']);
    expect(decision.lane).toBe('headless');
  });

  it('inspects every segment of a multi-command script', async () => {
    const decision = await route('scripts', ['npm', 'run', 'build']);
    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).toContain('package.json scripts.build: tsc');
  });

  it('sees through cross-env and shell redirection inside a script', async () => {
    const decision = await route('scripts', ['npm', 'run', 'record']);
    /* The flag is found inside `cross-env CI=1 playwright test --video=on >
       out.log 2>&1`, quoted back with its origin — and recording a video is not
       a reason to isolate anything, so the lane stays headless. */
    expect(signalText(decision)).toContain('package.json scripts.record: --video=on');
    expect(decision.lane).toBe('headless');
  });

  it('does not report the package manager itself as the tool', async () => {
    const decision = await route('scripts', ['npm', 'test']);
    expect(signalText(decision)).not.toContain('argv: npm');
  });

  it('falls back to the package manager when the script does not exist', async () => {
    const decision = await route('scripts', ['npm', 'run', 'nope']);
    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).toContain('argv: npm');
  });

  it('does not treat bun test as a package script', async () => {
    const decision = await route('scripts', ['bun', 'test']);
    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).toContain('argv: bun');
  });
});

describe('explicit headless overrides inferred evidence, but not the command itself', () => {
  it('lets --headless override a config that says headless: false', async () => {
    const decision = await route('pwHeaded', ['npx', 'playwright', 'test', '--headless']);
    expect(decision.lane).toBe('headless');
    expect(decision.reason).toMatch(/config in this repository asks for a headed browser/);
    expect(signalText(decision)).toContain('overridden by');
  });

  it('lets a headed:false hint override a config that says headless: false', async () => {
    const decision = await route('pwHeaded', ['npx', 'playwright', 'test'], { headed: false });
    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).toContain('overridden by');
  });

  it('keeps the container lane when the command itself asks for a head', async () => {
    const decision = await route('plain', ['npx', 'playwright', 'test', '--headed'], { headed: false });
    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('low');
    expect(decision.reason).toMatch(/contradicts/);
  });

  it('keeps the container lane when --headed and --headless are both present', async () => {
    const decision = await route('plain', ['node', 'bot.js', '--headed', '--headless']);
    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('low');
  });
});

describe('unreadable repositories are less information, not an error', () => {
  it('classifies against a directory that does not exist', async () => {
    const decision = await classify({
      cwd: path.join(fixtures.root, 'no-such-repo'),
      command: ['npx', 'playwright', 'test'],
    });
    expect(decision.lane).toBe('headless');
  });

  it('survives a malformed package.json', async () => {
    const decision = await route('badPackage', ['npm', 'test']);
    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).toContain('argv: npm');
  });

  it('reports a --config it could not read instead of guessing', async () => {
    const decision = await route('plain', ['npx', 'playwright', 'test', '--config', 'missing.config.ts']);
    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).toContain('missing.config.ts could not be read');
  });

  it('refuses to read a config outside the repository', async () => {
    const decision = await route('pwHeaded', [
      'npx',
      'playwright',
      'test',
      '--config',
      '../pwHeadless/playwright.config.ts',
    ]);
    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).toContain('could not be read');
  });
});

describe('classify() argument validation', () => {
  it('rejects an empty command', async () => {
    await expect(classify({ cwd: fixtures.root, command: [] })).rejects.toThrow(/non-empty command/);
  });

  it('rejects a missing cwd', async () => {
    await expect(classify({ cwd: '', command: ['npx', 'vitest'] })).rejects.toThrow(/non-empty cwd/);
  });

  it('rejects non-string argv entries', async () => {
    await expect(
      classify({ cwd: fixtures.root, command: ['npx', 3 as unknown as string] }),
    ).rejects.toThrow(/string/);
  });
});
