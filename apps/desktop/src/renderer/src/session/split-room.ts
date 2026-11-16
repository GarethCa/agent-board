// How small a split may leave a pane, as tmux refuses "no space for new pane" (break-it audit F2): a terminal wants
// room for a usable prompt, so a pane keeps at least this many columns and rows of the terminal's own font.
import type { SplitDirection } from '@agent-board/daemon/pane-layout';

export const MIN_PANE_COLS = 20;
export const MIN_PANE_ROWS = 5;

/** A terminal cell's size as a share of its font size, close to what xterm draws with the board's fonts. */
const CELL_WIDTH = 0.6;
const CELL_HEIGHT = 1.2;

/**
 * Why a pane of `size` px can't be split `direction`wise (horizontal: a pane beside it; vertical: one below) at terminal
 * font size `fontSize`, or undefined when each half keeps room for `MIN_PANE_COLS` by `MIN_PANE_ROWS`.
 */
export function noRoomToSplit(size: { width: number; height: number }, direction: SplitDirection, fontSize: number): string | undefined {
  const across = direction === 'horizontal';
  const room = (across ? size.width : size.height) / 2;
  const least = across ? MIN_PANE_COLS * CELL_WIDTH * fontSize : MIN_PANE_ROWS * CELL_HEIGHT * fontSize;
  if (room >= least) return undefined;
  return `no room to split: a pane keeps at least ${MIN_PANE_COLS} columns by ${MIN_PANE_ROWS} rows`;
}

/** How wide an agent's terminal is kept beside a page, in columns: room for its long lines and diffs. */
const BESIDE_COLS = 120;
/** The fewest columns a side keeps as a divider steps or rests. */
const LEAST_SIDE_COLS = 80;
/** How near, in px, a let-go divider snaps to 120 columns. */
const SNAP_PX = 12;

/** What a side of a split shows: a terminal (an agent or a shell) sized in columns, or a page that takes what is left. */
export type PaneSide = 'terminal' | 'page';

/** A split side by side: how wide it is in px, the terminals' font size, and what each side shows. */
export interface SplitSides {
  width: number;
  fontSize: number;
  first: PaneSide;
  second: PaneSide;
}

const columnsWidth = (cols: number, fontSize: number) => cols * CELL_WIDTH * fontSize;

/**
 * What a terminal's side spends on other than columns, in px: `.terminal-pane`'s padding either side (`--space-3`) and the
 * scrollbar xterm's fit keeps room for (14 px).
 */
const TERMINAL_INSET = 2 * 12 + 14;

/** How wide a terminal side is for `cols` columns as xterm fits them, with half a cell spare so a font a hair wider than the estimate still fits them all. */
const terminalWidth = (cols: number, fontSize: number) => columnsWidth(cols + 0.5, fontSize) + TERMINAL_INSET;

/** The first side's share, from the share of the side counted from: the terminal's, else the first's. */
const fromCounted = (sides: SplitSides, share: number) => (sides.first === 'page' && sides.second === 'terminal' ? 1 - share : share);

/** The first side's share that gives the terminal side 120 columns, when the other keeps at least 80 and two of a kind aren't split. */
function besideStop(sides: SplitSides): number | undefined {
  if (sides.first === sides.second) return undefined;
  const terminal = terminalWidth(BESIDE_COLS, sides.fontSize);
  if (sides.width - terminal < columnsWidth(LEAST_SIDE_COLS, sides.fontSize)) return undefined;
  return fromCounted(sides, terminal / sides.width);
}

/**
 * Where a divider rests as a terminal opens beside a page: the terminal 120 columns wide once that leaves the page as
 * much (a wide screen), else half and half (a laptop, or two of a kind).
 */
export function restingRatio(sides: SplitSides): number {
  const stop = besideStop(sides);
  if (stop === undefined) return 0.5;
  const terminal = terminalWidth(BESIDE_COLS, sides.fontSize);
  return sides.width - terminal >= terminal ? stop : 0.5;
}

/** The ratios a double-click steps a divider through: the terminal side 120 columns (where it fits), half, a third. */
export function dividerStops(sides: SplitSides): number[] {
  const stop = besideStop(sides);
  return [...(stop === undefined ? [] : [stop]), 0.5, fromCounted(sides, 1 / 3)];
}

/** The stop after the one the divider is at, round again from the last; the first from anywhere else. */
export function nextStop(ratio: number, stops: readonly number[]): number {
  const at = stops.findIndex((stop) => Math.abs(stop - ratio) < 0.01);
  return stops[(at + 1) % stops.length]!;
}

/** A let-go divider's ratio, snapped to the terminal side's 120 columns when it is a few px off them. */
export function snapRatio(ratio: number, sides: SplitSides): number {
  const stop = besideStop(sides);
  return stop !== undefined && Math.abs(stop - ratio) * sides.width <= SNAP_PX ? stop : ratio;
}
