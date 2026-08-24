/**
 * Throwaway repositories for the router tests.
 *
 * The router reads a handful of real files, so its tests need real files. They
 * are built in a fresh temp directory per run, never inside this repository,
 * which would leak fixtures into `tests/` and into whatever offstage is asked
 * to classify next.
 *
 * This file is `.ts`, not `.test.ts`, so vitest imports it but never collects
 * it as a suite.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type FixtureName =
  | 'plain'
  | 'pwHeaded'
  | 'pwHeadless'
  | 'pwCommented'
  | 'pwGpu'
  | 'pwExtension'
  | 'puppeteer'
  | 'puppeteerExtension'
  | 'puppeteerHeaded'
  | 'scripts'
  | 'xcode'
  | 'vitestBrowser'
  | 'vitestBrowserHeadless'
  | 'badPackage';

export interface Fixtures {
  root: string;
  path(name: FixtureName): string;
  cleanup(): Promise<void>;
}

const FILES: Record<FixtureName, Record<string, string>> = {
  plain: {
    // Deliberately empty: no package.json, no config, nothing to read.
    '.keep': '',
  },

  pwHeaded: {
    'playwright.config.ts': [
      "import { defineConfig } from '@playwright/test';",
      '',
      'export default defineConfig({',
      "  testDir: './e2e',",
      '  use: {',
      '    headless: false,',
      '  },',
      '});',
      '',
    ].join('\n'),
  },

  pwHeadless: {
    'playwright.config.ts': [
      "import { defineConfig } from '@playwright/test';",
      '',
      'export default defineConfig({',
      '  use: { headless: true },',
      '});',
      '',
    ].join('\n'),
  },

  pwCommented: {
    'playwright.config.js': [
      'module.exports = {',
      '  use: {',
      '    // headless: false, // handy when debugging locally',
      '    /* headless: false */',
      '    baseURL: "http://localhost:3000",',
      '  },',
      '};',
      '',
    ].join('\n'),
  },

  pwGpu: {
    'playwright.config.ts': [
      "import { defineConfig } from '@playwright/test';",
      '',
      'export default defineConfig({',
      '  use: {',
      '    launchOptions: {',
      "      args: ['--use-gl=egl', '--enable-unsafe-webgpu'],",
      '    },',
      '  },',
      '});',
      '',
    ].join('\n'),
  },

  pwExtension: {
    'playwright.config.ts': [
      "import { defineConfig } from '@playwright/test';",
      '',
      'export default defineConfig({',
      '  use: {',
      '    headless: true,',
      '    launchOptions: {',
      "      args: ['--disable-extensions-except=./ext', '--load-extension=./ext'],",
      '    },',
      '  },',
      '});',
      '',
    ].join('\n'),
  },

  puppeteerExtension: {
    'scripts/scrape.js': [
      "import puppeteer from 'puppeteer';",
      '',
      'const browser = await puppeteer.launch({',
      '  args: [',
      "    '--load-extension=./dist/extension',",
      "    '--use-gl=egl',",
      '  ],',
      '});',
      '',
    ].join('\n'),
  },

  puppeteer: {
    'scripts/scrape.js': [
      "const puppeteer = require('puppeteer');",
      '',
      'async function main() {',
      '  const browser = await puppeteer.launch();',
      '  const page = await browser.newPage();',
      "  await page.goto('https://example.com');",
      "  await page.screenshot({ path: 'out.png' });",
      '  await browser.close();',
      '}',
      '',
      'main();',
      '',
    ].join('\n'),
  },

  puppeteerHeaded: {
    'scripts/scrape.js': [
      "import puppeteer from 'puppeteer';",
      '',
      'const browser = await puppeteer.launch({',
      '  headless: false,',
      '  defaultViewport: null,',
      '});',
      '',
    ].join('\n'),
  },

  scripts: {
    'package.json': `${JSON.stringify(
      {
        name: 'fixture-scripts',
        scripts: {
          test: 'vitest run --reporter=dot',
          'test:unit': 'jest --ci',
          e2e: 'playwright test',
          'e2e:headed': 'playwright test --headed',
          'e2e:chain': 'npm run e2e:headed',
          loop: 'npm run loop',
          build: 'tsc -p tsconfig.json && node scripts/postbuild.mjs',
          record: 'cross-env CI=1 playwright test --video=on > out.log 2>&1',
        },
      },
      null,
      2,
    )}\n`,
  },

  xcode: {
    'App.xcodeproj/project.pbxproj': '// Fixture project file\n',
    'package.json': `${JSON.stringify(
      { name: 'fixture-xcode', scripts: { test: 'vitest run' } },
      null,
      2,
    )}\n`,
  },

  vitestBrowser: {
    'vitest.config.ts': [
      "import { defineConfig } from 'vitest/config';",
      '',
      'export default defineConfig({',
      '  test: {',
      '    browser: {',
      '      enabled: true,',
      "      name: 'chromium',",
      '    },',
      '  },',
      '});',
      '',
    ].join('\n'),
  },

  vitestBrowserHeadless: {
    'vitest.config.ts': [
      "import { defineConfig } from 'vitest/config';",
      '',
      'export default defineConfig({',
      '  test: {',
      '    browser: {',
      '      enabled: true,',
      '      headless: true,',
      '    },',
      '  },',
      '});',
      '',
    ].join('\n'),
  },

  badPackage: {
    'package.json': '{ "name": "broken", "scripts": { "test": }\n',
  },
};

/** Materialize every fixture repository under one temp root. */
export async function createFixtures(): Promise<Fixtures> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-router-'));

  for (const [name, files] of Object.entries(FILES)) {
    for (const [relative, contents] of Object.entries(files)) {
      const absolute = path.join(root, name, relative);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, contents, 'utf8');
    }
  }

  return {
    root,
    path: (name: FixtureName) => path.join(root, name),
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}
