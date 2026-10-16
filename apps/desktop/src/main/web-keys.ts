// The session window's own keys pressed while a web tab's page has the keyboard (BI2). The page is another
// web contents, so they never reach the window's renderer by themselves. Pure, so both platforms are tested.
import type { Input } from 'electron';

/** The window's shortcuts by `code` (`renderer/src/keys.ts`, `session/window-keys.ts`): tabs, splits, ⌘1–9, ⌘[ ⌘], ⌘I, ⌘K. */
const WINDOW_CODES = new Set(['KeyT', 'KeyW', 'KeyD', 'KeyK', 'BracketLeft', 'BracketRight', ...Array.from({ length: 9 }, (_, at) => `Digit${at + 1}`)]);
const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);

/** What a web tab's page does with a key press it would otherwise get: hand it to its window, reload itself, or keep it. */
export type WebKey = 'window' | 'reload' | 'hardReload' | undefined;

/**
 * What a key press in a web tab's page is for. Its window's own shortcuts go to the window (⌘W closes the tab, not the
 * OS window; ⌘T, ⌘D, ⌘1–9, ⌘K (the switcher) and ⌘⌥ and an arrow as anywhere in it; off macOS with Ctrl+Shift, Ctrl's own keys staying the
 * page's). ⌘R (Ctrl+R) reloads the page, never the app, and ⇧⌘R (Ctrl+Shift+R) skips its cache. Everything else, ⌘C
 * and ⌘V among them, is the page's.
 */
export function webKey(input: Pick<Input, 'type' | 'code' | 'meta' | 'control' | 'shift' | 'alt'>, isMac = process.platform === 'darwin'): WebKey {
  if (input.type !== 'keyDown') return undefined;
  const command = isMac ? input.meta && !input.control : input.control && !input.meta;
  if (command && !input.alt && input.code === 'KeyR') return input.shift ? 'hardReload' : 'reload';
  const chord = isMac ? command : command && input.shift;
  if (!chord) return undefined;
  // With Alt: an arrow moves between panes (⌘⌥, or Ctrl+Shift+Alt), and off macOS Ctrl+Shift+Alt+D splits below.
  if (input.alt) {
    if (ARROWS.has(input.code)) return isMac && input.shift ? undefined : 'window';
    return !isMac && input.code === 'KeyD' ? 'window' : undefined;
  }
  if (WINDOW_CODES.has(input.code)) return 'window';
  // ⌘I, not ⇧⌘I; off macOS Ctrl+Shift+I, as plain Ctrl+I is Tab.
  return input.code === 'KeyI' && !(isMac && input.shift) ? 'window' : undefined;
}
