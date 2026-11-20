// Whether a page keeps its sessions' terminals and chat views alive while they are off screen: the keep-sessions
// setting (Settings › Advanced › Terminals), or the benchmarks' and tests' override.
import { subscribe, viewSettings, viewSettingsLoaded } from '../board/view-settings';

/**
 * `?terminalCache=<bytes>`, a positive number, keeps them whatever the setting, with that budget for terminals: main sets
 * it from `AGENT_BOARD_TERMINAL_CACHE`, never in a packaged build, for the benchmarks and tests.
 */
// Unit tests import this module under node, where there is no `location`.
const asked = typeof location === 'undefined' ? 0 : Number(new URLSearchParams(location.search).get('terminalCache'));
export const CACHE_BYTES = asked > 0 ? asked : null;

/** Whether a terminal or a chat view built or brought back now is kept: read at the mount, so a change of the setting re-attaches no pane. */
export function keepingOffScreen(): boolean {
  return CACHE_BYTES !== null || (viewSettingsLoaded() && viewSettings().keepTerminals);
}

/**
 * Lets go of what a store keeps when the setting is turned off, though no pane may be mounted to hear it: the returned
 * call starts following the setting, from the first one kept, and does nothing after the first time.
 */
export function letGoWhenTurnedOff(letGo: () => void): () => void {
  let following = false;
  return () => {
    if (following) return;
    following = true;
    subscribe(() => {
      if (!keepingOffScreen() && viewSettingsLoaded()) letGo();
    });
  };
}

/**
 * A User Timing measure from `start` to now, for profiles, the benchmarks and the tests: a terminal's or a chat view's
 * mount, park and let-go, and a terminal's open and fit, snapshot and fill. Cleared as soon as it is written, so the
 * page's timeline never fills with them; a `PerformanceObserver` still hears each one.
 */
export function timing(name: string, start: number, detail: unknown): void {
  performance.measure(name, { start, detail });
  performance.clearMeasures(name);
}
