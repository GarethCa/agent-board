// The size a memory, queue or steps card takes as it folds and unfolds, and how far its rows are scrolled.
import { isCardSize, type CardSize } from '@agent-board/daemon/protocol';

/** A card as `foldTo` reads it: its size on the board and its saved data. */
interface Sized {
  width: number;
  height: number;
  data: Record<string, unknown>;
}

/**
 * The size a card folds or unfolds to, and the data that keeps its open size. Folding keeps the size it had open, which
 * the user may have given it; unfolding gives that back, or `sizes.open` for one that kept none.
 */
export function foldTo(card: Sized, folded: boolean, sizes: { folded: CardSize; open: CardSize }): { size: CardSize; kept: { openSize?: CardSize } } {
  if (folded) return { size: sizes.folded, kept: { openSize: { width: card.width, height: card.height } } };
  const open = card.data.openSize;
  return { size: isCardSize(open) ? { width: open.width, height: open.height } : sizes.open, kept: {} };
}

/** Which edges of a list have rows past them, for its fade: none when it all fits. */
export type FadeEdges = 'top' | 'bottom' | 'both';

/** A pixel or so of rounding is not a row past the edge. */
const SLACK = 1;

/** Which edges of a scrolled list have rows past them, from its scroll position and its sizes. */
export function fadeEdges({ scrollTop, clientHeight, scrollHeight }: { scrollTop: number; clientHeight: number; scrollHeight: number }): FadeEdges | undefined {
  const above = scrollTop > SLACK;
  const below = scrollTop + clientHeight < scrollHeight - SLACK;
  return above && below ? 'both' : above ? 'top' : below ? 'bottom' : undefined;
}

/**
 * Where a list scrolled to `scrollTop`, `clientHeight` tall, scrolls to so a row from `top` to `bottom` (in the list's
 * scrolled content) is in view: as little as it takes, its top first when it is taller than the list.
 */
export function scrollToShow({ scrollTop, clientHeight }: { scrollTop: number; clientHeight: number }, { top, bottom }: { top: number; bottom: number }): number {
  if (top < scrollTop) return top;
  if (bottom > scrollTop + clientHeight) return Math.min(top, bottom - clientHeight);
  return scrollTop;
}

/** A frame on the board, as a handle leaves it. */
type Frame = { x: number; y: number; width: number; height: number };

/**
 * Whether a resize pulled a card's height: by more than a pixel's rounding from `from`, the height its frame had as
 * the handle was taken.
 */
export const heightPulled = (height: number, from: number): boolean => Math.abs(height - from) > SLACK;

/**
 * The frame a card keeps from a resize. One whose frame grew round what it drew while selected (`grown`, the height it
 * had then) keeps its saved height unless the resize pulled its height: widened, it is wider, not taller.
 */
export function keptFrame(frame: Frame, { grown, saved }: { grown: number | undefined; saved: number }): Frame {
  return grown !== undefined && !heightPulled(frame.height, grown) ? { ...frame, height: saved } : frame;
}
