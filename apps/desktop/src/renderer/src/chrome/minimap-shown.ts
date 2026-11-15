// Whether the minimap is shown, the same on every level of the board: the main board's and each ticket's own. Kept for
// the window's life, not saved: Classic shows it until turned off, the Simplified design hides it until turned on.
import { useCallback, useSyncExternalStore } from 'react';
import { useSimplified } from '../design';

let picked: boolean | undefined;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Whether the minimap is shown, and the setter that shows or hides it on every level. */
export function useMinimapShown(): [boolean, (shown: boolean) => void] {
  const simplified = useSimplified();
  const chosen = useSyncExternalStore(subscribe, () => picked, () => picked);
  const set = useCallback((shown: boolean) => {
    picked = shown;
    for (const listener of listeners) listener();
  }, []);
  return [chosen ?? !simplified, set];
}
