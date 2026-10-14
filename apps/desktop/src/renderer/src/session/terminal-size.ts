// The terminal text size, one preference for every terminal: ⌘+ ⌘- ⌘0 and a pinch change it, the board's zoom doesn't.

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;
/** What one ⌘+ or ⌘- adds or takes away. */
export const FONT_STEP = 1;
/** Font size per pixel of pinch, so a pinch is smooth rather than a step per event. */
export const PINCH_RATE = 0.05;

const STORAGE_KEY = 'agent-board.terminal-font-size';

/** The size clamped to the limits, or the minimum if it isn't a number. */
export function clampFontSize(size: number): number {
  return Number.isFinite(size) ? Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size)) : MIN_FONT_SIZE;
}

/** What a key does to the size, if it is one of the terminal-size keys with the command key held. */
export function sizeKey(key: string): 'bigger' | 'smaller' | 'reset' | undefined {
  if (key === '+' || key === '=') return 'bigger';
  if (key === '-' || key === '_') return 'smaller';
  if (key === '0') return 'reset';
  return undefined;
}

let current: number | undefined = load();
const listeners = new Set<() => void>();

function load(): number | undefined {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return stored > 0 ? clampFontSize(stored) : undefined;
  } catch {
    return undefined;
  }
}

/** The chosen size, or undefined while it is the theme's. Fractional while pinching; terminals round it. */
export function chosenFontSize(): number | undefined {
  return current;
}

/** Sets the size (undefined resets it to the theme's) and tells every terminal. */
export function setFontSize(size: number | undefined): void {
  current = size === undefined ? undefined : clampFontSize(size);
  try {
    if (current === undefined) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, String(current));
  } catch {
    // The size just doesn't outlast this run.
  }
  for (const listener of listeners) listener();
}

/** Hears every change of size; returns how to stop. */
export function onFontSize(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
