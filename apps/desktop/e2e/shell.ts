// The shell's controls since M5b §2 (no top bar): the floating button's
// Edit / Global view / Search, and Settings… in the vault menu.
import type { Page } from '@playwright/test';

async function action(page: Page, name: string) {
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name, exact: true }).click();
}

export const showGlobalView = (page: Page) => action(page, 'Global view');
export const showEditor = (page: Page) => action(page, 'Edit');
export const openSearch = (page: Page) => action(page, 'Search');

/** Settings… from the vault menu, then a category of its left menu (M5b §18). */
export async function openSettings(page: Page, category?: string) {
  await page.locator('[data-vault-menu]').click();
  await page.getByRole('menuitem', { name: 'Settings…' }).click();
  if (category) {
    await page
      .getByRole('navigation', { name: 'Settings categories' })
      .getByRole('button', { name: category, exact: true })
      .click();
  }
}
