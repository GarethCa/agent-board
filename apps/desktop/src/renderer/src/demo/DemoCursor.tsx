import { useEffect, useRef, useState } from 'react';
import { DEMO } from './demo-mode';

/** A click's ripple, where it was pressed. */
interface Ripple {
  id: number;
  x: number;
  y: number;
}

/**
 * In demo mode, a drawn pointer for the recording, as an offscreen window paints none of its own: it follows the
 * mouse and ripples where it is pressed. Hidden until a spec calls `window.__demo.cursor(true)`; nothing outside demo
 * mode.
 */
export function DemoCursor() {
  return DEMO ? <Cursor /> : null;
}

function Cursor() {
  const [shown, setShown] = useState(false);
  const [at, setAt] = useState<{ x: number; y: number }>();
  const [ripples, setRipples] = useState<Ripple[]>([]);
  /** The next ripple's id: never reused, so a new ripple never takes an old one's place. */
  const nextRipple = useRef(0);
  useEffect(() => {
    const demo = (window.__demo ??= {});
    demo.cursor = setShown;
    return () => {
      delete demo.cursor;
    };
  }, []);
  useEffect(() => {
    if (!shown) return;
    const onMove = (event: PointerEvent) => setAt({ x: event.clientX, y: event.clientY });
    const onDown = (event: PointerEvent) => {
      onMove(event);
      const id = nextRipple.current++;
      setRipples((current) => [...current, { id, x: event.clientX, y: event.clientY }]);
    };
    // Captured, so a control that stops the event still moves the pointer.
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerdown', onDown, true);
      // Hidden, a ripple's span is gone before its animation ends: dropped here, so showing the cursor again can't replay it.
      setRipples([]);
    };
  }, [shown]);
  if (!shown) return null;
  return (
    <div className="demo-cursor-layer" aria-hidden data-testid="demo-cursor">
      {ripples.map((ripple) => (
        <span
          key={ripple.id}
          className="demo-cursor-ripple"
          style={{ translate: `${ripple.x}px ${ripple.y}px` }}
          onAnimationEnd={() => setRipples((current) => current.filter((each) => each.id !== ripple.id))}
        />
      ))}
      {at !== undefined && (
        <svg className="demo-cursor" style={{ translate: `${at.x}px ${at.y}px` }} viewBox="0 0 16 24">
          <path d="M1 1 L1 19 L5.5 14.5 L8.5 22 L11.5 20.8 L8.6 13.5 L14.5 13.5 Z" />
        </svg>
      )}
    </div>
  );
}
