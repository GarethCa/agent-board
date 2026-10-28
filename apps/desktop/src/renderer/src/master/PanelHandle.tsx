import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { PANEL_KEY_STEP } from './panel-layout';

interface PanelHandleProps {
  /** `vertical` is a line between side-by-side things, dragged across; `horizontal` one between stacked things, dragged up and down. */
  orientation: 'vertical' | 'horizontal';
  label: string;
  value: number;
  min: number;
  max: number;
  /** Which way the value grows with the pointer: 1 with the pointer's x or y, -1 against it (a panel docked on the right grows as its left edge goes left). */
  grow: 1 | -1;
  onChange(value: number): void;
  /** A double-click: back to the default. */
  onReset(): void;
  testId?: string;
}

/**
 * A grab area on the border of the Captain's panel or between two of its sections. Dragging moves the border with the
 * pointer, the arrow keys step it and a double-click resets it, as the details strip's handle does.
 */
export function PanelHandle({ orientation, label, value, min, max, grow, onChange, onReset, testId }: PanelHandleProps) {
  const [dragging, setDragging] = useState(false);
  const from = useRef({ pointer: 0, value: 0 });
  const along = (event: { clientX: number; clientY: number }) => (orientation === 'vertical' ? event.clientX : event.clientY);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    from.current = { pointer: along(event), value };
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging) onChange(from.current.value + grow * (along(event) - from.current.pointer));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = orientation === 'vertical' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
    const at = keys.indexOf(event.key);
    if (at < 0) return;
    event.preventDefault();
    event.stopPropagation();
    onChange(value + grow * (at === 0 ? -1 : 1) * PANEL_KEY_STEP);
  };
  return (
    <div
      className="master-panel-handle"
      data-orientation={orientation}
      data-testid={testId}
      data-dragging={dragging || undefined}
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      onLostPointerCapture={() => setDragging(false)}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
