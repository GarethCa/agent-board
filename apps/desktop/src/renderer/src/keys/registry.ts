// The key registry: every key the app answers to, in one list. The handlers match presses against it, and the cheat
// sheet, the tooltips and the menu hints write keys from it, so a key and what it says it is can't drift apart.
//
// Each entry is marked `today` (in the app before the registry), `new` (added since) or `fix` (an existing key changed
// to correct a bug). A `new` entry is inactive while the "Extended keyboard shortcuts" setting is off, so the app then
// behaves as it did before; `fix` entries stay, since they correct bugs. A later key is one more entry here.
import { ROTATION_SNAP } from '../board/items/rotation';
import { extendedShortcuts } from './extended-shortcuts';

const mac = navigator.platform.startsWith('Mac');

/**
 * Where a key works: on the board, on the one tile selected, in a session window, anywhere with a terminal included, or
 * in the dialog, menu or popover with the focus.
 */
export type KeyScope = 'board' | 'tile' | 'window' | 'terminal-safe' | 'dialog';

/** Whether the key was in the app before the registry, is new, or fixes one that was. */
export type KeyStatus = 'today' | 'new' | 'fix';

/**
 * How a chord's modifiers are pressed. `command`: ⌘ on macOS, Ctrl elsewhere (the board's). `window`: ⌘ on macOS,
 * Ctrl+Shift elsewhere, where Ctrl and its keys are a terminal's (a session window's). `pane`: ⌘⌥, or Ctrl+Shift+Alt.
 * Without one, no modifier but Shift.
 */
export type Modifier = 'command' | 'window' | 'pane';

export interface Chord {
  mod?: Modifier;
  /** Shift held too (`false`, the default, is Shift up); `'any'` matches either, for a key some layouts type with Shift. */
  shift?: boolean | 'any';
  /** `KeyboardEvent.key` (a letter in either case), for the keys matched by what they type: `n`, `\`, `Enter`, `F2`. */
  key?: string;
  /** `KeyboardEvent.code`, for the keys matched where they are: a window chord, whose key Shift would change. */
  code?: string;
  /** How it is written, when not `key` itself: `↵`, `Esc`, or a range no one press is (`1–9`, `←↑→↓`). */
  text?: string;
}

/** A heading on the cheat sheet. */
export type SectionId = 'tile' | 'move' | 'make' | 'edit' | 'window' | 'dialog';

export interface KeyBinding {
  /** `<section>.<action>`, never renamed: handlers, tests and later a remapping name it. */
  id: string;
  /** What it does, as the cheat sheet and Settings › Keyboard list it. */
  label: string;
  section: SectionId;
  scope: KeyScope;
  status: KeyStatus;
  /** Its default chords: any of them does it. */
  keys: readonly Chord[];
  /** Its default chords off macOS, where they are more than the modifier rule changes. */
  otherKeys?: readonly Chord[];
}

// Bare keys on the board: what they type, Shift or not, as the board's single keys have always taken.
const bare = (key: string, text = key.toUpperCase()): Chord => ({ key, text, shift: 'any' });

