// How the Captain's panel is sized (ADR-0019): its width, dragged on its left edge, the height of its For you list,
// dragged on the line under it, and which sections are folded. Each is one preference for every window of the app,
// kept in localStorage, so a reload or a restart finds the panel as it was left.
import { useSyncExternalStore } from 'react';
import { storedValue } from '../stored-value';

/** The panel's width until one is chosen; the same as `--size-master-panel`. */
export const DEFAULT_PANEL_WIDTH = 360;
export const MIN_PANEL_WIDTH = 280;
/** The most of the board it takes. */
const MAX_PANEL_FRACTION = 0.6;
/** The For you list is never shorter than a row, and the chat below keeps at least this much. */
export const MIN_FOR_YOU_HEIGHT = 64;
const MIN_CHAT_HEIGHT = 160;
/** What an arrow key adds or takes away. */
export const PANEL_KEY_STEP = 16;

/**
 * The widest the panel goes on a board this wide: at most 60% of it, and leaving `taken` px, which is
 * the panel's margin and the Edge rules panel beside it (see `usePanelRoom`).
 */
export const maxPanelWidth = (boardWidth: number, taken = 0): number => Math.max(MIN_PANEL_WIDTH, Math.min(Math.floor(boardWidth * MAX_PANEL_FRACTION), boardWidth - taken));

/** The width clamped to the limits, or the default if it isn't a number. */
export function clampPanelWidth(width: number, boardWidth: number, taken = 0): number {
  if (!Number.isFinite(width)) return DEFAULT_PANEL_WIDTH;
  return Math.min(maxPanelWidth(boardWidth, taken), Math.max(MIN_PANEL_WIDTH, Math.round(width)));
}

/** The most the For you list takes of a panel this tall: the rest keeps the header, the other sections and a chat. */
export const maxForYouHeight = (panelHeight: number, others: number): number => Math.max(MIN_FOR_YOU_HEIGHT, panelHeight - others - MIN_CHAT_HEIGHT);

export function clampForYouHeight(height: number, max: number): number {
  return Math.min(max, Math.max(MIN_FOR_YOU_HEIGHT, Math.round(height)));
}

/** The panel is never shorter than this when its bottom edge is dragged up. */
export const MIN_PANEL_HEIGHT = 240;

/**
 * Where the panel's bottom edge is, as px up from the board's bottom inset. Nothing chosen is full height, over the zoom bar and the minimap;
 * `controls` is the snap position, a gap above them (`lift`, from `usePanelRoom`); a number is a dragged height.
 */
export function panelBottom(stored: string | undefined, lift: number, max: number): number {
  const wanted = stored === 'controls' ? lift : positive(stored) ?? 0;
  return Math.min(Math.max(0, max), Math.max(0, Math.round(wanted)));
}

/** The furthest up the bottom edge goes on a board this tall (`top` is the panel's top, in px from the board's top): the panel keeps its least height. */
export const maxPanelBottom = (boardHeight: number, top: number, inset: number): number => Math.max(0, boardHeight - top - inset - MIN_PANEL_HEIGHT);

const widthStore = storedValue('agent-board.master-panel-width');
const forYouStore = storedValue('agent-board.master-panel-for-you-height');
const bottomStore = storedValue('agent-board.master-panel-bottom');
const foldedStore = storedValue('agent-board.master-panel-folded');

function positive(stored: string | undefined): number | undefined {
  return Number(stored) > 0 ? Number(stored) : undefined;
}

/** The panel's chosen width, live across every window of the app. */
export function usePanelWidth(): number {
  return useSyncExternalStore(widthStore.subscribe, () => positive(widthStore.get()) ?? DEFAULT_PANEL_WIDTH, () => DEFAULT_PANEL_WIDTH);
}
/** Sets the width; undefined goes back to the default. */
export const setPanelWidth = (width: number | undefined): void => widthStore.set(width === undefined ? undefined : String(Math.round(width)));

/** The For you list's chosen height, or undefined while it takes what its rows need. */
export function useForYouHeight(): number | undefined {
  return useSyncExternalStore(forYouStore.subscribe, () => positive(forYouStore.get()), () => undefined);
}
export const setForYouHeight = (height: number | undefined): void => forYouStore.set(height === undefined ? undefined : String(Math.round(height)));

export type PanelSection = 'watching' | 'for-you' | 'digest';

/** The sections folded to their headings, which stay folded across a reload. */
export function foldedSections(stored: string | undefined): ReadonlySet<PanelSection> {
  return new Set((stored ?? '').split(',').filter((name): name is PanelSection => name === 'watching' || name === 'for-you' || name === 'digest'));
}

/** Whether a section is folded, and how to flip it. */
export function useFolded(section: PanelSection): [boolean, () => void] {
  const stored = useSyncExternalStore(foldedStore.subscribe, foldedStore.get, () => undefined);
  const folded = foldedSections(stored).has(section);
  return [
    folded,
    () => {
      const next = new Set(foldedSections(foldedStore.get()));
      if (!next.delete(section)) next.add(section);
      foldedStore.set(next.size === 0 ? undefined : [...next].join(','));
    },
  ];
}

/** Where the panel's bottom edge was left: undefined (full height), `controls` or px; live across every window of the app. */
export function usePanelBottom(): string | undefined {
  return useSyncExternalStore(bottomStore.subscribe, bottomStore.get, () => undefined);
}
export const setPanelBottom = (bottom: string | number | undefined): void => bottomStore.set(bottom === undefined ? undefined : String(typeof bottom === 'number' ? Math.round(bottom) : bottom));
