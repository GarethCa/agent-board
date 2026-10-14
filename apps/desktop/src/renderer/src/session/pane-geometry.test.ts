import { describe, expect, it } from 'vitest';
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO, splitPane, type PaneLayout } from '@agent-board/daemon/pane-layout';
import type { WindowLayout } from '@agent-board/daemon/window-layout';
import { bySession, dropZoneAt, nearestInDirection, paneGeometry as geometryOf, ratioAt, type Rect } from './pane-geometry';

const paneGeometry = (layout: PaneLayout) => geometryOf(layout, bySession);

const pane = (sessionId: string): PaneLayout => ({ type: 'pane', sessionId });

describe('pane geometry', () => {
  it('gives a lone pane the whole window and no dividers', () => {
    expect(paneGeometry(pane('a'))).toEqual({ panes: [{ id: 'a', rect: { x: 0, y: 0, width: 1, height: 1 } }], dividers: [] });
  });

  it('puts side-by-side panes left and right of the divider, one above the other top and bottom', () => {
    const side = paneGeometry(splitPane(pane('a'), 'a', 'horizontal', 'b', 's'));
    expect(side.panes).toEqual([
      { id: 'a', rect: { x: 0, y: 0, width: 0.5, height: 1 } },
      { id: 'b', rect: { x: 0.5, y: 0, width: 0.5, height: 1 } },
    ]);
    expect(side.dividers).toEqual([{ splitId: 's', direction: 'horizontal', region: { x: 0, y: 0, width: 1, height: 1 }, ratio: 0.5 }]);

    const stacked = paneGeometry(splitPane(pane('a'), 'a', 'vertical', 'b', 's'));
    expect(stacked.panes[1]).toEqual({ id: 'b', rect: { x: 0, y: 0.5, width: 1, height: 0.5 } });
  });

  it('nests: a split inside a split divides only its own region', () => {
    const layout = splitPane(splitPane(pane('a'), 'a', 'horizontal', 'b', 's1'), 'b', 'vertical', 'c', 's2');
    const { panes, dividers } = paneGeometry(layout);
    expect(panes.map((p) => [p.id, p.rect])).toEqual([
      ['a', { x: 0, y: 0, width: 0.5, height: 1 }],
      ['b', { x: 0.5, y: 0, width: 0.5, height: 0.5 }],
      ['c', { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }],
    ]);
    expect(dividers.map((d) => [d.splitId, d.region])).toEqual([
      ['s1', { x: 0, y: 0, width: 1, height: 1 }],
      ['s2', { x: 0.5, y: 0, width: 0.5, height: 1 }],
    ]);
  });

  it('turns a pointer position into the divider’s ratio within its region', () => {
    const [divider] = paneGeometry(splitPane(splitPane(pane('a'), 'a', 'horizontal', 'b', 's1'), 'b', 'vertical', 'c', 's2')).dividers.slice(1);
    // s2 splits the right half top/bottom: y runs over the full height.
    expect(ratioAt(divider!, { x: 0.9, y: 0.25 })).toBe(0.25);
    const [outer] = paneGeometry(splitPane(pane('a'), 'a', 'horizontal', 'b', 's')).dividers;
    expect(ratioAt(outer!, { x: 0.3, y: 0.9 })).toBe(0.3);
  });

  it('keeps a dragged divider within the ratios a layout allows', () => {
    const [divider] = paneGeometry(splitPane(pane('a'), 'a', 'horizontal', 'b', 's')).dividers;
    expect(ratioAt(divider!, { x: -0.5, y: 0.5 })).toBe(MIN_SPLIT_RATIO);
    expect(ratioAt(divider!, { x: 1.5, y: 0.5 })).toBe(MAX_SPLIT_RATIO);
  });
});

it("lays a window's panes out by their ids, as a shell's by its sessions", () => {
  const window: WindowLayout = {
    type: 'split',
    id: 's',
    direction: 'vertical',
    ratio: 0.25,
    first: { type: 'pane', id: 'top', tabs: [{ kind: 'own' }], active: 'own' },
    second: { type: 'pane', id: 'bottom', tabs: [{ kind: 'shell', shellId: 'x' }], active: 'shell:x' },
  };
  expect(geometryOf(window, (leaf) => leaf.id).panes).toEqual([
    { id: 'top', rect: { x: 0, y: 0, width: 1, height: 0.25 } },
    { id: 'bottom', rect: { x: 0, y: 0.25, width: 1, height: 0.75 } },
  ]);
});

describe('dropping on a pane', () => {
  it('splits at the edge the point is nearest, within a quarter of it, and joins the strip from the middle', () => {
    expect(dropZoneAt({ x: 0.5, y: 0.5 })).toBe('center');
    expect(dropZoneAt({ x: 0.1, y: 0.5 })).toBe('left');
    expect(dropZoneAt({ x: 0.9, y: 0.4 })).toBe('right');
    expect(dropZoneAt({ x: 0.5, y: 0.05 })).toBe('top');
    expect(dropZoneAt({ x: 0.6, y: 0.8 })).toBe('bottom');
    // In a corner, the nearer edge.
    expect(dropZoneAt({ x: 0.05, y: 0.2 })).toBe('left');
    expect(dropZoneAt({ x: 0.2, y: 0.05 })).toBe('top');
  });
});

describe('moving focus between panes', () => {
  const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
  // a | b over c, with d below the whole of them.
  const slots = [rect(0, 0, 0.5, 0.25), rect(0.5, 0, 0.5, 0.25), rect(0.5, 0.25, 0.5, 0.25), rect(0, 0.5, 1, 0.5)];

  it('goes to the nearest pane on that side, the one most in line first', () => {
    expect(nearestInDirection(slots, 0, 'right')).toBe(1);
    expect(nearestInDirection(slots, 1, 'down')).toBe(2);
    expect(nearestInDirection(slots, 2, 'left')).toBe(0);
    expect(nearestInDirection(slots, 2, 'down')).toBe(3);
    expect(nearestInDirection(slots, 3, 'up')).toBe(2);
    expect(nearestInDirection(slots, 1, 'left')).toBe(0);
  });

  it('stays put with nothing on that side', () => {
    expect(nearestInDirection(slots, 0, 'left')).toBeUndefined();
    expect(nearestInDirection(slots, 3, 'down')).toBeUndefined();
    expect(nearestInDirection([rect(0, 0, 1, 1)], 0, 'right')).toBeUndefined();
  });
});
