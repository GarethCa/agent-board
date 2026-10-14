// A session window's panes (BH1), cmux-style: a binary tree of splits whose leaves are panes, each with its
// own strip of tabs. A tab shows one surface: the window's own session, one of its shell tabs, or another session.
// Pure, with no Node imports, so the daemon (which keeps it) and the app (which draws and changes it) share it.
import { parseSplitTree, type PaneLayout, type SplitDirection, type SplitTree } from './pane-layout.ts';

/** A session shown in another's window without moving it: an agent's own session, or a shell tile's panes. */
export interface SessionTarget {
  kind: 'agent' | 'shell';
  id: string;
}

/**
 * What a tab shows. `own` is the window's own session (an agent's, or a shell tile's own panes), `shell` one of its
 * shell tabs (a row of `shells` it owns), and `session` another agent or shell tile, shown here and still its own.
 * PR and web tabs join this union.
 */
export type Surface = { kind: 'own' } | { kind: 'shell'; shellId: string } | { kind: 'session'; target: SessionTarget };

/** The key of the window's own surface: an agent's session, or a shell tile's own panes. */
export const OWN_SURFACE = 'own';

/** Names a surface uniquely within a window. */
export function surfaceKey(surface: Surface): string {
  switch (surface.kind) {
    case 'own':
      return OWN_SURFACE;
    case 'shell':
      return `shell:${surface.shellId}`;
    case 'session':
      return `session:${surface.target.kind}:${surface.target.id}`;
  }
}

export interface WindowPane {
  type: 'pane';
  id: string;
  /** Its strip, in order; never empty. */
  tabs: Surface[];
  /** The key of the tab it shows. */
  active: string;
}

export type WindowLayout = SplitTree<WindowPane>;

export type Edge = 'left' | 'right' | 'top' | 'bottom';

/** Where a surface goes: into a pane's strip (at `index`, else its end), or into a new pane beside one, at its edge. */
export type Placement = { pane: string; index?: number } | { pane: string; edge: Edge };

/** The id of the pane a window starts with. */
const FIRST_PANE = 'main';

/** One pane holding `tabs`, the first showing: a window as it was before panes, its strip and nothing beside it. */
export function singlePane(tabs: readonly Surface[]): WindowPane {
  return { type: 'pane', id: FIRST_PANE, tabs: [...tabs], active: surfaceKey(tabs[0]!) };
}

/** The panes, in layout order: left before right, top before bottom. */
export function windowPanes(layout: WindowLayout): WindowPane[] {
  return layout.type === 'pane' ? [layout] : [...windowPanes(layout.first), ...windowPanes(layout.second)];
}

/** The pane whose strip holds the surface, if any. */
export function paneOfSurface(layout: WindowLayout, key: string): WindowPane | undefined {
  return windowPanes(layout).find((pane) => pane.tabs.some((tab) => surfaceKey(tab) === key));
}

/** Changes each pane through `change`; a pane it makes null goes, its sibling taking the split's place. */
function mapPanes(layout: WindowLayout, change: (pane: WindowPane) => WindowLayout | null): WindowLayout | null {
  if (layout.type === 'pane') return change(layout);
  const first = mapPanes(layout.first, change);
  const second = mapPanes(layout.second, change);
  if (first === null) return second;
  if (second === null) return first;
  return first === layout.first && second === layout.second ? layout : { ...layout, first, second };
}

/**
 * Takes the surface out of its strip. Its pane, if it showed it, shows the tab before (the next, for the first), and
 * goes once it has none. Null when nothing is left.
 */
export function removeSurface(layout: WindowLayout, key: string): WindowLayout | null {
  return mapPanes(layout, (pane) => {
    const index = pane.tabs.findIndex((tab) => surfaceKey(tab) === key);
    if (index === -1) return pane;
    const tabs = pane.tabs.filter((_, at) => at !== index);
    if (tabs.length === 0) return null;
    const active = pane.active === key ? surfaceKey(tabs[Math.max(0, index - 1)]!) : pane.active;
    return { ...pane, tabs, active };
  });
}

/** Shows the surface in the pane that holds it. */
export function selectSurface(layout: WindowLayout, key: string): WindowLayout {
  const holder = paneOfSurface(layout, key);
  if (holder === undefined || holder.active === key) return layout;
  return mapPanes(layout, (pane) => (pane === holder ? { ...pane, active: key } : pane))!;
}

/**
 * Puts the surface at `placement`, out of wherever it was. Into a strip it doesn't change what the pane shows; at an
 * edge, the pane is split with a new pane on that side holding and showing it. `newId` names the new pane, then its
 * split. A pane's only tab put back into that pane, into its strip or at its edge, stays put.
 */
