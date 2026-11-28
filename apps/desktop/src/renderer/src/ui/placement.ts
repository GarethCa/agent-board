// Where a menu, popover or panel goes so that all of it is inside the window: never past an edge, never under macOS's
// traffic lights. Radix places the ones it opens (Menu, Popover, Tooltip) beside their buttons, flipped and shifted
// along the side they open on by the padding `collisionPadding` gives it; menus and popovers are then moved in the
// rest of the way, and kept in as they are dragged, by `fitInWindow` (use-fit-in-window.ts). Pure but for
// `windowRoom` and `trafficLights`, which read the window.

/** A box in the window's CSS pixels, from its top-left. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The window as a box must fit in it: its size, the gap kept from each edge, and a corner kept clear, if any. */
export interface Room {
  width: number;
  height: number;
  /** The gap kept between the box and each edge of the window, px. */
  edge: number;
  /** A box nothing may cover, such as the traffic lights in the top-left, with the room kept round it included. */
  keepOut?: Box;
}

/** The gap a placed box keeps from each edge of the window, px: the same as the menus have always had. */
const WINDOW_EDGE = 8;

/**
 * Where `box` goes to be wholly inside `room`: the nearest place to where it is, shifted in from any edge it is past,
 * then out from under `keepOut` the shorter way, right or down, as long as that still fits. A box bigger than the room
 * keeps its top-left in it, so its head can always be reached.
 */
export function fitInWindow(box: Box, room: Room): { x: number; y: number } {
  const { edge, keepOut } = room;
  const within = (at: number, size: number, span: number) => Math.max(edge, Math.min(at, span - edge - size));
  const x = within(box.x, box.width, room.width);
  const y = within(box.y, box.height, room.height);
  if (keepOut === undefined || !overlaps({ ...box, x, y }, keepOut)) return { x, y };
  const right = keepOut.x + keepOut.width;
  const below = keepOut.y + keepOut.height;
  const fitsRight = right + box.width <= room.width - edge;
  const fitsBelow = below + box.height <= room.height - edge;
  if (fitsRight && (!fitsBelow || right - x < below - y)) return { x: right, y };
  return { x, y: below };
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * The padding Radix keeps a menu or popover inside the window by: `edge` round it, and along the top the strip the
 * traffic lights stand in, as Radix can keep only a whole side clear, not a corner.
 */
export function collisionPaddingFor(edge: number, keepOut: Box | undefined): { top: number; right: number; bottom: number; left: number } {
  const top = keepOut === undefined ? edge : Math.max(edge, keepOut.y + keepOut.height);
  return { top, right: edge, bottom: edge, left: edge };
}

/**
 * The box kept clear round the traffic lights, from the window's top-left, or undefined where there are none: the safe
 * zone the page sets round them on the root, `--traffic-lights-right` and `--traffic-lights-bottom` (0 where a window
 * has none, as off macOS or in full screen).
 */
export function lightsFrom(zone: { right: string; bottom: string }): Box | undefined {
  const right = Number.parseFloat(zone.right);
  const bottom = Number.parseFloat(zone.bottom);
  return right > 0 && bottom > 0 ? { x: 0, y: 0, width: right, height: bottom } : undefined;
}

/** The traffic lights' box in this window, read off its root. */
function trafficLights(root: HTMLElement = document.documentElement): Box | undefined {
  const style = getComputedStyle(root);
  return lightsFrom({ right: style.getPropertyValue('--traffic-lights-right'), bottom: style.getPropertyValue('--traffic-lights-bottom') });
}

/** The window as it is now, for `fitInWindow`. */
export function windowRoom(): Room {
  return { width: window.innerWidth, height: window.innerHeight, edge: WINDOW_EDGE, keepOut: trafficLights() };
}

/**
 * The props every Radix-placed menu, popover and tooltip takes, so all of them are placed the same way: on the side
 * asked for, flipped to the other where there is no room, then shifted in along that side and kept there however far
 * its button moves (`sticky: 'always'`, where Radix's own default lets it follow its button out of the window). Radix
 * shifts only along the side it opens on and keeps only whole sides clear, so a card that is `fitted` afterwards (by
 * `useFitInWindow`, which keeps the rest of it in and clear of the traffic lights' corner) keeps just the edge; one that
 * is not, a tooltip, keeps the whole strip along the top the lights stand in.
 */
export function placementProps({ fitted = false }: { fitted?: boolean } = {}): { collisionPadding: ReturnType<typeof collisionPaddingFor>; sticky: 'always'; avoidCollisions: true } {
  return { collisionPadding: collisionPaddingFor(WINDOW_EDGE, fitted ? undefined : trafficLights()), sticky: 'always', avoidCollisions: true };
}
