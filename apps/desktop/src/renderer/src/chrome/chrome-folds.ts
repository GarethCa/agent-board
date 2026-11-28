// When the top row's islands give way (chrome.css). First by the width the islands have, which is the window's, less what
// the Captain's pane takes beside the board, so a board narrowed by the pane folds as a window that narrow would: the
// Captain button's word, then the button, then the creation toolbar's words. Then, measured, while the toolbar still
// can't sit clear of the islands either side: it moves off the board's middle towards the wider gap, and the board's
// name, Classic's drawing tools (into one Draw menu), Draw's word, the Find button, the New agent and Shell words, and
// the Needs-you pill's words give way in turn. Where even that leaves it no room, as in the narrowest window with the
// traffic lights pushing the left island in, the toolbar takes a row of its own under the islands, so it covers none.
import { useLayoutEffect, type RefObject } from 'react';

/** The widths, in px, below which a fold applies; each one is a token of `data-folds` on the board. */
const CHROME_FOLDS = [1240, 1100, 960] as const;

/** The fold that puts Classic's drawing tools into one Draw menu (CreateToolbar.tsx). */
export const DRAW_FOLD = 'draw';

/**
 * The folds the row takes, in order, while its toolbar doesn't fit between the islands: tokens of `data-folds` too.
 * Those after `title` are Classic's but for `find` and `words`; under the Simplified design they change nothing, so the
 * next fold follows at once.
 */
const FIT_FOLDS = ['title', DRAW_FOLD, 'draw-word', 'find', 'words', 'needs-word'] as const;

/** The fold that puts the toolbar on its own row under the islands, where no other fold lets it fit between them. */
const ROW_FOLD = 'row';

/** Of `FIT_FOLDS`, those that narrow the islands, and those that narrow the toolbar: on its own row each is taken alone. */
const ISLAND_FOLDS = ['title', 'find', 'needs-word'] as const;
const TOOLBAR_FOLDS = [DRAW_FOLD, 'draw-word', 'words'] as const;

/** The least gap, in px, between the toolbar and the island either side of it, under the Simplified design. */
const TOP_ROW_GAP = 8;

/** The folds that apply with this much width: the tokens for `data-folds`, widest first. */
export const chromeFolds = (width: number): string => CHROME_FOLDS.filter((at) => width < at).join(' ');

/** The width the islands have: the window's, less what the board gives up beside it (its flow is narrower by that). */
export const islandsWidth = (windowWidth: number, boardWidth: number, flowWidth: number): number => windowWidth - Math.max(0, boardWidth - flowWidth);

/** The top row, measured across the screen: where the left island ends, where the right one starts, the toolbar's width and the board's middle. */
export interface TopRow {
  leftEnd: number;
  rightStart: number;
  toolbar: number;
  centre: number;
}

/**
 * How far the toolbar moves from the board's middle to sit clear of the islands either side: 0 where it fits in the
 * middle, the least move where it fits between them, or `undefined` where it doesn't fit at all.
 */
export function toolbarShift(row: TopRow, gap = TOP_ROW_GAP): number | undefined {
  const least = row.leftEnd + gap;
  const most = row.rightStart - gap - row.toolbar;
  if (most < least) return undefined;
  const middle = row.centre - row.toolbar / 2;
  return Math.min(most, Math.max(least, middle)) - middle;
}

/** The toolbar on its own row, measured across the screen: its width, the board's middle, and the board's two edges. */
export interface OwnRow {
  toolbar: number;
  centre: number;
  start: number;
  end: number;
}

/**
 * How far the toolbar moves from the board's middle on its own row: none, unless the middle would put it past an edge
 * of the board, the gap kept, when it moves just inside; a toolbar wider than that starts at the board's start.
 */
export function rowShift(row: OwnRow, gap = TOP_ROW_GAP): number {
  const least = row.start + gap;
  const most = Math.max(least, row.end - gap - row.toolbar);
  const middle = row.centre - row.toolbar / 2;
  return Math.min(most, Math.max(least, middle)) - middle;
}

/** The folds the row takes and how far its toolbar moves (`--toolbar-shift`). */
export interface Folds {
  folds: string;
  shift: number;
}

/**
 * The folds for the row: `byWidth`, then as few of `FIT_FOLDS` as let the toolbar fit between the islands, moved the
 * least way clear of them. If none does, the toolbar takes its own row under the islands, which has the board's width:
 * then the islands take as few of their folds as keep them clear of each other, and the toolbar as few of its own as let
 * it fit inside the board. `measure` sets the folds given and measures the row they give, or answers `undefined` where
 * the row has no islands, which folds by width alone.
 */
