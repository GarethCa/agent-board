import { shell, type BrowserWindow } from 'electron';
import { isWebTabUrl } from '@agent-board/daemon/web-url';

/** Opens `url` in the OS browser if `allowed` says so of it as parsed, which `openExternal` is given, so it can't read the string differently. */
async function openChecked(url: string, allowed: (parsed: URL) => boolean, what: string): Promise<void> {
  const parsed = new URL(url);
  if (!allowed(parsed)) throw new Error(`not ${what}: ${url}`);
  await shell.openExternal(parsed.href);
}

/** Opens a web link in the OS browser. Only https: `openExternal` would run anything else, such as `file:`. */
export const openWebLink = (url: string): Promise<void> => openChecked(url, (parsed) => parsed.protocol === 'https:', 'an https link');

/** Opens a web tab's page in the OS browser: https, or http on this machine (a dev server), as the tab shows it. */
export const openWebTabLink = (url: string): Promise<void> => openChecked(url, (parsed) => isWebTabUrl(parsed.href), "a web tab's link");

/**
 * Keeps `window` on the app: it opens no other window and navigates nowhere but `isAppUrl`. An https link it tries to
 * open or navigate to goes to the OS browser instead; anything else is dropped. Note text and tracker data come from
 * outside the app, so nothing they hold may load in an app window.
 */
export function guardWindow(window: BrowserWindow, isAppUrl: (url: string) => boolean): void {
  const toBrowser = (url: string) => void openWebLink(url).catch(() => {});
  // Nothing in the app calls window.open. If something ever does, it must check for a user gesture first: this sends
  // any https URL it is given to the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    toBrowser(url);
    return { action: 'deny' };
  });
  const stayOnApp = (event: { preventDefault(): void }, url: string) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    toBrowser(url);
  };
  window.webContents.on('will-navigate', stayOnApp);
  // A redirect (only the dev server could send one) must not leave the app either.
  window.webContents.on('will-redirect', stayOnApp);
}
