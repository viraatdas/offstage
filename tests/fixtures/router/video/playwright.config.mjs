// The counter-example behind one routing rule: video recording does NOT need a
// head. `headless: true` and `video: 'on'` together, so a run of this project
// either produces a real .webm without any display, or the rule that sends
// `--video=on` to the headless lane is wrong.
//
// Nothing here touches the network, the spec builds its DOM with setContent,
// and nothing downloads a browser. `outputDir` is pinned under `.offstage/`
// (gitignored at any depth) for hand-runs; the router test overrides it with
// `--output` into a temp directory.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['*.spec.mjs'],
  outputDir: '.offstage/playwright-output',
  reporter: [['list']],
  use: {
    headless: true,
    browserName: 'chromium',
    video: 'on',
    viewport: { width: 320, height: 240 },
  },
  workers: 1,
  retries: 0,
  forbidOnly: true,
});
