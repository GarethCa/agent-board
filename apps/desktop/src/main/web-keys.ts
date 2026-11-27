// The session window's own keys pressed while a web tab's page has the keyboard. The page is another web contents, so
// they never reach the window's renderer by themselves. Read from the key registry, so a window key added there is
// handed over here too; pure, so both platforms are tested.
import type { Input } from 'electron';
import { WINDOW_KEYS, windowHandles, type WindowKeys } from '../renderer/src/keys/menu-bar';
import { APP_MENU_KEYS, chordPressed, chordsOf, isActive, KEYS, type Chord, type KeyBinding, type KeyId } from '../renderer/src/keys/registry';

/**
 * The window's keys the page keeps: the terminal's text size, the app menu's own (Settings, Close Window, the Overview),
 * which a key handed over would keep from the menu, and the keys of a document or a message box, which a page is
 * neither of.
 */
const PAGE_KEEPS = new Set<KeyId>(['window.textSize', ...APP_MENU_KEYS, 'window.saveDoc', 'window.readingRail', 'window.approvePlan']);

/** The keys that open a field to type in over the window, or move the keyboard to its header or a region of it. */
const TAKE_KEYBOARD = new Set<KeyId>(['move.spotlight', 'move.parkThought', 'move.master', 'move.cheatSheetAnywhere', 'window.jumpOut', 'window.regions']);

// The presses a range written as one chord stands for.
const RANGES: Record<string, readonly string[]> = {
  '1–9': Array.from({ length: 9 }, (_, at) => `Digit${at + 1}`),
  '←↑→↓': ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown'],
};

/** The presses a chord is, a range's one by one. */
function pressesOf(chord: Chord): readonly Chord[] {
  const codes = chord.text === undefined || chord.key !== undefined || chord.code !== undefined ? undefined : RANGES[chord.text];
  return codes === undefined ? [chord] : codes.map((code) => ({ ...chord, code }));
}

/** A chord the page's typing never presses: one with a modifier, or a function key. */
const isChord = (chord: Chord) => chord.mod !== undefined || /^F\d{1,2}$/.test(chord.key ?? '');

/** The window's keys a page hands over: every key of a session window, and those that work anywhere, a terminal's too. */
const HANDED_OVER: readonly KeyBinding[] = KEYS.filter((entry: KeyBinding) => (entry.section === 'window' || entry.scope === 'terminal-safe') && !PAGE_KEEPS.has(entry.id as KeyId));

/** What a web tab's page does with a key press it would otherwise get: hand it to its window as a key, reload itself, or keep it. */
export type WebKey = { window: KeyId } | 'reload' | 'hardReload' | undefined;

type WebInput = Pick<Input, 'type' | 'key' | 'code' | 'meta' | 'control' | 'shift' | 'alt'>;

/**
 * What a key press in a web tab's page is for. The window's own keys from the registry go to the window, on the
 * platform's chords and only while they are on (a `new` key behind Extended shortcuts, a Simplified one under its design):
 * ⌘W closes the tab, not the OS window, and ⌘K, ⌘J, ⌘⇧G, ⌘Esc, F6 and ⌃Tab work as anywhere in it. ⌘R (Ctrl+R) reloads
 * the page, never the app, and ⇧⌘R (Ctrl+Shift+R) skips its cache. A key the tab's window has no handler for (`handles`,
 * such as the Captain's in a session window of its own) stays the page's. Everything else, ⌘C and ⌘V among them, is the page's.
 */
export function webKey(input: WebInput, isMac = process.platform === 'darwin', simplified = false, extended = true, handles: WindowKeys = WINDOW_KEYS.board): WebKey {
  if (input.type !== 'keyDown') return undefined;
  const command = isMac ? input.meta && !input.control : input.control && !input.meta;
  if (command && !input.alt && input.code === 'KeyR') return input.shift ? 'hardReload' : 'reload';
  const press = { key: input.key, code: input.code, metaKey: input.meta, ctrlKey: input.control, shiftKey: input.shift, altKey: input.alt };
  const entry = HANDED_OVER.find(
    (binding) => windowHandles(handles, binding) && isActive(binding, extended, simplified) && chordsOf(binding, isMac).some((chord) => isChord(chord) && pressesOf(chord).some((one) => chordPressed(one, press, isMac))),
  );
  return entry === undefined ? undefined : { window: entry.id as KeyId };
}

/**
 * Whether a key handed to the window must take the keyboard from the page too: those that open a field to type in over
 * the window (⌘K, the switcher; ⌘⇧P, park a thought; the Captain's message box; the cheat sheet's filter) or move the
 * keyboard to its header or another region (⌘J, F6). The page keeps the OS focus otherwise, and what is typed next
 * would go to it.
 */
export function takesKeyboard(id: KeyId): boolean {
  return TAKE_KEYBOARD.has(id);
}
