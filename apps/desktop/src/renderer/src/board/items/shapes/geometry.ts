// How a shape is drawn: its parts, in the box it is drawn in. Pure, so the board and the picker draw the same thing.

/** A box: its top-left and size. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How a part is inked (row CK): `shape` takes the fill and the stroke, `line` the stroke alone, and `solid` is filled
 * with the stroke's colour, as a UML start state is.
 */
export type Ink = 'shape' | 'line' | 'solid';

interface PartStyle {
  ink: Ink;
  /** Dashed whatever the shape's own stroke, as a group's outline or a lifeline is. */
  dashed?: boolean;
  /** Drawn fainter, for detail. */
  opacity?: number;
  /** Drawn only on the picker's button, as a class's sample attribute lines are: on the board, the text is real. */
  iconOnly?: boolean;
}

/** One SVG element of a shape. A `rect` with `round` takes the board's shape radius token. */
export type ShapePart = PartStyle &
  (
    | { el: 'rect'; x: number; y: number; width: number; height: number; rx?: number; round?: boolean }
    | { el: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
    | { el: 'path'; d: string }
  );

/** A part as the mock draws it, in its 80 × 56 cell: circles and polygons too. */
export type MockPart = PartStyle &
  (
    | { el: 'rect'; x: number; y: number; width: number; height: number; rx?: number }
    | { el: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
    | { el: 'circle'; cx: number; cy: number; r: number }
    | { el: 'polygon'; points: string }
    | { el: 'path'; d: string }
  );

/**
 * How mock parts fill a box: `stretch` maps their `frame` (the mock's outline, [left, top, right, bottom]) onto the
 * box, each axis on its own; `contain` keeps their proportions, centred, as a figure does. Circles stay round either
 * way, and corner radii scale with the shorter axis.
 */
export type Fit = 'stretch' | 'contain';

const round = (value: number) => Math.round(value * 100) / 100;

/** `parts` drawn in the mock's `frame`, mapped onto `box` as `fit` says. */
export function fitParts(parts: readonly MockPart[], frame: readonly [number, number, number, number], fit: Fit, box: Box): ShapePart[] {
  const [left, top, right, bottom] = frame;
  let sx = box.width / (right - left);
  let sy = box.height / (bottom - top);
  let ox = box.x;
  let oy = box.y;
  if (fit === 'contain') {
    const scale = Math.min(sx, sy);
    ox += (box.width - (right - left) * scale) / 2;
    oy += (box.height - (bottom - top) * scale) / 2;
    sx = scale;
    sy = scale;
  }
  const min = Math.min(sx, sy);
  const x = (value: number) => round(ox + (value - left) * sx);
  const y = (value: number) => round(oy + (value - top) * sy);
  return parts.map((part): ShapePart => {
    const { ink, dashed, opacity, iconOnly } = part;
    const style: PartStyle = { ink, ...(dashed && { dashed }), ...(opacity !== undefined && { opacity }), ...(iconOnly && { iconOnly }) };
    switch (part.el) {
      case 'rect':
        return {
          ...style,
          el: 'rect',
          x: x(part.x),
          y: y(part.y),
          width: round(part.width * sx),
          height: round(part.height * sy),
          ...(part.rx !== undefined && { rx: round(part.rx * min) }),
        };
      case 'ellipse':
        return { ...style, el: 'ellipse', cx: x(part.cx), cy: y(part.cy), rx: round(part.rx * sx), ry: round(part.ry * sy) };
      case 'circle':
        return { ...style, el: 'ellipse', cx: x(part.cx), cy: y(part.cy), rx: round(part.r * min), ry: round(part.r * min) };
      case 'polygon':
        return { ...style, el: 'path', d: mapPath(`M${part.points.trim().split(/\s+/).join('L')}Z`, x, y, sx, sy) };
      case 'path':
        return { ...style, el: 'path', d: mapPath(part.d, x, y, sx, sy) };
    }
  });
}

/** How many numbers each absolute path command takes. */
const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

/** An absolute SVG path (as the mock writes them) with its points mapped by `x` and `y`, and an arc's radii by the scales. */
export function mapPath(d: string, x: (value: number) => number, y: (value: number) => number, sx: number, sy: number): string {
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  let out = '';
  let command = '';
  for (let at = 0; at < tokens.length; ) {
    if (/[A-Za-z]/.test(tokens[at]!)) {
      command = tokens[at++]!;
      if (command !== command.toUpperCase()) throw new Error(`relative path command ${command} in a shape`);
      out += command;
      if (command === 'Z') continue;
    }
    const numbers = tokens.slice(at, at + ARITY[command]!).map(Number);
    at += ARITY[command]!;
    let mapped: number[];
    switch (command) {
      case 'H':
        mapped = [x(numbers[0]!)];
        break;
      case 'V':
        mapped = [y(numbers[0]!)];
        break;
      case 'A': {
        const [rx, ry, rotation, large, sweep, ex, ey] = numbers as [number, number, number, number, number, number, number];
        mapped = [round(rx * sx), round(ry * sy), rotation, large, sweep, x(ex), y(ey)];
        break;
      }
      default:
        mapped = numbers.map((value, index) => (index % 2 === 0 ? x(value) : y(value)));
    }
    out += `${mapped.join(' ')} `;
  }
  return out.trim().replace(/ ([A-Z])/g, '$1');
}

/** A path from points, closed. */
export const closed = (points: readonly (readonly [number, number])[]) =>
  `M${points.map(([px, py]) => `${round(px)} ${round(py)}`).join('L')}Z`;
