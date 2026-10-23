import { describe, expect, it } from 'vitest';
import { createWheelLatch, GESTURE_QUIET_MS, routeWheel } from './wheel-latch';

const terminal = {};
const note = {};

describe('the wheel latch', () => {
  it('keeps a pan that started on the board with the board across a terminal, momentum included', () => {
    const latch = createWheelLatch();
    expect(latch.owner({ time: 0, surface: null })).toBeNull();
    expect(latch.owner({ time: 16, surface: terminal })).toBeNull();
    for (let time = 32; time < 1000; time += 16) expect(latch.owner({ time, surface: terminal })).toBeNull();
  });

  it('keeps a scroll that started in a surface with that surface, not another or the bare board', () => {
    const latch = createWheelLatch();
    expect(latch.owner({ time: 0, surface: terminal })).toBe(terminal);
    expect(latch.owner({ time: 16, surface: null })).toBe(terminal);
    expect(latch.owner({ time: 32, surface: note })).toBe(terminal);
  });

  it('starts a new gesture once the stream has been quiet', () => {
    const latch = createWheelLatch();
    expect(latch.owner({ time: 0, surface: null })).toBeNull();
    expect(latch.owner({ time: GESTURE_QUIET_MS, surface: terminal })).toBeNull();
    expect(latch.owner({ time: GESTURE_QUIET_MS * 2 + 1, surface: terminal })).toBe(terminal);
    expect(latch.owner({ time: GESTURE_QUIET_MS * 4, surface: null })).toBeNull();
  });
});

describe('routing a wheel event', () => {
  it('lets a zoom (a pinch, or the zoom key) through whoever owns the gesture', () => {
    expect(routeWheel({ zoom: true, owner: null, surface: terminal })).toBe('pass');
    expect(routeWheel({ zoom: true, owner: terminal, surface: null })).toBe('pass');
  });

  it('pans the board from a board-owned gesture, over a surface too', () => {
    expect(routeWheel({ zoom: false, owner: null, surface: null })).toBe('pass');
    expect(routeWheel({ zoom: false, owner: null, surface: terminal })).toBe('redispatch');
  });

  it('leaves a surface-owned gesture to its surface and drops it anywhere else', () => {
    expect(routeWheel({ zoom: false, owner: terminal, surface: terminal })).toBe('pass');
    expect(routeWheel({ zoom: false, owner: terminal, surface: null })).toBe('drop');
    expect(routeWheel({ zoom: false, owner: terminal, surface: note })).toBe('drop');
  });
});
