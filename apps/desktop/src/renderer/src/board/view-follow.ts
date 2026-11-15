import { getViewportForBounds, type Rect, type Viewport } from '@xyflow/react';

/** How much room a tile brought into view keeps round it, as a share of the view. */
export const FIT_MARGIN = 0.15;

/** The chrome in the board's lower right a tile keeps clear of. */
const CORNER_CHROME = '.island-bottom-right, .board-minimap';

/** The panels that open over a side of the board (the Captain's pane, Edge rules) a tile keeps clear of. */
const SIDE_PANELS = '.master-panel, .edge-rules';
/** Edge rules is anchored to the board's right whatever the Captain's pane does beside it, so it always covers the right. */
const RIGHT_PANEL = '.edge-rules';

/**
 * What covers the board's view, in the view's own pixels from its top left: the side panels drawn over its left and
 * right (`left` and `right`, how far in from each edge they reach) and, for each piece of chrome in its lower right (the
 * minimap, the zoom bar), the box from its top left to the view's lower right; none when none of it shows. The pieces
 * are kept apart, not boxed together: the zoom bar reaches further left than the minimap, but only below it.
 */
export interface Covered {
  left: number;
  right: number;
  corner: Rect[];
}

/** Nothing over the view. */
export const UNCOVERED: Covered = { left: 0, right: 0, corner: [] };

/**
 * What covers the board's view now. The chrome is drawn over the board, not in it: `chrome` holds the corner's; the side
 * panels are looked for in the whole window. A panel that pushes the board aside, rather than lying over it, covers none.
 */
export function coveredView(board: HTMLElement, chrome: ParentNode): Covered {
  const edge = board.getBoundingClientRect();
  return { ...sidePanels(board, edge), corner: cornerChrome(edge, chrome) };
}

function cornerChrome(edge: DOMRect, chrome: ParentNode): Rect[] {
  return [...chrome.querySelectorAll<HTMLElement>(CORNER_CHROME)]
    .map((thing) => thing.getBoundingClientRect())
    .filter((box) => box.width > 0 && box.height > 0)
    .map((box) => ({ x: box.left - edge.left, y: box.top - edge.top, width: edge.right - box.left, height: edge.bottom - box.top }));
}

/** The chrome along the board's top (the board menu, the toolbar, the panel buttons) a tile the view moves to keeps clear of. */
const TOP_CHROME = '.island-top-left, .island-top-centre, .island-top-right';

/** How far down from the board's top the chrome along it reaches, in the board's own pixels; 0 when none shows. */
export function topChrome(board: HTMLElement, chrome: ParentNode): number {
  const edge = board.getBoundingClientRect();
  let bottom = 0;
  for (const thing of chrome.querySelectorAll<HTMLElement>(TOP_CHROME)) {
    const box = thing.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    bottom = Math.max(bottom, box.bottom - edge.top);
  }
  return Math.min(bottom, edge.height);
}

function sidePanels(board: HTMLElement, edge: DOMRect): { left: number; right: number } {
  let left = 0;
  let right = 0;
  for (const panel of board.ownerDocument.querySelectorAll<HTMLElement>(SIDE_PANELS)) {
    const box = panel.getBoundingClientRect();
    // Not shown, or beside the board rather than over it.
    if (box.width === 0 || box.height === 0 || box.right <= edge.left || box.left >= edge.right) continue;
    // Over the half of the board it is nearer (Edge rules: always the right, even where the Captain's pane over the board's right pushes its middle left of the board's).
    if (panel.matches(RIGHT_PANEL) || box.left + box.width / 2 >= edge.left + edge.width / 2) right = Math.max(right, edge.right - box.left);
    else left = Math.max(left, box.right - edge.left);
  }
  return { left, right };
}

/**
 * `covered` with its corner chrome boxed together: one box from the furthest left piece's left and the highest one's top
 * to the view's lower right. Expanding a tile in place keeps clear of that box, as it did before the pieces were kept
 * apart: panning a big tile into the step between the minimap and the zoom bar would move it, for a few pixels of room.
 */
