import type { ComponentType } from 'react';
import type { NodeProps } from '@xyflow/react';
import {
  AGENT_NOTE_SIZE,
  CLOCK_SIZE,
  DOCUMENT_CARD_SIZE,
  PLAN_CARD_SIZE,
  STICKY_COLORS,
  STICKY_SIZE,
  type BoardItemKind,
  type ColorSlot,
  type FillSlot,
} from '@agent-board/daemon/protocol';
import { fillToken, foldColors, foldFills, shapeColors, slotName, slotPaint, slotToken, stickyPaint } from '../../board-colors';
import { foldedNow } from './use-folded-slots';
import { itemNodeType, type ItemNodeType, type ItemNodeTypeName } from './items';
import { AgentNoteNode } from './AgentNoteNode';
import { clockData } from '../clocks';
import { ClockNode } from './ClockNode';
import { DocumentNode } from './DocumentNode';
import { PlanNode } from './PlanNode';
import { ImageNode, imageData } from './ImageNode';
import { ISSUE_CARD_SIZE, IssueNode } from './IssueNode';
import { LINK_CARD_SIZE, LinkNode } from './LinkNode';
import { ShapeNode, SHAPE_SIZE } from './ShapeNode';
import { newStickyData, StickyNode, stickyData } from './StickyNode';
import { filledIn, inSlot, newShapeData, newTextData, shapeData, textData } from './text-style';
import { TextNode } from './TextNode';

/** What the board needs to know about a kind of board item. A new kind plugs in here. */
export interface ItemKind {
  /** What the user calls one, as in "Could not save the sticky note". */
  label: string;
  /** Draws an item of the kind; registered as its node type, `item:<kind>`. */
  node: ComponentType<NodeProps<ItemNodeType>>;
  /** A new item's size. */
  size: { width: number; height: number };
  /** A new item's data, for a kind the user makes empty. Other kinds are made from what is pasted. */
  newData?(): Record<string, unknown>;
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
    label: 'sticky note',
    node: StickyNode,
    size: STICKY_SIZE,
    newData: () => ({ ...newStickyData() }),
    editOnCreate: true,
    minimapColor: (data) => stickyPaint(stickyData(data).color).color,
    colors: { label: 'Note colour', presets: () => STICKY_COLORS.map((preset) => ({ ...preset, color: stickyPaint(preset.value).color })), of: (data) => stickyData(data).color, patch: (color) => ({ color }) },
  },
  text: {
    label: 'text',
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
    label: 'shape',
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
    label: 'image',
    node: ImageNode,
    size: { width: 300, height: 200 },
    editOnCreate: false,
    minimapColor: (data) => (imageData(data) === undefined ? 'var(--raised)' : 'var(--muted)'),
  },
  link: {
    label: 'link card',
    node: LinkNode,
    size: LINK_CARD_SIZE,
    editOnCreate: false,
    minimapColor: () => 'var(--raised)',
  },
  issue: {
    label: 'issue card',
    node: IssueNode,
    size: ISSUE_CARD_SIZE,
    editOnCreate: false,
    minimapColor: () => 'var(--raised)',
  },
  // Made by agents only (`note add`), never from the toolbar.
  'agent-note': {
    label: 'agent note',
    node: AgentNoteNode,
    size: AGENT_NOTE_SIZE,
    editOnCreate: false,
    minimapColor: () => 'var(--agent-note-bar)',
  },
  // Made by agents only (`show_doc` on the board), never from the toolbar.
  document: {
    label: 'document',
    node: DocumentNode,
    size: DOCUMENT_CARD_SIZE,
    editOnCreate: false,
    minimapColor: () => 'var(--raised)',
  },
  // Made by agents only (a plan shown on the board), never from the toolbar.
  plan: {
    label: 'plan card',
    node: PlanNode,
    size: PLAN_CARD_SIZE,
    editOnCreate: false,
    minimapColor: () => 'var(--raised)',
  },
  // Made from the board's menu, or a tile's Schedule…, then set in its editor.
  clock: {
    label: 'clock',
    node: ClockNode,
    size: CLOCK_SIZE,
    newData: () => ({ ...clockData({}) }),
    editOnCreate: false,
    minimapColor: () => 'var(--accent)',
  },
};

/** Each kind's node component, keyed by its node type, for React Flow's `nodeTypes`. */
export const ITEM_NODE_TYPES = Object.fromEntries(
  Object.entries(ITEM_KINDS).map(([kind, { node }]) => [itemNodeType(kind as BoardItemKind), node]),
) as Record<ItemNodeTypeName, ItemKind['node']>;
