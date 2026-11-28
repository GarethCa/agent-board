import { describe, expect, it } from 'vitest';
import { collisionPaddingFor, fitInWindow, lightsFrom, type Box, type Room } from './placement';

const room: Room = { width: 1000, height: 800, edge: 8 };
const box = (x: number, y: number, width = 200, height = 300): Box => ({ x, y, width, height });

describe('fitInWindow', () => {
  it('leaves a box that fits where it is', () => {
    expect(fitInWindow(box(100, 100), room)).toEqual({ x: 100, y: 100 });
  });

  it.each([
    ['left', box(-50, 100), { x: 8, y: 100 }],
    ['right', box(900, 100), { x: 792, y: 100 }],
    ['top', box(100, -40), { x: 100, y: 8 }],
    ['bottom', box(100, 700), { x: 100, y: 492 }],
  ])('shifts in from past the %s edge', (_edge, at, fitted) => {
    expect(fitInWindow(at, room)).toEqual(fitted);
  });

  it.each([
    ['top-left', box(-50, -50), { x: 8, y: 8 }],
    ['top-right', box(950, -50), { x: 792, y: 8 }],
    ['bottom-left', box(-50, 790), { x: 8, y: 492 }],
    ['bottom-right', box(950, 790), { x: 792, y: 492 }],
  ])('shifts in from past the %s corner', (_corner, at, fitted) => {
    expect(fitInWindow(at, room)).toEqual(fitted);
  });

  it('keeps the top-left in the window when the box is bigger than it, so its head can always be reached', () => {
    expect(fitInWindow(box(300, 300, 1200, 900), room)).toEqual({ x: 8, y: 8 });
  });

  describe('with the traffic lights kept clear', () => {
    const lights: Room = { ...room, keepOut: { x: 0, y: 0, width: 80, height: 60 } };

    it('moves a box under them down, below them, when that is the shorter way out', () => {
      expect(fitInWindow(box(20, 10), lights)).toEqual({ x: 20, y: 60 });
    });

    it('moves it right of them when that is the shorter way out', () => {
      expect(fitInWindow(box(66, 30), lights)).toEqual({ x: 80, y: 30 });
    });

    it('keeps no more room round them than they carry', () => {
      expect(fitInWindow(box(70, 10), { ...room, keepOut: { x: 0, y: 0, width: 78, height: 52 } })).toEqual({ x: 78, y: 10 });
    });

    it('leaves a box beside them where it is', () => {
      expect(fitInWindow(box(80, 8), lights)).toEqual({ x: 80, y: 8 });
    });

    it('clears them after shifting in from past the top-left corner', () => {
      expect(fitInWindow(box(-100, -100), lights)).toEqual({ x: 8, y: 60 });
    });

    it('goes below them when going right would not fit across', () => {
      expect(fitInWindow(box(8, 8, 990, 100), lights)).toEqual({ x: 8, y: 60 });
    });
  });
});

describe('collisionPaddingFor', () => {
  it('keeps the edge all round with no traffic lights', () => {
    expect(collisionPaddingFor(8, undefined)).toEqual({ top: 8, right: 8, bottom: 8, left: 8 });
  });

  it('keeps the strip the traffic lights stand in clear along the top', () => {
    expect(collisionPaddingFor(8, { x: 0, y: 0, width: 80, height: 60 })).toEqual({ top: 60, right: 8, bottom: 8, left: 8 });
  });
});

describe('lightsFrom', () => {
  it('takes the safe zone the page sets round the traffic lights', () => {
    expect(lightsFrom({ right: '78px', bottom: '52px' })).toEqual({ x: 0, y: 0, width: 78, height: 52 });
  });

  it.each([
    ['an empty safe zone', '0px', '0px'],
    ['no safe zone at all', '', ''],
  ])('has none where the page sets %s', (_what, right, bottom) => {
    expect(lightsFrom({ right, bottom })).toBeUndefined();
  });
});
