import { describe, expect, it } from 'vitest';
import { clampFontSize, stepFontSize, textData } from './text-style';

describe('textData font size', () => {
  it('keeps the look of an item saved before font sizes, from its size', () => {
    expect(textData({ size: 'h1' }).fontSize).toBe(44);
    expect(textData({ size: 'h2' }).fontSize).toBe(28);
    expect(textData({ size: 'body' }).fontSize).toBe(16);
  });

  it('defaults to body text at 16px', () => {
    expect(textData({}).fontSize).toBe(16);
    expect(textData({ fontSize: 'big' }).fontSize).toBe(16);
  });

  it('takes a saved font size over the size, within the limits', () => {
    expect(textData({ size: 'h1', fontSize: 48 }).fontSize).toBe(48);
    expect(textData({ fontSize: 1 }).fontSize).toBe(8);
    expect(textData({ fontSize: 9999 }).fontSize).toBe(200);
  });
});

describe('stepFontSize', () => {
  it('steps to the next preset', () => {
    expect(stepFontSize(16, 1)).toBe(20);
    expect(stepFontSize(16, -1)).toBe(14);
  });

  it('steps from a size between presets', () => {
    expect(stepFontSize(44, 1)).toBe(48);
    expect(stepFontSize(44, -1)).toBe(32);
  });

  it('stops at the limits', () => {
    expect(stepFontSize(96, 1)).toBe(200);
    expect(stepFontSize(12, -1)).toBe(8);
    expect(clampFontSize(stepFontSize(8, -1))).toBe(8);
  });
});

describe('textData minHeight', () => {
  it('is 0 unless a height was dragged to', () => {
    expect(textData({}).minHeight).toBe(0);
    expect(textData({ minHeight: -5 }).minHeight).toBe(0);
    expect(textData({ minHeight: 120 }).minHeight).toBe(120);
  });
});
