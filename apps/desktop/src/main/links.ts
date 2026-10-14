import { shell, type BrowserWindow } from 'electron';

/** Opens a web link in the OS browser. Only https: `openExternal` would run anything else, such as `file:`. */
export async function openWebLink(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`not an https link: ${url}`);
  // The URL as parsed and checked, so openExternal can't read the string differently.
  await shell.openExternal(parsed.href);
}

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
