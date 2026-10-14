import { app, type BrowserWindow } from 'electron';

/**
 * Test-only headless mode (`AGENT_BOARD_HEADLESS=1`, set by every e2e launch): no window ever reaches the screen. Each
 * is created hidden and paints offscreen, so the page still renders, animates and takes Playwright's input and
 * screenshots, but the OS draws nothing and WindowServer composites nothing. `AGENT_BOARD_HEADED=1` overrides it, to
 * watch a run; the windows then show without focus, as background mode does.
 */
export const headless = process.env.AGENT_BOARD_HEADLESS === '1' && process.env.AGENT_BOARD_HEADED !== '1';

/**
 * Test-only background mode (`AGENT_BOARD_E2E_BACKGROUND=1`, set by every e2e launch, and implied by headless mode): the
 * app never activates itself, so a test run can't take focus or switch Spaces on the developer's Mac. Without either
 * variable nothing changes.
 */
export const backgroundMode = process.env.AGENT_BOARD_E2E_BACKGROUND === '1' || headless;

/** Call before any window exists. On macOS an accessory app has no Dock icon and is never activated. */
export function enterBackgroundMode(): void {
  if (backgroundMode && process.platform === 'darwin') app.setActivationPolicy('accessory');
}

/** Brings `window` to the front and focuses it; in background mode only makes sure it is visible, and headless, not even that. */
export function revealWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore(); // focus() alone leaves a minimised window in the Dock on macOS.
  if (headless) return;
  if (backgroundMode) {
    window.showInactive();
    return;
  }
  window.show();
  window.focus();
}
