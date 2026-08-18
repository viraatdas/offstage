import { expect, test } from '@playwright/test';

// Paints a few distinct frames so the recording has something to encode, then
// passes. Playwright writes the .webm when the context closes, whether or not
// a display exists.
test('records a video with no display attached', async ({ page }) => {
  for (const color of ['#101820', '#f2aa4c', '#101820', '#f2aa4c']) {
    await page.setContent(`<body style="background:${color}"><h1>offstage</h1></body>`);
    await expect(page.locator('h1')).toHaveText('offstage');
    await page.waitForTimeout(120);
  }
});
