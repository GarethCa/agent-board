import { WINDOW_QUERY } from '../preload/api';

/**
 * The macOS traffic lights and the safe zone round them: the one place every window's room for them comes from. Main
 * puts the lights where `TRAFFIC_LIGHTS` says (main/chrome.ts); each page reads its zone here and sets it as
 * `--traffic-lights-right` and `--traffic-lights-bottom` (renderer/src/main.tsx), which its styles keep
 * every control and title clear of. Where the OS frame holds the window controls, and in full screen, the zone is 0.
 */

/** Which window the chrome is for: the board, a session window popped out into its own, the Settings window or the Overview. */
export type ChromeFor = 'board' | 'pop-out' | 'settings' | 'overview';

/** Which window a renderer window's query opens: the board when it names none of the others. */
export function chromeFor(query: Record<string, string>): ChromeFor {
  if (WINDOW_QUERY.popOut in query) return 'pop-out';
  if (WINDOW_QUERY.settings in query) return 'settings';
  if (WINDOW_QUERY.overview in query) return 'overview';
  return 'board';
}

/**
 * Where the traffic lights sit, from the window's top-left: centred on the midline of the board's top islands
 * (`--island-inset` down, `--island-height` tall, in tokens.css: 14 + 46 / 2 = 37), or of a popped-out window's header
 * (`--window-header-height`, 50 / 2 = 25), or of the Settings or Overview window's title bar (`--settings-bar-height`,
 * 38 / 2 = 19).
 * The lights are 14px tall, so their top is 7px above the midline.
 */
export const TRAFFIC_LIGHTS: Record<ChromeFor, { x: number; y: number }> = {
  board: { x: 16, y: 30 },
  'pop-out': { x: 18, y: 18 },
  settings: { x: 14, y: 12 },
  overview: { x: 14, y: 12 },
};

/** The three lights' box, a little over what they draw (52 by 14), from their position. */
const LIGHTS_SIZE = { width: 56, height: 16 };

/** How far clear of the lights' box nothing the user can click or read may sit. */
export const SAFE_MARGIN = 6;

/** The lights' box in a window, from its top-left, in CSS pixels. */
export function trafficLightsBox(kind: ChromeFor): { left: number; top: number; right: number; bottom: number } {
  const { x, y } = TRAFFIC_LIGHTS[kind];
  return { left: x, top: y, right: x + LIGHTS_SIZE.width, bottom: y + LIGHTS_SIZE.height };
}

/** The safe zone's right and bottom edges from the window's top-left: it runs from the corner to past the lights. */
export interface TrafficLightsZone {
  right: number;
  bottom: number;
}

/** A window's safe zone: the lights' box and its margin when they float over the page, else nothing. */
export function trafficLightsZone({ inset, fullScreen, kind }: { inset: boolean; fullScreen: boolean; kind: ChromeFor }): TrafficLightsZone {
  if (!inset || fullScreen) return { right: 0, bottom: 0 };
  const box = trafficLightsBox(kind);
  return { right: box.right + SAFE_MARGIN, bottom: box.bottom + SAFE_MARGIN };
}

/** The zone as the page's custom properties. */
export function zoneProperties(zone: TrafficLightsZone): Record<'--traffic-lights-right' | '--traffic-lights-bottom', string> {
  return { '--traffic-lights-right': `${zone.right}px`, '--traffic-lights-bottom': `${zone.bottom}px` };
}
