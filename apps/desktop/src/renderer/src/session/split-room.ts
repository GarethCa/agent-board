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
