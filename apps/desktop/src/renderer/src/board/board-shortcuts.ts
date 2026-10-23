// The board's keys: which single keys are shortcuts, and where on the page a key or click belongs to something else.
import type { PointerMode } from '../chrome/CreateToolbar';
import { centreOf, type Point, type Rect } from '../geometry';
import { pressed, type KeyId } from '../keys/registry';
import type { ArmedTool } from './ToolOverlay';
import { isTyping } from './use-tile-moves';

/** Where ⌫ belongs to what is shown, not to the selected tile: an expanded tile or a session window. */
export const SESSION_SURFACES = '.expanded-tile, [data-testid="session-window"]';
/** Open over the board, these take ⌫ for themselves: a dialog, or a session window. */
export const KEY_BLOCKERS = '[role="dialog"], [role="alertdialog"], [data-testid="session-window"]';
/** What a click on a node presses rather than the node itself: its buttons, fields and links, and what takes input. */
export const CONTROLS = 'button, a, input, textarea, select, [role="menuitem"], .nodrag, .editable-name';

/** What each of the board's single keys asks of it, by its registry entry. */
const SHORTCUTS: readonly (readonly [KeyId, BoardShortcut])[] = [
  ['edit.escape', { kind: 'escape' }],
  ['make.insert', { kind: 'insert' }],
  ['move.connections', { kind: 'connections' }],
  ['move.crews', { kind: 'crews' }],
  ['make.note', { kind: 'note' }],
  ['make.text', { kind: 'tool', tool: 'text' }],
  ['make.shape', { kind: 'tool', tool: 'shape' }],
  ['make.zone', { kind: 'tool', tool: 'zone' }],
  ['make.agent', { kind: 'tool', tool: 'agent' }],
  ['make.shell', { kind: 'tool', tool: 'shell' }],
  ['move.select', { kind: 'mode', mode: 'select' }],
  ['move.box', { kind: 'mode', mode: 'box' }],
  ['move.hand', { kind: 'mode', mode: 'hand' }],
  ['move.cheatSheet', { kind: 'cheatSheet' }],
];

/** What a single key asks of the board. */
export type BoardShortcut =
  | { kind: 'escape' }
  | { kind: 'note' }
  | { kind: 'tool'; tool: ArmedTool }
  | { kind: 'mode'; mode: PointerMode }
  | { kind: 'connections' }
  | { kind: 'crews' }
  | { kind: 'insert' }
  | { kind: 'cheatSheet' };

/**
 * The shortcut a key press is, if any: N adds a note; T, S, Z, A and ` arm a tool; V selects, B box-selects and H pans;
 * ⇧E cycles which connections are drawn and ⇧C how a crew is shown; / opens the shape palette at the pointer; ? opens
 * the cheat sheet (with the extended keys on); and Escape. Never with ⌘, Ctrl or ⌥ held, nor as the key repeats.
 */
export function boardShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'>): BoardShortcut | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return undefined;
  return SHORTCUTS.find(([id]) => pressed(id, event))?.[1];
}

/** The shortcut a key press on the board is: none while it types into a field, a note, a shape or a terminal. */
export function boardKey(event: Parameters<typeof boardShortcut>[0] & Pick<KeyboardEvent, 'target'>): BoardShortcut | undefined {
  return isTyping(event) ? undefined : boardShortcut(event);
}

/** Where on the screen the shape palette opens: at the pointer, or in the middle of the board when the pointer is off it. */
export const quickInsertAt = (pointer: Point | undefined, board: Rect): Point => pointer ?? centreOf(board);

