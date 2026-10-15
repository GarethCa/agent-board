import { describe, expect, it } from 'vitest';
import { clampFrame, defaultFrame, frameFrom, fromFractions, MIN_HEIGHT, MIN_WIDTH, resizeFrame, toFractions } from './window-frame';

const bounds = { width: 1200, height: 800 };
const frame = { x: 100, y: 80, width: 600, height: 400 };

describe('the saved window frame', () => {
  it('reads back what was saved, and nothing else', () => {
    const half = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    expect(frameFrom({ ...half, maximised: false })).toEqual({ frame: half, maximised: false });
    expect(frameFrom({ ...half, maximised: true })).toEqual({ frame: half, maximised: true });
    expect(frameFrom(null)).toBeUndefined();
    expect(frameFrom({ ...frame, width: 'wide', maximised: false })).toBeUndefined();
    expect(frameFrom({ ...frame, width: Number.NaN, maximised: false })).toBeUndefined();
  });
});

describe('a frame saved in pixels by an older version', () => {
  it('is dropped when restored, so the window fills the board', () => {
    expect(frameFrom({ ...frame, maximised: false })).toBeUndefined();
  });

  it('keeps being maximised, with the default size to restore to', () => {
    expect(frameFrom({ ...frame, maximised: true })).toEqual({ frame: { x: 0.15, y: 0.125, width: 0.7, height: 0.75 }, maximised: true });
  });
});

describe('a frame as fractions of the board', () => {
  it('scales with the board', () => {
    const half = toFractions({ x: 300, y: 200, width: 600, height: 400 }, bounds);
    expect(half).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 });
    expect(fromFractions(half, { width: 2400, height: 1600 })).toEqual({ x: 600, y: 400, width: 1200, height: 800 });
  });
});

describe('keeping the window in the board', () => {
  it('leaves a frame that fits as it is', () => {
    expect(clampFrame(frame, bounds)).toEqual(frame);
  });

  it('keeps it at least the least size and at most the board', () => {
    expect(clampFrame({ ...frame, width: 10, height: 10 }, bounds)).toMatchObject({ width: MIN_WIDTH, height: MIN_HEIGHT });
    expect(clampFrame({ ...frame, width: 5000, height: 5000, x: 0, y: 0 }, bounds)).toMatchObject({ width: 1200, height: 800 });
  });

  it('pulls it back inside when the board got smaller', () => {
    const clamped = clampFrame({ x: 900, y: 700, width: 600, height: 400 }, bounds);
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(1200);
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(800);
    expect(clamped.x).toBeGreaterThanOrEqual(0);
  });

  it('opens centred when there is no frame yet', () => {
    const open = defaultFrame(bounds);
    expect(open.x * 2 + open.width).toBe(1200);
    expect(open.y * 2 + open.height).toBe(800);
  });
});

describe('dragging an edge or corner', () => {
  it('moves only the edge dragged', () => {
    expect(resizeFrame(frame, 'e', 50, 20, bounds)).toEqual({ ...frame, width: 650 });
    expect(resizeFrame(frame, 's', 50, 20, bounds)).toEqual({ ...frame, height: 420 });
  });

  it('moves the window with a west or north edge, so the far edge stays', () => {
    expect(resizeFrame(frame, 'w', -50, 0, bounds)).toEqual({ ...frame, x: 50, width: 650 });
    expect(resizeFrame(frame, 'n', 0, -30, bounds)).toEqual({ ...frame, y: 50, height: 430 });
  });

  it('moves both edges of a corner', () => {
    expect(resizeFrame(frame, 'se', 100, 100, bounds)).toEqual({ ...frame, width: 700, height: 500 });
    expect(resizeFrame(frame, 'nw', -20, -20, bounds)).toEqual({ x: 80, y: 60, width: 620, height: 420 });
  });

  it('stops at the least size, the far edge staying put', () => {
    const shrunk = resizeFrame(frame, 'w', 1000, 0, bounds);
    expect(shrunk.width).toBe(MIN_WIDTH);
    expect(shrunk.x + shrunk.width).toBe(700);
  });

  it('stops at the board edge', () => {
    expect(resizeFrame(frame, 'e', 5000, 0, bounds)).toMatchObject({ x: 100, width: 1100 });
    expect(resizeFrame(frame, 'w', -5000, 0, bounds)).toMatchObject({ x: 0, width: 700 });
    expect(resizeFrame(frame, 'n', 0, -5000, bounds)).toMatchObject({ y: 0, height: 480 });
  });
});

describe('a board with its top edge kept clear (the traffic lights)', () => {
  const clear = { ...bounds, top: 68 };

  it('keeps a frame below it, shrinking one that would not fit', () => {
    expect(clampFrame({ x: 0, y: 0, width: 600, height: 400 }, clear).y).toBe(68);
    expect(clampFrame({ x: 0, y: 0, width: 600, height: 800 }, clear)).toMatchObject({ y: 68, height: 732 });
  });

  it('stops dragging the top edge at it', () => {
    expect(resizeFrame({ x: 100, y: 100, width: 600, height: 400 }, 'n', 0, -500, clear)).toMatchObject({ y: 68, height: 432 });
  });
});
