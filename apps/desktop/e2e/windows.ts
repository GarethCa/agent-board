import type { Locator, Page } from '@playwright/test';

/**
 * Clicks a button that closes its own window, and waits for the window to close. The click can land and close the
 * window before Playwright hears back from it, which rejects the click; that's only a failure if the window stays open.
 */
export async function clickClosing(page: Page, button: Locator): Promise<void> {
  await Promise.all([
    page.waitForEvent('close'),
    button.click().catch((error: unknown) => {
      if (!page.isClosed()) throw error;
    }),
  ]);
}
