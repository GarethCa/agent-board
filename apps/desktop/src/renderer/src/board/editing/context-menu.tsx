import type { ReactNode } from 'react';
import type { BoardItemKind } from '@agent-board/daemon/protocol';
import {
  AlarmClock,
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
  LayoutGrid,
  Pencil,
  RotateCcw,
  Sparkles,
  SquareDashedMousePointer,
  Trash2,
} from 'lucide-react';
import { keyText } from '../../keys/registry';
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
  /** Puts a new clock where the menu was opened, and opens its editor. */
  addClock(): void;
}

/**
 * The context menu on a selection (WbTools): Ask Claude (CM), duplicate and copy, z-order, align, reset rotation, each selected kind's
 * colour, and delete, which asks before it deletes a session.
 */
export function selectionEntries(selection: SelectionSummary, selectedConnectors: number, actions: ContextActions): MenuEntry[] {
  const hasItems = selection.items.length > 0;
  const movable = selection.nodes.length;
  const alignTo = (label: string, how: Alignment, icon: ReactNode): MenuEntry => ({ label, icon, onSelect: () => actions.align(how) });
  const colours = [...selection.kinds].flatMap((kind): MenuEntry[] => {
    const colors = ITEM_KINDS[kind].colors;
    if (colors === undefined) return [];
    const shown = new Set(selection.items.filter((node) => node.data.item.kind === kind).map((node) => colors.of(node.data.item.data)));
    return [
      {
        label: colors.label,
        swatches: colors.presets.map(({ name, value, color }) => ({ name, value, color, pressed: shown.size === 1 && shown.has(value) })),
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
    { label: 'Duplicate', icon: <CopyPlus />, shortcut: keyText('edit.duplicate'), disabled: !hasItems, onSelect: actions.duplicate },
    { label: 'Copy', icon: <Copy />, shortcut: keyText('edit.copy'), disabled: !hasItems, onSelect: actions.copy },
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
    { label: 'Add a clock', icon: <AlarmClock />, hint: 'A schedule that messages an agent, or starts one', onSelect: actions.addClock },
    { label: 'Select all', icon: <SquareDashedMousePointer />, shortcut: keyText('edit.selectAll'), onSelect: actions.selectAll },
    { label: actions.grid ? 'Stop snapping to the grid' : 'Snap to the grid', icon: <Grid3x3 />, onSelect: actions.toggleGrid },
    { label: 'Tidy loose tiles', icon: <LayoutGrid />, hint: 'In a grid where they are, in reading order', onSelect: actions.tidyLoose },
  ];
}
