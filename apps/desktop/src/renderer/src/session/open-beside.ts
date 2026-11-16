// Opening a tab beside the focused pane (⇧↵ in ⌘K): in a pane of its own on the right, the divider between them where
// what each side shows wants it. Pure, so it is unit-tested.
import { setSplitRatio } from '@agent-board/daemon/pane-layout';
import { paneOfSurface, placeSurface, selectSurface, surfaceKey, windowPanes, type Surface, type WindowLayout, type WindowPane } from '@agent-board/daemon/window-layout';
import type { PaneSide } from './split-room';

/** Whether a surface is a terminal, sized in columns (a session or a shell), or a page that takes the room left. */
export function sideOf(surface: Surface): PaneSide {
  return surface.kind === 'own' || surface.kind === 'shell' || surface.kind === 'session' ? 'terminal' : 'page';
}

/**
 * The layout with `surface` shown in a new pane right of pane `paneId` (moved there if it is in that pane), the split
 * between them at `ratioOf` what the pane then shows and the surface. A surface already in another pane is only shown
 * there, and a pane's only tab stays in it, shown: it is beside something already, or has nothing to be beside.
 */
export function placeBeside(
  layout: WindowLayout,
  surface: Surface,
  paneId: string,
  newId: () => string,
  ratioOf: (first: Surface, second: Surface) => number,
): WindowLayout {
  const key = surfaceKey(surface);
  const from = paneOfSurface(layout, key);
  if (from !== undefined && (from.id !== paneId || from.tabs.length === 1)) return selectSurface(layout, key);
  // `placeSurface` names the new pane, then its split.
  const named: string[] = [];
  const placed = placeSurface(layout, surface, { pane: paneId, edge: 'right' }, () => {
    const id = newId();
    named.push(id);
    return id;
  });
  const left = windowPanes(placed).find((pane) => pane.id === paneId)!;
  return selectSurface(setSplitRatio(placed, named[1]!, ratioOf(showing(left), surface)), key);
}

/**
 * The layout with `anchor` shown, where it is or else in pane `paneId`, and `surface` beside it as `placeBeside` puts
 * it: a review's findings with its pull request on their right.
 */
export function placeBesideOf(
  layout: WindowLayout,
  anchor: Surface,
  surface: Surface,
  paneId: string,
  newId: () => string,
  ratioOf: (first: Surface, second: Surface) => number,
): WindowLayout {
  const key = surfaceKey(anchor);
  const shown = selectSurface(paneOfSurface(layout, key) === undefined ? placeSurface(layout, anchor, { pane: paneId }, newId) : layout, key);
  return placeBeside(shown, surface, paneOfSurface(shown, key)!.id, newId, ratioOf);
}

const showing = (pane: WindowPane): Surface => pane.tabs.find((tab) => surfaceKey(tab) === pane.active) ?? pane.tabs[0]!;

/** What the panes either side of split `splitId`'s divider show, nearest it first; undefined for no such split. */
export function splitSurfaces(layout: WindowLayout, splitId: string): { first: Surface; second: Surface } | undefined {
  if (layout.type === 'pane') return undefined;
  if (layout.id === splitId) return { first: showing(windowPanes(layout.first).at(-1)!), second: showing(windowPanes(layout.second)[0]!) };
  return splitSurfaces(layout.first, splitId) ?? splitSurfaces(layout.second, splitId);
}
