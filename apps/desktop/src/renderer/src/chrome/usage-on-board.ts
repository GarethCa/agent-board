// Whether the plan usage pill shows on the board, beside the zoom controls. A view setting, kept in the daemon's view
// state and shared by Settings › Usage › Plan usage, which turns it on, and the zoom controls, which show it.
import { useEffect, useSyncExternalStore } from 'react';
import { VIEW_KEYS } from '../../../shared/view-saver';

/** The setting as saved (view state, read back untyped): off unless it was saved on. */
export function usageOnBoardFrom(saved: unknown): boolean {
  return saved === true;
}

let value = false;
/** Counts the user's changes, so a read begun before one cannot undo it. */
let epoch = 0;
const listeners = new Set<() => void>();

const publish = (next: boolean) => {
  value = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The setting and its setter, read from the view state on first use, followed as any window changes it, and read again whenever this window comes to the front. */
export function useUsageOnBoard(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, () => value);
  useEffect(() => {
    const read = () => {
      const asked = epoch;
      window.agentBoard.view.get(VIEW_KEYS.usageOnBoard).then(
        (saved) => asked === epoch && publish(usageOnBoardFrom(saved)),
        () => {},
      );
    };
    read();
    window.addEventListener('focus', read);
    // Another window (Settings) changing it reaches this one at once.
    const stop = window.agentBoard.view.onChanged((key, saved) => {
      if (key !== VIEW_KEYS.usageOnBoard) return;
      epoch++;
      publish(usageOnBoardFrom(saved));
    });
    return () => {
      window.removeEventListener('focus', read);
      stop();
    };
  }, []);
  return [
    on,
    (next) => {
      epoch++;
      publish(next);
      void window.agentBoard.view.set(VIEW_KEYS.usageOnBoard, next).catch(() => {});
    },
  ];
}
