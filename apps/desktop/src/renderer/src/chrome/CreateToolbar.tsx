import { Brain, ChevronDown, Hand, ListTodo, MousePointer2, PenLine, Plus, Shapes, SquareCheckBig, SquareDashed, SquareDashedMousePointer, SquareTerminal, StickyNote, Ticket, Type } from 'lucide-react';
import { useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { DRAW_FOLD } from './chrome-folds';
import { GHOST_LABELS, TOOL_DRAG_MIN, ToolGhost, type ArmedTool } from '../board/ToolOverlay';
import { noteShapeUsed, useRecentShapes } from '../board/items/shapes/recents';
import { ShapeIcon } from '../board/items/shapes/ShapeArt';
import { crewMenu } from '../board/menu-model';
import { ShapePicker } from '../board/items/shapes/ShapePicker';
import { usePrefabs } from '../crews/prefab-store';
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
  /** Puts a new steps card in the middle of the board, ready to type its steps into. */
  onSteps(): void;
  /** Puts a new memory in the middle of the board, ready to type into. */
  onMemory(): void;
  /** Puts a new queue in the middle of the board, ready to add jobs to. */
  onQueue(): void;
  /** Puts a new to-do list of the user's in the middle of the board, ready to type its first line into. */
  onTodo(): void;
  /** Opens the New ticket sheet: one ticket tile, from a ticket prefab. */
  onTicket?(): void;
  /** Opens the prompt box of a crew from the prefab named, or the crew library for null. */
  onCrew?(prefab: string | null): void;
  /** The size on screen of the ghost tile the Agent and Shell tools carry, at the board's zoom. */
  ghostSize: { width: number; height: number };
  /** The Agent or Shell tool dragged straight off the toolbar and let go at `at`, on the screen. */
  onDropTool(tool: DraggedTool, at: { x: number; y: number }): void;
}

/** The tools that can be dragged off the toolbar onto the board. */
export type DraggedTool = 'agent' | 'shell';

/** Simplified's ▾ beside New agent: New agent, a crew from the library (kept current), a terminal, and a ticket. */
function StartMenu({ tool, onTool, onTicket, onCrew }: Pick<CreateToolbarProps, 'tool' | 'onTool' | 'onTicket' | 'onCrew'>) {
  const prefabs = usePrefabs();
  return (
    <Menu
      entries={[
        { label: 'New agent', icon: <Plus />, shortcut: keyText('make.agent'), onSelect: () => onTool('agent') },
        ...(onCrew === undefined ? [] : [crewMenu(prefabs, onCrew)]),
        { label: 'New terminal', icon: <SquareTerminal />, shortcut: keyText('make.shell'), onSelect: () => onTool('shell') },
        ...(onTicket === undefined ? [] : [{ label: 'New ticket…', icon: <Ticket />, onSelect: onTicket }]),
      ]}
      align="end"
    >
      <Button variant="primary" className="create-toolbar-agent-more" icon={<ChevronDown />} aria-label="More to start" aria-pressed={tool === 'shell'} />
    </Menu>
  );
}

/**
 * The creation toolbar, the top-centre island (chrome C, WbTools): how a drag acts, then what to put on the board, then
 * the sessions to start. The Zone tool (Z) drags out where a new zone goes, then asks what it is for (P1). The
 * Agent (A) and Shell (`) tools carry a ghost tile to where the new session goes, in a zone or loose.
 *
 * Where the top row is too narrow for Classic's toolbar to clear the islands either side, its drawing tools (Sticky
 * note, Text, Shape, Zone and More to add) fold into the Draw menu, so each is still a click or a Tab away. Both are
 * drawn and the stylesheet shows one, by the board's `data-folds`, so the fold's width is measured at once; the shape
 * picker and the tour follow the one shown.
 *
 * Under the Simplified design it holds fewer buttons: Select, Box select and Hand as in Classic, a Draw menu with the
 * drawing tools, and New agent, whose menu adds a crew from the library and the Shell tool as a new terminal. Every tool keeps its key.
 */
