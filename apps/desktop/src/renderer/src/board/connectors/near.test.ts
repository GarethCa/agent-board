import { describe, expect, it } from 'vitest';
import { nearestObject } from './near';

const tile = (id: string, x: number, y: number) => ({ id, rect: { x, y, width: 200, height: 100 }, zone: false });
const zone = { id: 'zone', rect: { x: 0, y: 0, width: 1000, height: 800 }, zone: true };

describe('the object a pointer is near, while an arrow is drawn or an end dragged', () => {
  it('is the tile the pointer is over', () => {
    expect(nearestObject([tile('a', 100, 100), tile('b', 400, 100)], { x: 450, y: 150 }, 40)).toBe('b');
  });

  it('is a tile the pointer is just outside, within the margin, and none further off', () => {
    const objects = [tile('a', 100, 100)];
    expect(nearestObject(objects, { x: 330, y: 150 }, 40)).toBe('a');
    expect(nearestObject(objects, { x: 350, y: 150 }, 40)).toBeUndefined();
  });

  it('is the nearer of two tiles the pointer is between', () => {
    expect(nearestObject([tile('a', 100, 100), tile('b', 340, 100)], { x: 330, y: 150 }, 40)).toBe('b');
  });

  it('is a tile in a zone rather than the zone round it', () => {
    expect(nearestObject([zone, tile('a', 100, 100)], { x: 150, y: 150 }, 40)).toBe('a');
  });

  it('is a zone only near its outline, not deep in its body', () => {
    expect(nearestObject([zone], { x: 500, y: 400 }, 40)).toBeUndefined();
    expect(nearestObject([zone], { x: 20, y: 400 }, 40)).toBe('zone');
    expect(nearestObject([zone], { x: 1020, y: 400 }, 40)).toBe('zone');
  });

  it('leaves out the objects it is told to', () => {
    expect(nearestObject([tile('a', 100, 100)], { x: 150, y: 150 }, 40, new Set(['a']))).toBeUndefined();
  });
});
