/**
 * WebDriver, the one browser stack with no useful default.
 *
 * `npx playwright test` is headless because Playwright says so; `npx wdio run`
 * is headless or headed because a capabilities object somewhere says so. The
 * router used to answer that with a shrug — container, low confidence, for
 * every WebDriver-shaped tool — which is a guess dressed as a decision. These
 * tests pin the replacement: read the capabilities, answer with evidence, and
 * fall back to the guess only when there is genuinely nothing to read.
 *
 * The fixtures here are built in this file rather than shared, because the
 * shared fixture helper is being moved by another change and these cases are
 * only interesting to WebDriver anyway.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { RouteDecision } from '../src/contract/index.js';
import { classify } from '../src/router/index.js';
import type { ClassifyHints } from '../src/router/index.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const REPOS = {
  /** Nothing to read: no config, no package.json. */
  bare: {
    '.keep': '',
  },

  /** The Chrome capability everyone actually writes. */
  chromeHeadless: {
    'wdio.conf.ts': [
      'export const config = {',
      '  capabilities: [',
      '    {',
      "      browserName: 'chrome',",
      "      'goog:chromeOptions': { args: ['--headless=new', '--disable-dev-shm-usage'] },",
      '    },',
      '  ],',
      '};',
      '',
    ].join('\n'),
  },

  /** Firefox spells it with a single dash. */
  firefoxHeadless: {
    'wdio.conf.js': [
      'exports.config = {',
      '  capabilities: [',
      "    { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless'] } },",
      '  ],',
      '};',
      '',
    ].join('\n'),
  },

  /** Some setups use the plain key instead of a browser switch. */
  headlessKey: {
    'wdio.conf.ts': [
      'export const config = {',
      "  capabilities: [{ browserName: 'chrome', headless: true }],",
      '};',
      '',
    ].join('\n'),
  },

  /** A deliberate headed run. */
  headed: {
    'wdio.conf.ts': [
      'export const config = {',
      "  capabilities: [{ browserName: 'chrome', headless: false }],",
      '};',
      '',
    ].join('\n'),
  },

  /** A switch that is only in a comment is not a switch. */
  commented: {
    'wdio.conf.js': [
      'exports.config = {',
      '  capabilities: [',
      '    {',
      "      browserName: 'chrome',",
      "      // 'goog:chromeOptions': { args: ['--headless=new'] },",
      "      /* args: ['--headless'] */",
      '    },',
      '  ],',
      '};',
      '',
    ].join('\n'),
  },

  /** A hosted grid: the browser is not on this machine at all. */
  grid: {
    'wdio.conf.ts': [
      'export const config = {',
      "  hostname: 'hub-cloud.browserstack.com',",
      '  port: 443,',
      "  capabilities: [{ browserName: 'chrome', headless: false }],",
      '};',
      '',
    ].join('\n'),
  },

  /** A grid named by its service rather than its hostname. */
  gridService: {
    'wdio.conf.ts': [
      'export const config = {',
      "  services: ['sauce'],",
      "  user: process.env.SAUCE_USERNAME,",
      "  capabilities: [{ browserName: 'chrome' }],",
      '};',
      '',
    ].join('\n'),
  },

  /** A local Selenium on this machine is not a grid. */
  localHub: {
    'wdio.conf.ts': [
      'export const config = {',
      "  hostname: 'localhost',",
      '  port: 4444,',
      "  capabilities: [{ browserName: 'chrome' }],",
      '};',
      '',
    ].join('\n'),
  },

  /** Headless, but loading an extension — which only a headed browser does. */
  extension: {
    'wdio.conf.ts': [
      'export const config = {',
      '  capabilities: [',
      "    { browserName: 'chrome', 'goog:chromeOptions': { args: ['--load-extension=./ext'] } },",
      '  ],',
      '};',
      '',
    ].join('\n'),
  },

  /** The layout the `wdio config` wizard produces. */
  subdir: {
    'test/wdio.conf.js': [
      'exports.config = {',
      "  capabilities: [{ browserName: 'chrome', 'goog:chromeOptions': { args: ['--headless'] } }],",
      '};',
      '',
    ].join('\n'),
  },

  /** A config under a name only the command line knows. */
  namedConfig: {
    'config/wdio.ci.conf.ts': [
      'export const config = {',
      "  capabilities: [{ browserName: 'chrome', 'goog:chromeOptions': { args: ['--headless=new'] } }],",
      '};',
      '',
    ].join('\n'),
  },

  /** The same computed shape, but in a Playwright repo, which does default headless. */
  playwrightComputed: {
    'package.json': `${JSON.stringify(
      { name: 'fixture-pw', devDependencies: { '@playwright/test': '^1.50.0' } },
      null,
      2,
    )}\n`,
    'playwright.config.ts': [
      'export default {',
      "  use: { headless: process.env.HEADED !== '1' },",
      '};',
      '',
    ].join('\n'),
  },

  /**
   * `headless` is real but computed, so offstage can see the key and still not
   * know the value. Playwright's answer to this is "keep the headless default";
   * wdio has no such default, so the same shrug would put a window on screen.
   */
  computed: {
    'wdio.conf.ts': [
      'export const config = {',
      '  capabilities: [',
      "    { browserName: 'chrome', 'goog:chromeOptions': { headless: process.env.HEADED !== '1' } },",
      '  ],',
      '};',
      '',
    ].join('\n'),
  },

  /** The capabilities live in another module offstage does not follow. */
  delegated: {
    'wdio.conf.ts': [
      "import { capabilities } from './caps.js';",
      '',
      'export const config = { capabilities };',
      '',
    ].join('\n'),
  },

  /** The command hides in a package script, which is where it usually lives. */
  scripted: {
    'package.json': `${JSON.stringify(
      { name: 'fixture-wdio', scripts: { e2e: 'wdio run wdio.conf.ts' } },
      null,
      2,
    )}\n`,
    'wdio.conf.ts': [
      'export const config = {',
      "  capabilities: [{ browserName: 'chrome', 'goog:chromeOptions': { args: ['--headless=new'] } }],",
      '};',
      '',
    ].join('\n'),
  },
} satisfies Record<string, Record<string, string>>;

