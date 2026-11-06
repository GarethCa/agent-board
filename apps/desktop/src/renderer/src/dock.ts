import { useSyncExternalStore } from 'react';
import { DEFAULT_DOCK, dockFrom, type DockMode } from '../../shared/dock';
import { observeRoot } from './design';

// The Dock setting (shared/dock.ts): `data-dock` on the root while it is not Show everything, so a window opens with
// the right dock and every pick shows at once. Show everything, the default, sets nothing, so what it draws is untouched.

/** What `followDock` needs of the setting: its value as the window opened, and its changes. */
export interface DockSource {
  initial: DockMode;
  onChanged(listener: (dock: DockMode) => void): () => void;
}

/** Shows the setting on `root`, now and whenever it is picked in any window. Returns a stop function. */
export function followDock(root: { dataset: DOMStringMap } = document.documentElement, source: DockSource = window.agentBoard.dock): () => void {
  const show = (dock: DockMode) => {
    if (dock === DEFAULT_DOCK) delete root.dataset.dock;
    else root.dataset.dock = dock;
  };
  show(source.initial);
  return source.onChanged(show);
}

/** The setting `root` shows. */
const dockOf = (root: { dataset: DOMStringMap } = document.documentElement): DockMode => dockFrom(root.dataset.dock);

const subscribe = observeRoot('data-dock');

/** What this window's dock holds, for a component that draws or leaves out the dock. */
export function useDock(): DockMode {
  return useSyncExternalStore(subscribe, () => dockOf(), () => DEFAULT_DOCK);
}
