// Which sections of an agent's shelves are folded: one choice for every window and tile, remembered the way the board
// menu remembers its sections. Every section starts open, and stays as the user left it. Pure but for the stored value, so
// it is unit-tested.
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { storedValue } from '../stored-value';

/** The sections of the shelves that fold: the groups of Made, Crew and Setup. Each is also its element's test id. */
export const SHELF_GROUPS = ['made-shown', 'made-handoff', 'crew-agents', 'crew-subagents', 'setup-where', 'setup-around'] as const;
export type ShelfGroupId = (typeof SHELF_GROUPS)[number];

const foldedStore = storedValue('agent-board.shelves.folded');

/** The folded sections, from what was stored: only sections the shelves have, once each. */
export function foldedFrom(stored: string | undefined): ShelfGroupId[] {
  try {
    const parsed: unknown = JSON.parse(stored ?? '[]');
    return Array.isArray(parsed) ? SHELF_GROUPS.filter((group) => parsed.includes(group)) : [];
  } catch {
    return [];
  }
}

/** `folded` with `group` folded or open: the whole choice, as it is stored (an empty one is forgotten). */
export function withFold(folded: readonly ShelfGroupId[], group: ShelfGroupId, fold: boolean): ShelfGroupId[] {
  const rest = folded.filter((each) => each !== group);
  return fold ? SHELF_GROUPS.filter((each) => each === group || rest.includes(each)) : rest;
}

/** Whether the section is folded as the user left it, and a setter that remembers the choice for every window and tile. */
export function useShelfFold(group: ShelfGroupId): [boolean, (fold: boolean) => void] {
  const stored = useSyncExternalStore(foldedStore.subscribe, foldedStore.get, () => undefined);
  const folded = useMemo(() => foldedFrom(stored).includes(group), [stored, group]);
  const set = useCallback(
    (fold: boolean) => {
      const next = withFold(foldedFrom(foldedStore.get()), group, fold);
      foldedStore.set(next.length === 0 ? undefined : JSON.stringify(next));
    },
    [group],
  );
  return [folded, set];
}
