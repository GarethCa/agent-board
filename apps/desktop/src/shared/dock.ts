// The Dock setting (Settings › Board › Opening tiles › Dock): what the dock along the board's bottom edge holds. Kept by the main
// process in a file of its own, as the design is, so it is known before a window paints.

export const DOCK_MODES = ['all', 'pinned', 'off'] as const;
/** `all`: every minimised and popped-out window; `pinned`: only the ones the user pinned; `off`: no dock. */
export type DockMode = (typeof DOCK_MODES)[number];

export const DEFAULT_DOCK: DockMode = 'all';

export function isDockMode(value: unknown): value is DockMode {
  return DOCK_MODES.includes(value as DockMode);
}

/** The setting as saved or as a window's query carries it (`WINDOW_QUERY.dock`), read back untyped: everything unless it is a mode. */
export function dockFrom(saved: unknown): DockMode {
  return isDockMode(saved) ? saved : DEFAULT_DOCK;
}

/** The labels Settings gives the modes (Show everything, Only what I pin, Off, in full). */
export const DOCK_LABELS: Record<DockMode, string> = { all: 'All', pinned: 'Pinned only', off: 'Off' };
