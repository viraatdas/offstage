// Tiny Playwright project the headless lane executes. It never opens a window
// (`headless: true`) and never touches the network: both specs build their DOM
// with page.setContent, so the only external thing needed is a Chromium build
// that is *already* in the Playwright browser cache. Nothing here downloads one.
//
// `outputDir` is pinned under `.offstage/`, which is gitignored at any depth, so
// running this fixture by hand cannot leave `test-results/` in the repository.
// The lane test overrides it with `--output` into that run's artifacts dir.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['*.spec.mjs'],
  outputDir: '.offstage/playwright-output',
  reporter: [['list']],
  use: { headless: true, browserName: 'chromium' },
  workers: 1,
  retries: 0,
  forbidOnly: true,
});
