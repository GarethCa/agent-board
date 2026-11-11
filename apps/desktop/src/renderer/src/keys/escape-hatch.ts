// The way out of a terminal. A terminal owns its keys, Esc included (an agent's interrupt), so ⌘J (Ctrl+Shift+J off
// macOS) moves the focus to the header of its session window or expanded tile, and F6 / ⇧F6 step through the regions
// round it. From the header Esc collapses the tile or minimises the window, the focus back on its tile, and ↵ goes back
// into the terminal. ⌘Esc does the leaving from anywhere in it, the terminal too. All of them are the registry's `new`
// keys, so with "Extended keyboard shortcuts" off none of this happens. Neither key leaves a window or tile holding an
// unsaved draft: the focus goes to the draft instead, as only its own Save or esc may let it go.
import { useEffect, useRef, type RefObject } from 'react';
import type { DocumentSurface, PlanSurface } from '@agent-board/daemon/window-layout';
import { requestTab } from '../session/tab-request';
import { useEscStep } from './esc-ladder';
import { pressed } from './registry';
import { isTyping } from './typing';

/** The regions F6 steps through, in its order. */
export const REGION_ORDER = ['terminal', 'tabs', 'details', 'composer', 'chrome', 'board'] as const;
export type Region = (typeof REGION_ORDER)[number];

/** The region after `current` (before, going `back`) among those shown, round from the last to the first. */
export function nextRegion(shown: readonly Region[], current: Region | undefined, back: boolean): Region | undefined {
  const ordered = REGION_ORDER.filter((region) => shown.includes(region));
  if (ordered.length === 0) return undefined;
  const at = current === undefined ? -1 : ordered.indexOf(current);
  if (at === -1) return back ? ordered.at(-1) : ordered[0];
  return ordered[(at + (back ? -1 : 1) + ordered.length) % ordered.length];
}

/** A session window, or an expanded tile on the board: what the way out leaves. */
const SURFACE = '.session-window, .expanded-tile';
const HEAD = '.session-window-head';
/** Where each region is drawn, in a window or an expanded tile; the board is the document's. */
const REGION_SELECTORS: Record<Exclude<Region, 'board'>, string> = {
  terminal: '.xterm',
  tabs: '.session-tabs-list',
  details: '.session-details, .agent-shelves',
  composer: '.composer',
  chrome: HEAD,
};
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select, [tabindex]:not([tabindex="-1"])';

/** What leaves each window or expanded tile mounted now: minimises or collapses it, the focus on its tile. */
const leaves = new WeakMap<Element, () => void>();
/** Where the focus was in each, as ⌘J left it: ↵ goes back there. */
const leftFrom = new WeakMap<Element, HTMLElement>();

const shown = (element: Element) => element.closest('[hidden]') === null && element.getClientRects().length > 0;
const surfaceOf = (node: EventTarget | null): HTMLElement | null => (node instanceof Element ? node.closest<HTMLElement>(SURFACE) : null);
const headOf = (surface: Element) => surface.querySelector<HTMLElement>(`:scope > ${HEAD}`);

/** The window or tile a press is for: the press's, the focus's, or else a window the document shows alone. */
function surfaceFor(event: KeyboardEvent): HTMLElement | null {
  const only = [...document.querySelectorAll<HTMLElement>('.session-window')].filter(shown);
  return surfaceOf(event.target) ?? surfaceOf(document.activeElement) ?? (only.length === 1 ? only[0]! : null);
}

/**
 * A draft not yet saved in a window or tile (a document or a plan being edited, with changes), in any of its tabs:
 * leaving would lose it. Its `data-unsaved` names the tab it is in.
 */
export function unsavedIn(surface: Pick<ParentNode, 'querySelector'>): Element | null {
  return surface.querySelector('[data-unsaved]');
}