export function CreateToolbar({ mode, onMode, tool, onTool, onSticky, onSteps, onMemory, onQueue, onTodo, onTicket, onCrew, ghostSize, onDropTool }: CreateToolbarProps) {
  const drag = useToolDrag(onDropTool);
  const simplified = useSimplified();
  // Where the top row is too narrow, Classic's drawing tools fold into the Draw menu (chrome-folds.ts, chrome.css).
  const island = useRef<HTMLDivElement>(null);
  const folded = useBoardFold(island, DRAW_FOLD);
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
      aria-label="New agent"
      aria-pressed={tool === 'agent'}
      tooltip={<>Put a new agent on the board, or in a zone <Kbd>{keyText('make.agent')}</Kbd></>}
      onClick={() => toggle('agent')}
      onPointerDown={(event) => drag.start('agent', event)}
      data-tour="new-agent"
    >
      <span className="create-toolbar-word">New agent</span>
    </Button>
  );
  // How a drag acts, the same under both designs.
  const pointerTools = (
    <>
      <ToolButton label="Select" icon={<MousePointer2 />} shortcut={keyText('move.select')} hint="Select and move" pressed={mode === 'select' && tool === undefined} onClick={() => onMode('select')} />
      <ToolButton label="Box select" icon={<SquareDashed />} shortcut={keyText('move.box')} hint="Draw a box round what to select, in a zone too" pressed={mode === 'box' && tool === undefined} onClick={() => onMode('box')} />
      <ToolButton label="Hand" icon={<Hand />} shortcut={keyText('move.hand')} hint="Pan the board" pressed={mode === 'hand' && tool === undefined} onClick={() => onMode('hand')} />
    </>
  );
  if (simplified) {
    return (
      <Island className="create-toolbar island-top-centre" role="toolbar" aria-label="Create">
        {pointerTools}
        <IslandSeparator />
        <DrawMenu tool={tool} onTool={onTool} onSticky={onSticky} onSteps={onSteps} onMemory={onMemory} onQueue={onQueue} onTodo={onTodo} />
        <IslandSeparator />
        <div className="create-toolbar-split">
          {newAgent}
          <StartMenu tool={tool} onTool={onTool} onTicket={onTicket} onCrew={onCrew} />
        </div>
        {ghost}
      </Island>
    );
  }
  return (
    <Island ref={island} className="create-toolbar island-top-centre" role="toolbar" aria-label="Create">
      {pointerTools}
      <IslandSeparator />
      <span className="create-toolbar-drawing">
        <ToolButton label="Sticky note" icon={<StickyNote />} shortcut={keyText('make.note')} hint="Add a sticky note, or double-click the board" onClick={onSticky} />
        <ToolButton label="Text" icon={<Type />} shortcut={keyText('make.text')} hint="Add text, then click the board" pressed={tool === 'text'} onClick={() => toggle('text')} />
        <ShapeTool armed={tool === 'shape' && !folded} onTool={onTool} />
        <div className="create-toolbar-add">
          <ToolButton label="Zone" icon={<SquareDashedMousePointer />} shortcut={keyText('make.zone')} hint="Add a zone: drag out where it goes" pressed={tool === 'zone'} onClick={() => toggle('zone')} data-tour={folded ? undefined : 'add-zone'} />
          <Menu entries={keepEntries({ onSteps, onMemory, onQueue, onTodo })} align="end">
            <ToolButton label="More to add" className="create-toolbar-add-more" icon={<ChevronDown />} hint="Add steps, a memory, a queue or a to-do list" />
          </Menu>
        </div>
      </span>
      <span className="create-toolbar-drawing-folded">
        <DrawMenu tool={tool} onTool={onTool} onSticky={onSticky} onSteps={onSteps} onMemory={onMemory} onQueue={onQueue} onTodo={onTodo} shown={folded} />
      </span>
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
        <span className="create-toolbar-word">Shell</span>
      </Button>
      {ghost}
    </Island>
  );
}

