// When the top row's islands give way (chrome.css). First by the width the islands have, which is the window's, less what
// the Captain's pane takes beside the board, so a board narrowed by the pane folds as a window that narrow would: the
// Captain button's word, then the button, then the creation toolbar's words. Then, measured, while the toolbar still
// can't sit clear of the islands either side: it moves off the board's middle towards the wider gap, and the board's
// name, the Find button and the New agent word give way in turn.
import { useLayoutEffect, type RefObject } from 'react';

/** The widths, in px, below which a fold applies; each one is a token of `data-folds` on the board. */
const CHROME_FOLDS = [1240, 1100, 960] as const;

/** The folds the row takes, in order, while its toolbar doesn't fit between the islands: tokens of `data-folds` too. */
const FIT_FOLDS = ['title', 'find', 'words'] as const;

/** The least gap, in px, between the toolbar and the island either side of it. */
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
export function toolbarShift(row: TopRow): number | undefined {
  const least = row.leftEnd + TOP_ROW_GAP;
  const most = row.rightStart - TOP_ROW_GAP - row.toolbar;
  if (most < least) return undefined;
  const middle = row.centre - row.toolbar / 2;
  return Math.min(most, Math.max(least, middle)) - middle;
}

/** The islands of the top row on this board, if they are all there. */
function islandsOf(board: HTMLElement): { left: HTMLElement; toolbar: HTMLElement; right: HTMLElement } | undefined {
  const left = board.querySelector<HTMLElement>('.island-top-left');
  const toolbar = board.querySelector<HTMLElement>('.create-toolbar');
  const right = board.querySelector<HTMLElement>('.island-top-right');
  return left === null || toolbar === null || right === null ? undefined : { left, toolbar, right };
}

/**
 * Sets the board's folds: those for its width, then as few of `FIT_FOLDS` as let the toolbar fit, and how far the toolbar
 * moves to fit (`--toolbar-shift`). If nothing lets it fit, every fold applies and the toolbar stays in the middle.
 */
function fold(board: HTMLElement, flow: HTMLElement | null): void {
  const flowWidth = flow?.clientWidth ?? board.clientWidth;
  const byWidth = chromeFolds(islandsWidth(window.innerWidth, board.clientWidth, flowWidth));
  const islands = islandsOf(board);
  for (let taken = 0; taken <= FIT_FOLDS.length; taken += 1) {
    board.dataset.folds = [byWidth, ...FIT_FOLDS.slice(0, taken)].filter(Boolean).join(' ');
    if (islands === undefined) break;
    const shift = toolbarShift({
      leftEnd: islands.left.getBoundingClientRect().right,
      rightStart: islands.right.getBoundingClientRect().left,
      toolbar: islands.toolbar.offsetWidth,
      centre: board.getBoundingClientRect().left + flowWidth / 2,
    });
    if (shift !== undefined) {
      board.style.setProperty('--toolbar-shift', `${shift}px`);
      return;
    }
  }
  board.style.removeProperty('--toolbar-shift');
}

/** Keeps the board's folds up to date as the window, the Captain's pane or the islands change their width. */
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
    return () => observer.disconnect();
  }, [board, loaded]);
}
