import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { shelvesCollapsed } from './agent-sidebar';

/** Whether a sidebar opens collapsed: Classic's details strip always does; the shelves as they were last left (`stored`). */
export function startsCollapsed(shelves: boolean, stored: string | undefined): boolean {
  return !(shelves && stored !== 'rail');
}

/** What the shelves' open-or-rail choice is stored as: `rail`, or nothing while they are open. */
export function railChoice(collapsed: boolean): string | undefined {
  return collapsed ? 'rail' : undefined;
}

/**
 * Whether an agent's sidebar is collapsed to its rail, for a session window or an expanded tile (`root`, the element
 * that holds the sidebar and its header). Classic's details strip opens collapsed to its rail in each; an agent's shelves
 * open, or collapsed to their rail, as they last were in any window or tile (⌘I): one choice for all of them, kept in
 * `shelvesCollapsed`, so one open beside the one that changed it follows. Switched between the sidebars while open (a pick
 * in Settings, the design, or its agent listed or gone), it opens as that sidebar opens. Collapsed from its handle
 * (dragged or stepped below its least), the focus the handle had goes to the header's toggle, or else to the rail's button
 * that opens the shelves again: else the focus falls to the page, and an arrow key would move the tile. Where
 * `tooNarrow` says there is no room for the shelves beside the terminal (an expanded tile under a width), they open on the
 * rail, as they open and when the sidebar switches to them: for this one alone, so it is not remembered nor told to the rest.
 */
export function useSidebarCollapsed(
  shelves: boolean,
  root: RefObject<HTMLElement | null>,
  tooNarrow?: () => boolean,
): [boolean, Dispatch<SetStateAction<boolean>>] {
  const [collapsed, setCollapsedHere] = useState(() => startsCollapsed(shelves, shelvesCollapsed.get()));
  const collapsedNow = useRef(collapsed);
  collapsedNow.current = collapsed;
  const remembers = useRef(shelves);
  remembers.current = shelves;
  /** Set when the user pulls the shelves shut, for the focus they had to be handed on. */
  const pulledShut = useRef(false);
  /** The user's pick: remembered, for every window and tile, while the shelves show. */
  const setCollapsed = useCallback((action: SetStateAction<boolean>) => {
    const next = typeof action === 'function' ? action(collapsedNow.current) : action;
    if (next && !collapsedNow.current) pulledShut.current = true;
    setCollapsedHere(next);
    if (remembers.current && railChoice(next) !== shelvesCollapsed.get()) shelvesCollapsed.set(railChoice(next));
  }, []);
  const narrow = useRef(tooNarrow);
  narrow.current = tooNarrow;
  // As it opens, before it is drawn. Once: a tile resized later is the user's to open or close.
  useLayoutEffect(() => {
    if (shelves && narrow.current?.()) setCollapsedHere(true);
  }, []);
  const wasShelves = useRef(shelves);
  useEffect(() => {
    if (wasShelves.current === shelves) return;
    wasShelves.current = shelves;
    setCollapsedHere(startsCollapsed(shelves, shelvesCollapsed.get()) || (shelves && narrow.current?.() === true));
  }, [shelves]);
  useEffect(() => {
    if (!shelves) return;
    return shelvesCollapsed.subscribe(() => setCollapsedHere(shelvesCollapsed.get() === 'rail'));
  }, [shelves]);
  useEffect(() => {
    if (collapsed && pulledShut.current && document.activeElement === document.body) {
      root.current?.querySelector<HTMLElement>('[data-details-toggle], .agent-shelves-rail [aria-label="Show the shelves"]')?.focus();
    }
    pulledShut.current = false;
  }, [collapsed, root]);
  return [collapsed, setCollapsed];
}