/** The cards that keep things for people and agents: steps, a memory, a queue and a to-do list, each with its key if it has one. In Classic's "More to add" menu and the Simplified design's Draw menu. */
function keepEntries({ onSteps, onMemory, onQueue, onTodo }: Pick<CreateToolbarProps, 'onSteps' | 'onMemory' | 'onQueue' | 'onTodo'>): MenuEntry[] {
  return [
    { label: 'Steps', icon: <ListTodo />, shortcut: keyText('make.steps'), hint: 'Questions and to-dos, in order', onSelect: onSteps },
    { label: 'Memory', icon: <Brain />, shortcut: keyText('make.memory'), hint: 'Notes and decisions you and agents keep for each other', onSelect: onMemory },
    { label: 'Queue', icon: <Ticket />, shortcut: keyText('make.queue'), hint: 'Jobs in order, for agents to take one at a time', onSelect: onQueue },
    { label: 'To-do list', icon: <SquareCheckBig />, hint: 'Things for you to do; agents add them with remind', onSelect: onTodo },
  ];
}

/** Whether the board this element is on has the fold `token` in its `data-folds` now, kept up to date as it changes. */
function useBoardFold(element: RefObject<HTMLElement | null>, token: string): boolean {
  const [folded, setFolded] = useState(false);
  useLayoutEffect(() => {
    const board = element.current?.closest<HTMLElement>('.board');
    if (board === null || board === undefined) return;
    const update = () => setFolded((board.dataset.folds ?? '').split(' ').includes(token));
    update();
    const observer = new MutationObserver(update);
    observer.observe(board, { attributes: true, attributeFilter: ['data-folds'] });
    return () => observer.disconnect();
  }, [element, token]);
  return folded;
}

/** The tools the Draw menu arms, so its button shows pressed while one is. */
const DRAW_TOOLS: ReadonlySet<ArmedTool> = new Set(['text', 'shape', 'zone']);

/**
 * The Draw menu, the Simplified design's and Classic's where its drawing tools fold: a sticky note, Text, Shape and Zone,
 * then Steps, Memory, Queue and a to-do list, each with its key if it has one. Picking Shape, or pressing S, opens the
 * shape picker under the button, as the Shape tool's own button does under Classic. A pick arms its tool, even one
 * already armed: a menu row is no toggle. Classic draws it hidden until its tools fold (`shown`); till then the picker
 * and the tour stay with the tools.
 */
function DrawMenu({ tool, onTool, onSticky, onSteps, onMemory, onQueue, onTodo, shown = true }: Pick<CreateToolbarProps, 'tool' | 'onTool' | 'onSticky' | 'onSteps' | 'onMemory' | 'onQueue' | 'onTodo'> & { shown?: boolean }) {
  const shapes = useShapePicker(tool === 'shape' && shown, onTool);
  const entries: MenuEntry[] = [
    { label: 'Sticky note', icon: <StickyNote />, shortcut: keyText('make.note'), onSelect: onSticky },
    { label: 'Text', icon: <Type />, shortcut: keyText('make.text'), onSelect: () => onTool('text') },
    { label: 'Shape', icon: <Shapes />, shortcut: keyText('make.shape'), onSelect: () => onTool('shape') },
    { label: 'Zone', icon: <SquareDashedMousePointer />, shortcut: keyText('make.zone'), onSelect: () => onTool('zone') },
    'separator',
    ...keepEntries({ onSteps, onMemory, onQueue, onTodo }),
  ];
  const pressed = tool !== undefined && DRAW_TOOLS.has(tool);
  return (
    <AnchoredPopover
      {...shapes.popover}
      side="bottom"
      sideOffset={6}
      anchor={
        <span className="create-toolbar-draw">
          <Menu entries={entries}>
            <Button variant="ghost" icon={<PenLine />} trailingIcon={<ChevronDown aria-hidden />} aria-label="Draw" aria-pressed={pressed} data-tour={shown ? 'add-zone' : undefined}>
              <span className="create-toolbar-draw-word">Draw</span>
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
