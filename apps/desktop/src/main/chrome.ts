import type { BrowserWindowConstructorOptions } from 'electron';
import { windowChrome } from '../preload/api';
import { TRAFFIC_LIGHTS, type ChromeFor } from '../shared/traffic-lights';

/**
 * The window options for its chrome (docs/adr/0001-app-shell.md): on macOS no title bar, the traffic lights over the
 * page where `TRAFFIC_LIGHTS` puts them (shared/traffic-lights.ts), the page keeping their safe zone clear and drawing
 * its own drag regions; elsewhere the native frame and its window controls.
 */
export function chromeOptions(platform: NodeJS.Platform, kind: ChromeFor): BrowserWindowConstructorOptions {
  if (windowChrome(platform) === 'framed') return {};
  return { titleBarStyle: 'hiddenInset', trafficLightPosition: TRAFFIC_LIGHTS[kind] };
}
