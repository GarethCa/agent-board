import { app, type BrowserWindow } from 'electron';
import { honoursTestOverrides } from './test-overrides';

/**
 * Whether the variables below are read: always in a dev build, in a packaged one only for a test (`AGENT_BOARD_TEST=1`).
 * Read when asked, not at import, and only once a variable is set, so this module works where there is no `app` (a unit
 * test's mock of electron).
 */
const testOverrides = () => honoursTestOverrides(app.isPackaged);

/**
 * Test-only headless mode (`AGENT_BOARD_HEADLESS=1`, set by every e2e launch): no window ever reaches the screen. Each
 * is created hidden and paints offscreen, so the page still renders, animates and takes Playwright's input and
 * screenshots, but the OS draws nothing and WindowServer composites nothing. `AGENT_BOARD_HEADED=1` overrides it, to
 * watch a run; the windows then show without focus, as background mode does.
 */
export function isHeadless(): boolean {
  return process.env.AGENT_BOARD_HEADLESS === '1' && process.env.AGENT_BOARD_HEADED !== '1' && testOverrides();
}

/**
 * Test-only background mode (`AGENT_BOARD_E2E_BACKGROUND=1`, set by every e2e launch, and implied by headless mode): the
 * app never activates itself, so a test run can't take focus or switch Spaces on the developer's Mac. Without either
 * variable nothing changes.
 */
export function inBackgroundMode(): boolean {
  return (process.env.AGENT_BOARD_E2E_BACKGROUND === '1' && testOverrides()) || isHeadless();
}

/** Call before any window exists. On macOS an accessory app has no Dock icon and is never activated. */
export function enterBackgroundMode(): void {
  if (inBackgroundMode() && process.platform === 'darwin') app.setActivationPolicy('accessory');
}

/** Brings `window` to the front and focuses it; in background mode only makes sure it is visible, and headless, not even that. */
export function revealWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore(); // focus() alone leaves a minimised window in the Dock on macOS.
  if (isHeadless()) return;
  if (inBackgroundMode()) {
    window.showInactive();
    return;
  }
  window.show();
  window.focus();
}