type RepoName = keyof typeof REPOS;

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-wdio-'));
  for (const [name, files] of Object.entries(REPOS)) {
    for (const [relative, contents] of Object.entries(files)) {
      const absolute = path.join(root, name, relative);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, contents, 'utf8');
    }
  }
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function route(repo: RepoName, command: string[], hints?: ClassifyHints): Promise<RouteDecision> {
  return classify({ cwd: path.join(root, repo), command, ...(hints === undefined ? {} : { hints }) });
}

function signalText(decision: RouteDecision): string {
  return decision.signals.join(' | ');
}

/* -------------------------------------------------------------------------- */
/* The capabilities decide                                                    */
/* -------------------------------------------------------------------------- */

describe('wdio is routed on its capabilities, not on its name', () => {
  it('runs in place when Chrome is launched headless', async () => {
    const decision = await route('chromeHeadless', ['npx', 'wdio', 'run', 'wdio.conf.ts']);
    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('high');
    expect(signalText(decision)).toContain('wdio.conf.ts: capabilities pass --headless=new');
    expect(decision.reason).toMatch(/opens no window/);
  });

  it('understands the single-dash spelling Firefox uses', async () => {
    const decision = await route('firefoxHeadless', ['npx', 'wdio', 'run', 'wdio.conf.js']);
    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('high');
    expect(signalText(decision)).toContain('capabilities pass -headless');
  });

  it('accepts a plain headless: true capability', async () => {
    const decision = await route('headlessKey', ['npx', 'wdio', 'run', 'wdio.conf.ts']);
    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('high');
    expect(signalText(decision)).toContain('wdio.conf.ts: headless: true');
  });

  it('routes a deliberate headed run to the container lane, with high confidence', async () => {
    const decision = await route('headed', ['npx', 'wdio', 'run', 'wdio.conf.ts']);
    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('high');
    expect(signalText(decision)).toContain('wdio.conf.ts: headless: false');
  });

  it('does not count a switch that is only in a comment', async () => {
    const decision = await route('commented', ['npx', 'wdio', 'run', 'wdio.conf.js']);
    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('low');
    expect(signalText(decision)).not.toContain('capabilities pass');
  });

  it('routes an extension-loading capability to the container lane', async () => {
    const decision = await route('extension', ['npx', 'wdio', 'run', 'wdio.conf.ts']);
    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('high');
    expect(signalText(decision)).toContain('--load-extension=./ext');
  });

  it('finds the config the wizard puts under test/', async () => {
    const decision = await route('subdir', ['npx', 'wdio']);
    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).toContain('test/wdio.conf.js: capabilities pass --headless');
  });

  it('reads the config named by --config', async () => {
    const decision = await route('namedConfig', [
      'npx',
      'wdio',
      'run',
      '--config',
      'config/wdio.ci.conf.ts',
    ]);
    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).toContain('config/wdio.ci.conf.ts: capabilities pass --headless=new');
  });

  it('reads the config named positionally, under any wdio-ish name', async () => {
    const decision = await route('namedConfig', ['npx', 'wdio', 'run', 'config/wdio.ci.conf.ts']);
    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).toContain('config/wdio.ci.conf.ts');
  });

  it('follows a package script down to the wdio config', async () => {
    const decision = await route('scripted', ['npm', 'run', 'e2e']);
    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('high');
    expect(signalText(decision)).toContain('wdio.conf.ts: capabilities pass --headless=new');
  });
});

