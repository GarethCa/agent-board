import {
  FILL_SLOT_COLORS,
  SLOT_COLORS,
  SHAPE_STROKE_WIDTHS,
  SHAPE_TYPES,
  TEXT_ALIGNS,
  TEXT_FONT_SIZES,
  TEXT_SIZES,
  LEGACY_TEXT_FONT_SIZES,
  MAX_TEXT_FONT_SIZE,
  MIN_TEXT_FONT_SIZE,
  colorSlotOf,
  fillSlotOf,
  type ColorSlot,
  type FillSlot,
  newShapeData as newProtocolShapeData,
  type ShapeData,
  type ShapeType,
  type TextData,
} from '@agent-board/daemon/protocol';
import { token, tokenNumber } from '../../theme';
import type { MeasureLine, TextBox } from './text-layout';
import { SHAPES } from './shapes/catalogue';

const pick = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const flag = (value: unknown, fallback = false) => (typeof value === 'boolean' ? value : fallback);
const color = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);
/**
 * The slot of a colour stored as `hex`: the one its data names, none (null) for a fixed colour, or `hex`'s own. A
 * slot whose colour is no longer `hex` is stale, the colour since set by something that sets only the colour (an app
 * or a daemon from before slots), so `hex`'s own is read then too.
 */
const slot = <Slot extends string>(colors: Record<Slot, string>, value: unknown, hex: string, of: (hex: string) => Slot | null): Slot | null =>
  value === null ? null : typeof value === 'string' && Object.hasOwn(colors, value) && colors[value as Slot] === hex.toLowerCase() ? (value as Slot) : of(hex);

/** A font size kept within what a text item may have. */
export const clampFontSize = (px: number): number =>
  Math.min(MAX_TEXT_FONT_SIZE, Math.max(MIN_TEXT_FONT_SIZE, Math.round(px)));

/** The font size a step up (`1`) or down (`-1`) from `px` lands on: the next preset that way, else the limit. */
export function stepFontSize(px: number, direction: 1 | -1): number {
  const next =
    direction === 1
      ? TEXT_FONT_SIZES.find((preset) => preset > px)
      : [...TEXT_FONT_SIZES].reverse().find((preset) => preset < px);
  return clampFontSize(next ?? (direction === 1 ? MAX_TEXT_FONT_SIZE : MIN_TEXT_FONT_SIZE));
}

/** A text item's data, with defaults for anything missing or of the wrong type. */
export function textData(data: Record<string, unknown>): TextData {
  const size = pick(TEXT_SIZES, data.size, 'body');
  const textColor = color(data.color, SLOT_COLORS.ink);
  return {
    text: text(data.text),
    size,
    fontSize:
      typeof data.fontSize === 'number' && Number.isFinite(data.fontSize)
        ? clampFontSize(data.fontSize)
        : LEGACY_TEXT_FONT_SIZES[size],
    minHeight: typeof data.minHeight === 'number' && data.minHeight > 0 ? data.minHeight : 0,
    bold: flag(data.bold),
    italic: flag(data.italic),
    align: pick(TEXT_ALIGNS, data.align, 'left'),
    color: textColor,
    colorSlot: slot(SLOT_COLORS, data.colorSlot, textColor, colorSlotOf),
    wrap: flag(data.wrap),
  };
}

/** The data that colours an item in `slot`: its stored colour (`key`) and its slot. */
export const inSlot = <Key extends string>(key: Key, slot: ColorSlot): Record<Key, string> & Record<`${Key}Slot`, ColorSlot> =>
  ({ [key]: SLOT_COLORS[slot], [`${key}Slot`]: slot }) as Record<Key, string> & Record<`${Key}Slot`, ColorSlot>;

/** The data that fills a shape in `slot`, or with none. */
export const filledIn = (slot: FillSlot | null): Pick<ShapeData, 'fill' | 'fillSlot'> =>
  slot === null ? { fill: null, fillSlot: null } : { fill: FILL_SLOT_COLORS[slot], fillSlot: slot };

/** The data that colours an item a fixed `hex`, in no slot: it stays as it is in every theme. */
export const fixedColor = <Key extends string>(key: Key, hex: string): Record<Key, string> & Record<`${Key}Slot`, null> =>
  ({ [key]: hex.toLowerCase(), [`${key}Slot`]: null }) as Record<Key, string> & Record<`${Key}Slot`, null>;

/** A new text item's data. */
export const newTextData = (): TextData => textData({});

/** A shape's data, with defaults for anything missing or of the wrong type. */
export function shapeData(data: Record<string, unknown>): ShapeData {
  const shape = pick(SHAPE_TYPES, data.shape, 'rectangle');
  // A new shape is Accent on the tile.
  const fill = data.fill === null ? null : color(data.fill, FILL_SLOT_COLORS.tile);
  const stroke = color(data.stroke, SLOT_COLORS.accent);
  const textColor = color(data.textColor, SLOT_COLORS.ink);
  return {
    shape,
    fill,
    fillSlot: fill === null ? null : slot(FILL_SLOT_COLORS, data.fillSlot, fill, fillSlotOf),
    stroke,
    strokeSlot: slot(SLOT_COLORS, data.strokeSlot, stroke, colorSlotOf),
    strokeWidth: typeof data.strokeWidth === 'number' ? data.strokeWidth : SHAPE_STROKE_WIDTHS[1],
    dashed: flag(data.dashed),
    text: text(data.text),
    textSize: pick(TEXT_SIZES, data.textSize, 'h2'),
    fontSize: typeof data.fontSize === 'number' && Number.isFinite(data.fontSize) ? clampFontSize(data.fontSize) : null,
    bold: flag(data.bold, true),
    align: pick(TEXT_ALIGNS, data.align, 'center'),
    // A class's attributes and methods are code: in mono unless the user says not.
    mono: flag(data.mono, SHAPES[shape].sections !== undefined),
    attributes: text(data.attributes),
    methods: text(data.methods),
    textColor,
    textColorSlot: slot(SLOT_COLORS, data.textColorSlot, textColor, colorSlotOf),
  };
}

/**
 * A shape's saved `data` with every key it lacks as it is read (one saved before alignment or sections existed has
 * none), its own kept as they are. An update only merges keys in, so putting a shape back as it was (undo, redo) sends
 * this: what was set since on a key it lacked goes too.
 */
export const completeShapeData = (data: Record<string, unknown>): Record<string, unknown> => ({ ...shapeData(data), ...data });

/** A new shape's data: the protocol's, which the daemon draws an agent's shapes with too. */
export const newShapeData = (shape: ShapeType = 'rectangle'): ShapeData => newProtocolShapeData(shape);

let canvas: CanvasRenderingContext2D | null | undefined;

/** How a text item is laid out and measured: its box, and a measure of one line in its font. */
export function textMetrics(data: TextData): {
  box: TextBox;
  measure: MeasureLine;
} {
  const fontSize = data.fontSize;
  const family = token('--font-sans');
  const weight = data.bold ? tokenNumber('--weight-bold') : tokenNumber('--weight-regular');
  const font = `${data.italic ? 'italic ' : ''}${weight} ${fontSize}px ${family}`;
  return {
    box: {
      padding: tokenNumber('--text-item-padding'),
      lineHeight: fontSize * Number(token('--text-item-leading')),
      minWidth: tokenNumber('--text-item-min-width'),
      // A caret's width and a pixel of rounding.
      slack: 3,
    },
    measure: (line) => {
      canvas ??= document.createElement('canvas').getContext('2d');
      if (canvas === null) return line.length * fontSize * 0.55;
      canvas.font = font;
      return canvas.measureText(line).width;
    },
  };
}
