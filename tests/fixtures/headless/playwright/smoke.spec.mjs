import { expect, test } from '@playwright/test';

test('renders a page without opening a window', async ({ page }) => {
  await page.setContent('<h1 id="heading">offstage headless fixture</h1>');
  await expect(page.locator('#heading')).toHaveText('offstage headless fixture');
});