/* -------------------------------------------------------------------------- */
/* Remote grids                                                               */
/* -------------------------------------------------------------------------- */

describe('a browser on someone else’s machine is not a window on yours', () => {
  it('runs the client in place when the config points at a hosted grid', async () => {
    const decision = await route('grid', ['npx', 'wdio', 'run', 'wdio.conf.ts']);
    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('high');
    expect(signalText(decision)).toContain('browser runs on hub-cloud.browserstack.com');
  });

  it('ignores headless: false when the browser is not on this machine', async () => {
    const decision = await route('grid', ['npx', 'wdio', 'run', 'wdio.conf.ts']);
    expect(signalText(decision)).not.toContain('headless: false');
  });

  it('recognises a grid named by its service rather than its hostname', async () => {
    const decision = await route('gridService', ['npx', 'wdio', 'run', 'wdio.conf.ts']);
    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).toContain('a hosted grid');
  });

  it('does not treat a local hub as a grid', async () => {
    const decision = await route('localHub', ['npx', 'wdio', 'run', 'wdio.conf.ts']);
    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('low');
  });
});

/* -------------------------------------------------------------------------- */
/* The honest fallback                                                        */
/* -------------------------------------------------------------------------- */

describe('when nothing settles it, the guess says it is a guess', () => {
  it('still routes to the container lane, at low confidence', async () => {
    const decision = await route('bare', ['npx', 'wdio', 'run', 'wdio.conf.js']);
    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('low');
  });

  it('names what would settle it instead of asserting a window opens', async () => {
    const decision = await route('bare', ['npx', 'wdio', 'run', 'wdio.conf.js']);
    expect(decision.reason).toMatch(/no headless default/);
    expect(decision.reason).toMatch(/--headless/);
    expect(signalText(decision)).toContain('no headless capability found');
  });

  it('reports a config it could not read rather than staying silent', async () => {
    const decision = await route('bare', ['npx', 'wdio', 'run', 'wdio.conf.js']);
    expect(signalText(decision)).toContain('wdio.conf.js could not be read');
  });

  it('refuses to read a config outside the repository', async () => {
    const decision = await route('chromeHeadless', ['npx', 'wdio', 'run', '../grid/wdio.conf.ts']);
    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('low');
    expect(signalText(decision)).toContain('could not be read');
  });

  it('is overridden by an explicit headless hint', async () => {
    const decision = await route('bare', ['npx', 'wdio', 'run', 'wdio.conf.js'], { headed: false });
    expect(decision.lane).toBe('headless');
    expect(decision.reason).toMatch(/overrides that guess/);
    expect(signalText(decision)).toContain('overridden by');
  });

  it('is overridden by --headless on the command line', async () => {
    const decision = await route('bare', ['npx', 'wdio', 'run', 'wdio.conf.js', '--headless']);
    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).not.toContain('no headless capability found');
  });

  it('still reports a headed config as overridden rather than hiding it', async () => {
    const decision = await route('headed', ['npx', 'wdio', 'run', 'wdio.conf.ts', '--headless']);
    expect(decision.lane).toBe('headless');
    expect(signalText(decision)).toContain('headless: false (overridden by --headless)');
    expect(decision.reason).toMatch(/config in this repository asks for a headed browser/);
  });

  it('keeps the container lane when the command itself asks for a head', async () => {
    const decision = await route('chromeHeadless', ['npx', 'wdio', 'run', 'wdio.conf.ts', '--headed']);
    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('high');
  });
});

