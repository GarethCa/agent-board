import type { ReactNode } from 'react';
import type { BoardItemKind } from '@agent-board/daemon/protocol';
import { covers } from '../../board-colors';
import {
  AlarmClock,
  Brain,
  SquareCheckBig,
  Ticket,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignCenterHorizontal,
  AlignVerticalDistributeCenter,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Copy,
  CopyPlus,
  Grid3x3,
  Spline,
  LayoutDashboard,
  LayoutGrid,
  LibraryBig,
  ListTodo,
  Pencil,
  Pin,
  PinOff,
  Rows3,
  RotateCcw,
  Sparkles,
  SquareDashedMousePointer,
  Trash2,
  Users,
  Workflow,
} from 'lucide-react';
import { CrewFaces } from '../../crews/icons';
import { crewGroups } from '../../crews/prefab-store';
import { binding, isActive, keyText } from '../../keys/registry';
import type { MenuEntry } from '../../ui';
import { ITEM_KINDS } from '../items/kinds';
import type { Alignment, Reorder } from './arrange';
import type { SelectionSummary } from './use-editing';
import { endOfNode } from '../connectors/endpoints';

/** What the context menu's rows do. */
export interface ContextActions {
  /** Opens Ask Claude about the selection (CM). */
  askClaude(): void;
  /** Renames the one agent or shell tile selected. */
  rename(): void;
  duplicate(): void;
  copy(): void;
  /** Copies the selected shapes, and the connectors between them, as Mermaid text. */
  copyMermaid(): void;
  restack(how: Reorder): void;
  align(how: Alignment): void;
  distribute(axis: 'x' | 'y'): void;
  setColor(patch: (value: string) => Record<string, unknown>, kind: BoardItemKind, value: string): void;
  /** Joins the two objects selected with a connector, or with one selected, waits for a click on the one to join it to. */
  connect(): void;
  /** Turns the selected items back straight. */
  resetRotation(): void;
  deleteSelection(): void;
  selectAll(): void;
  /** Whether a drag snaps to the grid, and turns that on or off. */
  grid: boolean;
  toggleGrid(): void;
  /** Lays the tiles loose on the board out in a grid where they are. */
  tidyLoose(): void;
  /** Lays the zones out in rows and gathers the loose tiles below them, never moving what is in a zone. */
  arrangeBoard(): void;
  /** Puts a new clock where the menu was opened, and opens its editor. */
  addClock(): void;
  /** A new steps card where the menu was opened. */
  addSteps(): void;
  /** A new memory where the menu was opened, its add box focused. */
  addMemory(): void;
  /** A new queue for agents where the menu was opened, its add box focused. */
  addQueue(): void;
  /** A new to-do list of the user's where the menu was opened, its add field focused. */
  addTodo(): void;
  /** Opens the prompt box of a crew from the prefab named. */
  startCrew(prefab: string): void;
  /** Opens the crew library. */
  crewLibrary(): void;
  /** With one lead tile selected in a shelved zone: whether it is pinned top-left, and how to free or pin it. */
  leadPin?: { pinned: boolean; toggle(): void };
  /** With one tile selected that was placed by hand in a zone with a layout rule: puts it back under the rule. */
  backUnderRule?: () => void;
}

/**
 * The context menu on a selection (WbTools): Ask Claude (CM), duplicate and copy (shapes also as Mermaid), z-order, align, reset rotation, each selected kind's
 * colour, and delete, which asks before it deletes a session.
 */
