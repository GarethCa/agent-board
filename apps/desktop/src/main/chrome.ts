import type { BrowserWindowConstructorOptions } from 'electron';
import { windowChrome } from '../preload/api';

/** Which window the chrome is for: the board, a session window popped out into its own, or the Settings window. */
export type ChromeFor = 'board' | 'pop-out' | 'settings';

/**
 * Where the traffic lights sit, from the window's top-left: centred on the midline of the board's top islands
 * (`--island-inset` down, `--island-height` tall, in tokens.css: 14 + 46 / 2 = 37), or of a popped-out window's header
 * (`--window-header-height`, 50 / 2 = 25), or of the Settings window's title bar (`--settings-bar-height`, 38 / 2 = 19).
 * The lights are 14px tall, so their top is 7px above the midline.
 */
const TRAFFIC_LIGHTS: Record<ChromeFor, { x: number; y: number }> = {
  board: { x: 16, y: 30 },
  'pop-out': { x: 18, y: 18 },
  settings: { x: 14, y: 12 },
};

/**
 * The window options for its chrome (docs/adr/0001-app-shell.md): on macOS no title bar, the traffic lights over the
 * page, which leaves room for them and draws its own drag regions; elsewhere the native frame and its window controls.
 */
export function chromeOptions(platform: NodeJS.Platform, kind: ChromeFor): BrowserWindowConstructorOptions {
  if (windowChrome(platform) === 'framed') return {};
  return { titleBarStyle: 'hiddenInset', trafficLightPosition: TRAFFIC_LIGHTS[kind] };
}