export const KEYS = [
  // The tile selected on the board.
  { id: 'tile.open', label: 'Open it, or type in a shape', section: 'tile', scope: 'tile', status: 'today', keys: [{ key: 'Enter', text: '↵' }] },
  { id: 'tile.rename', label: 'Rename (or click its name, then pause)', section: 'tile', scope: 'tile', status: 'today', keys: [{ key: 'F2', shift: 'any' }] },
  { id: 'tile.delete', label: 'Delete or close (asks first)', section: 'tile', scope: 'tile', status: 'today', keys: [{ text: '⌫' }] },

  // Getting round the board, and the keys that work anywhere.
  { id: 'move.spotlight', label: 'Jump to a session or zone', section: 'move', scope: 'terminal-safe', status: 'today', keys: [{ mod: 'window', code: 'KeyK', text: 'K' }] },
  { id: 'move.boardMenu', label: 'Board menu', section: 'move', scope: 'board', status: 'today', keys: [{ mod: 'command', key: '\\' }] },
  { id: 'move.select', label: 'Select and move', section: 'move', scope: 'board', status: 'today', keys: [bare('v')] },
  { id: 'move.box', label: 'Box select', section: 'move', scope: 'board', status: 'today', keys: [bare('b')] },
  { id: 'move.hand', label: 'Pan the board', section: 'move', scope: 'board', status: 'today', keys: [bare('h')] },
  { id: 'move.connections', label: 'Cycle which connections are drawn', section: 'move', scope: 'board', status: 'today', keys: [{ key: 'e', text: 'E', shift: true }] },
  { id: 'move.crews', label: 'Cycle how an orchestrator’s crew is shown', section: 'move', scope: 'board', status: 'today', keys: [{ key: 'c', text: 'C', shift: true }] },
  { id: 'move.cheatSheet', label: 'Keyboard shortcuts', section: 'move', scope: 'board', status: 'new', keys: [{ key: '?', shift: 'any' }] },
  { id: 'move.master', label: 'Open the Captain, its message box focused', section: 'move', scope: 'terminal-safe', status: 'new', keys: [{ mod: 'window', shift: true, code: 'KeyM', text: 'M' }], otherKeys: [{ mod: 'window', code: 'KeyM', text: 'M' }] },
  { id: 'move.cheatSheetAnywhere', label: 'Keyboard shortcuts, from anywhere', section: 'move', scope: 'terminal-safe', status: 'new', keys: [{ mod: 'window', code: 'Slash', text: '/' }] },

  // Putting things on the board.
  { id: 'make.agent', label: 'Agent: then click', section: 'make', scope: 'board', status: 'today', keys: [bare('a')] },
  { id: 'make.shell', label: 'Shell: then click', section: 'make', scope: 'board', status: 'today', keys: [bare('`')] },
  { id: 'make.note', label: 'Sticky note at the pointer', section: 'make', scope: 'board', status: 'today', keys: [bare('n')] },
  { id: 'make.text', label: 'Text: then click', section: 'make', scope: 'board', status: 'today', keys: [bare('t')] },
  { id: 'make.shape', label: 'Shape: then drag', section: 'make', scope: 'board', status: 'today', keys: [bare('s')] },
  { id: 'make.insert', label: 'Find a shape by name', section: 'make', scope: 'board', status: 'today', keys: [bare('/')] },
  { id: 'make.zone', label: 'Zone: drag out where it goes', section: 'make', scope: 'board', status: 'today', keys: [bare('z')] },
  { id: 'make.askClaude', label: 'Ask Claude about what is selected', section: 'make', scope: 'board', status: 'today', keys: [{ mod: 'command', shift: true, key: 'a', text: 'A' }] },

  // Changing what is selected.
  { id: 'edit.escape', label: 'Cancel the armed tool or Connect to…, or collapse the tile in front', section: 'edit', scope: 'board', status: 'today', keys: [{ key: 'Escape', text: 'esc', shift: 'any' }] },
  { id: 'edit.undo', label: 'Undo', section: 'edit', scope: 'board', status: 'today', keys: [{ mod: 'command', key: 'z', text: 'Z' }] },
  { id: 'edit.redo', label: 'Redo', section: 'edit', scope: 'board', status: 'today', keys: [{ mod: 'command', shift: true, key: 'z', text: 'Z' }, { mod: 'command', key: 'y', text: 'Y' }] },
  { id: 'edit.selectAll', label: 'Select all', section: 'edit', scope: 'board', status: 'today', keys: [{ mod: 'command', key: 'a', text: 'A' }] },
  { id: 'edit.duplicate', label: 'Duplicate', section: 'edit', scope: 'board', status: 'today', keys: [{ mod: 'command', key: 'd', text: 'D' }] },
  { id: 'edit.copy', label: 'Copy', section: 'edit', scope: 'board', status: 'today', keys: [{ mod: 'command', text: 'C' }] },
  { id: 'edit.cut', label: 'Cut', section: 'edit', scope: 'board', status: 'today', keys: [{ mod: 'command', text: 'X' }] },
  { id: 'edit.paste', label: 'Paste', section: 'edit', scope: 'board', status: 'today', keys: [{ mod: 'command', text: 'V' }] },
  { id: 'edit.front', label: 'Bring to front', section: 'edit', scope: 'board', status: 'today', keys: [{ key: ']' }] },
  { id: 'edit.back', label: 'Send to back', section: 'edit', scope: 'board', status: 'today', keys: [{ key: '[' }] },
  { id: 'edit.forward', label: 'Bring forward', section: 'edit', scope: 'board', status: 'today', keys: [{ mod: 'command', key: ']' }] },
  { id: 'edit.backward', label: 'Send backward', section: 'edit', scope: 'board', status: 'today', keys: [{ mod: 'command', key: '[' }] },
  { id: 'edit.nudge', label: 'Nudge 1px (⇧ 10px)', section: 'edit', scope: 'board', status: 'today', keys: [{ text: '←↑→↓' }] },
  { id: 'edit.swapDirection', label: 'Swap the direction of the arrow selected', section: 'edit', scope: 'board', status: 'new', keys: [{ key: 's', text: 'S', shift: true }] },
  { id: 'edit.resetRotation', label: 'Reset the rotation of what is selected', section: 'edit', scope: 'board', status: 'today', keys: [{ key: 'r', text: 'R', shift: true }] },
  { id: 'edit.snapTurn', label: `Hold while turning: ${ROTATION_SNAP}° steps`, section: 'edit', scope: 'board', status: 'today', keys: [{ text: '⇧' }] },
  { id: 'edit.handOffDrag', label: 'Hold while drawing an edge between agents: a hand-off', section: 'edit', scope: 'board', status: 'today', keys: [{ text: '⌥' }] },
  { id: 'edit.arrangeBoard', label: 'Arrange the board', section: 'edit', scope: 'board', status: 'new', keys: [{ key: 'l', text: 'L', shift: true }] },
  { id: 'edit.delete', label: 'Delete (sessions and zones ask first)', section: 'edit', scope: 'board', status: 'today', keys: [{ text: '⌫' }] },

  // A session window or an expanded tile: chords, so typing never fires one.
  { id: 'window.previous', label: 'Previous session in the group', section: 'window', scope: 'terminal-safe', status: 'today', keys: [{ mod: 'window', code: 'BracketLeft', text: '[' }] },
  { id: 'window.next', label: 'Next session in the group', section: 'window', scope: 'terminal-safe', status: 'today', keys: [{ mod: 'window', code: 'BracketRight', text: ']' }] },
  { id: 'window.tab', label: 'Tab 1–9 of the focused pane', section: 'window', scope: 'terminal-safe', status: 'today', keys: [{ mod: 'window', text: '1–9' }] },
  { id: 'window.newTab', label: 'New shell tab', section: 'window', scope: 'terminal-safe', status: 'today', keys: [{ mod: 'window', code: 'KeyT', text: 'T' }] },
  { id: 'window.closeTab', label: 'Close the tab', section: 'window', scope: 'terminal-safe', status: 'today', keys: [{ mod: 'window', code: 'KeyW', text: 'W' }] },
  { id: 'window.splitBeside', label: 'Split beside', section: 'window', scope: 'terminal-safe', status: 'today', keys: [{ mod: 'window', code: 'KeyD', text: 'D' }] },
  {
    id: 'window.splitBelow',
    label: 'Split below',
    section: 'window',
    scope: 'terminal-safe',
    status: 'today',
    keys: [{ mod: 'window', shift: true, code: 'KeyD', text: 'D' }],
    // Ctrl+Shift+D is already Split beside off macOS.
    otherKeys: [{ mod: 'pane', code: 'KeyD', text: 'D' }],
  },
  { id: 'window.paneFocus', label: 'Focus the pane that way', section: 'window', scope: 'terminal-safe', status: 'today', keys: [{ mod: 'pane', text: '←↑→↓' }] },
  // Ctrl+Shift+I off macOS, as plain Ctrl+I is Tab in a terminal.
  { id: 'window.details', label: 'Show or hide the details', section: 'window', scope: 'window', status: 'fix', keys: [{ mod: 'window', code: 'KeyI', text: 'I' }] },
  { id: 'window.runGate', label: 'Run the gate', section: 'window', scope: 'terminal-safe', status: 'today', keys: [{ mod: 'window', shift: true, code: 'KeyG', text: 'G' }], otherKeys: [{ mod: 'window', code: 'KeyG', text: 'G' }] },
  {
    id: 'window.textSize',
    label: 'Terminal text size',
    section: 'window',
    scope: 'terminal-safe',
    status: 'fix',
    keys: [{ mod: 'command', text: '+' }, { mod: 'command', text: '-' }, { mod: 'command', text: '0' }],
    // Ctrl+Shift off macOS, as plain Ctrl+- is undo in Claude Code and readline.
    otherKeys: [{ mod: 'window', text: '+' }, { mod: 'window', text: '-' }, { mod: 'window', text: '0' }],
  },
  { id: 'window.newLine', label: 'New line to the agent, in its terminal or message box', section: 'window', scope: 'terminal-safe', status: 'today', keys: [{ shift: true, text: '↵' }] },
  { id: 'window.openLink', label: 'Open a link in the terminal in a web tab', section: 'window', scope: 'window', status: 'today', keys: [{ mod: 'command', text: 'click' }] },
  { id: 'window.openLinkBrowser', label: 'Open an https link in the terminal in the browser', section: 'window', scope: 'window', status: 'today', keys: [{ mod: 'command', shift: true, text: 'click' }] },
  { id: 'window.send', label: 'Send the message box to the agent', section: 'window', scope: 'window', status: 'today', keys: [{ text: '↵' }] },
  { id: 'window.saveDoc', label: 'Save the document you are editing, and tell its agent', section: 'window', scope: 'window', status: 'new', keys: [{ mod: 'command', key: 's', text: 'S' }] },
  { id: 'window.leaveDocEdit', label: 'Leave Edit in a document, dropping what is unsaved', section: 'window', scope: 'window', status: 'new', keys: [{ key: 'Escape', text: 'esc' }] },

  // The dialog, menu or popover with the focus: its own keys, matched where it is drawn.
  { id: 'dialog.move', label: 'Move between the rows', section: 'dialog', scope: 'dialog', status: 'today', keys: [{ text: '↑' }, { text: '↓' }] },
  { id: 'dialog.pick', label: 'Pick the row, or confirm', section: 'dialog', scope: 'dialog', status: 'today', keys: [{ text: '↵' }] },
  { id: 'dialog.close', label: 'Close, the focus back where it was', section: 'dialog', scope: 'dialog', status: 'today', keys: [{ text: 'esc' }] },
  { id: 'dialog.submit', label: 'Start it, in New agent', section: 'dialog', scope: 'dialog', status: 'today', keys: [{ mod: 'command', text: '↵' }] },
  { id: 'dialog.openFromSwitcher', label: 'Open the session, from the switcher', section: 'dialog', scope: 'dialog', status: 'today', keys: [{ mod: 'window', text: '↵' }] },
  { id: 'dialog.handOff', label: 'Make the new edge a hand-off, in its chooser', section: 'dialog', scope: 'dialog', status: 'today', keys: [{ text: 'H' }] },
  { id: 'dialog.answer', label: 'Answer an ask with option 1–9, in the inbox', section: 'dialog', scope: 'dialog', status: 'today', keys: [{ text: '1–9' }] },
] as const satisfies readonly KeyBinding[];

