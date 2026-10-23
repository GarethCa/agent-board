import { useSyncExternalStore } from 'react';
import type { DaemonSettings, NeedsYouShows } from '@agent-board/daemon/protocol';

/** What the needs-you inbox lists until the daemon says: its default. */
const DEFAULT_SHOWS: NeedsYouShows = 'explicit';

let shows: NeedsYouShows = DEFAULT_SHOWS;
const listeners = new Set<() => void>();
let following = false;

const take = (settings: Pick<DaemonSettings, 'needsYouShows'>) => {
  if (settings.needsYouShows === shows) return;
  shows = settings.needsYouShows;
  for (const listener of listeners) listener();
};

/** Reads the setting once, and follows its changes from any window, from the first component that needs it. */
function follow() {
  // A window without the app's API (a gallery of tiles) keeps the default.
  if (following || window.agentBoard?.flowEdges === undefined) return;
  following = true;
  window.agentBoard.flowEdges.onSettingsChanged((event) => take(event.settings));
  window.agentBoard.flowEdges.settings().then(take, () => {});
}

const subscribe = (listener: () => void) => {
  follow();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * What the needs-you inbox lists (`DaemonSettings.needsYouShows`), shared by every component of the window: the
 * inbox, the pill and each tile's needs-you look follow it as it changes, in any window.
 */
export function useNeedsYouShows(): NeedsYouShows {
  return useSyncExternalStore(subscribe, () => shows, () => shows);
}
