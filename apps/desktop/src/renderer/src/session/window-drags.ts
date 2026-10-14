// What a session window's tabs drag as, and what a drag means to the window it is dropped on (BH1). Pure.
import type { ShellOwner } from '@agent-board/daemon/protocol';
import { OWN_SURFACE, surfaceKey, type Placement, type Surface } from '@agent-board/daemon/window-layout';
import { sameOwner, type ShellDrag } from './shell-moves';

/**
 * What a window's tab drags as: a shell tab as its shell, which can leave the window for another or the board; a shell
 * tile's own tab while it has no other, where the board can move it, as the tile; anything else as a surface, which
 * only moves among the window's panes.
 */
export function surfaceDrag(surface: Surface, owner: ShellOwner, options: { alone: boolean; canMove: boolean }): ShellDrag {
  if (surface.kind === 'shell') return { kind: 'tab', shellId: surface.shellId, from: owner };
  if (surface.kind === 'own' && owner.kind === 'shell' && options.alone && options.canMove) return { kind: 'tab', shellId: owner.id, from: owner };
  return { kind: 'surface', key: surfaceKey(surface), from: owner };
}

/** The surface a drag from `owner`'s own window moves among its panes, if it is one of its tabs: `surfaceOf` finds it by key. */
export function draggedWithin(drag: ShellDrag, owner: ShellOwner, surfaceOf: (key: string) => Surface | undefined): Surface | undefined {
  if (!sameOwner(drag.from, owner)) return undefined;
  if (drag.kind === 'surface') return surfaceOf(drag.key);
  if (drag.kind === 'tab') return surfaceOf(drag.shellId === owner.id ? OWN_SURFACE : surfaceKey({ kind: 'shell', shellId: drag.shellId }));
  return undefined;
}

/** Whether a pane of a split let go in the middle of the pane showing it (`shown`, its sessions) gives the drag up. */
export function givesUp(drag: ShellDrag, placement: Placement, shown: readonly string[]): boolean {
  return drag.kind === 'pane' && !('edge' in placement) && shown.includes(drag.sessionId);
}
