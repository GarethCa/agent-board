import type { Rect, Viewport } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { boxedCorner, clearRooms, coveredView, FIT_MARGIN, fitView, followView, topChrome, UNCOVERED } from './view-follow';

// A 1280 × 800 board at zoom 1, the board's origin at the view's top left.
const view = { width: 1280, height: 800, minZoom: 0.1 };
const atOrigin = { x: 0, y: 0, zoom: 1 };
// The minimap and the zoom bar, bottom right: 200 wide, 180 tall.
const corner = { x: 1064, y: 604, width: 200, height: 180 };
const cornered = clearRooms(view, { ...UNCOVERED, corner: [corner] });
const open = clearRooms(view, UNCOVERED);
/** The clear rooms with `chrome` in the corner and no side panel. */
const roomsWith = (chrome: Rect | undefined) => clearRooms(view, { ...UNCOVERED, corner: chrome === undefined ? [] : [chrome] });

describe('followView: where the view goes to show a tile just opened in place', () => {
  it('stays put when the tile is in view and clear of the corner', () => {
    expect(followView({ x: 40, y: 40, width: 960, height: 520 }, atOrigin, view, cornered)).toBeUndefined();
  });

  it('stays put with no corner chrome when the tile is in view', () => {
    expect(followView({ x: 300, y: 180, width: 960, height: 600 }, atOrigin, view, open)).toBeUndefined();
  });

  it('moves when the tile is in view but its lower right is under the minimap', () => {
    // 300..1260 across, 180..780 down: its footer runs under the corner.
    const tile = { x: 300, y: 180, width: 960, height: 600 };
    const next = followView(tile, atOrigin, view, cornered);
    expect(next).toBeDefined();
    const right = tile.x * next!.zoom + next!.x + tile.width * next!.zoom;
    const bottom = tile.y * next!.zoom + next!.y + tile.height * next!.zoom;
    const left = tile.x * next!.zoom + next!.x;
    const top = tile.y * next!.zoom + next!.y;
    // Wholly in view, and either left of the corner or above it.
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(right).toBeLessThanOrEqual(view.width);
    expect(bottom).toBeLessThanOrEqual(view.height);
    expect(right <= corner.x || bottom <= corner.y).toBe(true);
    // Never zoomed in.
    expect(next!.zoom).toBeLessThanOrEqual(1);
  });

  it('moves a small tile under the minimap only as far as it must, not across the view', () => {
    // 900..1200 across, 500..700 down: about 140 px left, or 100 px up, clears the corner.
    const tile = { x: 900, y: 500, width: 300, height: 200 };
    const next = followView(tile, atOrigin, view, cornered)!;
    expect(next.zoom).toBe(1);
    expect(Math.abs(next.x) + Math.abs(next.y)).toBeLessThan(250);
    const right = tile.x + next.x + tile.width;
    const bottom = tile.y + next.y + tile.height;
    expect(right <= corner.x || bottom <= corner.y).toBe(true);
  });

  it('pans a big tile clear of the minimap at its own zoom when it fits beside it, keeping less margin rather than zooming out', () => {
    // 960 × 600, its lower right under a corner 1080 across and 620 down: it fits left of the minimap or above it,
    // though not with the full margin round it.
    const minimap = { x: 1080, y: 620, width: 200, height: 180 };
    const tile = { x: 160, y: 100, width: 960, height: 600 };
    const next = followView(tile, atOrigin, view, roomsWith(minimap))!;
    expect(next.zoom).toBe(1);
    const [left, top] = [tile.x + next.x, tile.y + next.y];
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left + tile.width <= minimap.x || top + tile.height <= minimap.y).toBe(true);
  });

  it('moves a tile below the top chrome, not under it, when it moves', () => {
    // The same tile, with the toolbar 60 px down: above the minimap it would run under the toolbar, so it goes left.
    const minimap = { x: 1080, y: 620, width: 200, height: 180 };
    const tile = { x: 160, y: 100, width: 960, height: 600 };
    const next = followView(tile, atOrigin, view, roomsWith(minimap), 60)!;
    expect(next.zoom).toBe(1);
    expect(tile.y + next.y).toBeGreaterThanOrEqual(60);
    expect(tile.x + next.x + tile.width).toBeLessThanOrEqual(minimap.x);
  });

  it('stays put when the tile is in view and clear of the corner, though its top is under the top chrome', () => {
    expect(followView({ x: 40, y: 20, width: 960, height: 520 }, atOrigin, view, cornered, 60)).toBeUndefined();
  });

  it('pans a tile opened past the bottom up only as far as the room under the top chrome allows', () => {
    const next = followView({ x: 100, y: 300, width: 400, height: 700 }, atOrigin, view, open, 60)!;
    expect(next.zoom).toBe(1);
    expect(300 + next.y).toBeGreaterThanOrEqual(60);
    expect(300 + next.y + 700).toBeLessThanOrEqual(view.height);
  });

  it('centres a tile opened past the edge, as bringing it into view does, when that leaves it clear', () => {
    // 312..1272 across, 216..816 down: past the bottom. Centred, it is 160..1120 and 100..700: clear of a zoom bar alone.
    const zoomBar = { x: 1056, y: 746, width: 210, height: 40 };
    const tile = { x: 312, y: 216, width: 960, height: 600 };
    const next = followView(tile, atOrigin, view, roomsWith(zoomBar), 60)!;
    expect(next).toEqual({ x: -152, y: -116, zoom: 1 });
  });

  it('puts the view on whole pixels, however it moves, so text drawn in a moved tile stays sharp', () => {
    const odd = { x: 0.3, y: 0.7, zoom: 1.07 };
    const cases: [Rect, Viewport, Rect | undefined, number][] = [
      // Centred: opened past the edge, clear once centred.
      [{ x: 312.4, y: 216.3, width: 961, height: 601 }, atOrigin, undefined, 0],
      // Panned: in view, under the corner.
      [{ x: 900.5, y: 500.25, width: 300, height: 200 }, atOrigin, corner, 60],
      // Panned with a shrunk margin, at an odd zoom and offset.
      [{ x: 160.2, y: 100.6, width: 960, height: 600 }, odd, { x: 1080.4, y: 620.6, width: 200, height: 180 }, 60],
      // Fitted: too big for any room at its zoom.
      [{ x: 100.1, y: 100.9, width: 3000, height: 2000 }, atOrigin, corner, 60],
    ];
    for (const [tile, at, chrome, top] of cases) {
      const next = followView(tile, at, view, roomsWith(chrome), top)!;
      expect(Number.isInteger(next.x), JSON.stringify(tile)).toBe(true);
      expect(Number.isInteger(next.y), JSON.stringify(tile)).toBe(true);
    }
  });

  it('keeps the full margin when there is room for it', () => {
    // 900..1200 across, 150..790 down: in view, under the corner, too tall to go above it, with room for the full
    // margin left of it.
    const next = followView({ x: 900, y: 150, width: 300, height: 640 }, atOrigin, view, cornered)!;
    expect(next.zoom).toBe(1);
    expect(Math.abs(900 + next.x + 300 - (corner.x - (corner.x * FIT_MARGIN) / 2))).toBeLessThanOrEqual(0.5);
  });

  it('never zooms in to show a small tile', () => {
    const next = followView({ x: 2000, y: 2000, width: 200, height: 100 }, { x: 0, y: 0, zoom: 0.5 }, view, cornered);
    expect(next!.zoom).toBe(0.5);
  });

  it('brings a tile past the edge into view with no corner chrome', () => {
    const tile = { x: 1000, y: 600, width: 960, height: 600 };
    const next = followView(tile, atOrigin, view, open)!;
    expect(tile.x * next.zoom + next.x).toBeGreaterThanOrEqual(0);
    expect((tile.x + tile.width) * next.zoom + next.x).toBeLessThanOrEqual(view.width);
    expect((tile.y + tile.height) * next.zoom + next.y).toBeLessThanOrEqual(view.height);
  });
});

