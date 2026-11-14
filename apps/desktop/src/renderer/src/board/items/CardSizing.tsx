// What a memory, queue and steps card share to be sized by the user: the handles round it, and a fade on a list that
// scrolls past its edge.
import { useCallback } from 'react';
import { NodeResizer } from '@xyflow/react';
import type { CardSize } from '@agent-board/daemon/protocol';
import { fadeEdges } from './card-size';

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

/**
 * A ref for a list that scrolls inside its card: it marks `data-fade` with the edges that have rows past them, so the
 * CSS fades them out. It reads again as the list scrolls, as the card or a row is resized, and as rows come and go.
 */
export function useScrollFade<Element extends HTMLElement>(): (element: Element | null) => (() => void) | undefined {
  return useCallback((element: Element | null) => {
    if (element === null) return undefined;
    const mark = () => {
      const edges = fadeEdges(element);
      if (edges === undefined) delete element.dataset.fade;
      else element.dataset.fade = edges;
    };
    element.addEventListener('scroll', mark, { passive: true });
    // Its rows too: a row that wraps in full on the selected card grows the list without a change to the page.
    const resized = new ResizeObserver(mark);
    const watch = () => [element, ...element.children].forEach((each) => resized.observe(each));
    watch();
    mark();
    const changed = new MutationObserver(() => {
      watch();
      mark();
    });
    changed.observe(element, { childList: true, subtree: true, characterData: true });
    return () => {
      element.removeEventListener('scroll', mark);
      resized.disconnect();
      changed.disconnect();
    };
  }, []);
}
