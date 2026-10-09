import { expect } from '@playwright/test';

export async function selectSettingsModule(page, id) {
  await expect(page.locator('.settings-panel')).toBeVisible();
  const button = page.locator(`#settings-nav-${id}`);
  await expect(button).toBeAttached();
  if (await button.isVisible()) await button.click();
  else await page.locator('.settings-module-select select').selectOption(id);
  await expect(button).toHaveAttribute('aria-current', 'page');
}
