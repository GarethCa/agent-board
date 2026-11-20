// The size a memory, queue or steps card takes as it folds and unfolds, and how far its rows are scrolled.
import { isCardSize, type CardSize } from '@agent-board/daemon/protocol';

/** A card as `foldTo` reads it: its size on the board and its saved data. */
interface Sized {
  width: number;
  height: number;
  data: Record<string, unknown>;
}

/**
 * The size a card folds or unfolds to, and the data that keeps the size it leaves. Each way keeps its own size, which
 * the user may have given it: folding keeps the open size and gives back the icon's (`sizes.folded` for one that kept
 * none); unfolding keeps the icon's and gives back the open size (`sizes.open` for one that kept none).
 */
export function foldTo(
  card: Sized,
  folded: boolean,
  sizes: { folded: CardSize; open: CardSize },
): { size: CardSize; kept: { openSize?: CardSize; foldedSize?: CardSize } } {
  const now = { width: card.width, height: card.height };
  if (folded) return { size: keptSize(card.data.foldedSize) ?? sizes.folded, kept: { openSize: now } };
  return { size: keptSize(card.data.openSize) ?? sizes.open, kept: { foldedSize: now } };
}

const keptSize = (size: unknown): CardSize | undefined => (isCardSize(size) ? { width: size.width, height: size.height } : undefined);

/**
 * How much bigger than its icon (`base`) a folded card is drawn: its frame's width over the icon's. A folded card is a
 * picture, sized with its shape kept, so the width says it all.
 */
export function pictureScale(frame: CardSize, base: CardSize): number {
  const scale = frame.width / base.width;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** The least and most a folded icon is drawn, against its own size. */
const LEAST_PICTURE = 0.5;
const MOST_PICTURE = 4;

/** The frames a folded icon `base` big can be resized between, its shape kept. */
export function foldedBounds(base: CardSize): { least: CardSize; most: CardSize } {
  const times = (by: number) => ({ width: Math.round(base.width * by), height: Math.round(base.height * by) });
  return { least: times(LEAST_PICTURE), most: times(MOST_PICTURE) };
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
 * The height a list `room` tall is cut to so its last row in view shows whole, from where each row ends (`bottoms`, in
 * order, from the list's top): the end of the last row that fits. A list that fits, or whose first row is taller than
 * its room, is left as it is (undefined).
 */
export function wholeRowsHeight(room: number, bottoms: readonly number[]): number | undefined {
  const last = bottoms.at(-1);
  if (last === undefined || last <= room + SLACK) return undefined;
  return bottoms.filter((bottom) => bottom <= room + SLACK).at(-1);
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
