// The menu bar's renderer half, as pure functions: how the registry's keys show in it (main/menu-bar-items.ts draws
// them), the key press a picked item stands for, and a model menu (board/menu-model.tsx) as rows main can draw. Picking
// an item presses its key, so a menu item and its key do the same thing through the same handler.
import type { MenuBarKey, MenuBarRow } from '../../../shared/menu-bar';
import type { ModelEntry } from '../board/menu-model';
import { chordsOf, chordText, isActive, KEYS, type Chord, type KeyBinding } from './registry';

// The `code`s of the keys matched by place, as an accelerator names them.
const CODE_NAMES: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Slash: '/', Backslash: '\\', Period: '.', Comma: ',', Semicolon: ';', Quote: "'", Backquote: '`', Minus: '-', Equal: '=' };
// Keys an accelerator names by name, by their `key`.
const KEY_NAMES = new Set(['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Space', 'Home', 'End', 'PageUp', 'PageDown']);

/** The chord's key as an Electron accelerator names it, or undefined for one it can't: a range, a held key, a click. */
function acceleratorKey(chord: Chord): string | undefined {
  if (chord.code !== undefined) {
    const letter = /^Key([A-Z])$/.exec(chord.code)?.[1] ?? /^Digit(\d)$/.exec(chord.code)?.[1];
    return letter ?? CODE_NAMES[chord.code];
  }
  const key = chord.key ?? chord.text;
  if (key === undefined) return undefined;
  if (KEY_NAMES.has(key) || /^F\d{1,2}$/.test(key)) return key;
  if (key === '+') return 'Plus';
  return key.length === 1 && /[\x21-\x7e]/.test(key) ? key.toUpperCase() : undefined;
}

/**
 * The chord as an Electron accelerator, or undefined for a bare key (it would fire while you type) or one no
 * accelerator can name. ⌘ is always `CommandOrControl`, so two chords that are one press are one string, and the menu
 * bar can give each press to one item.
 */
export function acceleratorOf(chord: Chord, isMac: boolean): string | undefined {
  if (chord.mod === undefined) return undefined;
  const key = acceleratorKey(chord);
  if (key === undefined) return undefined;
  const shift = chord.shift === true;
  switch (chord.mod) {
    case 'command':
      return `CommandOrControl+${shift ? 'Shift+' : ''}${key}`;
    case 'window':
      // Off macOS a window chord is Ctrl+Shift already.
      return `CommandOrControl+${shift || !isMac ? 'Shift+' : ''}${key}`;
    case 'pane':
      return isMac ? `CommandOrControl+Alt+${key}` : `CommandOrControl+Shift+Alt+${key}`;
  }
}

/** What the focused window has now, which says which of the menu bar's key items can run in it. */
export interface MenuBarWhere {
  /** The board is in this window. */
  board: boolean;
  /** Something on the board is selected. */
  selection: boolean;
  /** An arrow on the board is selected. */
  arrows: boolean;
  /** The focus is in a session window, or this window is one. */
  session: boolean;
}

// The board's keys that act on what is selected, and do nothing with nothing selected.
const ON_SELECTION = new Set(['edit.duplicate', 'edit.delete', 'edit.front', 'edit.forward', 'edit.backward', 'edit.back', 'edit.resetRotation', 'make.askClaude']);

/**
 * Whether a binding's key does anything where the window is now: a session window's keys only with the focus in one (a
 * session window on the board, or a window that is one), the board's only in a window with the board, and its keys for
 * the selection only with something selected. So a menu item for one is greyed where its key would do something else,
 * such as ⌘D, which duplicates on the board and splits in a session window.
 */
export function keyAvailable(entry: KeyBinding, where: MenuBarWhere): boolean {
  if (entry.section === 'window') return where.session;
  if (entry.id === 'edit.swapDirection') return where.board && where.arrows && !where.session;
  // Not while a session window has focus, where ⌘D and ⌘[ ⌘] are its own (Split Beside, Previous and Next).
  if (ON_SELECTION.has(entry.id)) return where.board && where.selection && !where.session;
  if (entry.scope === 'board' || entry.scope === 'tile') return where.board;
  return true;
}

/**
 * How a binding shows in the menu bar: its first chord on this platform, and whether it is on and can run `where` (with
 * no `where`, whether the registry alone has it on). A key that is off (behind Extended shortcuts) whose action the
 * window can run without it (`runnable`, such as Arrange the Board) is still picked from the menu, with no accelerator.
 */
