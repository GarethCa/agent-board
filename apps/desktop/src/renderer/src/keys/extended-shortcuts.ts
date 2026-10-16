// The "Extended keyboard shortcuts" setting: whether the registry's `new` keys work. On by default; turned off, the app
// keeps only the keys it had before the registry (and the fixes). Kept in the daemon's view state, so every window
// reads the same value: each reads it as it opens and again whenever it comes to the front.
import { useSyncExternalStore } from 'react';
import { VIEW_KEYS } from '../../../shared/view-saver';

/** The setting as saved (view state, read back untyped): on unless it was turned off. */
export function extendedShortcutsFrom(saved: unknown): boolean {
  return saved !== false;
}

let current = true;
const listeners = new Set<() => void>();

function update(value: boolean) {
  if (value === current) return;
  current = value;
  for (const listener of listeners) listener();
}

/** Whether the registry's `new` keys work. */
export function extendedShortcuts(): boolean {
  return current;
}

/** Turns the setting on or off, here at once and saved for every window. */
export function setExtendedShortcuts(value: boolean): void {
  update(value);
  void window.agentBoard.view.set(VIEW_KEYS.extendedShortcuts, value).catch(() => {});
}

/** Reads the saved setting now and whenever this window comes to the front, where another window may have changed it. */
export function followExtendedShortcuts(): void {
  const read = () =>
    window.agentBoard.view.get(VIEW_KEYS.extendedShortcuts).then(
      (saved) => update(extendedShortcutsFrom(saved)),
      () => {},
    );
  void read();
  window.addEventListener('focus', () => void read());
}

/** The setting, for a component that shows it or what it turns on. */
export function useExtendedShortcuts(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    extendedShortcuts,
  );
}
