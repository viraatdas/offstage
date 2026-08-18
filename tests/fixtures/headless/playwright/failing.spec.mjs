import { expect, test } from '@playwright/test';

test('reads the rendered heading', async ({ page }) => {
  await page.setContent('<h1 id="heading">offstage headless fixture</h1>');
  // Deliberately wrong, so the lane has a real Playwright failure to parse.
  await expect(page.locator('#heading')).toHaveText('this text is deliberately wrong', {
    timeout: 2000,
  });
});