export function selectionEntries(selection: SelectionSummary, selectedConnectors: number, actions: ContextActions): MenuEntry[] {
  const hasItems = selection.items.length > 0;
  const movable = selection.movable.length;
  // Some selected tiles sit where their zone's layout puts them, so align and distribute leave them be.
  const laidOut = selection.movable.length < selection.nodes.length ? 'Tiles on shelves or in clusters keep their places there' : undefined;
  const alignTo = (label: string, how: Alignment, icon: ReactNode): MenuEntry => ({ label, icon, onSelect: () => actions.align(how) });
  const colours = [...selection.kinds].flatMap((kind): MenuEntry[] => {
    const colors = ITEM_KINDS[kind].colors;
    if (colors === undefined) return [];
    const shown = new Set(selection.items.filter((node) => node.data.item.kind === kind).map((node) => colors.of(node.data.item.data)));
    return [
      {
        label: colors.label,
        swatches: colors.presets().map(({ name, value, color, also = [] }) => ({ name, value, color, pressed: shown.size === 1 && [...shown].some((has) => covers({ slot: value, also }, has)) })),
        onPick: (value) => actions.setColor(colors.patch, kind, value),
      },
    ];
  });
  // A connector joins two objects: the pair selected, or the one selected and the one clicked next (the mouse-free way
  // to what dragging from a handle does).
  const joinable = selection.nodes.filter((node) => endOfNode(node, 'right') !== undefined);
  const connect: MenuEntry[] =
    selection.nodes.length === 2 && joinable.length === 2
      ? [{ label: 'Connect them', icon: <Spline />, onSelect: actions.connect }]
      : selection.nodes.length === 1 && joinable.length === 1
        ? [{ label: 'Connect to…', icon: <Spline />, hint: 'Then click what to join it to', onSelect: actions.connect }]
        : [];
  // Only about objects: a selection of connectors alone has nothing to draw or describe.
  const ask: MenuEntry[] =
    selection.nodes.length > 0
      ? [{ label: 'Ask Claude…', icon: <Sparkles />, shortcut: keyText('make.askClaude'), hint: 'Sends nothing until you press Ask', onSelect: actions.askClaude }, 'separator']
      : [];
  return [
    ...ask,
    ...(selection.renamable ? [{ label: 'Rename', icon: <Pencil />, shortcut: keyText('tile.rename'), onSelect: actions.rename }, 'separator' as const] : []),
    ...(actions.leadPin === undefined
      ? []
      : [
          actions.leadPin.pinned
            ? { label: 'Free from top-left', icon: <PinOff />, hint: 'It goes on the shelves as a stack of its own', onSelect: actions.leadPin.toggle }
            : { label: 'Pin top-left', icon: <Pin />, hint: "Back in the zone's head row, above the shelves", onSelect: actions.leadPin.toggle },
          'separator' as const,
        ]),
    ...(actions.backUnderRule === undefined ? [] : [{ label: 'Put back under the rule', icon: <Rows3 />, hint: "The zone's rule lays it out again", onSelect: actions.backUnderRule }, 'separator' as const]),
    { label: 'Duplicate', icon: <CopyPlus />, shortcut: keyText('edit.duplicate'), disabled: !hasItems, onSelect: actions.duplicate },
    { label: 'Copy', icon: <Copy />, shortcut: keyText('edit.copy'), disabled: !hasItems, onSelect: actions.copy },
    ...(selection.kinds.has('shape') ? [{ label: 'Copy as Mermaid', icon: <Workflow />, hint: 'The shapes and their connectors, as diagram text', onSelect: actions.copyMermaid }] : []),
    ...(connect.length > 0 ? ['separator' as const, ...connect] : []),
    'separator',
    { label: 'Bring to front', icon: <ArrowUpToLine />, shortcut: keyText('edit.front'), onSelect: () => actions.restack('front') },
    { label: 'Bring forward', icon: <ArrowUp />, shortcut: keyText('edit.forward'), onSelect: () => actions.restack('forward') },
    { label: 'Send backward', icon: <ArrowDown />, shortcut: keyText('edit.backward'), onSelect: () => actions.restack('backward') },
    { label: 'Send to back', icon: <ArrowDownToLine />, shortcut: keyText('edit.back'), onSelect: () => actions.restack('back') },
    {
      label: 'Align',
      icon: <AlignStartVertical />,
      disabled: movable < 2,
      hint: laidOut,
      entries: [
        alignTo('Left edges', 'left', <AlignStartVertical />),
        alignTo('Centres', 'centre', <AlignCenterVertical />),
        alignTo('Right edges', 'right', <AlignEndVertical />),
        'separator',
        alignTo('Top edges', 'top', <AlignStartHorizontal />),
        alignTo('Middles', 'middle', <AlignCenterHorizontal />),
        alignTo('Bottom edges', 'bottom', <AlignEndHorizontal />),
        'separator',
        { label: 'Distribute horizontally', icon: <AlignHorizontalDistributeCenter />, disabled: movable < 3, onSelect: () => actions.distribute('x') },
        { label: 'Distribute vertically', icon: <AlignVerticalDistributeCenter />, disabled: movable < 3, onSelect: () => actions.distribute('y') },
      ],
    },
    {
      label: 'Reset rotation',
      icon: <RotateCcw />,
      shortcut: keyText('edit.resetRotation'),
      disabled: !selection.items.some((node) => node.data.item.rotation !== 0),
      onSelect: actions.resetRotation,
    },
    ...(colours.length > 0 ? ['separator' as const, ...colours] : []),
    'separator',
    {
      label: 'Delete',
      icon: <Trash2 />,
      shortcut: keyText('edit.delete'),
      danger: true,
      disabled: !hasItems && selectedConnectors === 0 && !selection.hasSessions && !selection.hasZones,
      hint: selection.hasSessions ? "Sessions are asked about first, and can't be undone." : selection.hasZones ? 'Zones are asked about first; their tiles stay on the board' : undefined,
      onSelect: actions.deleteSelection,
    },
  ];
}