export type KeyId = (typeof KEYS)[number]['id'];

const BY_ID = new Map<string, KeyBinding>(KEYS.map((binding) => [binding.id, binding]));

/** The registry's entry for `id`. */
export function binding(id: KeyId): KeyBinding {
  return BY_ID.get(id)!;
}

/** Whether a binding is in use: always, unless it is `new` and the "Extended keyboard shortcuts" setting is off. */
export function isActive(entry: KeyBinding, extended = extendedShortcuts()): boolean {
  return entry.status !== 'new' || extended;
}

/** A binding's default chords on this platform. */
export function chordsOf(entry: KeyBinding, isMac = mac): readonly Chord[] {
  return (!isMac && entry.otherKeys) || entry.keys;
}

/** A chord as the platform writes it: `⌘⇧A` and `Ctrl+Shift+A`, `⌘⌥←` and `Ctrl+Shift+Alt+←`, `⇧E`. */
export function chordText(chord: Chord, isMac = mac): string {
  const key = chord.text ?? chord.key ?? '';
  const shifted = chord.shift === true;
  switch (chord.mod) {
    case 'command':
      return isMac ? `⌘${shifted ? '⇧' : ''}${key}` : `Ctrl+${shifted ? 'Shift+' : ''}${key}`;
    case 'window':
      // Off macOS the chord is Ctrl+Shift already.
      return isMac ? `⌘${shifted ? '⇧' : ''}${key}` : `Ctrl+Shift+${key}`;
    case 'pane':
      return isMac ? `⌘⌥${key}` : `Ctrl+Shift+Alt+${key}`;
    case undefined:
      return `${shifted ? '⇧' : ''}${key}`;
  }
}

