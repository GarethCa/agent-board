import type { CSSProperties } from 'react';
import { Background, BackgroundVariant, useStore } from '@xyflow/react';
import { LEAST_PATTERN_ZOOM, STILL_BACKGROUNDS, useBoardBackground, type BoardBackground } from './board-background';

/** The pattern moves with the viewport: its offset and cell scale are the board's pan and zoom, as CSS variables. */
function MovingBackdrop({ background }: { background: BoardBackground }) {
  const x = useStore((state) => state.transform[0]);
  const y = useStore((state) => state.transform[1]);
  const zoom = useStore((state) => state.transform[2]);
  if (zoom < LEAST_PATTERN_ZOOM) return null;
  const view = { '--backdrop-x': `${x}px`, '--backdrop-y': `${y}px`, '--backdrop-zoom': zoom } as CSSProperties;
  return <div className="board-backdrop" data-board-background={background} style={view} aria-hidden />;
}

/**
 * The board's desk pattern, under the zones and tiles. Standard is React Flow's own dots, which the snap grid shares
 * its gap with; every other choice is a CSS pattern (app.css) that follows the viewport, or sits still.
 */
export function BoardBackdrop({ gap, size }: { gap: number; size: number }) {
  const background = useBoardBackground();
  if (background === 'standard') return <Background variant={BackgroundVariant.Dots} gap={gap} size={size} color="var(--surface-dot)" />;
  if (STILL_BACKGROUNDS.includes(background)) return <div className="board-backdrop" data-board-background={background} aria-hidden />;
  return <MovingBackdrop background={background} />;
}