/* -------------------------------------------------------------------------- */
/* A value it cannot read is not a value it can assume                        */
/* -------------------------------------------------------------------------- */

/**
 * The regression followup-10 flagged and nobody had a fixture for.
 *
 * `computed` and `delegated` mean "the file names headless but offstage cannot
 * evaluate it", and the honest fallback is whatever the tool does on its own.
 * For Playwright that is headless, so those shapes keep the default lane. For
 * wdio there is no default at all, and inheriting Playwright's answer routed a
 * config that might well open a window straight into the headless lane — a real
 * window on a real desktop, which is the one outcome offstage promises never to
 * cause. Worse, it was *less* safe the more the config said: a wdio.conf.ts with
 * no headless key routed to the container, and adding a computed one moved it
 * out.
 */
describe('a headless it could not evaluate is not a headless it can assume', () => {
  it('routes a computed headless to the container, not to the default lane', async () => {
    const decision = await route('computed', ['npx', 'wdio', 'run', 'wdio.conf.ts']);
    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('low');
  });

  it('says it could not evaluate the expression, and that wdio has no default', async () => {
    const decision = await route('computed', ['npx', 'wdio', 'run', 'wdio.conf.ts']);
    expect(decision.reason).toMatch(/computes headless at runtime/);
    expect(decision.reason).toMatch(/no headless default/);
  });

  it('routes delegated capabilities to the container too', async () => {
    const decision = await route('delegated', ['npx', 'wdio', 'run', 'wdio.conf.ts']);
    expect(decision.lane).toBe('container');
    expect(decision.confidence).toBe('low');
  });

  it('is never less safe than the same config with nothing to read', async () => {
    const [computed, bare] = await Promise.all([
      route('computed', ['npx', 'wdio', 'run', 'wdio.conf.ts']),
      route('bare', ['npx', 'wdio', 'run', 'wdio.conf.js']),
    ]);
    expect(computed.lane).toBe(bare.lane);
  });

  it('still lets an explicit --headless settle it', async () => {
    const decision = await route('computed', ['npx', 'wdio', 'run', 'wdio.conf.ts', '--headless']);
    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('high');
  });

  it('leaves Playwright alone: it does have a headless default', async () => {
    /* The same shape in a Playwright repo must keep the headless lane, or the
       fix has traded one wrong answer for another. */
    const decision = await classify({
      cwd: path.join(root, 'playwrightComputed'),
      command: ['npx', 'playwright', 'test'],
    });
    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('low');
  });
});

/* -------------------------------------------------------------------------- */
/* Driver servers                                                             */
/* -------------------------------------------------------------------------- */