describe('followView with no clear room', () => {
  it('still brings a tile past the edge into view when the corner covers the whole view', () => {
    const everywhere = { x: 0, y: 0, width: 1280, height: 800 };
    const next = followView({ x: 2000, y: 2000, width: 400, height: 300 }, atOrigin, view, roomsWith(everywhere), 60);
    expect(next).toBeDefined();
    expect(2000 + next!.x).toBeGreaterThanOrEqual(0);
    expect(2000 + next!.x + 400).toBeLessThanOrEqual(view.width);
  });

  it('uses the whole height when the top chrome leaves no room above the corner or beside it', () => {
    const next = followView({ x: 2000, y: 2000, width: 400, height: 300 }, atOrigin, view, cornered, 800)!;
    expect(2000 + next.y).toBeGreaterThanOrEqual(0);
    expect(2000 + next.y + 300).toBeLessThanOrEqual(view.height);
  });
});

const pane = { left: 0, right: 360, corner: [{ x: 704, y: 604, width: 576, height: 196 }] };
const besidePane = clearRooms(view, pane);

describe('clearRooms: the parts of the view nothing covers', () => {
  it('is the whole view with nothing over it', () => {
    expect(clearRooms(view, UNCOVERED)).toEqual([{ x: 0, y: 0, width: 1280, height: 800 }]);
  });

  it('is above the corner, or left of it, with the minimap showing', () => {
    expect(cornered).toEqual([
      { x: 0, y: 0, width: 1280, height: 604 },
      { x: 0, y: 0, width: 1064, height: 800 },
    ]);
  });

  it('stops short of a panel on the right, above and left of the minimap', () => {
    expect(besidePane).toEqual([
      { x: 0, y: 0, width: 920, height: 604 },
      { x: 0, y: 0, width: 704, height: 800 },
    ]);
  });

  it('starts past a panel on the left', () => {
    expect(clearRooms(view, { left: 300, right: 0, corner: [] })).toEqual([{ x: 300, y: 0, width: 980, height: 800 }]);
  });

  it('takes no room for a corner under the right panel', () => {
    expect(clearRooms(view, { left: 0, right: 360, corner: [{ x: 1064, y: 604, width: 200, height: 180 }] })).toEqual([{ x: 0, y: 0, width: 920, height: 800 }]);
  });

  it('is the whole view when the panels leave only a sliver of it', () => {
    expect(clearRooms(view, { left: 0, right: 1240, corner: [] })).toEqual([{ x: 0, y: 0, width: 1280, height: 800 }]);
  });

  it('drops a sliver left of the minimap, keeping the room above it', () => {
    expect(clearRooms(view, { left: 0, right: 0, corner: [{ x: 120, y: 604, width: 1160, height: 196 }] })).toEqual([{ x: 0, y: 0, width: 1280, height: 604 }]);
  });

  it('steps round a zoom bar that reaches further left than the minimap, below it', () => {
    const minimap = { x: 1080, y: 620, width: 200, height: 180 };
    const zoomBar = { x: 1021, y: 748, width: 259, height: 52 };
    expect(clearRooms(view, { ...UNCOVERED, corner: [minimap, zoomBar] })).toEqual([
      { x: 0, y: 0, width: 1280, height: 620 },
      { x: 0, y: 0, width: 1080, height: 748 },
      { x: 0, y: 0, width: 1021, height: 800 },
    ]);
  });

  it('boxes the pieces together for a tile expanded in place', () => {
    const minimap = { x: 1080, y: 620, width: 200, height: 180 };
    const zoomBar = { x: 1021, y: 748, width: 259, height: 52 };
    expect(boxedCorner({ ...UNCOVERED, corner: [minimap, zoomBar] }).corner).toEqual([{ x: 1021, y: 620, width: 259, height: 180 }]);
    expect(boxedCorner(UNCOVERED)).toEqual(UNCOVERED);
  });

  it('is the whole view when the panels cover all of it', () => {
    expect(clearRooms(view, { left: 700, right: 700, corner: [] })).toEqual([{ x: 0, y: 0, width: 1280, height: 800 }]);
  });
});