/** A binding's keys as the platform writes them, one per chord: `['⌘⇧Z', '⌘Y']`. */
export function keysText(id: KeyId, isMac = mac): string[] {
  return chordsOf(binding(id), isMac).map((chord) => chordText(chord, isMac));
}

/** A binding's first key as the platform writes it, for a tooltip or a menu row: `⌘D`, or `Ctrl+D`. */
export function keyText(id: KeyId, isMac = mac): string {
  return keysText(id, isMac)[0]!;
}

/** A key press: its `key` where a chord goes by what it types, its `code` where it goes by the key's place. */
type KeyPress = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'> & { key?: string; code?: string };

/** Whether `event` is `chord`. A chord written only (a range, a held key) is never pressed. */
export function chordPressed(chord: Chord, event: KeyPress, isMac = mac): boolean {
  if (chord.code !== undefined ? event.code !== chord.code : chord.key === undefined || event.key?.toLowerCase() !== chord.key.toLowerCase()) return false;
  const command = isMac ? event.metaKey : event.ctrlKey;
  const shift = chord.shift ?? false;
  switch (chord.mod) {
    case undefined:
      return !command && !event.altKey && (shift === 'any' || event.shiftKey === shift);
    case 'command':
      return command && !event.altKey && (shift === 'any' || event.shiftKey === shift);
    case 'window':
      // Off macOS Shift is the chord's own, so a shifted window chord is the same press as its plain one.
      if (event.altKey) return false;
      if (isMac) return event.metaKey && !event.ctrlKey && (shift === 'any' || event.shiftKey === shift);
      return event.ctrlKey && event.shiftKey && !event.metaKey;
    case 'pane':
      return event.altKey && (isMac ? event.metaKey && !event.ctrlKey && !event.shiftKey : event.ctrlKey && event.shiftKey && !event.metaKey);
  }
}

interface PressOptions {
  isMac?: boolean;
  /** The "Extended keyboard shortcuts" setting, read from its store unless given. */
  extended?: boolean;
}

/**
 * Whether `event` presses the binding `id` on this platform: one of its chords, and the binding active. Handlers keep
 * their own guards (typing, an overlay, what has the focus); this is only which key it is.
 */
export function pressed(id: KeyId, event: KeyPress, { isMac = mac, extended }: PressOptions = {}): boolean {
  const entry = binding(id);
  return isActive(entry, extended) && chordsOf(entry, isMac).some((chord) => chordPressed(chord, event, isMac));
}
