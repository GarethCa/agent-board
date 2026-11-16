// Going through the user's queue in its own tile, one thing at a time: which one shows as the queue changes under it,
// where Next, Skip and Done go, and which keys the tile takes. The board around it stays usable, so a key is the tile's
// only while it is selected and the key was pressed on it or on the bare board, never in a field, a terminal or another tile.
import { isTyping } from '../../keys/typing';
import { lookKey, type LookItem } from './to-look-at';

/** The thing shown: by its key, so a row put in front of it doesn't move it; its index, for when it is gone. */
export interface GoThroughPlace {
  key: string | undefined;
  index: number;
}

export const FIRST_PLACE: GoThroughPlace = { key: undefined, index: 0 };

/** Where `place` is in `items` now: the thing it names while it is there, else the one at its index (or the last). -1 for none. */
export function placeIn(items: readonly LookItem[], place: GoThroughPlace): number {
  if (items.length === 0) return -1;
  const kept = place.key === undefined ? -1 : items.findIndex((item) => lookKey(item) === place.key);
  return kept >= 0 ? kept : Math.min(Math.max(place.index, 0), items.length - 1);
}

const at = (items: readonly LookItem[], index: number): GoThroughPlace => ({ key: items[index] === undefined ? undefined : lookKey(items[index]), index });

/** Next, and Skip (which puts the thing at `index` last): the one after it, round to the first after the last. */
export function nextPlace(items: readonly LookItem[], index: number): GoThroughPlace {
  return items.length === 0 ? FIRST_PLACE : at(items, (index + 1) % items.length);
}

/** Done takes the thing at `index` off: the one after it shows, or the one before it when it was the last. */
export function placeAfterDone(items: readonly LookItem[], index: number): GoThroughPlace {
  const after = items[index + 1];
  return after === undefined ? { key: undefined, index: Math.max(index - 1, 0) } : { key: lookKey(after), index };
}

export type GoThroughAct = 'open' | 'next' | 'skip' | 'done';

const KEYS: Record<string, GoThroughAct> = { Enter: 'open', ArrowRight: 'next', s: 'skip', S: 'skip', d: 'done', D: 'done' };

/** What a key press is near: enough of an element for the checks below. */
type Target = (Pick<HTMLElement, 'tagName' | 'closest'> & Partial<Pick<HTMLElement, 'isContentEditable'>>) | null;

/**
 * What a key does to the tile going through its queue, or nothing. Only ↵, →, S and D, with no ⌘, ⌃ or ⌥; never while
 * typing (a field, a terminal, anything that owns its keys), and only when pressed on this tile (`tile`) or the bare
 * board: on another tile, in a panel beside the board or a dialog, it is theirs. A focused button takes its own ↵.
 */
export function goThroughKey(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'> & { target: unknown }, tile: Pick<Node, 'contains'> | null): GoThroughAct | undefined {
  const act = KEYS[event.key];
  if (act === undefined || event.metaKey || event.ctrlKey || event.altKey) return undefined;
  const target = event.target as Target;
  if (target === null || typeof target.closest !== 'function') return act;
  if (isTyping({ target: target as unknown as EventTarget })) return undefined;
  const here = tile?.contains(target as unknown as Node) === true;
  if (!here && target.tagName !== 'BODY') {
    // The bare board (its pane), not another tile on it, nor anything off the board.
    if (target.closest('.react-flow') === null || target.closest('.react-flow__node') !== null) return undefined;
  }
  if (act === 'open' && target.tagName === 'BUTTON') return undefined;
  return act;
}

/**
 * Whether the board's arrow-key nudge leaves → to the queue tile going through its things: only when that tile, and
 * nothing else, is what it would move. With more selected, the tile takes no keys, and → nudges them all.
 */
export function leavesArrowToGoingThrough(key: string, nudged: readonly string[], going: string | undefined): boolean {
  return key === 'ArrowRight' && going !== undefined && nudged.length === 1 && nudged[0] === going;
}
