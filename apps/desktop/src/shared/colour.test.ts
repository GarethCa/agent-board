import { describe, expect, it } from 'vitest';
import { contrast, fillUnder, mix, readable } from './colour';

describe('colour maths', () => {
  it('measures contrast as WCAG does', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
    expect(contrast('#ffffff', '#777777')).toBe(contrast('#777777', '#ffffff'));
  });

  it('mixes a share of one colour into another, as color-mix does in sRGB', () => {
    expect(mix('#ffffff', '#000000', 0.5)).toBe('#808080');
    expect(mix('#ff0000', '#0000ff', 1)).toBe('#ff0000');
    expect(mix('#ff0000', '#0000ff', 0)).toBe('#0000ff');
  });

  it('keeps a colour that already reads, and nudges one that does not the least it must, away from its background', () => {
    expect(readable('#000000', ['#ffffff'])).toBe('#000000');
    const onLight = readable('#999999', ['#ffffff']);
    expect(contrast(onLight, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(readable('#999999', ['#ffffff'], 3), '#ffffff')).toBeGreaterThanOrEqual(3);
    const onDark = readable('#555555', ['#111111', '#222222']);
    expect(contrast(onDark, '#222222')).toBeGreaterThanOrEqual(4.5);
    expect(contrast(onDark, '#111111')).toBeGreaterThanOrEqual(4.5);
  });

  it('refuses a colour that no nudge makes read', () => {
    expect(() => readable('#808080', ['#000000', '#ffffff'], 7)).toThrow(/can't be made to read/);
  });

  it('darkens a fill until white reads on it, keeping its hue', () => {
    const fill = fillUnder('#89b4fa', '#ffffff');
    expect(contrast('#ffffff', fill)).toBeGreaterThanOrEqual(4.5);
    expect(fill).toBe('#186cf5');
    expect(fillUnder('#3b5bdb', '#ffffff')).toBe('#3b5bdb');
    expect(contrast('#111111', fillUnder('#3b5bdb', '#111111'))).toBeGreaterThanOrEqual(4.5);
  });
});