export function boxedCorner(covered: Covered): Covered {
  if (covered.corner.length === 0) return covered;
  const x = Math.min(...covered.corner.map((piece) => piece.x));
  const y = Math.min(...covered.corner.map((piece) => piece.y));
  const right = Math.max(...covered.corner.map((piece) => piece.x + piece.width));
  const bottom = Math.max(...covered.corner.map((piece) => piece.y + piece.height));
  return { ...covered, corner: [{ x, y, width: right - x, height: bottom - y }] };
}

/** The least share of the view's width or height a clear room takes: a sliver narrower than this is no room at all. */
const LEAST_ROOM = 0.25;

/**
 * The parts of a view of `width` × `height` that `covered` leaves clear, each as a box in the view's own pixels: the
 * width between the side panels, or, with the corner chrome showing, the widest boxes in it that no piece of the chrome
 * reaches into: above all of it, left of all of it, and each step between (left of the minimap and above the zoom bar,
 * say). A room under a quarter of the view across or down is dropped; with no room left, the whole view: better partly
 * under a panel than zoomed right out to fit a sliver.
 */
export function clearRooms(view: { width: number; height: number }, covered: Covered): [Rect, ...Rect[]] {
  const roomy = (room: Rect) => room.width >= view.width * LEAST_ROOM && room.height >= view.height * LEAST_ROOM;
  const x = covered.left;
  const width = view.width - covered.left - covered.right;
  const between = { x, y: 0, width, height: view.height };
  if (!roomy(between)) return [{ x: 0, y: 0, width: view.width, height: view.height }];
  // Chrome under the right panel, or past it, takes no more room.
  const pieces = covered.corner.filter((piece) => piece.x < x + width);
  if (pieces.length === 0) return [between];
  // Each room runs from the left panel to where a piece of the chrome starts, or to the right panel, and down to the top
  // of the highest piece left of that: widest (the least tall) first.
  const ends = [...new Set([x + width, ...pieces.map((piece) => piece.x)])].filter((end) => end > x).sort((a, b) => b - a);
  const rooms = ends.map((end) => ({ x, y: 0, width: end - x, height: Math.min(view.height, ...pieces.filter((piece) => piece.x < end).map((piece) => piece.y)) }));
  // A room as tall as a wider one is inside it.
  const [first, ...rest] = rooms.filter((room, at) => rooms.slice(0, at).every((wider) => wider.height < room.height)).filter(roomy);
  return first === undefined ? [between] : [first, ...rest];
}

/**
 * The view fitted round a part of the board: zoomed between `minZoom` and `maxZoom`, `margin` (a share of the room) kept
 * round it, on whole pixels. Centred between the side panels, as if nothing else were there, when that leaves it wholly in
 * one of the rooms; otherwise centred in the room that shows it biggest. Where `bringIntoView` and `flyTo` go.
 */
export function fitView(rect: Rect, rooms: [Rect, ...Rect[]], minZoom: number, maxZoom: number, margin = FIT_MARGIN): Viewport {
  const fitInto = (room: Rect) => {
    const fit = getViewportForBounds(rect, room.width, room.height, minZoom, maxZoom, margin);
    return whole({ x: fit.x + room.x, y: fit.y + room.y, zoom: fit.zoom });
  };
  const centred = fitInto(span(rooms));
  if (rooms.some(holds(drawnAt(rect, centred)))) return centred;
  return rooms.map(fitInto).reduce((best, next) => (next.zoom > best.zoom ? next : best));
}

/** The box round all the rooms: the width between the side panels, the view's whole height. */
function span(rooms: [Rect, ...Rect[]]): Rect {
  const x = Math.min(...rooms.map((room) => room.x));
  const y = Math.min(...rooms.map((room) => room.y));
  return { x, y, width: Math.max(...rooms.map((room) => room.x + room.width)) - x, height: Math.max(...rooms.map((room) => room.y + room.height)) - y };
}

/** Where a part of the board is drawn in the view at `at`. */
const drawnAt = (rect: Rect, at: Viewport): Rect => ({ x: rect.x * at.zoom + at.x, y: rect.y * at.zoom + at.y, width: rect.width * at.zoom, height: rect.height * at.zoom });