describe('fitView: a part of the board centred in the clear view', () => {
  const inRoom = (rect: { x: number; y: number; width: number; height: number }, next: { x: number; y: number; zoom: number }, room: { x: number; y: number; width: number; height: number }) => {
    const left = rect.x * next.zoom + next.x;
    const top = rect.y * next.zoom + next.y;
    return left >= room.x && top >= room.y && left + rect.width * next.zoom <= room.x + room.width && top + rect.height * next.zoom <= room.y + room.height;
  };

  it('centres a row whose end is left of the minimap and above the zoom bar, though right of the zoom bar\'s left edge', () => {
    // A stack and its three tiles fanned out below it, 833 × 580: centred, 224..1057 across and 110..690 down. Boxed
    // together, the minimap and the zoom bar would start at x 1021 and y 620 and cover its end.
    const covered = { ...UNCOVERED, corner: [{ x: 1080, y: 620, width: 200, height: 180 }, { x: 1021, y: 748, width: 259, height: 52 }] };
    const row = { x: 0, y: 0, width: 833, height: 580 };
    expect(fitView(row, clearRooms(view, covered), 0.1, 1)).toEqual({ x: 224, y: 110, zoom: 1 });
    expect(fitView(row, clearRooms(view, covered), 0.1, 1)).toEqual(fitView(row, open, 0.1, 1));
    // Boxed together, the chrome would push it left of the zoom bar.
    expect(fitView(row, clearRooms(view, boxedCorner(covered)), 0.1, 1).x).toBeLessThan(224);
  });

  it('lands a tile left of the Captain pane, not under it', () => {
    const tile = { x: 5000, y: 3000, width: 400, height: 300 };
    const next = fitView(tile, besidePane, 0.1, 1);
    expect(next.zoom).toBe(1);
    expect(besidePane.some((room) => inRoom(tile, next, room))).toBe(true);
    // Its right edge is clear of the pane.
    expect((tile.x + tile.width) * next.zoom + next.x).toBeLessThanOrEqual(920);
  });

  it('lands a tile past a left panel', () => {
    const rooms = clearRooms(view, { left: 300, right: 0, corner: [] });
    const tile = { x: -2000, y: 0, width: 400, height: 300 };
    const next = fitView(tile, rooms, 0.1, 1);
    expect(tile.x * next.zoom + next.x).toBeGreaterThanOrEqual(300);
  });

  it('picks the room that shows the tile biggest', () => {
    // A tall tile: left of the minimap (800 tall) beats above it (604 tall).
    const tile = { x: 0, y: 0, width: 300, height: 1000 };
    const next = fitView(tile, cornered, 0.1, 1);
    expect(inRoom(tile, next, cornered[1]!)).toBe(true);
    expect(next.zoom).toBeGreaterThan(0.604);
  });

  it('centres in the whole view, as with nothing over it, when that is already clear of the minimap', () => {
    // A zone 720 × 480: centred, it is 280..1000 across and 160..640 down, left of the corner.
    const zone = { x: 0, y: 0, width: 720, height: 480 };
    expect(fitView(zone, cornered, 0.1, 1)).toEqual(fitView(zone, open, 0.1, 1));
    expect(fitView(zone, cornered, 0.1, 1)).toEqual({ x: 280, y: 160, zoom: 1 });
  });

  it('centres in a room only when centring in the whole view leaves it under the minimap', () => {
    // 1000 × 500: centred in the whole view, it is 140..1140 across and 150..650 down, its lower right under the corner.
    const wide = { x: 0, y: 0, width: 1000, height: 500 };
    const next = fitView(wide, cornered, 0.1, 1);
    expect(next.zoom).toBeLessThanOrEqual(1);
    const bottom = (wide.y + wide.height) * next.zoom + next.y;
    const right = (wide.x + wide.width) * next.zoom + next.x;
    expect(bottom <= corner.y || right <= corner.x).toBe(true);
  });

  it('lands on whole pixels', () => {
    const next = fitView({ x: 10.3, y: 20.7, width: 333.3, height: 222.2 }, besidePane, 0.1, 1);
    expect(Number.isInteger(next.x) && Number.isInteger(next.y)).toBe(true);
  });

  it('never zooms past the zoom it is given', () => {
    expect(fitView({ x: 0, y: 0, width: 10, height: 10 }, besidePane, 0.1, 0.7).zoom).toBe(0.7);
  });
});

