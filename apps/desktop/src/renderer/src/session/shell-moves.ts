// Moving tabs between session windows, across OS windows too, and the board (AT2): what is dragged, what
// a drop does with it, and how the undo history keeps the move. Pure but for the one drag in flight, which every window
// of the app hears of; the board makes the moves.
import { useEffect, useSyncExternalStore, type DragEvent } from 'react';
import { paneIds, paneName } from '@agent-board/daemon/pane-layout';
import type { Shell, ShellOwner, ShellPlace } from '@agent-board/daemon/protocol';
import { surfaceKey, type Placement } from '@agent-board/daemon/window-layout';
import type { TabDrag, ShellMove, SurfaceMove, TabMove } from '../../../preload/api';
import { historyKey, type Change } from '../board/editing/use-history';
import { insideWorktree } from './live-folder';

export type { TabDrag, ShellMove, SurfaceMove, TabMove };

/** The drag data type of a dragged tab or pane: only the app's own windows take it. */
const TAB_DRAG_TYPE = 'application/x-agent-board-tab';

/** Whether two owners (of shells, or windows) are the same one. */
export const sameOwner = (a: { kind: string; id: string }, b: { kind: string; id: string }) => a.kind === b.kind && a.id === b.id;

/** Names what a drag moves, so a tab can tell it is the one being dragged. */
export const dragKey = (drag: TabDrag): string => (drag.kind === 'surface' ? surfaceKey(drag.surface) : drag.kind === 'tab' ? `shell:${drag.shellId}` : `pane:${drag.sessionId}`);

/**
 * What dropping `drag` at `to` does: undefined for a tab dropped back on its own window (or a shell tile on itself),
 * which stays where it is, for a tab that only moves within its window, and for a pane let go over itself (`onPane`,
 * the pane under the drop), as a drag given up. A pane dropped anywhere else leaves its split, becoming a tab of its
 * own in its own window too.
 */
export function dropMove(drag: TabDrag, to: ShellPlace, onPane?: string): ShellMove | undefined {
  if (drag.kind === 'surface') return undefined;
  if (drag.kind === 'pane') return onPane === drag.sessionId ? undefined : { kind: 'pane', shellId: drag.shellId, sessionId: drag.sessionId, to };
  if ('owner' in to && (sameOwner(drag.from, to.owner) || (to.owner.kind === 'shell' && to.owner.id === drag.shellId))) return undefined;
  return { kind: 'tab', shellId: drag.shellId, to };
}

/** Where the shell is: its owner's tabs, or its tile's place; undefined for a tile not placed yet. */
export function placeOf(shell: Shell): ShellPlace | undefined {
  if (shell.owner !== null) return { owner: shell.owner };
  if (shell.position === null) return undefined;
  const { x, y, z } = shell.position;
  return { tile: { zoneId: shell.zoneId, x, y, ...(z === null ? {} : { z }) } };
}

/** The undo history's changes for shells moved whole: where each was (and its order) before, and is after. */
export function tabMoveChanges(before: readonly Shell[], after: readonly Shell[]): Change[] {
  return after.flatMap((moved): Change[] => {
    const was = before.find((shell) => shell.id === moved.id);
    const from = was === undefined ? undefined : placeOf(was);
    const to = placeOf(moved);
    if (was === undefined || from === undefined || to === undefined) return [];
    return [[historyKey.shell(moved.id), { type: 'shellPlace', to: from, order: was.tabOrder }, { type: 'shellPlace', to, order: moved.tabOrder }]];
  });
}

/**
 * The undo history's change for a tab that is only a place in a window, moved between windows (slice 4):
 * which window it was in and where (`was`, as the daemon said), and where it went; each with the window it leaves to
 * get back there.
 */
export function surfaceMoveChanges(move: SurfaceMove, was: Placement | null): Change[] {
  const { surface, from, to } = move;
  const before = from === null ? null : { owner: from, ...(was === null ? {} : { placement: was }) };
  const after = to === null ? null : { owner: to.owner, ...(to.placement === undefined ? {} : { placement: to.placement }) };
  return [
    [
      historyKey.surface(surfaceKey(surface)),
      { type: 'surfacePlace', surface, in: before, from: to?.owner ?? null },
      { type: 'surfacePlace', surface, in: after, from },
    ],
  ];
}

/**
 * `places` with those going onto the board first: undoing a shell tile taken into an agent's tabs puts the tile back
 * before its own tabs go back to it, as a tab's owner must be a tile.
 */
export const tilesFirst = <T extends { to: ShellPlace }>(places: readonly T[]): T[] => [
  ...places.filter((place) => 'tile' in place.to),
  ...places.filter((place) => 'owner' in place.to),
];

/**
 * The amber hint for an agent's window whose shells run outside its worktree (a shell moved in from another agent
 * keeps its folder): the first such shell pane, and whose worktree it is in, if any agent's. Undefined when all are home.
 */
export function foreignFolder(
  tabs: readonly Shell[],
  agentId: string,
  worktree: string,
  worktrees: readonly { name: string; worktree: string }[],
): string | undefined {
  for (const tab of tabs) {
    for (const sessionId of paneIds(tab.layout)) {
      if (sessionId === agentId) continue;
      const folder = tab.paneFolders[sessionId];
      if (folder === undefined || insideWorktree(folder, worktree)) continue;
      const label = paneName(tab.layout, sessionId) ?? tab.name;
      // The innermost, should one worktree sit inside another.
      const home = worktrees.filter((other) => insideWorktree(folder, other.worktree)).sort((a, b) => b.worktree.length - a.worktree.length)[0];
      return home === undefined ? `${label} runs outside this worktree` : `${label} runs in ${home.name}'s worktree`;
    }
  }
  return undefined;
}

