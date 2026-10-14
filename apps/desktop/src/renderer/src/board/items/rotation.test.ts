import { describe, expect, it } from 'vitest';
import { angleAt, rotatedBy, ROTATION_SNAP } from './rotation';

describe('angleAt', () => {
  const centre = { x: 100, y: 100 };

  it('is 0 straight above the centre, and grows clockwise', () => {
    expect(angleAt(centre, { x: 100, y: 0 })).toBeCloseTo(0);
    expect(angleAt(centre, { x: 200, y: 100 })).toBeCloseTo(90);
    expect(angleAt(centre, { x: 100, y: 200 })).toBeCloseTo(-180);
    expect(angleAt(centre, { x: 0, y: 100 })).toBeCloseTo(-90);
  });
});

describe('rotatedBy', () => {
  it('turns an angle by how far the pointer has gone round', () => {
    expect(rotatedBy(10, 33.3, false)).toBeCloseTo(43.3);
    expect(rotatedBy(170, 20, false)).toBeCloseTo(-170);
  });

  it(`snaps the angle it ends at to ${ROTATION_SNAP}° steps`, () => {
    expect(ROTATION_SNAP).toBe(15);
    expect(rotatedBy(10, 33.3, true)).toBe(45);
    expect(rotatedBy(3, 4, true)).toBe(0);
    expect(rotatedBy(-100, -8, true)).toBe(-105);
  });
});
