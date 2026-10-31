import { useSyncExternalStore } from 'react';
import type { Design } from '../../shared/design';

// Which design a window shows (docs/adr/0022-simplified-design.md): `data-design='simplified'` on the root under the
// Simplified design, and no attribute at all under Classic, so nothing Classic draws can tell the setting exists.
// Restyling is tokens.css's work, under `:root[data-design='simplified']`; `useSimplified()` is for a component that
// must render something different, not only look different.

/** What `followDesign` needs of the Simplified design setting: its value as the window opened, and its changes. */
export interface DesignSource {
  initial: Design;
  onChanged(listener: (design: Design) => void): () => void;
}

/** Shows the design on `root`, now and whenever it is picked in any window. Returns a stop function. */
export function followDesign(root: { dataset: DOMStringMap } = document.documentElement, source: DesignSource = window.agentBoard.design): () => void {
  const show = (design: Design) => {
    if (design === 'simplified') root.dataset.design = design;
    else delete root.dataset.design;
  };
  show(source.initial);
  return source.onChanged(show);
}

/** Whether `root` shows the Simplified design. */
export const isSimplified = (root: { dataset: DOMStringMap } = document.documentElement) => root.dataset.design === 'simplified';

/** A `useSyncExternalStore` subscription that calls `changed` whenever one of the root's `attributes` changes. */
export function observeRoot(...attributes: string[]): (changed: () => void) => () => void {
  return (changed) => {
    const observer = new MutationObserver(changed);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: attributes });
    return () => observer.disconnect();
  };
}

const subscribe = observeRoot('data-design');

/**
 * Whether this window shows the Simplified design, for a component that renders differently under it. Rendered with no
 * window (a server render, as tests do), Classic.
 */
export function useSimplified(): boolean {
  return useSyncExternalStore(subscribe, () => isSimplified(), () => false);
}