/** The tab a draft is in, as its `data-unsaved` names it. */
export function draftTab(draft: Pick<Element, 'getAttribute'>): DocumentSurface | PlanSurface | undefined {
  try {
    const tab = JSON.parse(draft.getAttribute('data-unsaved') ?? '') as Partial<DocumentSurface | PlanSurface> | null;
    return (tab?.kind === 'document' || tab?.kind === 'plan') && typeof tab.sessionId === 'string' ? (tab as DocumentSurface | PlanSurface) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the focus is in a dialog or menu that keeps it: any but a session window (a dialog too), which F6 steps through. */
function inModal(): boolean {
  const held = document.activeElement?.closest('[role="dialog"], [role="alertdialog"], [role="menu"]');
  return held != null && !held.matches('.session-window');
}

/**
 * Puts the focus back in the draft that keeps a window or tile from being left: in a tab not showing, it shows the tab
 * first, so the key is seen to do something, and focuses the draft once it is drawn.
 */
function backToDraft(draft: Element) {
  const into = () => draft.querySelector<HTMLElement>('textarea')?.focus({ preventScroll: true });
  if (shown(draft)) return into();
  const tab = draftTab(draft);
  if (tab !== undefined) requestTab(tab.sessionId, tab);
  let frames = 10;
  const once = () => {
    if (!draft.isConnected) return;
    if (shown(draft)) return into();
    if (--frames > 0) requestAnimationFrame(once);
  };
  requestAnimationFrame(once);
}

/** The board tile of a window or an expanded tile: the node an expanded tile is drawn in, or the one showing its session. */
function tileOf(surface: HTMLElement): HTMLElement | null {
  if (surface.matches('.expanded-tile')) return surface.closest<HTMLElement>('.react-flow__node');
  const { sessionId, shellId } = surface.dataset;
  const marker = sessionId !== undefined ? `[data-session-id="${CSS.escape(sessionId)}"]` : shellId !== undefined ? `[data-shell-id="${CSS.escape(shellId)}"]` : undefined;
  return marker === undefined ? null : document.querySelector<HTMLElement>(`.react-flow__node:has(${marker}):not(:has(.expanded-tile))`);
}

/** Where the focus goes once a window of joined tabs is minimised, as it has no one tile: its button in the dock. */
function dockItemOf(surface: HTMLElement): HTMLElement | null {
  const id = surface.dataset.tabWindowId;
  return id === undefined ? null : document.querySelector<HTMLElement>(`.session-dock-item[data-tab-window-id="${CSS.escape(id)}"] .session-dock-open`);
}

/** Focuses `element`, making it focusable for as long as it has the focus if it isn't already. */
function focus(element: HTMLElement) {
  if (!element.hasAttribute('tabindex') && !element.matches(FOCUSABLE)) {
    element.tabIndex = -1;
    element.addEventListener('blur', () => element.removeAttribute('tabindex'), { once: true });
  }
  element.focus({ preventScroll: true });
}

function regionsOf(surface: HTMLElement): Map<Region, HTMLElement> {
  const regions = new Map<Region, HTMLElement>();
  for (const [region, selector] of Object.entries(REGION_SELECTORS) as [Region, string][]) {
    const remembered = region === 'terminal' ? leftFrom.get(surface)?.closest<HTMLElement>('.xterm') : undefined;
    const found = remembered?.isConnected && shown(remembered) ? remembered : [...surface.querySelectorAll<HTMLElement>(selector)].find(shown);
    if (found !== undefined) regions.set(region, found);
  }
  const board = document.querySelector<HTMLElement>('.react-flow');
  if (board !== null && shown(board)) regions.set('board', board);
  return regions;
}

function focusRegion(region: Region, element: HTMLElement, surface: HTMLElement) {
  if (region === 'terminal') return element.querySelector<HTMLElement>('textarea')?.focus();
  if (region === 'chrome') return focus(element);
  if (region === 'board') return focus(tileOf(surface) ?? element);
  focus(element.querySelector<HTMLElement>(FOCUSABLE) ?? element);
}

/**
 * F6, or ⇧F6: the next region of the focus's window or tile; from the board, into the one in front. Returns how to step
 * there, or undefined when there is nowhere else to go (no window or tile is shown), so the key is left to the page.
 */
function stepRegion(from: Element | null, back: boolean): (() => void) | undefined {
  const fronts = [...document.querySelectorAll<HTMLElement>(SURFACE)].filter(shown);
  const surface = surfaceOf(from) ?? fronts.at(-1) ?? null;
  if (surface === null) return undefined;
  const regions = regionsOf(surface);
  const holding = [...regions].find(([region, element]) => region !== 'board' && from !== null && element.contains(from));
  const current = holding?.[0] ?? (from !== null && regions.get('board')?.contains(from) ? 'board' : undefined);
  const next = nextRegion([...regions.keys()], current, back);
  if (next === undefined || next === current) return undefined;
  return () => focusRegion(next, regions.get(next)!, surface);
}

/** ↵ from the header: back where ⌘J left, or else into its terminal. */
function backIn(surface: HTMLElement) {
  const left = leftFrom.get(surface);
  if (left?.isConnected && surface.contains(left)) return left.focus();
  surface.querySelector<HTMLElement>('.xterm textarea')?.focus();
}

/** Listens for the way out's keys in this window, before a terminal (which would type them) or anything else has them. */
export function followEscapeHatch(): void {
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.defaultPrevented) return;
      const take = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (pressed('window.jumpOut', event)) {
        const surface = surfaceFor(event);
        const head = surface && headOf(surface);
        if (!head) return;
        take();
        const active = document.activeElement;
        if (active instanceof HTMLElement && surface.contains(active) && !head.contains(active)) leftFrom.set(surface, active);
        focus(head);
      } else if (pressed('window.regions', event)) {
        // A modal dialog or menu keeps the focus: F6 isn't a way out of it.
        if (inModal()) return;
        const step = stepRegion(event.target instanceof Element ? event.target : document.activeElement, event.shiftKey);
        if (step === undefined) return;
        take();
        step();
      } else if (pressed('window.leave', event)) {
        const surface = surfaceFor(event);
        const leave = surface && leaves.get(surface);
        if (!leave) return;
        take();
        const draft = unsavedIn(surface);
        if (draft !== null) backToDraft(draft);
        else leave();
      } else if (pressed('window.backIn', event) && event.target instanceof HTMLElement && event.target.matches(HEAD)) {
        const surface = surfaceOf(event.target);
        if (surface === null) return;
        take();
        backIn(surface);
      }
    },
    true,
  );
}

