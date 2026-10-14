import type { ReactNode } from 'react';
import type { BoardItemKind } from '@agent-board/daemon/protocol';
import {
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
  LayoutGrid,
  Pencil,
  SquareDashedMousePointer,
  Trash2,
} from 'lucide-react';
import { withCommand } from '../../keys';
import type { MenuEntry } from '../../ui';
import { ITEM_KINDS } from '../items/kinds';
import type { Alignment, Reorder } from './arrange';
import type { SelectionSummary } from './use-editing';
import { themedColor } from '../../board-colors';

/** What the context menu's rows do. */
export interface ContextActions {
  /** Renames the one agent or shell tile selected. */
  rename(): void;
  duplicate(): void;
  copy(): void;
  restack(how: Reorder): void;
  align(how: Alignment): void;
  distribute(axis: 'x' | 'y'): void;
  setColor(patch: (value: string) => Record<string, unknown>, kind: BoardItemKind, value: string): void;
  deleteSelection(): void;
  selectAll(): void;
  /** Whether a drag snaps to the grid, and turns that on or off. */
  grid: boolean;
  toggleGrid(): void;
  /** Lays the tiles loose on the board out in a grid where they are. */
  tidyLoose(): void;
}

/**
 * The context menu on a selection (WbTools): duplicate and copy, z-order, align, each selected kind's colour, and
 * delete, which leaves sessions alone and says so.
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
        swatches: colors.presets.map(({ name, value }) => ({ name, value, color: themedColor(value), pressed: shown.size === 1 && shown.has(value) })),
        onPick: (value) => actions.setColor(colors.patch, kind, value),
      },
    ];
  });
  return [
    ...(selection.renamable ? [{ label: 'Rename', icon: <Pencil />, shortcut: 'F2', onSelect: actions.rename }, 'separator' as const] : []),
    { label: 'Duplicate', icon: <CopyPlus />, shortcut: withCommand('D'), disabled: !hasItems, onSelect: actions.duplicate },
    { label: 'Copy', icon: <Copy />, shortcut: withCommand('C'), disabled: !hasItems, onSelect: actions.copy },
    'separator',
    { label: 'Bring to front', icon: <ArrowUpToLine />, shortcut: ']', onSelect: () => actions.restack('front') },
    { label: 'Bring forward', icon: <ArrowUp />, shortcut: withCommand(']'), onSelect: () => actions.restack('forward') },
    { label: 'Send backward', icon: <ArrowDown />, shortcut: withCommand('['), onSelect: () => actions.restack('backward') },
    { label: 'Send to back', icon: <ArrowDownToLine />, shortcut: '[', onSelect: () => actions.restack('back') },
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
    ...(colours.length > 0 ? ['separator' as const, ...colours] : []),
    'separator',
    {
      label: 'Delete',
      icon: <Trash2 />,
      shortcut: '⌫',
      danger: true,
      disabled: !hasItems && selectedConnectors === 0,
      hint: selection.hasSessions ? 'Deletes the notes and items only. Sessions stay running.' : undefined,
      onSelect: actions.deleteSelection,
    },
  ];
}

/** The context menu on empty board: select everything, and snap to the grid. */
export function boardEntries(actions: ContextActions): MenuEntry[] {
  return [
    { label: 'Select all', icon: <SquareDashedMousePointer />, shortcut: withCommand('A'), onSelect: actions.selectAll },
    { label: actions.grid ? 'Stop snapping to the grid' : 'Snap to the grid', icon: <Grid3x3 />, onSelect: actions.toggleGrid },
    { label: 'Tidy loose tiles', icon: <LayoutGrid />, hint: 'In a grid where they are, in reading order', onSelect: actions.tidyLoose },
  ];
}
