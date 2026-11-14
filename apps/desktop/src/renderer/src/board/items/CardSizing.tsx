// What a memory, queue and steps card share to be sized by the user: the handles round it, and a fade on a list that
// scrolls past its edge.
import { useCallback, useRef } from 'react';
import { NodeResizer } from '@xyflow/react';
import type { CardSize } from '@agent-board/daemon/protocol';
import { fadeEdges, wholeRowsHeight } from './card-size';

interface CardResizerProps {
  /** Shown while the card is selected and open: a folded one is its icon, which keeps its size. */
  visible: boolean;
  /** The least it can be made: its head and a row or so still show. */
  least: CardSize;
  /** Told as a handle is first pulled, with the frame the card had then. */
  onResizeStart?(frame: { width: number; height: number }): void;
  /** Told as the handle moves, with the frame it gives. */
  onResize?(frame: { width: number; height: number }): void;
  /** Saves the size it was given, and where it now starts, as a sticky's is. */
  onResized(frame: { x: number; y: number; width: number; height: number }): void;
}

/** The handles on each edge and corner of a selected card, as a sticky's and a document's. */
export function CardResizer({ visible, least, onResizeStart, onResize, onResized }: CardResizerProps) {
  return (
    <NodeResizer
      isVisible={visible}
      color="var(--sticky-resizer)"
      minWidth={least.width}
      minHeight={least.height}
      onResizeStart={(_event, { width, height }) => onResizeStart?.({ width, height })}
      onResize={onResize === undefined ? undefined : (_event, { width, height }) => onResize({ width, height })}
      onResizeEnd={(_event, { x, y, width, height }) => onResized({ x, y, width, height })}
    />
  );
}

/** What a list that scrolls inside its card also does, beyond its fade. */
interface ScrollFadeOptions {
  /** Cut to its last row that shows whole when it runs past its room, so no sliver of the next row shows. */
  whole?: boolean;
  /** Told how many rows (a row as tall as its shortest `.listcard-row`) its room holds, as that changes. */
  onRows?(rows: number): void;
}

/** Where each of a list's rows ends, from its top: in the list's own pixels, which the board's zoom does not scale. */
const rowBottoms = (element: HTMLElement): number[] => [...element.children].map((row) => (row as HTMLElement).offsetTop - element.offsetTop + (row as HTMLElement).offsetHeight);

/**
 * A ref for a list that scrolls inside its card: it marks `data-fade` with the edges that have rows past them, so the
 * CSS fades them out. It reads again as the list scrolls, as the card or a row is resized, and as rows come and go.
 */
export function useScrollFade<Element extends HTMLElement>({ whole = false, onRows }: ScrollFadeOptions = {}): (element: Element | null) => (() => void) | undefined {
  const told = useRef(onRows);
  told.current = onRows;
  return useCallback(
    (element: Element | null) => {
      if (element === null) return undefined;
      let rows: number | undefined;
      const measure = () => {
        if (!whole && told.current === undefined) return;
        // Its room is its height uncut: the card's, less its head and foot.
        element.style.maxHeight = '';
        const room = element.clientHeight;
        if (whole) {
          const cut = wholeRowsHeight(room, rowBottoms(element));
          if (cut !== undefined) element.style.maxHeight = `${cut}px`;
        }
        // A row's height is its shortest one's: on the selected card a long row wraps in full, and the count stays put.
        const heights = [...element.querySelectorAll<HTMLElement>(':scope > .listcard-row')].map((each) => each.offsetHeight).filter((height) => height > 0);
        const row = heights.length > 0 ? Math.min(...heights) : 0;
        const fit = row > 0 ? Math.floor(room / row) : undefined;
        if (fit !== undefined && fit !== rows) told.current?.((rows = fit));
      };
      const mark = () => {
        const edges = fadeEdges(element);
        if (edges === undefined) delete element.dataset.fade;
        else element.dataset.fade = edges;
      };
      const read = () => {
        measure();
        mark();
      };
      element.addEventListener('scroll', mark, { passive: true });
      // Its rows too: a row that wraps in full on the selected card grows the list without a change to the page. And
      // its card, which a resize changes, as a list cut short does not grow with it.
      const resized = new ResizeObserver(read);
      const watch = () => [element, element.parentElement, ...element.children].forEach((each) => each !== null && resized.observe(each));
      watch();
      read();
      const changed = new MutationObserver(() => {
        watch();
        read();
      });
      changed.observe(element, { childList: true, subtree: true, characterData: true });
      return () => {
        element.removeEventListener('scroll', mark);
        resized.disconnect();
        changed.disconnect();
      };
    },
    [whole],
  );
}
