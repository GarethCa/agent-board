import { describe, expect, it } from 'vitest';
import { SHAPE_FILLS, SHAPE_STROKES, STICKY_COLORS, TEXT_COLORS } from '@agent-board/daemon/protocol';
import { boardPaint, shapeInk, stickyPaint, themedColor } from './board-colors';

describe('stickyPaint', () => {
  it('draws each stored note colour as its theme tokens, by name', () => {
    expect(stickyPaint('#fff3a3')).toEqual({ color: 'var(--sticky-yellow)', ink: 'var(--sticky-yellow-ink)' });
    expect(stickyPaint('#ffffff')).toEqual({ color: 'var(--sticky-white)', ink: 'var(--sticky-white-ink)' });
    for (const { value } of STICKY_COLORS) expect(stickyPaint(value).color).toMatch(/^var\(--sticky-[a-z]+\)$/);
  });

  it('draws a colour that is no preset as it is, in the theme’s ink for paper', () => {
    expect(stickyPaint('#123456')).toEqual({ color: '#123456', ink: 'var(--sticky-other-ink)' });
  });

  it('matches stored colours whatever their case', () => {
    expect(stickyPaint('#FFF3A3').color).toBe('var(--sticky-yellow)');
  });
});

describe('themedColor', () => {
  it('draws every preset a text item, shape or connector stores as a theme token', () => {
    for (const { value } of [...TEXT_COLORS, ...SHAPE_STROKES]) expect(themedColor(value)).toMatch(/^var\(--paint-[a-z]+\)$/);
    for (const { value } of SHAPE_FILLS) expect(themedColor(value)).toMatch(/^var\(--(?:shape-fill|sticky)-[a-z]+\)$/);
    for (const { value } of STICKY_COLORS) expect(themedColor(value)).toMatch(/^var\(--sticky-[a-z]+\)$/);
  });

  it('keeps a colour that is no preset', () => {
    expect(themedColor('#123456')).toBe('#123456');
  });

  it('gives the same name the same token in every palette', () => {
    expect(themedColor('#2b2a27')).toBe('var(--paint-ink)');
    expect(themedColor('#3b5bdb')).toBe('var(--paint-blue)');
  });
});

describe('shapeInk', () => {
  it('draws the text colour a filled shape stores as its theme token for text on paper', () => {
    for (const { value } of [...TEXT_COLORS, ...SHAPE_STROKES]) expect(shapeInk(value)).toMatch(/^var\(--shape-ink-[a-z]+\)$/);
    expect(shapeInk('#2b2a27')).toBe('var(--shape-ink-ink)');
    expect(shapeInk('#123456')).toBe('#123456');
  });
});

describe('boardPaint', () => {
  it('lists each token with the stored colour the light theme draws it in', () => {
    const paints = boardPaint();
    expect(paints.get('--sticky-yellow')).toBe('#fff3a3');
    expect(paints.get('--paint-ink')).toBe('#2b2a27');
    expect(paints.get('--shape-fill-blue')).toBe('#d0ebff');
    expect(paints.get('--shape-ink-blue')).toBe('#3b5bdb');
    const values = (presets: readonly { value: string }[]) => new Set(presets.map(({ value }) => value)).size;
    expect(paints.size).toBe(values([...STICKY_COLORS, ...TEXT_COLORS, ...SHAPE_FILLS, ...SHAPE_STROKES]) + values([...TEXT_COLORS, ...SHAPE_STROKES]));
  });
});
