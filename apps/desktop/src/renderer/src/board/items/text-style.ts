import {
  SHAPE_FILLS,
  SHAPE_STROKES,
  SHAPE_STROKE_WIDTHS,
  SHAPE_TYPES,
  TEXT_ALIGNS,
  TEXT_COLORS,
  TEXT_FONT_SIZES,
  TEXT_SIZES,
  LEGACY_TEXT_FONT_SIZES,
  MAX_TEXT_FONT_SIZE,
  MIN_TEXT_FONT_SIZE,
  type ShapeData,
  type ShapeType,
  type TextData,
} from '@agent-board/daemon/protocol';
import { token, tokenNumber } from '../../theme';
import type { MeasureLine, TextBox } from './text-layout';

const pick = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const flag = (value: unknown, fallback = false) => (typeof value === 'boolean' ? value : fallback);
const color = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);

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
    color: color(data.color, TEXT_COLORS[0].value),
    wrap: flag(data.wrap),
  };
}

/** A new text item's data. */
export const newTextData = (): TextData => textData({});

/** A shape's data, with defaults for anything missing or of the wrong type. */
export function shapeData(data: Record<string, unknown>): ShapeData {
  return {
    shape: pick(SHAPE_TYPES, data.shape, 'rectangle'),
    fill: data.fill === null ? null : color(data.fill, SHAPE_FILLS[0].value),
    stroke: color(data.stroke, SHAPE_STROKES[0].value),
    strokeWidth: typeof data.strokeWidth === 'number' ? data.strokeWidth : SHAPE_STROKE_WIDTHS[1],
    dashed: flag(data.dashed),
    text: text(data.text),
    textSize: pick(TEXT_SIZES, data.textSize, 'h2'),
    bold: flag(data.bold, true),
    textColor: color(data.textColor, TEXT_COLORS[0].value),
  };
}

/** A new shape's data. */
export const newShapeData = (shape: ShapeType = 'rectangle'): ShapeData => shapeData({ shape });

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
