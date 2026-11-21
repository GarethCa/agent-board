// The size of an agent's pop-up (AgentPopup.tsx): the largest 16:10 box in the room it has, or the size the user dragged
// it to, kept for every pop-up. The room is the board less the margin round the pop-up, which is the CSS's (the scrim's
// padding), measured by the pop-up. Pure, so it is unit-tested; the storage is the one side effect, at the end.

export interface Size {
  width: number;
  height: number;
}

/** Width over height of the pop-up as it fits the board. */
const POPUP_ASPECT = 16 / 10;
/** The least it is dragged to, in px; in a room smaller than this, the room. */
export const POPUP_MIN: Size = { width: 560, height: 360 };

/** Which of its edges or corners a drag holds. */
export type PopupEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const POPUP_EDGES: readonly PopupEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/**
 * The widest a pop-up grows, in px, on a wide screen, unless it is set to fill it: its room, split or not, stops at this
 * width, centred, and keeps its full height. A board no wider than this plus its margins never meets it.
 */
export const POPUP_CAP = 1600;

/** Whether `room` is wider than the cap: a wide screen, where the pop-up stops at it unless set to fill. */
export function capBites(room: Size): boolean {
  return room.width > POPUP_CAP;
}

/** The room a pop-up may take: all of `room` set to fill, else no wider than the cap. */
export function popupRoom(room: Size, fill: boolean): Size {
  return fill ? room : { width: Math.min(room.width, POPUP_CAP), height: room.height };
}

/** The largest 16:10 box that fits `room`. */
export function fitPopup(room: Size): Size {
  const width = Math.max(0, room.width);
  const height = Math.max(0, room.height);
  return width / height > POPUP_ASPECT ? { width: Math.round(height * POPUP_ASPECT), height } : { width, height: Math.round(width / POPUP_ASPECT) };
}

const clamp = (value: number, least: number, most: number) => Math.min(most, Math.max(Math.min(least, most), value));

/** `size` kept between the least it may be and `room`. */
export function clampPopup(size: Size, room: Size): Size {
  const most = { width: Math.max(0, room.width), height: Math.max(0, room.height) };
  return { width: Math.round(clamp(size.width, POPUP_MIN.width, most.width)), height: Math.round(clamp(size.height, POPUP_MIN.height, most.height)) };
}

/**
 * Its size split, two agents side by side: grown to the board's edges, all of the room, the margin round it the same.
 * Nothing kept changes, so the size it had comes back as the split ends.
 */
export function splitPopupSize(room: Size): Size {
  return { width: Math.max(0, room.width), height: Math.max(0, room.height) };
}

/**
 * The pop-up's size in `room`: split, all the room it may take; else the size dragged to, kept to that room, else the
 * 16:10 fit, no wider than that room. Unless set to `fill`, the room stops at the cap's width with all its height.
 */
export function popupSize(room: Size, saved: Size | null, { split = false, fill = false }: { split?: boolean; fill?: boolean } = {}): Size {
  const most = popupRoom(room, fill);
  if (split) return splitPopupSize(most);
  if (saved !== null) return clampPopup(saved, most);
  const fit = fitPopup(room);
  return { width: Math.min(fit.width, most.width), height: fit.height };
}

/**
 * Its size as `edge` is dragged by (dx, dy) from where the drag started, at `start`. It stays centred, so an edge moved
 * by a pixel grows or shrinks it by two, the far edge moving with it.
 */
export function dragPopup(start: Size, edge: PopupEdge, dx: number, dy: number, room: Size): Size {
  const width = edge.includes('e') ? start.width + 2 * dx : edge.includes('w') ? start.width - 2 * dx : start.width;
  const height = edge.includes('s') ? start.height + 2 * dy : edge.includes('n') ? start.height - 2 * dy : start.height;
  return clampPopup({ width, height }, room);
}

/** Where the size dragged to is kept: every pop-up's, through restarts. */
export const POPUP_SIZE_KEY = 'agent-board.popup-size';

/** The size kept as `text`, or null for none, or for anything that isn't a size. */
export function parsePopupSize(text: string | null): Size | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    const { width, height } = value as Record<string, unknown>;
    return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
  } catch {
    return null;
  }
}

/** Reads the size kept, null where there is none or storage is blocked. */
export function readPopupSize(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Size | null {
  try {
    return parsePopupSize(storage?.getItem(POPUP_SIZE_KEY) ?? null);
  } catch {
    return null;
  }
}

/** Keeps `size` for every pop-up; null drops it, back to the fit. Blocked storage keeps it for this run only. */
export function writePopupSize(size: Size | null, storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.localStorage): void {
  try {
    if (size === null) storage?.removeItem(POPUP_SIZE_KEY);
    else storage?.setItem(POPUP_SIZE_KEY, JSON.stringify({ width: Math.round(size.width), height: Math.round(size.height) }));
  } catch {
    // Blocked: the size holds until the app quits.
  }
}
