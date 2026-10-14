import { describe, expect, it } from 'vitest';
import { DEFAULT_ZONE_SIZE, MIN_ZONE_SIZE } from '@agent-board/daemon/protocol';
import { draggedZoneLayout, matches, popoverPlacement } from './add-zone';

describe('draggedZoneLayout', () => {
  it('takes the box dragged out, whichever way it was dragged', () => {
    expect(draggedZoneLayout({ x: 500, y: 400 }, { x: 100, y: 50 })).toEqual({ x: 100, y: 50, width: 400, height: 350 });
  });

  it('grows a small drag to the least zone size, from where it started', () => {
    expect(draggedZoneLayout({ x: 100, y: 100 }, { x: 150, y: 120 })).toEqual({
      x: 100,
      y: 100,
      ...MIN_ZONE_SIZE,
    });
  });

  it('makes a click a zone of the default size centred on it', () => {
    expect(draggedZoneLayout({ x: 1000, y: 500 }, { x: 1002, y: 501 })).toEqual({
      x: 1000 - DEFAULT_ZONE_SIZE.width / 2,
      y: 500 - DEFAULT_ZONE_SIZE.height / 2,
      ...DEFAULT_ZONE_SIZE,
    });
  });
});

describe('matches', () => {
  it('finds every word typed in any of the texts, ignoring case', () => {
    expect(matches(['acme/pantry-api', 'Shared backend'], 'PAN back')).toBe(true);
    expect(matches(['acme/pantry-api', null], 'ops')).toBe(false);
    expect(matches(['anything'], '  ')).toBe(true);
  });
});

describe('popoverPlacement', () => {
  const view = { left: 0, right: 1280 };
  it('goes right of the outline when it fits there, else left', () => {
    expect(popoverPlacement({ left: 100, right: 500 }, view, 640)).toEqual({ side: 'right', sideOffset: 10 });
    expect(popoverPlacement({ left: 700, right: 1200 }, view, 640)).toEqual({ side: 'left', sideOffset: 10 });
  });

  it('goes over the right edge of the outline, inside it, when neither side has room', () => {
    expect(popoverPlacement({ left: 280, right: 1000 }, view, 640)).toEqual({ side: 'right', sideOffset: -660 });
  });
});