describe('followView beside a side panel', () => {
  it('moves a tile opened under the Captain pane out from under it', () => {
    // 600..1100 across: its right part is under the pane, which starts at 920.
    const tile = { x: 600, y: 100, width: 500, height: 300 };
    const next = followView(tile, atOrigin, view, besidePane)!;
    expect(next).toBeDefined();
    expect((tile.x + tile.width) * next.zoom + next.x).toBeLessThanOrEqual(920);
  });

  it('stays put for a tile already clear of the pane and the minimap', () => {
    expect(followView({ x: 100, y: 100, width: 500, height: 300 }, atOrigin, view, besidePane)).toBeUndefined();
  });
});

// What `coveredView` reads: each element's box in the window, and what the board's window and chrome hold.
type Box = { left: number; top: number; width: number; height: number };
const boxOf = (box: Box) => ({ ...box, right: box.left + box.width, bottom: box.top + box.height });
const element = (box: Box) => ({ getBoundingClientRect: () => boxOf(box) }) as unknown as HTMLElement;
/** Each element answers `matches` for the selector it is held under, as in the window. */
const holding = (elements: Record<string, HTMLElement[]>) =>
  ({
    querySelectorAll: (selector: string) =>
      selector.split(', ').flatMap((one) => (elements[one] ?? []).map((held) => Object.assign(held, { matches: (asked: string) => asked === one }))),
  }) as unknown as ParentNode;
