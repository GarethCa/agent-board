// How this window draws the board, said to the daemon (`layout.measured`) so an orchestrator's arrange and zone map
// see what the user sees: tiles and items pushed aside by an expanded tile, text items as big as their text, and the
// height each agent note's text needs. Only the window in front says it, a moment after what it draws changes.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Node } from '@xyflow/react';
import { measuredText, type BoxRect, type ExpandedBox, type LayoutMeasured, type MeasuredBox } from '@agent-board/daemon/protocol';
import { CAPTURE_FRAME } from './capture-mode';
import type { ExpandedTiles } from './expanded';
import { useWindowFocused } from './items/grow-to-fit';
import type { AgentNoteLook } from './items/agent-note-look';

/**
 * An agent note's height for its text (`text`), measured `width` wide, drawn as `look` says, with what else is drawn
 * round its text (`noteFitContext`).
 */
export interface NoteFit {
  width: number;
  height: number;
  text: string;
  context: string;
}

/**
 * What a note's height for its text depends on besides its text and width: the look notes are drawn in, the question
 * it answers and the edits it suggests. A fit measured with any of them otherwise is not said.
 */
export function noteFitContext(look: AgentNoteLook, data: Record<string, unknown>): string {
  const asked = typeof data.asked === 'string' ? data.asked : '';
  const edits = Array.isArray(data.suggestions) ? data.suggestions.length : 0;
  return JSON.stringify([look, asked, edits]);
}

type Size = { width: number; height: number };

/** How long what is drawn must hold still before it is said: a drag or an expanding tile says it once, at its end. */
const SETTLE_MS = 250;

/** What the daemon keys tiles and items by, as the board's node ids are. */
const MEASURED = /^(agent|shell|external|item):/;

/** Half a pixel: what is drawn and what is saved are rounded differently. */
const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
const sameRect = (a: BoxRect, b: BoxRect) => near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);

const boxOf = (node: Node, size: Size | undefined): BoxRect => ({
  x: node.position.x,
  y: node.position.y,
  width: size?.width ?? node.width ?? node.measured?.width ?? 0,
  height: size?.height ?? node.height ?? node.measured?.height ?? 0,
});

/** A board item's data, from its node, if it is one. */
const itemData = (node: Node): Record<string, unknown> | undefined => (node.data as { item?: { data?: Record<string, unknown> } }).item?.data;

/**
 * The boxes to say of `nodes` (where tiles and items are saved) drawn as `shown` (pushed aside by an expanded tile or
 * not): each one drawn elsewhere, or other than its size (`sizes`, a text item's by its text), and each agent note with
 * its height for its text (`fits`) at the width it is drawn, measured in `look` and as it is now.
 */
export function measuredBoxes(
  nodes: readonly Node[],
  shown: readonly Node[],
  sizes: ReadonlyMap<string, Size>,
  fits: ReadonlyMap<string, NoteFit>,
  look: AgentNoteLook,
): MeasuredBox[] {
  const saved = new Map(nodes.map((node) => [node.id, node]));
  return shown.flatMap((node) => {
    const at = saved.get(node.id);
    if (at === undefined || !MEASURED.test(node.id)) return [];
    const box = { key: node.id, saved: boxOf(at, undefined), drawn: boxOf(node, sizes.get(node.id)) };
    const fit = fits.get(node.id);
    const holds = fit !== undefined && near(fit.width, box.saved.width) && fit.context === noteFitContext(look, itemData(node) ?? {});
    if (holds) return [{ ...box, fits: { height: fit.height, text: measuredText(fit.text) } }];
    return sameRect(box.saved, box.drawn) ? [] : [box];
  });
}

/** The tiles `expanded` among `nodes`: where each is saved, at its expanded size. What the rest are drawn round. */
export function expandedBoxes(nodes: readonly Node[], expanded: ExpandedTiles): ExpandedBox[] {
  const saved = new Map(nodes.map((node) => [node.id, node]));
  return expanded.flatMap((tile) => {
    const node = saved.get(tile.id);
    return node === undefined ? [] : [{ key: tile.id, x: node.position.x, y: node.position.y, width: tile.width, height: tile.height }];
  });
}