export function menuBarKey(entry: KeyBinding, isMac: boolean, extended: boolean, simplified: boolean, where?: MenuBarWhere, runnable = false): MenuBarKey {
  const chord = chordsOf(entry, isMac)[0];
  const active = isActive(entry, extended, simplified);
  const accelerator = chord === undefined || !active ? undefined : acceleratorOf(chord, isMac);
  return {
    ...(accelerator === undefined ? {} : { accelerator }),
    ...(chord === undefined ? {} : { text: chordText(chord, isMac) }),
    enabled: (active || runnable) && (where === undefined || keyAvailable(entry, where)),
  };
}

/** Every binding as the menu bar shows it, by its id. */
export function menuBarKeys(isMac: boolean, extended: boolean, simplified: boolean, where?: MenuBarWhere, runnable: ReadonlySet<string> = new Set()): Record<string, MenuBarKey> {
  return Object.fromEntries(KEYS.map((entry) => [entry.id, menuBarKey(entry, isMac, extended, simplified, where, runnable.has(entry.id))]));
}

// How a key written only by its symbol is pressed.
const TEXT_KEYS: Record<string, string> = { '⌫': 'Backspace', '↵': 'Enter', esc: 'Escape' };

/** The key press a binding's first chord is, for the menu bar to run it as if pressed. */
export function pressOf(entry: KeyBinding, isMac: boolean): KeyboardEventInit {
  const chord = chordsOf(entry, isMac)[0] ?? {};
  const text = chord.text === undefined ? undefined : (TEXT_KEYS[chord.text] ?? chord.text);
  const fromCode = chord.code === undefined ? undefined : (/^Key([A-Z])$/.exec(chord.code)?.[1]?.toLowerCase() ?? /^Digit(\d)$/.exec(chord.code)?.[1] ?? CODE_NAMES[chord.code]);
  const command = chord.mod !== undefined;
  const shift = chord.shift === true || (!isMac && (chord.mod === 'window' || chord.mod === 'pane'));
  return {
    key: chord.key ?? fromCode ?? text ?? '',
    ...(chord.code === undefined ? {} : { code: chord.code }),
    metaKey: isMac && command,
    ctrlKey: !isMac && command,
    shiftKey: shift,
    altKey: chord.mod === 'pane',
    bubbles: true,
    cancelable: true,
  };
}

/**
 * A model menu as rows main can draw, each with its path (`menuIds`). A swatch row is a submenu of its swatches, the
 * one picked checked; a slider has no native form, so it is left to the ⋯ menu.
 */
export function menuBarRows(entries: readonly ModelEntry[]): MenuBarRow[] {
  const rows = (list: readonly ModelEntry[], prefix: string): MenuBarRow[] =>
    list.flatMap((entry): MenuBarRow[] => {
      if (entry === 'separator') return ['separator'];
      if ('heading' in entry) return [{ heading: entry.heading }];
      if ('min' in entry) return [];
      const id = `${prefix}${entry.id}`;
      if ('swatches' in entry) {
        return [{ id, label: entry.label, enabled: true, entries: entry.swatches.map((swatch) => ({ id: `${id}/${swatch.value}`, label: swatch.name, enabled: true, checked: swatch.pressed })) }];
      }
      const enabled = entry.disabled !== true;
      if ('entries' in entry) return [{ id, label: entry.label, enabled, entries: rows(entry.entries, `${id}/`) }];
      return [
        {
          id,
          label: entry.label,
          enabled,
          ...(entry.shortcut === undefined ? {} : { shortcut: entry.shortcut }),
          ...(entry.checked === undefined ? {} : { checked: entry.checked }),
          ...(entry.danger === true ? { danger: true } : {}),
        },
      ];
    });
  return rows(entries, '');
}

/** Runs the row at `path` in a model menu, as picking it there does; false if the menu has no such row now. */
export function runRow(entries: readonly ModelEntry[], path: string): boolean {
  const [head, ...rest] = path.split('/');
  for (const entry of entries) {
    if (entry === 'separator' || 'heading' in entry || entry.id !== head) continue;
    if ('swatches' in entry) {
      const value = rest.join('/');
      if (!entry.swatches.some((swatch) => swatch.value === value)) return false;
      entry.onPick(value);
      return true;
    }
    if ('entries' in entry) return rest.length > 0 && entry.disabled !== true && runRow(entry.entries, rest.join('/'));
    if ('min' in entry || rest.length > 0 || entry.disabled === true) return false;
    entry.onSelect();
    return true;
  }
  return false;
}