let dragging: TabDrag | undefined;
const listeners = new Set<() => void>();

/** Notes the tab or pane being dragged (undefined once the drag ends): a drag's data can't be read until it drops. */
function setTabDrag(drag: TabDrag | undefined): void {
  // The same drag heard back from main, a copy: kept as it is, so nothing that goes by it starts over.
  if (drag === dragging || (drag !== undefined && dragging !== undefined && dragKey(drag) === dragKey(dragging) && sameOwner(drag.from, dragging.from))) return;
  dragging = drag;
  for (const listener of listeners) listener();
}

/**
 * The tab or pane being dragged, in this window or another of the app's, if any. What a window's drop surfaces go by,
 * not the drag's data type: that may not reach a window the drag didn't start in.
 */
export const tabDrag = (): TabDrag | undefined => dragging;

/** Keeps this window's drag in step with the drags of the app's other windows, so their tabs land here too. */
export function useDragsFromOtherWindows(): void {
  useEffect(() => window.agentBoard.tabDrags.onChanged(setTabDrag), []);
}

/** The tab or pane being dragged in any window, kept live. */
export function useTabDrag(): TabDrag | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tabDrag,
    tabDrag,
  );
}

/** The pane under the point on the screen, by its session id, if any. */
export const paneAtPoint = (x: number, y: number): string | undefined =>
  document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-testid="shell-pane"]')?.dataset.sessionId;

/** What a drop surface (a tile, a window's body or tab strip) is marked with: whose tabs a shell dropped there joins. */
export const dropKey = (owner: { kind: string; id: string }): string => `${owner.kind}:${owner.id}`;

const fromDropKey = (key: string): ShellOwner | undefined => {
  const [kind, ...id] = key.split(':');
  return (kind === 'agent' || kind === 'shell') && id.length > 0 ? { kind, id: id.join(':') } : undefined;
};

/**
 * Whose tabs the drop surface under the point stands for (`data-tab-drop`), topmost first: a session window over the
 * board before a tile under it. Passes over anything inside the node `skip` (the tile being dragged), and with
 * `agentsOnly`, anything but an agent's.
 */
export function ownerAtPoint(x: number, y: number, options: { skip?: string; agentsOnly?: boolean } = {}): ShellOwner | undefined {
  for (const element of document.elementsFromPoint(x, y)) {
    if (options.skip !== undefined && element.closest(`.react-flow__node[data-id="${CSS.escape(options.skip)}"]`) !== null) continue;
    const key = element.closest<HTMLElement>('[data-tab-drop]')?.dataset.tabDrop;
    const owner = key === undefined ? undefined : fromDropKey(key);
    if (owner === undefined) continue;
    if (options.agentsOnly === true && owner.kind !== 'agent') continue;
    return owner;
  }
  return undefined;
}

/** A value the board keeps for its windows and tiles to read, kept live: in a pop-out, which has no board, it stays as it began. */
function boardValue<T>(initial: T): { set(value: T): void; use(): T } {
  let value = initial;
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const read = () => value;
  return {
    set(next) {
      if (next === value) return;
      value = next;
      for (const listener of listeners) listener();
    },
    use: () => useSyncExternalStore(subscribe, read, read),
  };
}

/** Makes a move the user dropped, which can be undone: the board's, which a popped-out window asks to make its moves. */
export const tabMover = boardValue<((move: TabMove) => void) | undefined>(undefined);

/** Each agent's name and worktree, for saying whose worktree a shell moved into another agent's window runs in. */
export const agentWorktrees = boardValue<readonly { name: string; worktree: string }[]>([]);

/** The drop surface a dragged tab, pane or shell tile is over now, by `dropKey`, which shows it would land there. */
export const dropOver = boardValue<string | undefined>(undefined);

/**
 * Starts dragging a tab or pane (AT2): its data typed so only the app's windows and board take it, noted for
 * the surfaces it passes over, and drawn as a lifted tab, as the AT2 mock has it.
 */
export function startDrag(event: DragEvent, drag: TabDrag, label: string): void {
  event.dataTransfer.setData(TAB_DRAG_TYPE, JSON.stringify(drag));
  event.dataTransfer.effectAllowed = 'move';
  const ghost = document.createElement('span');
  ghost.className = 'session-tab-ghost';
  ghost.textContent = label;
  document.body.append(ghost);
  event.dataTransfer.setDragImage(ghost, 12, 12);
  // Drawn into the drag image as it starts; not needed after.
  requestAnimationFrame(() => ghost.remove());
  setTabDrag(drag);
  window.agentBoard.tabDrags.set(drag);
}

/**
 * Ends the drag in every window, as a window takes its drop: the tab it came from may go with the move, and the end
 * of its drag with it.
 */
export function dropTaken(): void {
  setTabDrag(undefined);
  window.agentBoard.tabDrags.set(undefined);
}

/**
 * Ends the drag of a tab or pane, in every window. One no window took (`dropEffect` none, and not taken by another
 * window meanwhile), let go outside every window of the app, the board pops out into an OS window of its own there.
 */
export function endDrag(event: DragEvent, drag: TabDrag): void {
  const taken = tabDrag() === undefined;
  dropTaken();
  if (taken || event.dataTransfer.dropEffect !== 'none') return;
  // Where its end says it was let go; main reads the pointer when it doesn't. Fails only with main gone, when nothing
  // could pop out.
  window.agentBoard.tabDrags.untaken(drag, { x: event.screenX, y: event.screenY }).catch(() => {});
}