export function pickFolds(byWidth: string, measure: (folds: string) => (TopRow & OwnRow) | undefined, gap = TOP_ROW_GAP): Folds {
  const withFolds = (...taken: (readonly string[])[]): string => [byWidth, ...taken.flat()].filter(Boolean).join(' ');
  for (let taken = 0; taken <= FIT_FOLDS.length; taken += 1) {
    const folds = withFolds(FIT_FOLDS.slice(0, taken));
    const row = measure(folds);
    if (row === undefined) return { folds, shift: 0 };
    const shift = toolbarShift(row, gap);
    if (shift !== undefined) return { folds, shift };
  }
  /** The fewest of `options` that `fits`, else all of them. */
  const fewest = (options: readonly string[], fits: (taken: readonly string[]) => boolean): readonly string[] => {
    for (let taken = 0; taken < options.length; taken += 1) if (fits(options.slice(0, taken))) return options.slice(0, taken);
    return options;
  };
  const clear = (row: TopRow | undefined): boolean => row === undefined || row.leftEnd + gap <= row.rightStart;
  const inside = (row: (TopRow & OwnRow) | undefined): boolean => row === undefined || row.toolbar <= row.end - row.start - 2 * gap;
  const islands = fewest(ISLAND_FOLDS, (taken) => clear(measure(withFolds(taken, [ROW_FOLD]))));
  const toolbar = fewest(TOOLBAR_FOLDS, (taken) => inside(measure(withFolds(islands, taken, [ROW_FOLD]))));
  const folds = withFolds(islands, toolbar, [ROW_FOLD]);
  const row = measure(folds);
  return { folds, shift: row === undefined ? 0 : rowShift(row, gap) };
}

/** Whether `folds` put the toolbar on its own row under the islands. */
export const onOwnRow = (folds: string): boolean => folds.split(' ').includes(ROW_FOLD);

/** The islands of the top row on this board, if they are all there. */
function islandsOf(board: HTMLElement): { left: HTMLElement; toolbar: HTMLElement; right: HTMLElement } | undefined {
  const left = board.querySelector<HTMLElement>('.island-top-left');
  const toolbar = board.querySelector<HTMLElement>('.create-toolbar');
  const right = board.querySelector<HTMLElement>('.island-top-right');
  return left === null || toolbar === null || right === null ? undefined : { left, toolbar, right };
}

/**
 * The least gap the design keeps either side of the toolbar: Classic's islands keep their inset from the window's edges
 * (`--island-inset`) from each other too, so they never look joined; the Simplified design's, 8 px.
 */
function rowGap(): number {
  const root = document.documentElement;
  if (root.dataset.design === 'simplified') return TOP_ROW_GAP;
  return parseFloat(getComputedStyle(root).getPropertyValue('--island-inset')) || TOP_ROW_GAP;
}

/** Sets the board's folds (`pickFolds`) and how far its toolbar moves, keeping the design's least gap either side. */
function fold(board: HTMLElement, flow: HTMLElement | null): void {
  const flowWidth = flow?.clientWidth ?? board.clientWidth;
  const byWidth = chromeFolds(islandsWidth(window.innerWidth, board.clientWidth, flowWidth));
  const islands = islandsOf(board);
  const { folds, shift } = pickFolds(byWidth, (folds) => {
    board.dataset.folds = folds;
    if (islands === undefined) return undefined;
    const start = board.getBoundingClientRect().left;
    return {
      leftEnd: islands.left.getBoundingClientRect().right,
      rightStart: islands.right.getBoundingClientRect().left,
      toolbar: islands.toolbar.offsetWidth,
      centre: start + flowWidth / 2,
      start,
      end: start + flowWidth,
    };
  }, rowGap());
  board.dataset.folds = folds;
  if (shift === 0) board.style.removeProperty('--toolbar-shift');
  else board.style.setProperty('--toolbar-shift', `${shift}px`);
  // How much lower the toolbar's own row ends than the islands', for what sits under them (the restart toast, the Edge
  // rules panel, a session window on macOS) to start that much lower.
  const below = islands === undefined || !onOwnRow(folds) ? 0 : islands.toolbar.getBoundingClientRect().bottom - islands.left.getBoundingClientRect().bottom;
  if (below > 0) board.style.setProperty('--toolbar-row', `${below}px`);
  else board.style.removeProperty('--toolbar-row');
}

/**
 * Calls `onChange` each time the page's traffic-lights safe zone changes (renderer/src/main.tsx sets it on the root's
 * style, on start and as full screen comes and goes), which moves no island and resizes nothing an observer would see.
 */
export function watchZone(onChange: () => void): () => void {
  const root = document.documentElement;
  const zone = () => root.style.getPropertyValue('--traffic-lights-right');
  let last = zone();
  const observer = new MutationObserver(() => {
    if (zone() === last) return;
    last = zone();
    onChange();
  });
  observer.observe(root, { attributes: true, attributeFilter: ['style'] });
  return () => observer.disconnect();
}

/** Keeps the board's folds up to date as the window, the Captain's pane, the islands or the lights' safe zone change. */
export function useChromeFolds(board: RefObject<HTMLElement | null>, loaded: boolean): void {
  useLayoutEffect(() => {
    const element = board.current;
    if (element === null) return;
    const flow = element.querySelector<HTMLElement>('.react-flow');
    const update = (): void => fold(element, flow);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    // Folding resizes the islands, but to the same sizes each time for the same row, so the observer settles.
    const observer = new ResizeObserver(update);
    for (const watched of [element, flow, ...Object.values(islandsOf(element) ?? {})]) if (watched !== null) observer.observe(watched);
    const unwatch = watchZone(update);
    return () => {
      observer.disconnect();
      unwatch();
    };
  }, [board, loaded]);
}
