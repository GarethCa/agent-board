import { describe, expect, it } from 'vitest';
import { MAX_TEXT_FONT_SIZE, MIN_TEXT_FONT_SIZE } from '@agent-board/daemon/protocol';
import { clampFontSize, completeShapeData, newShapeData, shapeData, stepFontSize, textData } from './text-style';

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

describe('shapeData text style', () => {
  it('gives a shape saved without one the defaults', () => {
    expect(shapeData({})).toMatchObject({ fontSize: null, align: 'center', mono: false, attributes: '', methods: '' });
  });

  it('gives a class its sections, empty if not saved, and mono unless saved as not', () => {
    expect(shapeData({ shape: 'class', attributes: '+ id: string', methods: 7 })).toMatchObject({ attributes: '+ id: string', methods: '', mono: true });
    expect(shapeData({ shape: 'interface-box', mono: false }).mono).toBe(false);
    expect(newShapeData('class')).toMatchObject({ attributes: '', methods: '', mono: true });
    expect(newShapeData('rectangle').mono).toBe(false);
  });

  it('keeps a font size within what a text item may have, and drops one that is not a number', () => {
    expect(shapeData({ fontSize: 4 }).fontSize).toBe(MIN_TEXT_FONT_SIZE);
    expect(shapeData({ fontSize: 9999 }).fontSize).toBe(MAX_TEXT_FONT_SIZE);
    expect(shapeData({ fontSize: 20 }).fontSize).toBe(20);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '20', null]) expect(shapeData({ fontSize: bad }).fontSize).toBeNull();
  });

  it('falls back to centred for an alignment it does not know, and to not mono for a non-boolean', () => {
    expect(shapeData({ align: 'justify' }).align).toBe('center');
    expect(shapeData({ align: 'right', mono: true })).toMatchObject({ align: 'right', mono: true });
    expect(shapeData({ mono: 'yes' }).mono).toBe(false);
  });
});

describe('completeShapeData', () => {
  it('gives a shape saved before some keys existed each one as it is read, so putting it back clears what was set since', () => {
    expect(completeShapeData({ shape: 'class', text: 'Session' })).toMatchObject({ text: 'Session', attributes: '', methods: '', align: 'center', mono: true, fontSize: null });
  });

  it("keeps the shape's own data as saved, a kind this app doesn't know included", () => {
    expect(completeShapeData({ shape: 'hexagon-3d', align: 'left', extra: 1 })).toMatchObject({ shape: 'hexagon-3d', align: 'left', extra: 1, attributes: '' });
  });
});

