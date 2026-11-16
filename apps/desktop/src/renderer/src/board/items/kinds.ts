import type { ComponentType } from 'react';
import type { NodeProps } from '@xyflow/react';
import {
  AGENT_NOTE_SIZE,
  CLOCK_SIZE,
  CREW_CARD_SIZE,
  DONE_LINE_HEIGHT,
  DOCUMENT_CARD_SIZE,
  PLAN_CARD_SIZE,
  STEPS_CARD_SIZE,
  MEMORY_CARD_SIZE,
  QUEUE_CARD_SIZE,
  TODO_CARD_SIZE,
  STICKY_COLORS,
  STICKY_SIZE,
  type BoardItemKind,
  type ColorSlot,
  type FillSlot,
} from '@agent-board/daemon/protocol';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { EMPTY_STAGE_BOARD_SIZE } from '@agent-board/daemon/stage-board';
import { fillToken, foldColors, foldFills, shapeColors, slotName, slotPaint, slotToken, stickyPaint } from '../../board-colors';
import { foldedNow } from './use-folded-slots';
import { ITEM_KIND_LABELS, itemKindLabel } from './kind-labels';
import { isKnownItemKind, itemNodeType, UNKNOWN_ITEM_NODE_TYPE, type ItemNodeType, type ItemNodeTypeName } from './items';
import { AgentNoteNode } from './AgentNoteNode';
import { clockData } from '../clocks';
import { ClockNode } from './ClockNode';
import { CrewCardNode } from './CrewCardNode';
import { DocumentNode } from './DocumentNode';
import { DoneLineNode } from './DoneLineNode';
import { PlanNode } from './PlanNode';
import { ImageNode, imageData } from './ImageNode';
import { ISSUE_CARD_SIZE, IssueNode } from './IssueNode';
import { LINK_CARD_SIZE, LinkNode } from './LinkNode';
import { newMemoryData } from './memory-card';
import { MemoryNode } from './MemoryNode';
import { newQueueData } from './queue-card';
import { QueueNode } from './QueueNode';
import { ShapeNode, SHAPE_SIZE } from './ShapeNode';
import { newStepsData, StepsNode } from './StepsNode';
import { newStickyData, StickyNode, stickyData } from './StickyNode';
import { filledIn, inSlot, newShapeData, newTextData, shapeData, textData } from './text-style';
import { TextNode } from './TextNode';
import { newTodoData } from './todo-view';
import { TodoNode } from './TodoNode';
import { StagesNode } from './StagesNode';
import { UnknownItemNode } from './UnknownItemNode';

/** What the board needs to know about a kind of board item. A new kind plugs in here. */
export interface ItemKind {
  /** What the user calls one, as in "Could not save the sticky note". */
  label: string;
  /** Draws an item of the kind; registered as its node type, `item:<kind>`. */
  node: ComponentType<NodeProps<ItemNodeType>>;
  /** A new item's size. */
  size: { width: number; height: number };
  /**
   * A new item's data, for a kind the user makes empty, given the name of the zone it lands in. Other kinds are made
   * from what is pasted.
   */
  newData?(where: { zoneName?: string }): Record<string, unknown>;
  /** Whether a new one opens ready to type into. */
  editOnCreate: boolean;
  /** The item's colour on the minimap, from its data. */
  minimapColor(data: Record<string, unknown>): string;
  /** The colours an item of the kind can be given from the board's context menu, for a kind that has one. */
  colors?: ItemColors;
}

/** A kind's one colour: what the menu calls it, the presets, and where it is in an item's data. */
export interface ItemColors {
  /** "Note colour". */
  label: string;
  /**
   * Each colour to pick, as the menu opens: its name, its value in `of` and `patch` (a sticky's stored colour, a slot),
   * how the theme draws it, and the later values the theme draws just the same, which it stands for.
   */
  presets(): readonly { name: string; value: string; color: string; also?: readonly string[] }[];
  /** The colour an item has, from its data. */
  of(data: Record<string, unknown>): string | null;
  /** The change to an item's data that gives it `value`. */
  patch(value: string): Record<string, unknown>;
}

