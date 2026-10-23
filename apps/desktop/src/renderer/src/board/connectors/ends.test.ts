import { describe, expect, it } from 'vitest';
import { labelNear, lineDashes } from './ends';
import { samplePath } from './geometry';

describe('the dashes of a connector’s line', () => {
  it('is plain for a solid line drawn to both ends, and a repeating dash for a dashed one', () => {
    expect(lineDashes(100, 0, 0, false)).toBeUndefined();
    expect(lineDashes(100, 0, 0, true)).toBe('5 4');
  });

  it('stops a solid line short of a hollow end at either end', () => {
    expect(lineDashes(100, 0, 10, false)).toBe('0 0 90 11');
    expect(lineDashes(100, 16, 0, false)).toBe('0 16 84 1');
  });

  it('dashes up to where a hollow end begins, and draws nothing past it', () => {
    expect(lineDashes(20, 0, 10, true)).toBe('0 0 5 4 1 11');
    expect(lineDashes(19, 0, 10, true)).toBe('0 0 5 15');
  });

  it('draws nothing of a line too short to reach past its ends', () => {
    expect(lineDashes(20, 16, 10, false)).toBe('0 16 0 11');
  });
});

describe('a double-click on a line', () => {
  const across = (length: number) => samplePath(`M0,0 L${length},0`);

  it('types the label of the end it is near, else the middle one', () => {
    expect(labelNear({ x: 20, y: 5 }, across(300))).toBe('startLabel');
    expect(labelNear({ x: 270, y: -8 }, across(300))).toBe('endLabel');
    expect(labelNear({ x: 150, y: 0 }, across(300))).toBe('label');
    expect(labelNear({ x: 60, y: 0 }, across(300))).toBe('label');
  });

  it('keeps a middle on a short line, whose ends are near only within a quarter of it each', () => {
    expect(labelNear({ x: 30, y: 0 }, across(60))).toBe('label');
    expect(labelNear({ x: 20, y: 0 }, across(60))).toBe('label');
    expect(labelNear({ x: 10, y: 0 }, across(60))).toBe('startLabel');
    expect(labelNear({ x: 52, y: 0 }, across(60))).toBe('endLabel');
  });

  it('measures along the line, so the middle of a U whose ends are close is its middle', () => {
    const u = samplePath('M0,0 L200,0 L200,40 L0,40');
    expect(labelNear({ x: 200, y: 20 }, u)).toBe('label');
    expect(labelNear({ x: 10, y: 40 }, u)).toBe('endLabel');
  });
});
