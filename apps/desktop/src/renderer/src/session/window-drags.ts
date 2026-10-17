// What a session window's tabs drag as, and what a drag means to the window it is dropped on (slice 4
// across windows). Pure.
import type { WindowOwner } from '@agent-board/daemon/protocol';
import { isLooseSurface, OWN_SURFACE, surfaceKey, type Placement, type Surface } from '@agent-board/daemon/window-layout';
import type { SurfaceMove } from '../../../preload/api';
import { sameOwner, type TabDrag } from './shell-moves';

/**
 * What a window's tab drags as: a shell tab as its shell, which can leave the window for another or the board; a shell
 * tile's own tab while it has no other, where the board can move it, as the tile; anything else as its surface, which
 * moves among the window's panes, and a pull request, web or session tab to another window too.
 */
export function surfaceDrag(surface: Surface, owner: WindowOwner, options: { alone: boolean; canMove: boolean }): TabDrag {
  if (surface.kind === 'shell' && owner.kind !== 'tabs') return { kind: 'tab', shellId: surface.shellId, from: owner };
  if (surface.kind === 'own' && owner.kind === 'shell' && options.alone && options.canMove) return { kind: 'tab', shellId: owner.id, from: owner };
  return { kind: 'surface', surface, from: owner };
}

/** The surface a drag from `owner`'s own window moves among its panes, if it is one of its tabs: `surfaceOf` finds it by key. */
export function draggedWithin(drag: TabDrag, owner: WindowOwner, surfaceOf: (key: string) => Surface | undefined): Surface | undefined {
  if (!sameOwner(drag.from, owner)) return undefined;
  if (drag.kind === 'surface') return surfaceOf(surfaceKey(drag.surface));
  if (drag.kind === 'tab') return surfaceOf(drag.shellId === owner.id ? OWN_SURFACE : surfaceKey({ kind: 'shell', shellId: drag.shellId }));
  return undefined;
}

/**
 * The move a tab from another window makes, dropped in `to`'s at `placement`: a pull request, web page or session
 * moves there, unless the window already `shows` it, or it is the session whose window it is. Undefined for anything
 * else: a window's own tab stays in it, and shells move by `dropMove`.
 */
export function surfaceMoveInto(drag: TabDrag, to: WindowOwner, shows: (key: string) => boolean, placement?: Placement): SurfaceMove | undefined {
  if (drag.kind !== 'surface' || sameOwner(drag.from, to)) return undefined;
  const { surface } = drag;
  if (!isLooseSurface(surface)) return undefined;
  if (surface.kind === 'session' && sameOwner(surface.target, to)) return undefined;
  if (shows(surfaceKey(surface))) return undefined;
  return { kind: 'surface', surface, from: drag.from, to: { owner: to, ...(placement === undefined ? {} : { placement }) } };
}

/**
 * What a tab that is only a place in a window does dropped on the board (slice 4): onto a tile or a window,
 * of `onto`, it joins that window as `surfaceMoveInto` says; on bare board, a session leaves its window (it is a tile
 * already), and a window's own tab, dragged from its pop-out (`popped`), pops it back in. A pull request or web page
 * has no tile to be, and stays. Shells move by `dropMove`.
 */
export function boardDrop(drag: TabDrag, onto: WindowOwner | undefined, popped: boolean): { kind: 'move'; move: SurfaceMove } | { kind: 'popIn'; owner: WindowOwner } | undefined {
  if (drag.kind !== 'surface') return undefined;
  if (onto !== undefined) {
    // The board can't see the window's tabs: one it already shows, the daemon refuses.
    const move = surfaceMoveInto(drag, onto, () => false);
    return move === undefined ? undefined : { kind: 'move', move };
  }
  if (drag.surface.kind === 'session') return { kind: 'move', move: { kind: 'surface', surface: drag.surface, from: drag.from, to: null } };
  if (drag.surface.kind === 'own' && popped) return { kind: 'popIn', owner: drag.from };
  return undefined;
}

/** Whether a pane of a split let go in the middle of the pane showing it (`shown`, its sessions) gives the drag up. */
export function givesUp(drag: TabDrag, placement: Placement, shown: readonly string[]): boolean {
  return drag.kind === 'pane' && !('edge' in placement) && shown.includes(drag.sessionId);
}