export function placeSurface(layout: WindowLayout, surface: Surface, placement: Placement, newId: () => string): WindowLayout {
  const key = surfaceKey(surface);
  if (!windowPanes(layout).some((pane) => pane.id === placement.pane)) throw new Error(`no pane ${placement.pane}`);
  const from = paneOfSurface(layout, key);
  // A pane's only tab put back into that pane, anywhere, stays put: taking it out would close the pane it goes to.
  if (from?.id === placement.pane && from.tabs.length === 1) return layout;
  // What is left once it is out: never nothing, as the pane it goes to is another, or keeps another tab.
  const rest = from === undefined ? layout : removeSurface(layout, key);
  if (rest === null || !windowPanes(rest).some((pane) => pane.id === placement.pane)) throw new Error(`pane ${placement.pane} goes when ${key} leaves it`);
  if ('edge' in placement) {
    const pane: WindowPane = { type: 'pane', id: newId(), tabs: [surface], active: key };
    const direction: SplitDirection = placement.edge === 'left' || placement.edge === 'right' ? 'horizontal' : 'vertical';
    const before = placement.edge === 'left' || placement.edge === 'top';
    const splitId = newId();
    return mapPanes(rest, (target) =>
      target.id === placement.pane
        ? { type: 'split', id: splitId, direction, ratio: 0.5, first: before ? pane : target, second: before ? target : pane }
        : target,
    )!;
  }
  // The index is counted with the surface still in its strip, as a drag along it sees the tabs: past where it was, one
  // fewer once it is out.
  const was = from?.id === placement.pane ? from.tabs.findIndex((tab) => surfaceKey(tab) === key) : -1;
  const index = placement.index !== undefined && was !== -1 && placement.index > was ? placement.index - 1 : placement.index;
  return mapPanes(rest, (target) => {
    if (target.id !== placement.pane) return target;
    const at = Math.min(index ?? target.tabs.length, target.tabs.length);
    return { ...target, tabs: [...target.tabs.slice(0, at), surface, ...target.tabs.slice(at)] };
  })!;
}

/**
 * Lays a tab's split (from before windows had panes) out as panes: the pane `paneId` takes the place of the
 * split's `kept` pane, and each of its other panes becomes a pane of its own holding `surfaceOf` it, the splits keeping
 * their directions and ratios. `newId` names the new panes and splits.
 */
export function paneSplitInto(
  layout: WindowLayout,
  paneId: string,
  split: PaneLayout,
  kept: string,
  surfaceOf: (sessionId: string) => Surface,
  newId: () => string,
): WindowLayout {
  return mapPanes(layout, (pane) => {
    if (pane.id !== paneId) return pane;
    const walk = (node: PaneLayout): WindowLayout => {
      if (node.type === 'split') return { ...node, id: newId(), first: walk(node.first), second: walk(node.second) };
      if (node.sessionId === kept) return pane;
      const surface = surfaceOf(node.sessionId);
      return { type: 'pane', id: newId(), tabs: [surface], active: surfaceKey(surface) };
    };
    return walk(split);
  })!;
}

/**
 * The layout with exactly the `available` surfaces: those gone dropped (a pane left with none closes), and each new one
 * put where `placement` says (a drop), else into the pane `into` (the focused one), else the last. With nothing saved,
 * one pane holding them all, in order. A layout with nothing to change comes back as it is.
 */
export function reconcileWindow(
  layout: WindowLayout | null,
  available: readonly Surface[],
  options: { newId(): string; into?: string; placement?(surface: Surface): Placement | undefined },
): WindowLayout {
  const keys = new Set(available.map(surfaceKey));
  let result: WindowLayout | null = layout;
  if (result !== null) {
    for (const pane of windowPanes(result)) {
      for (const tab of pane.tabs) if (!keys.has(surfaceKey(tab))) result = result === null ? null : removeSurface(result, surfaceKey(tab));
    }
  }
  for (const surface of available) {
    if (result === null) {
      result = singlePane([surface]);
      continue;
    }
    if (paneOfSurface(result, surfaceKey(surface)) !== undefined) continue;
    const panes = windowPanes(result);
    const asked = options.placement?.(surface);
    const target = asked !== undefined && panes.some((pane) => pane.id === asked.pane) ? asked : { pane: (panes.find((pane) => pane.id === options.into) ?? panes.at(-1)!).id };
    result = placeSurface(result, surface, target, options.newId);
  }
  if (result === null) throw new Error('a window has at least its own surface');
  return result;
}

/**
 * A layout read back from storage or the wire; throws if it isn't one: every strip holds at least one tab and shows one
 * of its own, and no pane, split or surface appears twice.
 */
export function parseWindowLayout(value: unknown): WindowLayout {
  const bad = (): Error => new Error(`not a window layout: ${JSON.stringify(value)?.slice(0, 200)}`);
  const layout = parseSplitTree(
    value,
    (node): WindowPane | undefined => {
      if (node.type !== 'pane' || typeof node.id !== 'string' || !Array.isArray(node.tabs) || node.tabs.length === 0 || typeof node.active !== 'string') return undefined;
      const tabs = node.tabs.map(parseSurface);
      if (tabs.some((tab) => tab === undefined)) return undefined;
      const keys = (tabs as Surface[]).map(surfaceKey);
      return keys.includes(node.active) ? { type: 'pane', id: node.id, tabs: tabs as Surface[], active: node.active } : undefined;
    },
    bad,
  );
  const ids: string[] = [];
  const keys: string[] = [];
  const walk = (node: WindowLayout) => {
    ids.push(node.id);
    if (node.type === 'pane') keys.push(...node.tabs.map(surfaceKey));
    else [node.first, node.second].forEach(walk);
  };
  walk(layout);
  if (new Set(ids).size !== ids.length || new Set(keys).size !== keys.length) throw bad();
  return layout;
}

function parseSurface(raw: unknown): Surface | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const fields = raw as Record<string, unknown>;
  if (fields.kind === 'own') return { kind: 'own' };
  if (fields.kind === 'shell' && typeof fields.shellId === 'string') return { kind: 'shell', shellId: fields.shellId };
  if (fields.kind !== 'session' || typeof fields.target !== 'object' || fields.target === null) return undefined;
  const { kind, id } = fields.target as Record<string, unknown>;
  return (kind === 'agent' || kind === 'shell') && typeof id === 'string' ? { kind: 'session', target: { kind, id } } : undefined;
}
