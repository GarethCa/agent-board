import { Hand, MousePointer2, Plus, Shapes, SquareDashedMousePointer, SquareTerminal, StickyNote, Type } from 'lucide-react';
import { useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { GHOST_LABELS, TOOL_DRAG_MIN, ToolGhost, type ArmedTool } from '../board/ToolOverlay';
import { Button, Island, IslandSeparator, Kbd, ToolButton } from '../ui';

/** How a drag on the board acts: selecting and moving what it starts on, or panning the board. */
export type PointerMode = 'select' | 'hand';

export interface CreateToolbarProps {
  mode: PointerMode;
  onMode(mode: PointerMode): void;
  /** The tool armed for the next click or drag, if any. */
  tool: ArmedTool | undefined;
  onTool(tool: ArmedTool | undefined): void;
  onSticky(): void;
  /** The size on screen of the ghost tile the Agent and Shell tools carry, at the board's zoom. */
  ghostSize: { width: number; height: number };
  /** The Agent or Shell tool dragged straight off the toolbar and let go at `at`, on the screen (AG2). */
  onDropTool(tool: DraggedTool, at: { x: number; y: number }): void;
}

/** The tools that can be dragged off the toolbar onto the board. */
export type DraggedTool = 'agent' | 'shell';

/**
 * The creation toolbar, the top-centre island (chrome C, WbTools): how a drag acts, then what to put on the board, then
 * the sessions to start. The Zone tool (Z) drags out where a new zone goes, then asks what it is for (P1). The
 * Agent (A) and Shell (`) tools carry a ghost tile to where the new session goes, in a zone or loose (AG2).
 */
export function CreateToolbar({ mode, onMode, tool, onTool, onSticky, ghostSize, onDropTool }: CreateToolbarProps) {
  const drag = useToolDrag(onDropTool);
  // A click arms the tool, for a click on the board; a drag off the button puts the tile where it is let go.
  const toggle = (armed: ArmedTool) => drag.consumeClick() || onTool(tool === armed ? undefined : armed);
  return (
    <Island className="create-toolbar island-top-centre" role="toolbar" aria-label="Create">
      <ToolButton label="Select" icon={<MousePointer2 />} shortcut="V" hint="Select and move" pressed={mode === 'select' && tool === undefined} onClick={() => onMode('select')} />
      <ToolButton label="Hand" icon={<Hand />} shortcut="H" hint="Pan the board" pressed={mode === 'hand' && tool === undefined} onClick={() => onMode('hand')} />
      <IslandSeparator />
      <ToolButton label="Sticky note" icon={<StickyNote />} shortcut="N" hint="Add a sticky note, or double-click the board" onClick={onSticky} />
      <ToolButton label="Text" icon={<Type />} shortcut="T" hint="Add text, then click the board" pressed={tool === 'text'} onClick={() => toggle('text')} />
      <ToolButton label="Shape" icon={<Shapes />} shortcut="S" hint="Add a shape, then drag on the board" pressed={tool === 'shape'} onClick={() => toggle('shape')} />
      <ToolButton label="Zone" icon={<SquareDashedMousePointer />} shortcut="Z" hint="Add a zone: drag out where it goes" pressed={tool === 'zone'} onClick={() => toggle('zone')} data-tour="add-zone" />
      <IslandSeparator />
      <Button
        variant="primary"
        className="create-toolbar-agent"
        icon={<Plus />}
        aria-pressed={tool === 'agent'}
        tooltip={<>Put a new agent on the board, or in a zone <Kbd>A</Kbd></>}
        onClick={() => toggle('agent')}
        onPointerDown={(event) => drag.start('agent', event)}
        data-tour="new-agent"
      >
        New agent
      </Button>
      <Button
        icon={<SquareTerminal />}
        aria-label="New shell"
        aria-pressed={tool === 'shell'}
        tooltip={<>Put a new shell on the board, or in a zone <Kbd>`</Kbd></>}
        onClick={() => toggle('shell')}
        onPointerDown={(event) => drag.start('shell', event)}
      >
        Shell
      </Button>
      {drag.ghost !== undefined &&
        createPortal(<ToolGhost at={drag.ghost.at} size={ghostSize} label={GHOST_LABELS[drag.ghost.tool]!} fromToolbar />, document.body)}
    </Island>
  );
}

/**
 * Dragging the Agent or Shell tool straight off its button (AG2): past `TOOL_DRAG_MIN` a ghost tile follows the
 * pointer, and letting go hands where to `onDrop`. The click that may follow a drag is then not a click.
 */
function useToolDrag(onDrop: (tool: DraggedTool, at: { x: number; y: number }) => void) {
  const [ghost, setGhost] = useState<{ tool: DraggedTool; at: { x: number; y: number } }>();
  const dragged = useRef(false);
  const start = (tool: DraggedTool, event: PointerEvent) => {
    dragged.current = false;
    if (event.button !== 0) return;
    const from = { x: event.clientX, y: event.clientY };
    const move = (moved: globalThis.PointerEvent) => {
      const at = { x: moved.clientX, y: moved.clientY };
      if (!dragged.current && Math.hypot(at.x - from.x, at.y - from.y) < TOOL_DRAG_MIN) return;
      dragged.current = true;
      setGhost({ tool, at });
    };
    const end = (ended: globalThis.PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      setGhost(undefined);
      if (dragged.current && ended.type === 'pointerup') onDrop(tool, { x: ended.clientX, y: ended.clientY });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  /** Whether the click just heard ends a drag, and so does nothing more. */
  const consumeClick = () => {
    const was = dragged.current;
    dragged.current = false;
    return was;
  };
  return { ghost, start, consumeClick };
}
