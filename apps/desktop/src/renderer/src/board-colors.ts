import { SHAPE_FILLS, SHAPE_STROKES, STICKY_COLORS, TEXT_COLORS } from '@agent-board/daemon/protocol';

/*
 * The colours a sticky note, text item, shape or connector stores are its data: light-theme hex values from the
 * protocol's presets, which no theme may rewrite. The board draws each preset through a theme token named for it
 * instead ("map sticky notes by colour name, not by stored hex"), so the dark theme can dim a note's paper and
 * lift Ink off the dark desk. The light theme's tokens are the stored values themselves (tokens.test.ts checks).
 */

type Named<T extends readonly { name: string }[]> = T[number]['name'];
type PaintName = Named<typeof TEXT_COLORS> | Named<typeof SHAPE_STROKES>;

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

/** Text, a connector's line and a shape's outline: drawn on the desk. */
const PAINT_TOKENS: Record<PaintName, string> = {
  Ink: '--paint-ink',
  Grey: '--paint-grey',
  Red: '--paint-red',
  Orange: '--paint-orange',
  Green: '--paint-green',
  Blue: '--paint-blue',
  Violet: '--paint-violet',
};

/** Text in a filled shape: drawn on its paper, which every theme keeps light. */
const SHAPE_INK_TOKENS: Record<PaintName, string> = {
  Ink: '--shape-ink-ink',
  Grey: '--shape-ink-grey',
  Red: '--shape-ink-red',
  Orange: '--shape-ink-orange',
  Green: '--shape-ink-green',
  Blue: '--shape-ink-blue',
  Violet: '--shape-ink-violet',
};

/** A shape's fill: paper, like a note's. White is a note's white. */
const SHAPE_FILL_TOKENS: Record<Named<typeof SHAPE_FILLS>, string> = {
  Yellow: '--shape-fill-yellow',
  Green: '--shape-fill-green',
  Blue: '--shape-fill-blue',
  Pink: '--shape-fill-pink',
  White: STICKY_TOKENS.White.paper,
};

/** Each stored preset's token. A value two palettes share (Ink, White) is one colour, so has one token. */
const tokens = new Map<string, string>([
  ...STICKY_COLORS.map(({ name, value }): [string, string] => [value, STICKY_TOKENS[name].paper]),
  ...SHAPE_FILLS.map(({ name, value }): [string, string] => [value, SHAPE_FILL_TOKENS[name]]),
  ...[...TEXT_COLORS, ...SHAPE_STROKES].map(({ name, value }): [string, string] => [value, PAINT_TOKENS[name]]),
]);
const stickies = new Map<string, { paper: string; ink: string }>(STICKY_COLORS.map(({ name, value }) => [value, STICKY_TOKENS[name]]));
const shapeInks = new Map<string, string>([...TEXT_COLORS, ...SHAPE_STROKES].map(({ name, value }) => [value, SHAPE_INK_TOKENS[name]]));

const paint = (token: string) => `var(${token})`;

/** How a note stored as `color` is drawn: its paper and ink in the theme, or the colour as it is if it is no preset. */
export function stickyPaint(color: string): { color: string; ink: string } {
  const tokens = stickies.get(color.toLowerCase());
  return tokens === undefined ? { color, ink: paint('--sticky-other-ink') } : { color: paint(tokens.paper), ink: paint(tokens.ink) };
}

/** How a stored colour (a text item's, a shape's fill or outline, a connector's) is drawn on the desk in the theme. */
export function themedColor(color: string): string {
  const token = tokens.get(color.toLowerCase());
  return token === undefined ? color : paint(token);
}

/** How a filled shape's stored text colour is drawn on its fill in the theme. */
export function shapeInk(color: string): string {
  const token = shapeInks.get(color.toLowerCase());
  return token === undefined ? color : paint(token);
}

/** Each colour token, with the stored value it stands for: what the light theme draws it in. */
export function boardPaint(): Map<string, string> {
  return new Map([...tokens, ...shapeInks].map(([value, token]) => [token, value]));
}
