import { describe, expect, it } from 'vitest';
import { motionDuration } from './theme';

describe('motionDuration', () => {
  it('keeps the duration', () => {
    expect(motionDuration(200, false)).toBe(200);
  });

  it('is none with reduced motion, so the view jumps', () => {
    expect(motionDuration(200, true)).toBe(0);
  });
});