/** A board 1280 × 800 at the window's (100, 0), with the side panels in its window and the corner chrome given. */
function boardWith(panels: Record<string, HTMLElement[]>, chrome: Record<string, HTMLElement[]> = {}) {
  const board = { getBoundingClientRect: () => boxOf({ left: 100, top: 0, width: 1280, height: 800 }), ownerDocument: holding(panels) } as unknown as HTMLElement;
  return coveredView(board, holding(chrome));
}

describe('coveredView: what covers the board, measured', () => {
  it('is nothing with no panel and no corner chrome', () => {
    expect(boardWith({})).toEqual(UNCOVERED);
  });

  it('counts the Captain pane lying over the board on the right', () => {
    expect(boardWith({ '.master-panel': [element({ left: 1020, top: 0, width: 360, height: 800 })] })).toMatchObject({ left: 0, right: 360 });
  });

  it('counts nothing for a pane that pushes the board in, beside it', () => {
    expect(boardWith({ '.master-panel': [element({ left: 1380, top: 0, width: 360, height: 800 })] })).toMatchObject({ left: 0, right: 0 });
  });

  it('counts nothing for a closed panel', () => {
    expect(boardWith({ '.edge-rules': [element({ left: 0, top: 0, width: 0, height: 0 })] })).toMatchObject({ left: 0, right: 0 });
  });

  it('takes the further in of Edge rules and the Captain pane, both open on the right', () => {
    const pane = element({ left: 1020, top: 0, width: 360, height: 800 });
    const rules = element({ left: 640, top: 60, width: 366, height: 726 });
    expect(boardWith({ '.master-panel': [pane], '.edge-rules': [rules] })).toMatchObject({ left: 0, right: 740 });
  });

  it('counts Edge rules as covering the right even when the pane over the board puts its middle left of the board’s', () => {
    // A 1000 px board at the window's left: the pane over its right 640..1000, Edge rules beside it 240..626, its middle at 433.
    const board = { getBoundingClientRect: () => boxOf({ left: 0, top: 0, width: 1000, height: 800 }), ownerDocument: holding({ '.master-panel': [element({ left: 640, top: 0, width: 360, height: 800 })], '.edge-rules': [element({ left: 240, top: 60, width: 386, height: 726 })] }) } as unknown as HTMLElement;
    expect(coveredView(board, holding({}))).toMatchObject({ left: 0, right: 760 });
  });

  it('counts a panel docked on the left from the left edge', () => {
    expect(boardWith({ '.master-panel': [element({ left: 100, top: 0, width: 300, height: 800 })] })).toMatchObject({ left: 300, right: 0 });
  });

  it('measures the corner from the minimap and the zoom bar, skipping chrome not shown', () => {
    const minimap = element({ left: 1164, top: 604, width: 200, height: 140 });
    const zoom = element({ left: 1200, top: 750, width: 166, height: 36 });
    const hidden = element({ left: 0, top: 0, width: 0, height: 0 });
    expect(boardWith({}, { '.board-minimap': [minimap, hidden], '.island-bottom-right': [zoom] }).corner).toEqual([
      { x: 1100, y: 750, width: 180, height: 50 },
      { x: 1064, y: 604, width: 216, height: 196 },
    ]);
  });
});

describe('topChrome: how far down the chrome along the board\'s top reaches', () => {
  const board = element({ left: 100, top: 50, width: 1280, height: 800 });

  it('is the lowest bottom of the top islands, from the board\'s top', () => {
    const islands = [element({ left: 114, top: 64, width: 260, height: 44 }), element({ left: 500, top: 64, width: 520, height: 48 })];
    expect(topChrome(board, holding({ '.island-top-left': [islands[0]!], '.island-top-centre': [islands[1]!] }))).toBe(62);
  });

  it('is 0 with none showing, and skips one with no size', () => {
    expect(topChrome(board, holding({}))).toBe(0);
    expect(topChrome(board, holding({ '.island-top-left': [element({ left: 114, top: 64, width: 0, height: 0 })] }))).toBe(0);
  });
});