/** Whether two reports say the same. */
export function sameReport(a: LayoutMeasured, b: LayoutMeasured): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// What items measured of themselves, by node id. A text item's size is measured as it is drawn, and kept once it is no
// longer drawn (off screen, where the board draws nothing): it is said only while the item is saved as it was, though
// text changed while it was off screen goes unmeasured until it is drawn again. A note's fit is measured out of sight
// (`AgentNoteMeasurer`), drawn or not, each time its text, width or what else is drawn round its text changes; it is
// said only while its width and what is drawn round its text are as they were, and the daemon uses it only while the
// note says the same.
const drawnSizes = new Map<string, Size>();
const noteFits = new Map<string, NoteFit>();
const listeners = new Set<() => void>();
let version = 0;
const changed = () => {
  version++;
  for (const listener of listeners) listener();
};

/** A text item's size as its text takes it, as it is drawn. */
export function reportDrawnSize(id: string, size: Size): void {
  const was = drawnSizes.get(id);
  if (was !== undefined && near(was.width, size.width) && near(was.height, size.height)) return;
  drawnSizes.set(id, size);
  changed();
}

/** Agent notes' heights for their text, by node id, as they are measured: said once for them all. */
export function reportNoteFits(fits: ReadonlyMap<string, NoteFit>): void {
  let any = false;
  for (const [id, fit] of fits) {
    const was = noteFits.get(id);
    if (was !== undefined && near(was.width, fit.width) && near(was.height, fit.height) && was.text === fit.text && was.context === fit.context) continue;
    noteFits.set(id, fit);
    any = true;
  }
  if (any) changed();
}

/** Whether agent note `id`'s height for its text is known as it is now: `width` wide, saying `text`, drawn round `context`. */
export function noteFitKnown(id: string, { width, text, context }: Omit<NoteFit, 'height'>): boolean {
  const fit = noteFits.get(id);
  return fit !== undefined && near(fit.width, width) && fit.text === text && fit.context === context;
}

/** Forgets every agent note's height for its text, so each is measured again: in a font just loaded, text takes another. */
export function forgetNoteFits(): void {
  if (noteFits.size === 0) return;
  noteFits.clear();
  changed();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Draws again each time an item says what it measured of itself. */
export const useMeasuresChanged = (): number => useSyncExternalStore(subscribe, () => version);

/** This window's size, px, if it has one: what masonry and a treemap pack to. */
export const windowSize = (of: Pick<Window, 'innerWidth' | 'innerHeight'>): Pick<LayoutMeasured, 'window'> =>
  of.innerWidth > 0 && of.innerHeight > 0 ? { window: { width: of.innerWidth, height: of.innerHeight } } : {};

/**
 * Calls `say` a moment from now, and again a moment after each time `target` (the window) is resized, the last of a
 * drag's resizes only, so nothing draws again as it is resized. Returns how to stop.
 */
export function settleThenSay(say: () => void, target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> = window): () => void {
  let timer = setTimeout(say, SETTLE_MS);
  const resized = () => {
    clearTimeout(timer);
    timer = setTimeout(say, SETTLE_MS);
  };
  target.addEventListener('resize', resized);
  return () => {
    clearTimeout(timer);
    target.removeEventListener('resize', resized);
  };
}

/**
 * Says how this window draws `nodes` as `shown`, round the tiles `expanded`, and how big it is, to the daemon, a moment
 * after it changes, while this window is the one in front (and again each time it comes to the front). Once it is no
 * longer in front it says so (`away`), so an arrange waits on no measure from it. A capture window says nothing.
 */
export function useMeasuredBoxes(nodes: readonly Node[], shown: readonly Node[], expanded: ExpandedTiles, look: AgentNoteLook): void {
  const focused = useWindowFocused();
  const measuredVersion = useMeasuresChanged();
  const sent = useRef<LayoutMeasured | undefined>(undefined);
  const say = (report: LayoutMeasured) => {
    sent.current = report;
    window.agentBoard.view.measured(report).catch(() => {
      sent.current = undefined;
    });
  };
  useEffect(() => {
    if (CAPTURE_FRAME !== undefined) return;
    if (!focused) {
      if (sent.current !== undefined && sent.current.away !== true) say({ ...sent.current, away: true });
      return;
    }
    return settleThenSay(() => {
      const report = { boxes: measuredBoxes(nodes, shown, drawnSizes, noteFits, look), expanded: expandedBoxes(nodes, expanded), ...windowSize(window) };
      if (sent.current === undefined || !sameReport(sent.current, report)) say(report);
    });
  }, [focused, nodes, shown, expanded, look, measuredVersion]);
}
