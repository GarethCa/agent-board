import { describe, expect, it } from 'vitest';
import { freeTile, inFreeArea, lanesInside } from '@agent-board/daemon/shelf-layout';
import { lanesDragged } from './lanes-area';

const zone = { width: 1000, height: 800 };
const least = { width: 300, height: 200 };
const start = { x: 100, y: 100, width: 600, height: 400 };

describe('lanesDragged', () => {
  it('moves the dragged corner and keeps the other where it was', () => {
    expect(lanesDragged(start, 'bottom-right', { x: -100, y: 50 }, zone, least)).toEqual({ x: 100, y: 100, width: 500, height: 450 });
    expect(lanesDragged(start, 'top-left', { x: 50, y: -40 }, zone, least)).toEqual({ x: 150, y: 60, width: 550, height: 440 });
    expect(lanesDragged(start, 'top-right', { x: 20, y: 30 }, zone, least)).toEqual({ x: 100, y: 130, width: 620, height: 370 });
    expect(lanesDragged(start, 'bottom-left', { x: -30, y: -10 }, zone, least)).toEqual({ x: 70, y: 100, width: 630, height: 390 });
  });

  it('stays inside the zone', () => {
    expect(lanesDragged(start, 'bottom-right', { x: 900, y: 900 }, zone, least)).toEqual({ x: 100, y: 100, width: 900, height: 700 });
    expect(lanesDragged(start, 'top-left', { x: -900, y: -900 }, zone, least)).toEqual({ x: 0, y: 0, width: 700, height: 500 });
  });

  it('goes no smaller than its lanes need, from either side', () => {
    expect(lanesDragged(start, 'bottom-right', { x: -900, y: -900 }, zone, least)).toEqual({ x: 100, y: 100, ...least });
    expect(lanesDragged(start, 'top-left', { x: 900, y: 900 }, zone, least)).toEqual({ x: 400, y: 300, ...least });
  });
});

describe('the free area', () => {
  const lanes = { x: 0, y: 0, width: 500, height: 300 };

  it('takes a tile put down wholly outside the lanes area, at a tile size, and none while the lanes fill the zone', () => {
    expect(freeTile(null, { x: 900, y: 900 })).toBe(false);
    expect(freeTile(lanes, { x: 10, y: 10 })).toBe(false);
    expect(freeTile(lanes, { x: 500, y: 10 })).toBe(true);
    expect(freeTile(lanes, { x: 10, y: 320 })).toBe(true);
    // Left of the lanes by less than a tile's width, it would lie over them.
    expect(freeTile({ ...lanes, x: 300 }, { x: 200, y: 10 })).toBe(false);
    expect(freeTile({ ...lanes, x: 300 }, { x: 40, y: 10 })).toBe(true);
  });

  it('holds the tiles marked free while the zone has a lanes area, whatever their places', () => {
    expect(inFreeArea({ lanes, free: ['shell:a'] }, 'shell:a')).toBe(true);
    expect(inFreeArea({ lanes, free: ['shell:a'] }, 'shell:b')).toBe(false);
    expect(inFreeArea({ lanes: null, free: ['shell:a'] }, 'shell:a')).toBe(false);
    // From a daemon from before zones had lanes areas of their own.
    expect(inFreeArea({}, 'shell:a')).toBe(false);
  });

  it('is kept inside the zone it is in', () => {
    expect(lanesInside({ x: 700, y: 50, width: 400, height: 100 }, zone)).toEqual({ x: 600, y: 50, width: 400, height: 100 });
    expect(lanesInside({ x: 50, y: 50, width: 1200, height: 900 }, zone)).toEqual({ x: 0, y: 0, width: 1000, height: 800 });
  });
});
