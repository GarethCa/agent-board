// The rules of a pop-up's one row of tabs: its view, its agents and its shells, in the order they were dragged into,
// folded into "+n ▾" when they don't fit. Pure, so each rule is tested on its own; the pop-up draws what they say.
import { windowShortcut } from '../keys';
import { pressed } from '../keys/registry';

/** What a tab in the row shows: the pop-up's overview, one of its agents, or a shell. */
export type RowTabKind = 'view' | 'agent' | 'shell';

export interface RowTab {
  /** The tab's own key in the row, the one its kept order names. */
  key: string;
  kind: RowTabKind;
}

const KIND_ORDER: Record<RowTabKind, number> = { view: 0, agent: 1, shell: 2 };

/** The row with nothing dragged: the view, then the agents, then the shells, each as listed. */
const plainOrder = <T extends RowTab>(tabs: readonly T[]): T[] => [...tabs].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);

/**
 * The row as it shows: in the order its tabs were dragged into (`kept`, by key), else the view, then the agents, then
 * the shells. A kept key whose tab has gone is passed over; a tab the kept order doesn't name goes after the tab before
 * it in the plain order, or first when none of those is kept.
 */
export function rowOrder<T extends RowTab>(tabs: readonly T[], kept: readonly string[] | undefined): T[] {
  const plain = plainOrder(tabs);
  if (kept === undefined) return plain;
  const byKey = new Map(plain.map((tab) => [tab.key, tab]));
  const row = kept.flatMap((key) => {
    const tab = byKey.get(key);
    return tab === undefined ? [] : [tab];
  });
  plain.forEach((tab, index) => {
    if (row.includes(tab)) return;
    const before = plain.slice(0, index).findLast((each) => row.includes(each));
    row.splice(before === undefined ? 0 : row.indexOf(before) + 1, 0, tab);
  });
  return row;
}

/**
 * The row's keys after a drag let `key` go at `index`: the slot before the tab then at that index (the row's length
 * for its end), as the strip counts it with the dragged tab still in place.
 */
export function movedTab(order: readonly string[], key: string, index: number): string[] {
  const from = order.indexOf(key);
  if (from === -1) return [...order];
  const rest = order.filter((each) => each !== key);
  rest.splice(index > from ? index - 1 : index, 0, key);
  return rest;
}

/** A tab measured for the fold: its key and its width on the row. */
export interface MeasuredTab {
  key: string;
  width: number;
}

/**
 * Which tabs show and which fold into "+n ▾", when they don't all fit in `room`: the last first, right to left, until
 * what is left and the "+n" (`more` wide) fit. A tab in `keep` (the one that is on, the amber ones) never folds, the
 * tabs before it folding instead; kept tabs show even if they alone overflow. Both lists are in the row's order.
 */
export function foldRow(tabs: readonly MeasuredTab[], { room, more, keep }: { room: number; more: number; keep: ReadonlySet<string> }): { shown: string[]; folded: string[] } {
  const width = (list: readonly MeasuredTab[]) => list.reduce((sum, tab) => sum + tab.width, 0);
  const folded = new Set<string>();
  const shownTabs = () => tabs.filter((tab) => !folded.has(tab.key));
  if (width(tabs) > room) {
    for (const tab of [...tabs].reverse()) {
      if (width(shownTabs()) + more <= room) break;
      if (!keep.has(tab.key)) folded.add(tab.key);
    }
  }
  return { shown: shownTabs().map((tab) => tab.key), folded: tabs.filter((tab) => folded.has(tab.key)).map((tab) => tab.key) };
}

/**
 * The tab `step` places on from `on` (⌃Tab one on, ⌃⇧Tab one back), round from the end to the start, passing over the
 * tabs in `skip` (a helper shown in a window of its own); `on` itself when every other tab is skipped.
 */