/**
 * How a session window or an expanded tile is left from the keyboard: Esc with the focus in it (not in its terminal or
 * a field), or ⌘Esc from anywhere in it. `leave` minimises or collapses it; the focus goes to its tile first, which
 * stays on the board as the window or the expanded tile goes (a window of joined tabs: its button in the dock). Without
 * `leave` (a window of its own), neither key does; with an unsaved draft in it, both go back to the draft instead.
 */
export function useLeaveKeys(root: RefObject<HTMLElement | null>, leave: (() => void) | undefined): void {
  const run = () => {
    const surface = root.current;
    const draft = surface && unsavedIn(surface);
    if (draft) return backToDraft(draft);
    const tile = surface && tileOf(surface);
    if (tile) focus(tile);
    leave?.();
    // The board draws the tile again as it goes (an expanded tile's node moves in the board's order), which can drop
    // its focus: given back once it has drawn, unless it has gone somewhere else meanwhile. A tabs window's dock button
    // is only drawn once it is minimised.
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;
      const target = tile?.isConnected ? tile : surface && dockItemOf(surface);
      if (target) focus(target);
    });
  };
  const latest = useRef(run);
  latest.current = run;
  useEscStep(
    'surface',
    (event) => leave !== undefined && pressed('window.escape', event) && event.target instanceof Node && root.current?.contains(event.target) === true && !isTyping(event),
    run,
  );
  const canLeave = leave !== undefined;
  useEffect(() => {
    const surface = root.current;
    if (surface === null || !canLeave) return;
    leaves.set(surface, () => latest.current());
    return () => void leaves.delete(surface);
  }, [root, canLeave]);
}
