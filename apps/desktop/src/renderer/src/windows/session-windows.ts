// Where each session window is: shown on the board, minimised to the dock, or popped out into its own OS window.
// Pure, so every move is unit-tested; the board holds the list in state.
import type { WindowTarget } from '../../../preload/api';

/** At most one window is `shown` on the board at a time. */
export type Placement = 'shown' | 'docked' | 'popped';

/** A window: what it shows (a session or a shell tile, by ID), what its title bar and dock button call it, and where. */
export interface SessionWindowEntry extends WindowTarget {
  placement: Placement;
}

/** The board's session windows, in the order they were first opened: their order in the dock. */
export type SessionWindows = readonly SessionWindowEntry[];

/** The window shown on the board, if any. */
export function shownWindow(windows: SessionWindows): SessionWindowEntry | undefined {
  return windows.find((entry) => entry.placement === 'shown');
}

/**
 * Shows the target's window on the board, opening it if it is new and docking the one shown before. A popped-out
 * window stays out: the caller brings its OS window forward instead.
 */
export function showWindow(windows: SessionWindows, target: WindowTarget): SessionWindows {
  const existing = windows.find((entry) => entry.id === target.id);
  if (existing?.placement === 'popped') return windows;
  return place(existing ? windows : [...windows, { ...target, placement: 'docked' }], target);
}

/**
 * Swaps what the window `fromId` shows for the target: the window stays where it is, so the session it showed
 * goes rather than into the dock, and the target leaves the dock if it was there. A popped-out target stays out, and
 * nothing changes: stepping goes past those (`poppedOut`).
 */
export function switchWindow(windows: SessionWindows, fromId: string, target: WindowTarget): SessionWindows {
  const existing = windows.find((entry) => entry.id === target.id);
  if (existing?.placement === 'popped' || target.id === fromId) return windows;
  if (!windows.some((entry) => entry.id === fromId)) return showWindow(windows, target);
  return windows
    .filter((entry) => entry !== existing)
    .map((entry) => (entry.id === fromId ? { ...target, placement: 'shown' as const } : entry));
}

/** The sessions in OS windows of their own, which the board's window can't show. */
export function poppedOut(windows: SessionWindows): ReadonlySet<string> {
  return new Set(windows.filter((entry) => entry.placement === 'popped').map((entry) => entry.id));
}

/** Minimises the window to the dock. */
export function minimiseWindow(windows: SessionWindows, id: string): SessionWindows {
  return update(windows, id, (entry) => ({ ...entry, placement: 'docked' }));
}

/** Closes the window, wherever it is. What it shows keeps running. */
export function closeWindow(windows: SessionWindows, id: string): SessionWindows {
  return windows.some((entry) => entry.id === id) ? windows.filter((entry) => entry.id !== id) : windows;
}

/** Notes that the target's window is now in its own OS window, adding it if the board never opened it (its tile popped it out). */
export function popOutWindow(windows: SessionWindows, target: WindowTarget): SessionWindows {
  if (!windows.some((entry) => entry.id === target.id)) return [...windows, { ...target, placement: 'popped' }];
  return update(windows, target.id, (entry) => ({ ...entry, placement: 'popped' }));
}

/** Brings a popped-out window back onto the board, shown; opens it if the board had lost track of it. */
export function popInWindow(windows: SessionWindows, target: WindowTarget): SessionWindows {
  const known = windows.some((entry) => entry.id === target.id);
  return place(known ? windows : [...windows, { ...target, placement: 'docked' }], target);
}

const PLACEMENTS: readonly Placement[] = ['shown', 'docked', 'popped'];

/**
 * The windows as the board last saved them (`saved`, read back untyped), with `current` on top: what the board opened
 * with, or opened before the saved list came back (a notification's agent, a double-clicked tile). A window in both is
 * where it is now; a shown one in `current` stays shown. An entry it can't read, a repeat, and any shown window after
 * the first are dropped or docked, so a damaged save never breaks the board.
 */
export function restoreWindows(saved: unknown, current: SessionWindows): SessionWindows {
  const restored: SessionWindowEntry[] = [];
  for (const entry of Array.isArray(saved) ? (saved as unknown[]) : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { kind, id, title, placement } = entry as Record<string, unknown>;
    if ((kind !== 'session' && kind !== 'shell' && kind !== 'tabs') || typeof id !== 'string' || typeof title !== 'string') continue;
    // A tab window is only ever an OS window of its own.
    if (kind === 'tabs' && placement !== 'popped') continue;
    if (!PLACEMENTS.includes(placement as Placement) || restored.some((known) => known.id === id)) continue;
    const shownAlready = placement === 'shown' && restored.some((known) => known.placement === 'shown');
    restored.push({ kind, id, title, placement: shownAlready ? 'docked' : (placement as Placement) });
  }
  let windows: SessionWindows = restored;
  for (const entry of current) {
    if (entry.placement === 'shown') windows = showWindow(update(windows, entry.id, (known) => ({ ...known, placement: 'docked' })), entry);
    else if (windows.some((known) => known.id === entry.id)) windows = update(windows, entry.id, () => entry);
    else windows = [...windows, entry];
  }
  return windows;
}

/** Shows the target's window, with its title, and docks any other shown one. */
function place(windows: SessionWindows, { id, title }: WindowTarget): SessionWindows {
  return windows.map((entry) => {
    if (entry.id === id) return { ...entry, title, placement: 'shown' };
    return entry.placement === 'shown' ? { ...entry, placement: 'docked' } : entry;
  });
}

function update(windows: SessionWindows, id: string, change: (entry: SessionWindowEntry) => SessionWindowEntry): SessionWindows {
  return windows.some((entry) => entry.id === id) ? windows.map((entry) => (entry.id === id ? change(entry) : entry)) : windows;
}

