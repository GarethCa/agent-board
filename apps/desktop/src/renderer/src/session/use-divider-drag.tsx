import { useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { setSplitRatio, type SplitTree } from '@agent-board/daemon/pane-layout';
import { paneGeometry, ratioAt, type Divider, type PaneGeometry } from './pane-geometry';

const percent = (fraction: number) => `${fraction * 100}%`;

/**
 * Drags the dividers of a split tree laid out flat in `container` (a shell's panes, or a window's), each pane by `idOf`: a
 * dragged divider moves alone, as a guide line, and the panes take their new sizes once it is let go, so their
 * terminals are resized once, not on every pointer move. `onResize` saves where it was left, and settles once the saved
 * layout is in (or saving failed). The geometry is the layout's, with a let-go divider held where it was left meanwhile.
 */
export function useDividerDrag<L extends { type: 'pane' }>(
  container: RefObject<HTMLElement | null>,
  layout: SplitTree<L>,
  idOf: (leaf: L) => string,
  onResize: (splitId: string, ratio: number) => Promise<void>,
): { geometry: PaneGeometry; dividers: DividersProps } {
  /** The divider being dragged and where it is; `released` once let go, until the saved layout replaces it. */
  const [drag, setDrag] = useState<{ splitId: string; ratio: number; released: boolean }>();
  /** Takes the drag's listeners off the window, while there is a drag. */
  const endDrag = useRef<() => void>(undefined);
  useEffect(() => () => endDrag.current?.(), []);
  const saved = paneGeometry(layout, idOf);
  // A divider gone meanwhile (its pane closed elsewhere) drags nothing.
  const current = drag && saved.dividers.some((divider) => divider.splitId === drag.splitId) ? drag : undefined;
  const geometry = current?.released ? paneGeometry(setSplitRatio(layout, current.splitId, current.ratio), idOf) : saved;
  const dividers = geometry.dividers.map((divider) => (divider.splitId === current?.splitId ? { ...divider, ratio: current.ratio } : divider));

  /**
   * Follows the pointer from a divider until it is let go, with listeners on the window: nothing under the pointer
   * (a terminal, the board) can swallow the drag, and it carries on outside the panes.
   */
  const start = (divider: Divider, down: PointerEvent) => {
    if (down.button !== 0) return;
    down.preventDefault();
    endDrag.current?.();
    const ratioFor = (event: { clientX: number; clientY: number }) => {
      const box = container.current!.getBoundingClientRect();
      return ratioAt(divider, { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height });
    };
    const onMove = (event: globalThis.PointerEvent) => setDrag({ splitId: divider.splitId, ratio: ratioFor(event), released: false });
    const onUp = (event: globalThis.PointerEvent) => {
      const ratio = ratioFor(event);
      stop();
      // Held where it was let go until the saved layout replaces it, so it doesn't snap back meanwhile.
      setDrag({ splitId: divider.splitId, ratio, released: true });
      void onResize(divider.splitId, ratio).finally(() => setDrag(undefined));
    };
    const onCancel = () => {
      stop();
      setDrag(undefined);
    };
    const stop = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      endDrag.current = undefined;
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    endDrag.current = stop;
  };
  return { geometry, dividers: { dividers, dragging: current?.released === false ? current.splitId : undefined, onStart: start } };
}

interface DividersProps {
  dividers: Divider[];
  /** The divider being dragged, not yet let go. */
  dragging: string | undefined;
  onStart(divider: Divider, event: PointerEvent): void;
}

/** The dividers between panes, each dragged to resize the panes either side. */
export function Dividers({ dividers, dragging, onStart, className = 'shell-divider', testId = 'shell-divider' }: DividersProps & { className?: string; testId?: string }) {
  return dividers.map((divider) => {
    const side = divider.direction === 'horizontal';
    const at = side ? divider.region.x + divider.region.width * divider.ratio : divider.region.y + divider.region.height * divider.ratio;
    return (
      <div
        key={divider.splitId}
        className={className}
        data-testid={testId}
        data-dragging={divider.splitId === dragging}
        data-direction={divider.direction}
        data-ratio={divider.ratio}
        role="separator"
        aria-orientation={side ? 'vertical' : 'horizontal'}
        style={
          side
            ? { left: percent(at), top: percent(divider.region.y), height: percent(divider.region.height) }
            : { top: percent(at), left: percent(divider.region.x), width: percent(divider.region.width) }
        }
        onPointerDown={(event) => onStart(divider, event)}
      />
    );
  });
}
