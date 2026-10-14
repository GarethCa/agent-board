import { describe, expect, it } from 'vitest';
import { clampFontSize, MAX_FONT_SIZE, MIN_FONT_SIZE, sizeKey } from './terminal-size';

describe('terminal text size', () => {
  it('clamps to the limits', () => {
    expect(clampFontSize(2)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(99)).toBe(MAX_FONT_SIZE);
    expect(clampFontSize(14)).toBe(14);
    expect(clampFontSize(NaN)).toBe(MIN_FONT_SIZE);
  });

  it('reads + (or =, the same key unshifted), - and 0', () => {
    expect(sizeKey('+')).toBe('bigger');
    expect(sizeKey('=')).toBe('bigger');
    expect(sizeKey('-')).toBe('smaller');
    expect(sizeKey('0')).toBe('reset');
    expect(sizeKey('a')).toBeUndefined();
  });
});