/** Whether `box` lies wholly in a room. */
const holds = (box: Rect) => (room: Rect) => box.x >= room.x && box.y >= room.y && box.x + box.width <= room.x + room.width && box.y + box.height <= room.y + room.height;

/** The view on whole pixels: a fractional pan blurs every glyph a terminal draws, and a tile's edges with it. */
const whole = (at: Viewport): Viewport => ({ x: Math.round(at.x), y: Math.round(at.y), zoom: at.zoom });

/**
 * Where the view goes to show a tile just opened in place, or undefined if it can stay. `tile` is on the board; `viewport`
 * is the board's camera; `rooms` are the parts of the view nothing covers (`clearRooms`); `top` is how far down the
 * chrome along the view's top reaches.
 *
 * A tile already wholly in one of the rooms stays where it is, even with its top under the top chrome. One opened past
 * the edge of the view is centred between the side panels, as `bringIntoView` would, if that leaves it in a room and
 * below the top chrome. Otherwise (one in view but under something, or one centring would leave there) it is shown in
 * one of the rooms, below the top chrome, whichever needs the view zoomed out the least, then moved the least. The view
 * pans only as far as it must, and zooms out only if the tile cannot fit otherwise, never in. It lands on whole pixels.
 */
export function followView(tile: Rect, viewport: Viewport, view: { width: number; height: number; minZoom: number }, rooms: [Rect, ...Rect[]], top = 0): Viewport | undefined {
  const drawn = (at: Viewport) => drawnAt(tile, at);
  const shown = drawn(viewport);
  const fits = holds;
  // Already showing: the top chrome is no reason to move a tile the user can see.
  if (rooms.some(fits(shown))) return undefined;
  // The rooms below the top chrome; with too little left there, the rooms as they are.
  const below = rooms
    .map((room) => ({ ...room, y: Math.max(room.y, top), height: room.y + room.height - Math.max(room.y, top) }))
    .filter((room) => room.height > 0);
  const clear = below.length > 0 ? below : rooms;
  // Opened past the edge of the view: centred between the side panels, as anything brought into view is, if that leaves
  // it clear.
  const inView = shown.x >= 0 && shown.y >= 0 && shown.x + shown.width <= view.width && shown.y + shown.height <= view.height;
  if (!inView) {
    // Checked as it will be drawn, on whole pixels.
    const centred = fitView(tile, [span(rooms)], view.minZoom, viewport.zoom);
    if (clear.some(fits(drawn(centred)))) return centred;
  }
  let best: Viewport | undefined;
  const moved = (next: Viewport) => Math.abs(next.x - viewport.x) + Math.abs(next.y - viewport.y);
  for (const room of clear) {
    const next = panInto(shown, viewport, room) ?? fitView(tile, [room], view.minZoom, viewport.zoom);
    // The room that zooms out the least; of two that zoom alike, the one the view moves the least to.
    if (best === undefined || next.zoom > best.zoom || (next.zoom === best.zoom && moved(next) < moved(best))) best = next;
  }
  return best === undefined ? undefined : whole(best);
}

/**
 * The view panned, at its own zoom, just far enough to bring a tile drawn at `shown` inside a room of it, a margin in
 * from its edges; undefined if the tile is too big for that room at this zoom. The margin shrinks to what the room has
 * spare round the tile: panning a tile close to the edge beats zooming out just to keep the margin.
 */
function panInto(shown: Rect, viewport: Viewport, room: Rect): Viewport | undefined {
  if (shown.width > room.width || shown.height > room.height) return undefined;
  const marginX = Math.min((room.width * FIT_MARGIN) / 2, (room.width - shown.width) / 2);
  const marginY = Math.min((room.height * FIT_MARGIN) / 2, (room.height - shown.height) / 2);
  const shift = (start: number, size: number, from: number, length: number, margin: number) =>
    start < from + margin ? from + margin - start : start + size > from + length - margin ? from + length - margin - (start + size) : 0;
  return {
    x: viewport.x + shift(shown.x, shown.width, room.x, room.width, marginX),
    y: viewport.y + shift(shown.y, shown.height, room.y, room.height, marginY),
    zoom: viewport.zoom,
  };
}
