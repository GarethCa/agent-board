import {
  SHAPE_FILLS,
  SHAPE_STROKES,
  SHAPE_STROKE_WIDTHS,
  SHAPE_TYPES,
  TEXT_ALIGNS,
  TEXT_COLORS,
  TEXT_SIZES,
  type ShapeData,
  type ShapeType,
  type TextData,
  type TextSize,
} from '@agent-board/daemon/protocol';
import { token, tokenNumber } from '../../theme';
import type { MeasureLine, TextBox } from './text-layout';

const pick = <T extends string>(options: readonly T[], value: unknown, fallback: T): T =>
  options.includes(value as T) ? (value as T) : fallback;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const flag = (value: unknown, fallback = false) => (typeof value === 'boolean' ? value : fallback);
const color = (value: unknown, fallback: string) => (typeof value === 'string' ? value : fallback);

/** A text item's data, with defaults for anything missing or of the wrong type. */
export function textData(data: Record<string, unknown>): TextData {
  return {
    text: text(data.text),
    size: pick(TEXT_SIZES, data.size, 'body'),
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

const SIZE_TOKENS = {
  h1: '--text-item-h1-size',
  h2: '--text-item-h2-size',
  body: '--text-item-body-size',
} as const satisfies Record<TextSize, `--${string}`>;

let canvas: CanvasRenderingContext2D | null | undefined;

/** The size a text item's `size` is set in, px. */
const textSizePx = (size: TextSize): number => tokenNumber(SIZE_TOKENS[size]);

/** How a text item is laid out and measured: its box, and a measure of one line in its font. */
export function textMetrics(data: TextData): {
  box: TextBox;
  measure: MeasureLine;
} {
  const fontSize = textSizePx(data.size);
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
