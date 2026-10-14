import { describe, expect, it } from 'vitest';
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO, splitPane, type PaneLayout } from '@agent-board/daemon/pane-layout';
import { paneGeometry, ratioAt } from './pane-geometry';

const pane = (sessionId: string): PaneLayout => ({ type: 'pane', sessionId });

describe('pane geometry', () => {
  it('gives a lone pane the whole window and no dividers', () => {
    expect(paneGeometry(pane('a'))).toEqual({ panes: [{ sessionId: 'a', rect: { x: 0, y: 0, width: 1, height: 1 } }], dividers: [] });
  });

  it('puts side-by-side panes left and right of the divider, one above the other top and bottom', () => {
    const side = paneGeometry(splitPane(pane('a'), 'a', 'horizontal', 'b', 's'));
    expect(side.panes).toEqual([
      { sessionId: 'a', rect: { x: 0, y: 0, width: 0.5, height: 1 } },
      { sessionId: 'b', rect: { x: 0.5, y: 0, width: 0.5, height: 1 } },
    ]);
    expect(side.dividers).toEqual([{ splitId: 's', direction: 'horizontal', region: { x: 0, y: 0, width: 1, height: 1 }, ratio: 0.5 }]);

    const stacked = paneGeometry(splitPane(pane('a'), 'a', 'vertical', 'b', 's'));
    expect(stacked.panes[1]).toEqual({ sessionId: 'b', rect: { x: 0, y: 0.5, width: 1, height: 0.5 } });
  });

  it('nests: a split inside a split divides only its own region', () => {
    const layout = splitPane(splitPane(pane('a'), 'a', 'horizontal', 'b', 's1'), 'b', 'vertical', 'c', 's2');
    const { panes, dividers } = paneGeometry(layout);
    expect(panes.map((p) => [p.sessionId, p.rect])).toEqual([
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
