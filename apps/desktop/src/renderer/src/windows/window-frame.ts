// The size and place of the session window shown on the board: one global "last frame", kept in the view
// state, resized from any edge or corner and maximised or restored. Pure, so the geometry is unit-tested.

/** The window's place and size in the board's pixels, from the board's top-left. */
export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The frame as kept: the one to restore to, and whether the window fills the board now. The frame is in fractions of
 * the board area (0 to 1), so it scales when the screen or the app window changes size.
 */
export interface SavedFrame {
  frame: Frame;
  maximised: boolean;
}

/** An edge or a corner of the window, by compass point. */
export type Edge = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const EDGES: readonly Edge[] = ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'];

/** The least size the window can be resized to. */
export const MIN_WIDTH = 520;
export const MIN_HEIGHT = 320;

/**
 * The board's size, which the window stays inside, less `top` px kept clear along its top edge: on macOS, windowed, the
 * traffic lights float over the board's top-left, so a window never reaches under them.
 */
export interface Bounds {
  width: number;
  height: number;
  top?: number;
}

/** The default restored size as fractions of the board: most of it, centred. */
const DEFAULT_FRACTIONS: Frame = { x: 0.15, y: 0.125, width: 0.7, height: 0.75 };

/** What it opens as when restored with no frame kept: most of the board, centred. */
export function defaultFrame(bounds: Bounds): Frame {
  const width = Math.round(bounds.width * 0.7);
  const height = Math.round(bounds.height * 0.75);
  return { x: Math.round((bounds.width - width) / 2), y: Math.round((bounds.height - height) / 2), width, height };
}

/** A frame in pixels as fractions of the board area. */
export function toFractions(frame: Frame, bounds: Bounds): Frame {
  return { x: frame.x / bounds.width, y: frame.y / bounds.height, width: frame.width / bounds.width, height: frame.height / bounds.height };
}

/** A frame kept as fractions of the board area, in pixels of this board. */
export function fromFractions(frame: Frame, bounds: Bounds): Frame {
  return { x: frame.x * bounds.width, y: frame.y * bounds.height, width: frame.width * bounds.width, height: frame.height * bounds.height };
}

/**
 * The frame as saved (read back untyped), or undefined if it can't be read. A frame saved in pixels by an earlier build (any
 * value over 1) is dropped, falling back to the default size; a saved "maximised" survives it.
 */
export function frameFrom(saved: unknown): SavedFrame | undefined {
  if (typeof saved !== 'object' || saved === null) return undefined;
  const { x, y, width, height, maximised } = saved as Record<string, unknown>;
  const numbers = [x, y, width, height];
  if (!numbers.every((value) => typeof value === 'number' && Number.isFinite(value)) || typeof maximised !== 'boolean') return undefined;
  const [fx, fy, fw, fh] = numbers as number[];
  const fractions = [fx, fy, fw, fh].every((value) => value! >= 0 && value! <= 1) && fw! > 0 && fh! > 0;
  if (fractions) return { frame: { x: fx, y: fy, width: fw, height: fh } as Frame, maximised };
  return maximised ? { frame: DEFAULT_FRACTIONS, maximised } : undefined;
}

/** The frame kept inside the board and at least the least size (or the board's, if that is smaller). */
export function clampFrame(frame: Frame, bounds: Bounds): Frame {
  const width = Math.min(Math.max(frame.width, Math.min(MIN_WIDTH, bounds.width)), bounds.width);
  const top = bounds.top ?? 0;
  const room = bounds.height - top;
  const height = Math.min(Math.max(frame.height, Math.min(MIN_HEIGHT, room)), room);
  return {
    width,
    height,
    x: Math.min(Math.max(frame.x, 0), bounds.width - width),
    y: Math.min(Math.max(frame.y, top), bounds.height - height),
  };
}

/** The frame with an edge or corner dragged by `dx`, `dy`: the opposite edges stay put, within the least size and the board. */
export function resizeFrame(frame: Frame, edge: Edge, dx: number, dy: number, bounds: Bounds): Frame {
  let { x, y, width, height } = frame;
  const right = x + width;
  const bottom = y + height;
  if (edge.includes('e')) width = Math.min(Math.max(width + dx, MIN_WIDTH), bounds.width - x);
  if (edge.includes('s')) height = Math.min(Math.max(height + dy, MIN_HEIGHT), bounds.height - y);
  if (edge.includes('w')) {
    x = Math.min(Math.max(x + dx, 0), right - MIN_WIDTH);
    width = right - x;
  }
  if (edge.includes('n')) {
    y = Math.min(Math.max(y + dy, bounds.top ?? 0), bottom - MIN_HEIGHT);
    height = bottom - y;
  }
  return { x, y, width, height };
}
