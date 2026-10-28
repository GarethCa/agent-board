// Demo mode, for recording the promo: the main process opens the board with `?demo=1` only under `AGENT_BOARD_DEMO=1`
// in a build that isn't packaged (main/index.ts), so nothing here is reachable from a packaged app. It hides the
// chrome that only matters while developing (demo.css, `:root[data-demo]`), and gives a recording spec a scripted
// camera and a drawn cursor through `window.__demo`.
import { getViewportForBounds, type Rect, type Viewport } from '@xyflow/react';
import { WINDOW_QUERY } from '../../../preload/api';

/** Whether a window opened with `search` is in demo mode. */
export function demoFrom(search: string): boolean {
  return new URLSearchParams(search).get(WINDOW_QUERY.demo) === '1';
}

/** Whether this window is in demo mode. Read once: only the main process sets it, as the window opens. */
export const DEMO: boolean = typeof location === 'undefined' ? false : demoFrom(location.search);

/** How a camera move speeds up and slows down, by name, so a spec can pass one through `page.evaluate`. */
const EASINGS = {
  linear: (t: number) => t,
  'ease-in': (t: number) => t ** 3,
  'ease-out': (t: number) => 1 - (1 - t) ** 3,
  'ease-in-out': (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
} as const;
export type DemoEasing = keyof typeof EASINGS;

/** The easing called `name`: in and out by default, slow at both ends, as a camera operator moves. */
export function demoEasing(name: DemoEasing = 'ease-in-out'): (t: number) => number {
  if (!Object.hasOwn(EASINGS, name)) throw new Error(`no easing called ${name}: give one of ${Object.keys(EASINGS).join(', ')}`);
  return EASINGS[name];
}

/** The margin round a part of the board the camera frames, as a share of it: the board's own fits use the same. */
const CAMERA_MARGIN = 0.15;

/**
 * The viewport that frames `rect` (in board coordinates) in a window of `view`'s size, centred: zoomed in on it as far
 * as the board zooms, or out as far as it must to fit. Unlike the board's own moves, which never zoom in, a camera
 * pushes in on a tile.
 */
export function cameraViewport(rect: Rect, view: { width: number; height: number; minZoom: number; maxZoom: number }): Viewport {
  return getViewportForBounds(rect, view.width, view.height, view.minZoom, view.maxZoom, CAMERA_MARGIN);
}

/** What a recording spec drives in demo mode, as `window.__demo`. Each move resolves once it is over, finished or cut short. */
export interface DemoApi {
  /** Moves the camera to frame `rect`, in board coordinates, over `ms` milliseconds. */
  camera(rect: Rect, ms: number, easing?: DemoEasing): Promise<void>;
  /** Moves the camera to frame the zone `zoneId` over `ms` milliseconds. */
  fit(zoneId: string, ms: number, easing?: DemoEasing): Promise<void>;
  /** Shows or hides the drawn cursor, which follows the mouse and ripples where it clicks. */
  cursor(shown: boolean): void;
}
