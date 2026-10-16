// The board's keys: which single keys are shortcuts, and where on the page a key or click belongs to something else.
import type { PointerMode } from '../chrome/CreateToolbar';
import { centreOf, type Point, type Rect } from '../geometry';
import type { ArmedTool } from './ToolOverlay';
import { isTyping } from './use-tile-moves';

/** Where ⌫ belongs to what is shown, not to the selected tile: an expanded tile or a session window. */
export const SESSION_SURFACES = '.expanded-tile, [data-testid="session-window"]';
/** Open over the board, these take ⌫ for themselves: a dialog, or a session window. */
export const KEY_BLOCKERS = '[role="dialog"], [role="alertdialog"], [data-testid="session-window"]';
/** What a click on a node presses rather than the node itself: its buttons, fields and links, and what takes input. */
export const CONTROLS = 'button, a, input, textarea, select, [role="menuitem"], .nodrag, .editable-name';

/** The keys that pick how a drag acts: V selects and moves, B box-selects, H pans. */
const MODE_KEYS: Record<string, PointerMode> = { v: 'select', b: 'box', h: 'hand' };

/** The keys that arm a tool (T, S, Z, A and `). */
const TOOL_KEYS: Record<string, ArmedTool> = { t: 'text', s: 'shape', z: 'zone', a: 'agent', '`': 'shell' };

/** What a single key asks of the board. */
export type BoardShortcut = { kind: 'escape' } | { kind: 'note' } | { kind: 'tool'; tool: ArmedTool } | { kind: 'mode'; mode: PointerMode } | { kind: 'connections' } | { kind: 'insert' };

/**
 * The shortcut a key press is, if any: N adds a note; T, S, Z, A and ` arm a tool; V selects, B box-selects and H pans;
 * ⇧E cycles which connections are drawn; / opens the shape palette at the pointer; and Escape.
 * Never with ⌘, Ctrl or ⌥ held, nor as the key repeats.
 */
export function boardShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'>): BoardShortcut | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return undefined;
  if (event.key === 'Escape') return { kind: 'escape' };
  // Shifted or not, as some keyboards type / with ⇧.
  if (event.key === '/') return { kind: 'insert' };
  const key = event.key.toLowerCase();
  if (key === 'e') return event.shiftKey ? { kind: 'connections' } : undefined;
  if (key === 'n') return { kind: 'note' };
  if (Object.hasOwn(TOOL_KEYS, key)) return { kind: 'tool', tool: TOOL_KEYS[key]! };
  if (Object.hasOwn(MODE_KEYS, key)) return { kind: 'mode', mode: MODE_KEYS[key]! };
  return undefined;
}

/** The shortcut a key press on the board is: none while it types into a field, a note, a shape or a terminal. */
export function boardKey(event: Parameters<typeof boardShortcut>[0] & Pick<KeyboardEvent, 'target'>): BoardShortcut | undefined {
  return isTyping(event) ? undefined : boardShortcut(event);
}

/** Where on the screen the shape palette opens: at the pointer, or in the middle of the board when the pointer is off it. */
export const quickInsertAt = (pointer: Point | undefined, board: Rect): Point => pointer ?? centreOf(board);