describe('a driver server opens nothing until a client asks it to', () => {
  for (const bin of ['chromedriver', 'geckodriver', 'msedgedriver'] as const) {
    it(`routes ${bin} to the container lane at low confidence`, async () => {
      const decision = await route('bare', [bin, '--port=9515']);
      expect(decision.lane).toBe('container');
      expect(decision.confidence).toBe('low');
      expect(decision.reason).toMatch(/opens no window itself/);
      expect(decision.reason).toMatch(/as soon as a client asks it for a session/);
    });
  }

  it('does not read a wdio config on behalf of a bare driver server', async () => {
    // The client that connects to this driver may not be wdio at all, so the
    // repository's wdio config says nothing about it.
    const decision = await route('chromeHeadless', ['chromedriver', '--port=9515']);
    expect(decision.lane).toBe('container');
    expect(signalText(decision)).not.toContain('capabilities pass');
  });

  it('honours a headless switch buried in a capability argument', async () => {
    const decision = await route('bare', [
      'npx',
      'selenium-side-runner',
      '-c',
      'goog:chromeOptions.args=[--headless]',
      'suite.side',
    ]);
    expect(decision.lane).toBe('headless');
    expect(decision.confidence).toBe('high');
    expect(signalText(decision)).toContain('--headless');
  });

  it('is overridden by a headless hint', async () => {
    const decision = await route('bare', ['geckodriver'], { headed: false });
    expect(decision.lane).toBe('headless');
    expect(decision.reason).toMatch(/overrides that guess/);
  });

  it('does not mistake --no-headless for a headless request', async () => {
    const decision = await route('bare', ['chromedriver', '--no-headless']);
    expect(decision.lane).toBe('container');
  });
});

/* -------------------------------------------------------------------------- */
/* safaridriver                                                               */
/* -------------------------------------------------------------------------- */

describe('safaridriver is macOS-only, so no container can run it', () => {
  it('routes to the vm lane', async () => {
    const decision = await route('bare', ['safaridriver', '--port', '4444']);
    expect(decision.lane).toBe('vm');
    expect(decision.confidence).toBe('high');
    expect(decision.reason).toMatch(/only with macOS/);
  });

  it('routes to the vm lane even from a package script', async () => {
    const decision = await route('bare', ['npx', 'safaridriver', '--enable']);
    expect(decision.lane).toBe('vm');
  });
});

/* -------------------------------------------------------------------------- */
/* The promises the router makes everywhere else                              */
/* -------------------------------------------------------------------------- */

describe('WebDriver classification keeps the router’s other promises', () => {
  const SHAPES: string[][] = [
    ['npx', 'wdio', 'run', 'wdio.conf.ts'],
    ['npx', 'wdio'],
    ['chromedriver', '--port=9515'],
    ['geckodriver'],
    ['safaridriver', '--port', '4444'],
  ];

  it('gives the same answer every time', async () => {
    for (const repo of Object.keys(REPOS) as RepoName[]) {
      for (const command of SHAPES) {
        const first = await route(repo, command);
        expect(await route(repo, command), `${repo}: ${command.join(' ')}`).toEqual(first);
      }
    }
  });

  it('never returns a lane outside the contract', async () => {
    for (const repo of Object.keys(REPOS) as RepoName[]) {
      for (const command of SHAPES) {
        const decision = await route(repo, command);
        expect(decision.lane).toMatch(/^(headless|container|vm)$/);
        expect(decision.reason.length).toBeGreaterThan(0);
        expect(decision.signals.length).toBeGreaterThan(0);
      }
    }
  });

  it('leaves every fixture repository byte-for-byte unchanged', async () => {
    const snapshot = async (): Promise<string[]> => {
      const out: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const absolute = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(absolute);
            continue;
          }
          const stats = await fs.stat(absolute);
          out.push(`${path.relative(root, absolute)} ${stats.size} ${stats.mtimeMs}`);
        }
      };
      await walk(root);
      return out.sort();
    };

    const before = await snapshot();
    for (const repo of Object.keys(REPOS) as RepoName[]) {
      for (const command of SHAPES) {
        await route(repo, command);
        await route(repo, command, { headed: true });
      }
    }
    expect(await snapshot()).toEqual(before);
  });
});
