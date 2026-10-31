import { ChevronDown, Hand, MousePointer2, PenLine, Plus, Shapes, SquareDashed, SquareDashedMousePointer, SquareTerminal, StickyNote, Type } from 'lucide-react';
import { useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { GHOST_LABELS, TOOL_DRAG_MIN, ToolGhost, type ArmedTool } from '../board/ToolOverlay';
import { noteShapeUsed, useRecentShapes } from '../board/items/shapes/recents';
import { ShapeIcon } from '../board/items/shapes/ShapeArt';
import { ShapePicker } from '../board/items/shapes/ShapePicker';
import { useSimplified } from '../design';
import { keyText } from '../keys/registry';
import { AnchoredPopover, Button, Island, IslandSeparator, Kbd, Menu, Popover, ToolButton, type MenuEntry } from '../ui';

/**
 * How a drag on the board acts: selecting and moving what it starts on; the same, but a zone's body draws a marquee and
 * the zone moves only by its tab (box select); or panning the board.
 */
export type PointerMode = 'select' | 'box' | 'hand';

export interface CreateToolbarProps {
  mode: PointerMode;
  onMode(mode: PointerMode): void;
  /** The tool armed for the next click or drag, if any. */
  tool: ArmedTool | undefined;
  onTool(tool: ArmedTool | undefined): void;
  onSticky(): void;
  /** The size on screen of the ghost tile the Agent and Shell tools carry, at the board's zoom. */
  ghostSize: { width: number; height: number };
  /** The Agent or Shell tool dragged straight off the toolbar and let go at `at`, on the screen. */
  onDropTool(tool: DraggedTool, at: { x: number; y: number }): void;
}

/** The tools that can be dragged off the toolbar onto the board. */
export type DraggedTool = 'agent' | 'shell';

/**
 * The creation toolbar, the top-centre island (chrome C, WbTools): how a drag acts, then what to put on the board, then
 * the sessions to start. The Zone tool (Z) drags out where a new zone goes, then asks what it is for (P1). The
 * Agent (A) and Shell (`) tools carry a ghost tile to where the new session goes, in a zone or loose.
 *
 * Under the Simplified design it holds fewer buttons: Select, Hand, a Draw menu with the drawing tools and Box select,
 * and New agent, whose menu adds the Shell tool as a new terminal. Every tool keeps its key.
 */
export function CreateToolbar({ mode, onMode, tool, onTool, onSticky, ghostSize, onDropTool }: CreateToolbarProps) {
  const drag = useToolDrag(onDropTool);
  const simplified = useSimplified();
  // A click arms the tool, for a click on the board; a drag off the button puts the tile where it is let go.
  const toggle = (armed: ArmedTool) => drag.consumeClick() || onTool(tool === armed ? undefined : armed);
  const ghost =
    drag.ghost !== undefined &&
    createPortal(<ToolGhost at={drag.ghost.at} size={ghostSize} label={GHOST_LABELS[drag.ghost.tool]!} fromToolbar />, document.body);
  const newAgent = (
    <Button
      variant="primary"
      className="create-toolbar-agent"
      icon={<Plus />}
      aria-pressed={tool === 'agent'}
      tooltip={<>Put a new agent on the board, or in a zone <Kbd>{keyText('make.agent')}</Kbd></>}
      onClick={() => toggle('agent')}
      onPointerDown={(event) => drag.start('agent', event)}
      data-tour="new-agent"
    >
      New agent
    </Button>
  );
  if (simplified) {
    return (
      <Island className="create-toolbar island-top-centre" role="toolbar" aria-label="Create">
        <ToolButton label="Select" icon={<MousePointer2 />} hint="Select and move" shortcut={keyText('move.select')} pressed={mode === 'select' && tool === undefined} onClick={() => onMode('select')} />
        <ToolButton label="Hand" icon={<Hand />} hint="Pan the board" shortcut={keyText('move.hand')} pressed={mode === 'hand' && tool === undefined} onClick={() => onMode('hand')} />
        <IslandSeparator />
        <DrawMenu mode={mode} tool={tool} onMode={onMode} onTool={onTool} onSticky={onSticky} />
        <IslandSeparator />
        <div className="create-toolbar-split">
          {newAgent}
          <Menu
            entries={[
              { label: 'New agent', icon: <Plus />, shortcut: keyText('make.agent'), onSelect: () => onTool('agent') },
              { label: 'New terminal', icon: <SquareTerminal />, shortcut: keyText('make.shell'), onSelect: () => onTool('shell') },
            ]}
            align="end"
          >
            <Button variant="primary" className="create-toolbar-agent-more" icon={<ChevronDown />} aria-label="More to start" aria-pressed={tool === 'shell'} />
          </Menu>
        </div>
        {ghost}
      </Island>
    );
  }
  return (
    <Island className="create-toolbar island-top-centre" role="toolbar" aria-label="Create">
      <ToolButton label="Select" icon={<MousePointer2 />} shortcut={keyText('move.select')} hint="Select and move" pressed={mode === 'select' && tool === undefined} onClick={() => onMode('select')} />
      <ToolButton label="Box select" icon={<SquareDashed />} shortcut={keyText('move.box')} hint="Draw a box round what to select, in a zone too" pressed={mode === 'box' && tool === undefined} onClick={() => onMode('box')} />
      <ToolButton label="Hand" icon={<Hand />} shortcut={keyText('move.hand')} hint="Pan the board" pressed={mode === 'hand' && tool === undefined} onClick={() => onMode('hand')} />
      <IslandSeparator />
      <ToolButton label="Sticky note" icon={<StickyNote />} shortcut={keyText('make.note')} hint="Add a sticky note, or double-click the board" onClick={onSticky} />
      <ToolButton label="Text" icon={<Type />} shortcut={keyText('make.text')} hint="Add text, then click the board" pressed={tool === 'text'} onClick={() => toggle('text')} />
      <ShapeTool armed={tool === 'shape'} onTool={onTool} />
      <ToolButton label="Zone" icon={<SquareDashedMousePointer />} shortcut={keyText('make.zone')} hint="Add a zone: drag out where it goes" pressed={tool === 'zone'} onClick={() => toggle('zone')} data-tour="add-zone" />
      <IslandSeparator />
      {newAgent}
      <Button
        icon={<SquareTerminal />}
        aria-label="New shell"
        aria-pressed={tool === 'shell'}
        tooltip={<>Put a new shell on the board, or in a zone <Kbd>{keyText('make.shell')}</Kbd></>}
        onClick={() => toggle('shell')}
        onPointerDown={(event) => drag.start('shell', event)}
      >
        Shell
      </Button>
      {ghost}
    </Island>
  );
}

/** The tools the Simplified design's Draw menu arms, so its button shows pressed while one is. */
const DRAW_TOOLS: ReadonlySet<ArmedTool> = new Set(['text', 'shape', 'zone']);

/**
 * The Simplified design's Draw menu: a sticky note, Text, Shape and Zone, then Box select, each with its key. Picking
 * Shape, or pressing S, opens the shape picker under the button, as the Shape tool's own button does under Classic. A
 * pick arms its tool, even one already armed: a menu row is no toggle.
 */
function DrawMenu({ mode, tool, onMode, onTool, onSticky }: Pick<CreateToolbarProps, 'mode' | 'tool' | 'onMode' | 'onTool' | 'onSticky'>) {
  const shapes = useShapePicker(tool === 'shape', onTool);
  const entries: MenuEntry[] = [
    { label: 'Sticky note', icon: <StickyNote />, shortcut: keyText('make.note'), onSelect: onSticky },
    { label: 'Text', icon: <Type />, shortcut: keyText('make.text'), onSelect: () => onTool('text') },
    { label: 'Shape', icon: <Shapes />, shortcut: keyText('make.shape'), onSelect: () => onTool('shape') },
    { label: 'Zone', icon: <SquareDashedMousePointer />, shortcut: keyText('make.zone'), onSelect: () => onTool('zone') },
    'separator',
    { label: 'Box select', icon: <SquareDashed />, shortcut: keyText('move.box'), onSelect: () => onMode('box') },
  ];
  const pressed = (tool !== undefined && DRAW_TOOLS.has(tool)) || (tool === undefined && mode === 'box');
  return (
    <AnchoredPopover
      {...shapes.popover}
      side="bottom"
      sideOffset={6}
      anchor={
        <span className="create-toolbar-draw">
          <Menu entries={entries}>
            <Button variant="ghost" icon={<PenLine />} trailingIcon={<ChevronDown aria-hidden />} aria-pressed={pressed} data-tour="add-zone">
              Draw
            </Button>
          </Menu>
        </span>
      }
    >
      {shapes.picker}
    </AnchoredPopover>
  );
}

/**
 * The Shape tool: its button draws the shape picked last, which a drag on the board then draws. Arming
 * it, from the button or S, opens the shape picker under it, its search focused. A pick arms that shape and closes
 * the picker; a press on the board closes it too and draws, while Esc or the button again puts the tool down.
 */
function ShapeTool({ armed, onTool }: { armed: boolean; onTool(tool: ArmedTool | undefined): void }) {
  const { last, popover, picker } = useShapePicker(armed, onTool);
  return (
    <Popover {...popover} content={picker}>
      <ToolButton
        label="Shape"
        className="create-toolbar-shape"
        icon={
          <>
            <ShapeIcon shape={last} room={{ width: 20, height: 16 }} />
            <ChevronDown className="create-toolbar-shape-more" aria-hidden />
          </>
        }
        shortcut={keyText('make.shape')}
        hint="Add a shape, then drag on the board"
        pressed={armed}
      />
    </Popover>
  );
}

/**
 * The shape picker's state, for whichever button it opens under: open whenever the Shape tool is armed, until it is
 * picked from or the board is pressed. A pick arms that shape and closes it; a press on the board closes it too and
 * draws, while Esc or a press elsewhere puts the tool down.
 */
function useShapePicker(armed: boolean, onTool: (tool: ArmedTool | undefined) => void) {
  const last = useRecentShapes()[0] ?? 'rectangle';
  const [closed, setClosed] = useState(false);
  const [wasArmed, setWasArmed] = useState(armed);
  if (wasArmed !== armed) {
    setWasArmed(armed);
    setClosed(false);
  }
  /** Closed by a pick or a press on the board: the tool stays armed, and focus stays off the button. */
  const keepArmed = useRef(false);
  const close = () => {
    keepArmed.current = true;
    setClosed(true);
  };
  return {
    last,
    popover: {
      'aria-label': 'Shapes',
      className: 'shape-picker-popover',
      open: armed && !closed,
      onOpenChange: (open: boolean) => {
        if (open) {
          setClosed(false);
          onTool('shape');
        } else if (keepArmed.current) setClosed(true);
        else onTool(undefined);
      },
      onPointerDownOutside: (event: Event) => {
        if ((event.target as Element | null)?.closest('[data-testid="board-tool"]')) keepArmed.current = true;
      },
      onCloseAutoFocus: (event: Event) => {
        if (keepArmed.current) event.preventDefault();
        keepArmed.current = false;
      },
    },
    picker: (
      <ShapePicker
        current={last}
        hint={
          <>
            <span>Click, then drag on the board</span>·<span>↵ the first match</span>
          </>
        }
        onEscape={() => onTool(undefined)}
        onPick={(shape) => {
          noteShapeUsed(shape);
          close();
        }}
      />
    ),
  };
}

/**
 * Dragging the Agent or Shell tool straight off its button: past `TOOL_DRAG_MIN` a ghost tile follows the
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
