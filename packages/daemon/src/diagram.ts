// The geometry of a diagram's shapes and connectors that the board and the daemon's drawing commands share: how big a
// shape starts for its text, and which sides a connector between two shapes leaves and arrives at.
import type { Rect, Size } from './board-layout.ts';
import { SECTIONED_SHAPES, SHAPE_SECTIONS, type ConnectorSide, type ShapeType } from './protocol.ts';

/** The widest a drawn shape starts, before its text wraps. */
const MAX_SHAPE_WIDTH = 480;
/** How wide a character is, in px, in a shape's name (heading 2, bold) and in its sections (mono), about. */
const NAME_CHAR = 14;
const SECTION_CHAR = 9;
/** A line's height in a shape's name and in its sections, px, and the room round a shape's text. */
const NAME_LINE = 32;
const SECTION_LINE = 22;
const SHAPE_PAD = 32;

/**
 * The size a drawn shape starts at: as wide as its longest line, up to a limit, and as tall as its name and sections.
 * About: the board grows a shape taller to fit its text as it draws it.
 */
export function shapeSize(data: { shape: ShapeType; text: string; attributes?: string; methods?: string }): Size {
  const lines = (text: string) => (text === '' ? [] : text.split('\n'));
  const name = lines(data.text);
  const sections = SECTIONED_SHAPES.includes(data.shape) ? SHAPE_SECTIONS.map((section) => lines(data[section] ?? '')) : [];
  const longest = Math.max(0, ...name.map((line) => line.length * NAME_CHAR), ...sections.flat().map((line) => line.length * SECTION_CHAR));
  const width = Math.min(MAX_SHAPE_WIDTH, Math.max(sections.length > 0 ? 200 : 160, longest + SHAPE_PAD));
  const sectionHeight = sections.reduce((sum, each) => sum + Math.max(1, each.length) * SECTION_LINE + SHAPE_PAD / 2, 0);
  return { width, height: Math.max(80, Math.max(1, name.length) * NAME_LINE + SHAPE_PAD + sectionHeight) };
}

/**
 * The sides a connector from `from` to `to` (board rects) leaves and arrives at: facing each other across the axis
 * they are furthest apart on, so a parent above its children is joined bottom to top.
 */
export function facingSides(from: Rect, to: Rect): { from: ConnectorSide; to: ConnectorSide } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
  return dy > 0 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' };
}
