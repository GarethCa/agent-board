// Moving shells between session windows and the board (AT2): what is dragged, what a drop does with it, and
// how the undo history keeps the move. Pure but for the one drag in flight; the board makes the moves.
import { useSyncExternalStore, type DragEvent } from 'react';
import { paneIds, paneName } from '@agent-board/daemon/pane-layout';
import type { Shell, ShellOwner, ShellPlace } from '@agent-board/daemon/protocol';
import { historyKey, type Change } from '../board/editing/use-history';
import { insideWorktree } from './live-folder';

/** The drag data type of a dragged tab or pane: only the app's own windows take it. */
export const SHELL_DRAG_TYPE = 'application/x-agent-board-shell';

/**
 * A tab dragged (its shell, whole) or one pane of a split, and the window it is dragged from: an agent's, or a shell
 * tile's (whose first tab is the tile itself). Or a tab that only moves within its window: its own, or
 * another session shown there, by its surface key.
 */
export type ShellDrag =
  | { kind: 'tab'; shellId: string; from: ShellOwner }
  | { kind: 'pane'; shellId: string; sessionId: string; from: ShellOwner }
  | { kind: 'surface'; key: string; from: ShellOwner };

/** A move to make: a whole shell, or a pane out of its split into a shell of its own. */
export type ShellMove = { kind: 'tab'; shellId: string; to: ShellPlace } | { kind: 'pane'; shellId: string; sessionId: string; to: ShellPlace };

export const sameOwner = (a: ShellOwner, b: ShellOwner) => a.kind === b.kind && a.id === b.id;

/** Names what a drag moves, so a tab can tell it is the one being dragged. */
export const dragKey = (drag: ShellDrag): string => (drag.kind === 'surface' ? drag.key : drag.kind === 'tab' ? `shell:${drag.shellId}` : `pane:${drag.sessionId}`);

/**
 * What dropping `drag` at `to` does: undefined for a tab dropped back on its own window (or a shell tile on itself),
 * which stays where it is, for a tab that only moves within its window, and for a pane let go over itself (`onPane`,
 * the pane under the drop), as a drag given up. A pane dropped anywhere else leaves its split, becoming a tab of its
 * own in its own window too.
 */
export function dropMove(drag: ShellDrag, to: ShellPlace, onPane?: string): ShellMove | undefined {
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

let dragging: ShellDrag | undefined;
const listeners = new Set<() => void>();

/** Notes the tab or pane being dragged (undefined once the drag ends): a drag's data can't be read until it drops. */
export function setShellDrag(drag: ShellDrag | undefined): void {
  dragging = drag;
  for (const listener of listeners) listener();
}

/** The tab or pane being dragged in this window, if any. */
export const shellDrag = (): ShellDrag | undefined => dragging;

/** The tab or pane being dragged in this window, kept live. */
export function useShellDrag(): ShellDrag | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    shellDrag,
    shellDrag,
  );
}

/** The pane under the point on the screen, by its session id, if any. */
export const paneAtPoint = (x: number, y: number): string | undefined =>
  document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-testid="shell-pane"]')?.dataset.sessionId;

/** What a drop surface (a tile, a window's body or tab strip) is marked with: whose tabs a shell dropped there joins. */
export const dropKey = (owner: ShellOwner): string => `${owner.kind}:${owner.id}`;

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

/** Makes a move the user dropped, which can be undone: the board's; none in a pop-out, where nothing drags yet. */
export const shellMover = boardValue<((move: ShellMove) => void) | undefined>(undefined);

/** Each agent's name and worktree, for saying whose worktree a shell moved into another agent's window runs in. */
export const agentWorktrees = boardValue<readonly { name: string; worktree: string }[]>([]);

/** The drop surface a dragged tab, pane or shell tile is over now, by `dropKey`, which shows it would land there. */
export const dropOver = boardValue<string | undefined>(undefined);

/**
 * Starts dragging a tab or pane (AT2): its data typed so only the app's windows and board take it, noted for
 * the surfaces it passes over, and drawn as a lifted tab, as the AT2 mock has it.
 */
export function startDrag(event: DragEvent, drag: ShellDrag, label: string): void {
  event.dataTransfer.setData(SHELL_DRAG_TYPE, JSON.stringify(drag));
  event.dataTransfer.effectAllowed = 'move';
  const ghost = document.createElement('span');
  ghost.className = 'session-tab-ghost';
  ghost.textContent = label;
  document.body.append(ghost);
  event.dataTransfer.setDragImage(ghost, 12, 12);
  // Drawn into the drag image as it starts; not needed after.
  requestAnimationFrame(() => ghost.remove());
  setShellDrag(drag);
}