/** The context menu on empty board: select everything, and snap to the grid. */
export function boardEntries(actions: ContextActions): MenuEntry[] {
  return [
    { label: 'New steps', icon: <ListTodo />, shortcut: keyText('make.steps'), hint: 'Questions and to-dos, in order', onSelect: actions.addSteps },
    { label: 'Add a clock', icon: <AlarmClock />, hint: 'A schedule that messages an agent, or starts one', onSelect: actions.addClock },
    { label: 'Add a memory', icon: <Brain />, shortcut: keyText('make.memory'), hint: 'Notes and decisions you and agents keep for each other', onSelect: actions.addMemory },
    { label: 'Add a queue', icon: <Ticket />, shortcut: keyText('make.queue'), hint: 'Jobs in order, for agents to take one at a time', onSelect: actions.addQueue },
    { label: 'Add a to-do list', icon: <SquareCheckBig />, hint: 'Things for you to do; agents add them with remind', onSelect: actions.addTodo },
    {
      label: 'New crew',
      icon: <Users />,
      entries: [
        ...crewGroups().flatMap((group): MenuEntry[] => [
          ...group.map((prefab): MenuEntry => ({ label: prefab.name, icon: <CrewFaces members={prefab.members} />, onSelect: () => actions.startCrew(prefab.name) })),
          'separator',
        ]),
        { label: 'Library…', icon: <LibraryBig />, onSelect: actions.crewLibrary },
      ],
    },
    { label: 'Select all', icon: <SquareDashedMousePointer />, shortcut: keyText('edit.selectAll'), onSelect: actions.selectAll },
    { label: actions.grid ? 'Stop snapping to the grid' : 'Snap to the grid', icon: <Grid3x3 />, onSelect: actions.toggleGrid },
    { label: 'Tidy loose tiles', icon: <LayoutGrid />, hint: 'In a grid where they are, in reading order', onSelect: actions.tidyLoose },
    {
      label: 'Arrange the board',
      icon: <LayoutDashboard />,
      shortcut: isActive(binding('edit.arrangeBoard')) ? keyText('edit.arrangeBoard') : undefined,
      hint: 'Zones in rows, loose tiles below; nothing inside a zone moves',
      onSelect: actions.arrangeBoard,
    },
  ];
}