export const ITEM_KINDS: Record<BoardItemKind, ItemKind> = {
  sticky: {
    label: ITEM_KIND_LABELS.sticky,
    node: StickyNode,
    size: STICKY_SIZE,
    newData: () => ({ ...newStickyData() }),
    editOnCreate: true,
    minimapColor: (data) => stickyPaint(stickyData(data).color).color,
    colors: { label: 'Note colour', presets: () => STICKY_COLORS.map((preset) => ({ ...preset, color: stickyPaint(preset.value).color })), of: (data) => stickyData(data).color, patch: (color) => ({ color }) },
  },
  text: {
    label: ITEM_KIND_LABELS.text,
    node: TextNode,
    size: { width: 40, height: 36 },
    newData: () => ({ ...newTextData() }),
    editOnCreate: true,
    minimapColor: (data) => slotPaint(textData(data).colorSlot, textData(data).color),
    colors: {
      label: 'Text colour',
      presets: () => foldedNow(foldColors).map(({ slot, also }) => ({ name: slotName(slot), value: slot, color: slotToken(slot), also })),
      of: (data) => textData(data).colorSlot,
      patch: (slot) => inSlot('color', slot as ColorSlot),
    },
  },
  shape: {
    label: ITEM_KIND_LABELS.shape,
    node: ShapeNode,
    size: SHAPE_SIZE,
    newData: () => ({ ...newShapeData() }),
    editOnCreate: false,
    minimapColor: (data) => {
      const style = shapeData(data);
      const { fill, stroke } = shapeColors(style, true);
      return style.fill === null ? stroke : fill;
    },
    colors: {
      label: 'Shape fill',
      presets: () => [
        { name: slotName('tile'), value: 'tile', color: fillToken('tile') },
        ...foldedNow(foldFills).map(({ slot, also }) => ({ name: slotName(slot), value: slot, color: fillToken(slot), also })),
      ],
      of: (data) => (shapeData(data).fill === null ? null : shapeData(data).fillSlot),
      patch: (slot) => filledIn(slot as FillSlot),
    },
  },
  image: {
    label: ITEM_KIND_LABELS.image,
    node: ImageNode,
    size: { width: 300, height: 200 },
    editOnCreate: false,
    minimapColor: (data) => (imageData(data) === undefined ? 'var(--raised)' : 'var(--muted)'),
  },
  link: {
    label: ITEM_KIND_LABELS.link,
    node: LinkNode,
    size: LINK_CARD_SIZE,
    editOnCreate: false,
    minimapColor: () => 'var(--raised)',
  },
  issue: {
    label: ITEM_KIND_LABELS.issue,
    node: IssueNode,
    size: ISSUE_CARD_SIZE,
    editOnCreate: false,
    minimapColor: () => 'var(--raised)',
  },
  // Made by agents only (`note add`), never from the toolbar.
  'agent-note': {
    label: ITEM_KIND_LABELS['agent-note'],
    node: AgentNoteNode,
    size: AGENT_NOTE_SIZE,
    editOnCreate: false,
    minimapColor: () => 'var(--agent-note-bar)',
  },
  // Made by agents only (`show_doc` on the board), never from the toolbar.
  document: {
    label: ITEM_KIND_LABELS.document,
    node: DocumentNode,
    size: DOCUMENT_CARD_SIZE,
    editOnCreate: false,
    minimapColor: () => 'var(--raised)',
  },
  // Made by agents only (a plan shown on the board), never from the toolbar.
  plan: {
    label: ITEM_KIND_LABELS.plan,
    node: PlanNode,
    size: PLAN_CARD_SIZE,
    editOnCreate: false,
    minimapColor: () => 'var(--raised)',
  },
  // Made from the board's menu, or a tile's Schedule…, then set in its editor.
  clock: {
    label: ITEM_KIND_LABELS.clock,
    node: ClockNode,
    size: CLOCK_SIZE,
    newData: () => ({ ...clockData({}) }),
    editOnCreate: false,
    minimapColor: () => 'var(--accent)',
  },
  // An agent's (`steps new`), or the user's from the board's menu or K, typed in as it is made.
  steps: {
    label: ITEM_KIND_LABELS.steps,
    node: StepsNode,
    size: STEPS_CARD_SIZE,
    newData: () => ({ ...newStepsData() }),
    editOnCreate: true,
    minimapColor: () => 'var(--steps)',
  },
  // Made from the board's menu (or M), named after its zone, or by an agent's `memory new`.
  memory: {
    label: ITEM_KIND_LABELS.memory,
    node: MemoryNode,
    size: MEMORY_CARD_SIZE,
    newData: ({ zoneName }) => ({ ...newMemoryData(zoneName) }),
    editOnCreate: true,
    minimapColor: () => 'var(--raised)',
  },
  // Made from the board's menu (or Q), for agents and named after its zone, or by an agent's `queue new`.
  queue: {
    label: ITEM_KIND_LABELS.queue,
    node: QueueNode,
    size: QUEUE_CARD_SIZE,
    newData: ({ zoneName }) => ({ ...newQueueData(zoneName) }),
    editOnCreate: true,
    minimapColor: () => 'var(--raised)',
  },
  // An agent's (`remind`), under its tile, or the user's from the board's menus, its add field open as it is made.
  todo: {
    label: ITEM_KIND_LABELS.todo,
    node: TodoNode,
    size: TODO_CARD_SIZE,
    newData: () => ({ ...newTodoData() }),
    editOnCreate: true,
    minimapColor: () => 'var(--todo)',
  },
  // The daemon's, made as a crew starts: none is made from the board's menus.
  crew: {
    label: ITEM_KIND_LABELS.crew,
    node: CrewCardNode,
    size: CREW_CARD_SIZE,
    editOnCreate: false,
    minimapColor: () => 'var(--raised)',
  },
  // A zone's, from its menu, one to a zone: it draws its own size from its stages, empty to begin with.
  stages: {
    label: ITEM_KIND_LABELS.stages,
    node: StagesNode,
    size: EMPTY_STAGE_BOARD_SIZE,
    newData: () => ({ joined: [], left: [] }),
    editOnCreate: false,
    minimapColor: () => 'var(--raised)',
  },
  // A Spine zone's, made by its first Clean up that finds a ticket finished: none is made from the board's menus.
  'done-line': {
    label: ITEM_KIND_LABELS['done-line'],
    node: DoneLineNode,
    size: { width: AGENT_TILE_SIZE.width, height: DONE_LINE_HEIGHT },
    editOnCreate: false,
    minimapColor: () => 'var(--raised)',
  },
};

/**
 * What the board knows of `kind`, for every kind an item can have. A kind this app doesn't know (a newer app's, after a
 * downgrade) is a placeholder that names it: no colours, nothing to type into, never made from the board's menus.
 */
export function itemKind(kind: string): ItemKind {
  if (isKnownItemKind(kind)) return ITEM_KINDS[kind];
  return { label: itemKindLabel(kind), node: UnknownItemNode, size: LINK_CARD_SIZE, editOnCreate: false, minimapColor: () => 'var(--raised)' };
}

/** Each kind's node component, keyed by its node type, for React Flow's `nodeTypes`; and the placeholder's. */
export const ITEM_NODE_TYPES = Object.fromEntries([
  ...Object.entries(ITEM_KINDS).map(([kind, { node }]) => [itemNodeType(kind as BoardItemKind), node] as const),
  [UNKNOWN_ITEM_NODE_TYPE, UnknownItemNode],
]) as Record<ItemNodeTypeName, ItemKind['node']>;