export function steppedTab(order: readonly string[], on: string, step: 1 | -1, skip: ReadonlySet<string> = new Set()): string | undefined {
  const stops = order.filter((key) => key === on || !skip.has(key));
  if (stops.length === 0) return undefined;
  const at = stops.indexOf(on);
  return stops[(at + step + stops.length) % stops.length];
}

/** What a key press asks of the row: a step along it, back to the tab before, or the tab at a place in it. */
export type RowKey = { kind: 'step'; step: 1 | -1 } | { kind: 'back' } | { kind: 'tab'; digit: number };

type RowKeyPress = Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'key' | 'code'>;

/** The row's keys: ⌃Tab on, ⌃⇧Tab back, ⌘[ to the tab you came from, ⌘1–⌘9 a place (`tabAtDigit`); undefined for any other. */
export function popUpRowKey(event: RowKeyPress, options: { isMac?: boolean; extended?: boolean } = {}): RowKey | undefined {
  if (pressed('window.nextTab', event, options)) return { kind: 'step', step: 1 };
  if (pressed('window.previousTab', event, options)) return { kind: 'step', step: -1 };
  if (pressed('window.backTab', event, options)) return { kind: 'back' };
  const digit = /^Digit([1-9])$/.exec(windowShortcut(event, options.isMac) ?? '')?.[1];
  return digit === undefined ? undefined : { kind: 'tab', digit: Number(digit) };
}

/** Each owner's kept order, by owner key (`ticket:<chat's session id>`), as the view state holds them. */
export type KeptOrders = Readonly<Record<string, readonly string[]>>;

/** The kept orders in a saved value, passing over anything that is not a list of keys. */
export function keptOrders(saved: unknown): KeptOrders {
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return {};
  return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((key) => typeof key === 'string')));
}

/** The most owners whose orders are kept; past it, the one dragged longest ago is let go. */
const KEPT_OWNERS = 50;

/** The kept orders with `owner`'s new one, as the latest: the owners dragged longest ago are let go past `most`. */
export function withKeptOrder(orders: KeptOrders, owner: string, order: readonly string[], most = KEPT_OWNERS): KeptOrders {
  const entries = [...Object.entries(orders).filter(([key]) => key !== owner), [owner, order] as const];
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - most)));
}

/**
 * The views open after a click on `key`'s row in the sidebar: its tab opens at the end of the views open, or, open
 * already, is gone to, never opened twice.
 */
export function openedView(open: readonly string[], key: string): string[] {
  return open.includes(key) ? [...open] : [...open, key];
}

/** The views open after `key`'s × closes its tab. */
export const closedView = (open: readonly string[], key: string): string[] => open.filter((each) => each !== key);

/**
 * The tab on once the tab `key` closes: unchanged unless it was the one on; then the one it came from, while that is still
 * in the row, else the agent tab on last (`under`, the one shown under the views), so its terminal comes back as it was.
 */
export function afterClose(key: string, { active, from, order, under }: { active: string; from: string | undefined; order: readonly string[]; under: string }): string {
  if (key !== active) return active;
  return from !== undefined && from !== key && order.includes(from) ? from : under;
}

/** How a view's row reads in the sidebar: `on` while its tab is on, `open` (the small dot) while it is a tab not on, else `closed`. */
export function viewRow(key: string, open: readonly string[], on: string): 'on' | 'open' | 'closed' {
  return key === on ? 'on' : open.includes(key) ? 'open' : 'closed';
}

/**
 * One agent's row: none while its own tab is its only one, the header naming it; once a view or a shell opens a second,
 * the row shows, and its own tab is named for the view it shows ("Chat" or "Terminal"), as the header already names the agent.
 */
export function soloRow(tabs: readonly RowTab[], view: 'chat' | 'terminal' = 'terminal'): { shows: boolean; ownLabel: 'Chat' | 'Terminal' | undefined } {
  const shows = tabs.length > 1;
  return { shows, ownLabel: shows ? (view === 'chat' ? 'Chat' : 'Terminal') : undefined };
}
