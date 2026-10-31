// A session window's panes: a binary tree of splits whose leaves are panes, each with its
// own strip of tabs. A tab shows one surface: the window's own session, one of its shell tabs, another session, a pull
// request or a web page.
// Pure, with no Node imports, so the daemon (which keeps it) and the app (which draws and changes it) share it.
import { isGitHubRepo } from '@agent-board/tracker/pull-request-ref';
import { isWebTabUrl } from './web-url.ts';
import { parseSplitTree, type PaneLayout, type SplitDirection, type SplitTree } from './pane-layout.ts';

/** A session shown in another's window without moving it: an agent's own session, or a shell tile's panes. */
export interface SessionTarget {
  kind: 'agent' | 'shell';
  id: string;
}

/**
 * What a tab shows. `own` is the window's own session (an agent's, or a shell tile's own panes), `shell` one of its
 * shell tabs (a row of `shells` it owns), `session` another agent or shell tile, shown here and still its own, `pr`
 * a GitHub pull request (`repo` is its `owner/repo`), read from GitHub by the daemon, and `web` a web page, kept
 * by the URL it was last at (`isWebTabUrl`; empty for a new tab nothing has been typed in yet) and named by an `id` of its own, so it stays one tab as its page changes; a `private` one keeps nothing past its page (no shared session).
 * `gate` is an agent's merge gate: its latest run's steps and logs, named by the agent's session. `plan`
 * is an agent's plans: their versions, the one picked rendered, and the decision on the latest. `doc` is one of
 * an agent's hand-off docs, by its absolute `path`, read through that agent. `document` is a document an agent showed
 * (`board.showDoc`), named by its id, with its agent's session.
 */
export type Surface =
  | { kind: 'own' }
  | { kind: 'shell'; shellId: string }
  | { kind: 'session'; target: SessionTarget }
  | { kind: 'pr'; repo: string; number: number }
  | { kind: 'web'; id: string; url: string; private?: true }
  | { kind: 'gate'; sessionId: string }
  | { kind: 'plan'; sessionId: string }
  | { kind: 'doc'; sessionId: string; path: string }
  | { kind: 'document'; sessionId: string; documentId: string };

/** A pull request's surface. */
export type PullRequestSurface = Extract<Surface, { kind: 'pr' }>;

/** A web page's surface. */
export type WebSurface = Extract<Surface, { kind: 'web' }>;

/** An agent's merge gate's surface. */
export type GateSurface = Extract<Surface, { kind: 'gate' }>;

/** An agent's plans' surface. */
export type PlanSurface = Extract<Surface, { kind: 'plan' }>;

/** An agent's hand-off doc's surface. */
export type DocSurface = Extract<Surface, { kind: 'doc' }>;

/** A document's surface. */
export type DocumentSurface = Extract<Surface, { kind: 'document' }>;

/** A surface that moves between windows by itself (slice 4): a pull request, a web page, a gate, plans, a doc, a document or another session. */
export type LooseSurface = Extract<Surface, { kind: 'pr' | 'web' | 'session' | 'gate' | 'plan' | 'doc' | 'document' }>;

/**
 * Whether the surface is only a place in a window, which moves between windows by itself and is all a tab window holds:
 * not a window's own session, nor a shell tab, which its owner holds.
 */
export const isLooseSurface = (surface: Surface): surface is LooseSurface =>
  surface.kind === 'pr' || surface.kind === 'web' || surface.kind === 'session' || surface.kind === 'gate' || surface.kind === 'plan' || surface.kind === 'doc' || surface.kind === 'document';

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
    case 'pr':
      // GitHub's names are the same in any case: one pull request, one tab.
      return `pr:${surface.repo.toLowerCase()}#${surface.number}`;
    case 'web':
      return `web:${surface.id}`;
    case 'gate':
      return `gate:${surface.sessionId}`;
    case 'plan':
      return `plan:${surface.sessionId}`;
    case 'doc':
      return `doc:${surface.sessionId}:${surface.path}`;
    case 'document':
      return `document:${surface.documentId}`;
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

/** Changes the surface `surface` names (by its key) where it is, its pane still showing it if it did: a web tab's URL as its page moves on. */
export function updateSurface(layout: WindowLayout, surface: Surface): WindowLayout {
  const key = surfaceKey(surface);
  const holder = paneOfSurface(layout, key);
  const was = holder?.tabs.find((tab) => surfaceKey(tab) === key);
  if (holder === undefined || JSON.stringify(was) === JSON.stringify(surface)) return layout;
  return mapPanes(layout, (pane) => (pane === holder ? { ...pane, tabs: pane.tabs.map((tab) => (surfaceKey(tab) === key ? surface : tab)) } : pane))!;
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

/** A surface read back from storage or the wire, if it is one. */
export function parseSurface(raw: unknown): Surface | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const fields = raw as Record<string, unknown>;
  if (fields.kind === 'own') return { kind: 'own' };
  if (fields.kind === 'shell' && typeof fields.shellId === 'string') return { kind: 'shell', shellId: fields.shellId };
  if (fields.kind === 'pr') {
    const { repo, number } = fields;
    return typeof repo === 'string' && isGitHubRepo(repo) && typeof number === 'number' && Number.isSafeInteger(number) && number >= 1 ? { kind: 'pr', repo, number } : undefined;
  }
  if (fields.kind === 'gate' || fields.kind === 'plan') {
    return typeof fields.sessionId === 'string' && fields.sessionId !== '' ? { kind: fields.kind, sessionId: fields.sessionId } : undefined;
  }
  if (fields.kind === 'document') {
    const { sessionId, documentId } = fields;
    return typeof sessionId === 'string' && sessionId !== '' && typeof documentId === 'string' && documentId !== '' ? { kind: 'document', sessionId, documentId } : undefined;
  }
  if (fields.kind === 'doc') {
    const { sessionId, path } = fields;
    return typeof sessionId === 'string' && sessionId !== '' && typeof path === 'string' && path.startsWith('/') ? { kind: 'doc', sessionId, path } : undefined;
  }
  if (fields.kind === 'web') {
    const { id, url } = fields;
    if (typeof id !== 'string' || id === '' || typeof url !== 'string' || (url !== '' && !isWebTabUrl(url))) return undefined;
    return fields.private === true ? { kind: 'web', id, url, private: true } : { kind: 'web', id, url };
  }
  if (fields.kind !== 'session' || typeof fields.target !== 'object' || fields.target === null) return undefined;
  const { kind, id } = fields.target as Record<string, unknown>;
  return (kind === 'agent' || kind === 'shell') && typeof id === 'string' ? { kind: 'session', target: { kind, id } } : undefined;
}
