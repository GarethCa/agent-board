import { useState } from 'react';
import type { Point } from '../geometry';

/**
 * A tool the user arms (T, S, Z, A, `, or its button) before clicking, or dragging, on the board. The Agent and Shell
 * tools (AG2) carry a ghost tile under the pointer to where it lands.
 */
export type ArmedTool = 'text' | 'shape' | 'zone' | 'agent' | 'shell';

/** What the Agent and Shell tools' ghost tile says. */
export const GHOST_LABELS: Partial<Record<ArmedTool, string>> = { agent: 'New agent', shell: 'New shell' };

/** How far, px, a pointer must travel for a press to be a drag rather than a click. */
export const TOOL_DRAG_MIN = 6;

/**
 * Takes the board's next click or drag while a tool is armed, over everything else, and reports it in screen
 * coordinates. A shape's or a zone's drag shows the box being sized.
 */
export function ToolOverlay({
  tool,
  ghostSize,
  onUse,
}: {
  tool: ArmedTool;
  /** The size on screen of the ghost tile the Agent and Shell tools carry. */
  ghostSize?: { width: number; height: number };
  onUse(from: Point, to: Point): void;
}) {
  const [drag, setDrag] = useState<{ from: Point; to: Point }>();
  /** Where the pointer is over the board, for the ghost tile. */
  const [hover, setHover] = useState<Point>();
  const ghost = GHOST_LABELS[tool];
  return (
    <div
      className="board-tool"
      data-testid="board-tool"
      data-tool={tool}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const at = { x: event.clientX, y: event.clientY };
        setDrag({ from: at, to: at });
      }}
      onPointerLeave={() => setHover(undefined)}
      onPointerMove={(event) => {
        setHover({ x: event.clientX, y: event.clientY });
        setDrag(
          (current) =>
            current && {
              ...current,
              to: { x: event.clientX, y: event.clientY },
            },
        );
      }}
      onPointerUp={(event) => {
        if (drag === undefined) return;
        setDrag(undefined);
        onUse(drag.from, { x: event.clientX, y: event.clientY });
      }}
      onPointerCancel={() => setDrag(undefined)}
    >
      {(tool === 'shape' || tool === 'zone') && drag !== undefined && <Rubber from={drag.from} to={drag.to} zone={tool === 'zone'} />}
      {ghost !== undefined && hover !== undefined && ghostSize !== undefined && <ToolGhost at={hover} size={ghostSize} label={ghost} />}
    </div>
  );
}

/** The box dragged between two screen points, drawn inside the overlay (which fills the board's container); dashed for a zone. */
function Rubber({ from, to, zone = false }: { from: Point; to: Point; zone?: boolean }) {
  const container = document.querySelector('.board')?.getBoundingClientRect();
  const origin = { x: container?.left ?? 0, y: container?.top ?? 0 };
  return (
    <div
      className="board-tool-rubber"
      data-zone={zone || undefined}
      style={{
        left: Math.min(from.x, to.x) - origin.x,
        top: Math.min(from.y, to.y) - origin.y,
        width: Math.abs(to.x - from.x),
        height: Math.abs(to.y - from.y),
      }}
    />
  );
}

/**
 * The tile the Agent or Shell tool will put down, centred under the pointer (`at`, on the screen): over the board while
 * the tool is armed, or dragged straight off the toolbar.
 */
export function ToolGhost({
  at,
  size,
  label,
  fromToolbar = false,
}: {
  at: Point;
  size: { width: number; height: number };
  label: string;
  /** Dragged off the toolbar: drawn over the islands too. */
  fromToolbar?: boolean;
}) {
  return (
    <div
      className="board-tool-ghost"
      data-testid="tool-ghost"
      data-from-toolbar={fromToolbar || undefined}
      style={{ left: at.x - size.width / 2, top: at.y - size.height / 2, ...size }}
    >
      {label}
    </div>
  );
}
