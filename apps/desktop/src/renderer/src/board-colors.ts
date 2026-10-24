import {
  SLOT_COLORS,
  STICKY_COLORS,
  colorSlotOf,
  type ColorSlot,
  type FillSlot,
  type ShapeData,
} from '@agent-board/daemon/protocol';
import { readable } from '../../shared/colour';

/*
 * A text item, shape or connector is drawn in the theme's colour slots: each of its colours names one, and the board
 * draws it through that slot's token, so switching theme recolours it. A colour with no slot is fixed, drawn as
 * stored. A sticky note's colour is its data, a light-theme hex from the protocol's presets that no theme may rewrite:
 * the board draws each preset through a theme token named for it instead, so the dark theme can dim a note's paper.
 */

type Named<T extends readonly { name: string }[]> = T[number]['name'];

/** A note's paper and the ink written on it, for each sticky colour. */
const STICKY_TOKENS: Record<Named<typeof STICKY_COLORS>, { paper: string; ink: string }> = {
  Yellow: { paper: '--sticky-yellow', ink: '--sticky-yellow-ink' },
  Orange: { paper: '--sticky-orange', ink: '--sticky-orange-ink' },
  Pink: { paper: '--sticky-pink', ink: '--sticky-pink-ink' },
  Violet: { paper: '--sticky-violet', ink: '--sticky-violet-ink' },
  Blue: { paper: '--sticky-blue', ink: '--sticky-blue-ink' },
  Green: { paper: '--sticky-green', ink: '--sticky-green-ink' },
  Grey: { paper: '--sticky-grey', ink: '--sticky-grey-ink' },
  White: { paper: '--sticky-white', ink: '--sticky-white-ink' },
};

/** Text, a connector's line and a shape's outline and text, in a slot: drawn on the desk, or on a shape's fill. */
const PAINT_TOKENS: Record<ColorSlot, string> = {
  accent: '--paint-accent',
  ink: '--paint-ink',
  grey: '--paint-grey',
  red: '--paint-red',
  orange: '--paint-orange',
  yellow: '--paint-yellow',
  green: '--paint-green',
  teal: '--paint-teal',
  cyan: '--paint-cyan',
  blue: '--paint-blue',
  violet: '--paint-violet',
  pink: '--paint-pink',
};

/** A shape's text on its fill, in a slot: the slot's paint, nudged to read on every fill. */
const SHAPE_INK_TOKENS: Record<ColorSlot, string> = {
  accent: '--shape-ink-accent',
  ink: '--shape-ink-ink',
  grey: '--shape-ink-grey',
  red: '--shape-ink-red',
  orange: '--shape-ink-orange',
  yellow: '--shape-ink-yellow',
  green: '--shape-ink-green',
  teal: '--shape-ink-teal',
  cyan: '--shape-ink-cyan',
  blue: '--shape-ink-blue',
  violet: '--shape-ink-violet',
  pink: '--shape-ink-pink',
};

/** A shape's fill in a slot: the slot tinted into the tile, or the tile itself. */
const FILL_TOKENS: Record<FillSlot, string> = {
  tile: '--raised',
  accent: '--shape-fill-accent',
  yellow: '--shape-fill-yellow',
  green: '--shape-fill-green',
  teal: '--shape-fill-teal',
  cyan: '--shape-fill-cyan',
  blue: '--shape-fill-blue',
  violet: '--shape-fill-violet',
  pink: '--shape-fill-pink',
  red: '--shape-fill-red',
  orange: '--shape-fill-orange',
};

const stickies = new Map<string, { paper: string; ink: string }>(STICKY_COLORS.map(({ name, value }) => [value, STICKY_TOKENS[name]]));

const paint = (token: string) => `var(${token})`;

/** How a note stored as `color` is drawn: its paper and ink in the theme, or the colour as it is if it is no preset. */
export function stickyPaint(color: string): { color: string; ink: string } {
  const tokens = stickies.get(color.toLowerCase());
  return tokens === undefined ? { color, ink: paint('--sticky-other-ink') } : { color: paint(tokens.paper), ink: paint(tokens.ink) };
}

/** A slot's name as the board shows it: `Blue`. */
export const slotName = (slot: ColorSlot | FillSlot): string => `${slot[0]!.toUpperCase()}${slot.slice(1)}`;

/** How `slot` is drawn in the theme, as text, a line or an outline. */
export const slotToken = (slot: ColorSlot): string => paint(PAINT_TOKENS[slot]);

/** How `slot` is drawn in the theme as a shape's fill. */
export const fillToken = (slot: FillSlot): string => paint(FILL_TOKENS[slot]);

/** How a colour in `slot` is drawn in the theme, or `color` as it is for none. */
export const slotPaint = (slot: ColorSlot | null, color: string): string => (slot === null ? color : slotToken(slot));

/** How a fill in `slot` is drawn in the theme, `fill` as it is for none, or `none` for no fill. */
export const fillPaint = (slot: FillSlot | null, fill: string | null): string => (fill === null ? 'none' : slot === null ? fill : fillToken(slot));

/** How a connector's stored colour is drawn: its slot's, read from the colour, or the colour as it is. */
export const connectorPaint = (color: string): string => slotPaint(colorSlotOf(color), color);

/**
 * A shape's fill, outline and text colours in the theme. Text in a slot on a slot's fill is the slot's text on fills,
 * which reads on every one; text on a fixed fill is that fill's in every theme: its light colour, nudged until it reads
 * on the fill. Fixed text on a slot's fill is as the user picked it.
 */
export function shapeColors(style: ShapeData, textOnFill: boolean): { fill: string; stroke: string; text: string } {
  const filled = textOnFill && style.fill !== null;
  const text =
    filled && style.fillSlot === null
      ? onFixedFill(style.textColorSlot === null ? style.textColor : SLOT_COLORS[style.textColorSlot], style.fill!)
      : filled && style.textColorSlot !== null
        ? paint(SHAPE_INK_TOKENS[style.textColorSlot])
        : slotPaint(style.textColorSlot, style.textColor);
  return { fill: fillPaint(style.fillSlot, style.fill), stroke: slotPaint(style.strokeSlot, style.stroke), text };
}

function onFixedFill(text: string, fill: string): string {
  try {
    return readable(text, [fill]);
  } catch {
    return text; // a fill nothing reads on, as the user picked it
  }
}

/** Each sticky and paint token, with the stored value it stands for: what the light theme draws it in. */
export function boardPaint(): Map<string, string> {
  return new Map([
    ...STICKY_COLORS.map(({ name, value }): [string, string] => [STICKY_TOKENS[name].paper, value]),
    ...Object.entries(SLOT_COLORS).map(([slot, value]): [string, string] => [PAINT_TOKENS[slot as ColorSlot], value]),
  ]);
}
