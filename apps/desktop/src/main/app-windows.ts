import type { WebContents } from 'electron';

/**
 * The app's own windows: every renderer window `openWindow` makes (the board, pop-outs, Settings, Overview, and the
 * hidden ones that take pictures), by their web contents, each with what counts as the app's page in it. Only these
 * hear main's broadcasts (`broadcast.ts`), and only their page, while it is the app's, may call main over IPC
 * (`ipc-guard.ts`). A web tab's page, a plan's view, and anything else with a web contents of its own, are never in it.
 *
 * `guardWindow` (`links.ts`) is what keeps an app window on the app's page; the page check here holds even if it misses
 * a way out, so the preload running on some other page still reaches nothing.
 */
const appWindows = new WeakMap<WebContents, (url: string) => boolean>();

/** Counts `contents` as one of the app's own windows, from before its page loads to when it is destroyed. */
export function markAppWindow(contents: WebContents, isAppUrl: (url: string) => boolean): void {
  appWindows.set(contents, isAppUrl);
}

/** Whether `contents` is one of the app's own windows, and still open. */
export function isAppWindow(contents: WebContents): boolean {
  return appWindows.has(contents) && !contents.isDestroyed();
}

/** Whether `url`, shown in `contents`, is the app's own page in one of its own windows. */
export function isAppPage(contents: WebContents, url: string): boolean {
  return isAppWindow(contents) && appWindows.get(contents)!(url);
}
