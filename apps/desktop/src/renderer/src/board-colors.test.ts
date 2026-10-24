import { describe, expect, it } from 'vitest';
import { STICKY_COLORS } from '@agent-board/daemon/protocol';
import { boardPaint, connectorPaint, fillPaint, shapeColors, slotPaint, stickyPaint } from './board-colors';
import { contrast } from '../../shared/colour';
import { shapeData } from './board/items/text-style';

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

describe('slot colours', () => {
  it('draws a colour in a slot as its theme token, and one in none as it is', () => {
    expect(slotPaint('teal', '#087f5b')).toBe('var(--paint-teal)');
    expect(slotPaint(null, '#087f5b')).toBe('#087f5b');
  });

  it('draws a fill in a slot as its tint, the tile as the tile, and no fill as none', () => {
    expect(fillPaint('blue', '#d0ebff')).toBe('var(--shape-fill-blue)');
    expect(fillPaint('tile', '#ffffff')).toBe('var(--raised)');
    expect(fillPaint(null, '#ffe8d6')).toBe('#ffe8d6');
    expect(fillPaint(null, null)).toBe('none');
  });

  it("draws a connector's colour as its slot, read from the colour, or as it is if it is no slot's", () => {
    expect(connectorPaint('#3b5bdb')).toBe('var(--paint-blue)');
    expect(connectorPaint('#3B5BDB')).toBe('var(--paint-blue)');
    expect(connectorPaint('#e8590c')).toBe('#e8590c');
  });
});

describe('shapeColors', () => {
  it("draws a shape saved before slots in the slots its colours were, and any other colour as it is", () => {
    const legacy = shapeData({ fill: '#fff3bf', stroke: '#d9480f', textColor: '#2b2a27' });
    expect(shapeColors(legacy, true)).toEqual({ fill: 'var(--shape-fill-yellow)', stroke: 'var(--paint-orange)', text: 'var(--shape-ink-ink)' });
    expect(shapeColors(shapeData({ fill: '#ffffff', stroke: '#e8590c' }), true)).toMatchObject({ fill: 'var(--raised)', stroke: '#e8590c' });
  });

  it('keeps a fixed colour fixed, even one that is a slot’s', () => {
    expect(shapeColors(shapeData({ stroke: '#3b5bdb', strokeSlot: null }), true).stroke).toBe('#3b5bdb');
  });

  it("draws text in a slot on a slot's fill in the slot's text on fills, and on no fill in its paint", () => {
    expect(shapeColors(shapeData({ fill: '#d0ebff', fillSlot: 'blue', textColorSlot: 'red', textColor: '#c92a2a' }), true).text).toBe('var(--shape-ink-red)');
    expect(shapeColors(shapeData({ fill: null, textColorSlot: 'red', textColor: '#c92a2a' }), true).text).toBe('var(--paint-red)');
    expect(shapeColors(shapeData({ fill: '#d0ebff', textColor: '#123456', textColorSlot: null }), true).text).toBe('#123456');
  });

  it('draws text on a fixed fill so it reads on it in every theme', () => {
    const { text } = shapeColors(shapeData({ fill: '#3a3a3a', fillSlot: null, textColorSlot: 'ink' }), true);
    expect(contrast(text, '#3a3a3a')).toBeGreaterThanOrEqual(4.5);
    // Outside its outline (an actor's name), text is on the desk.
    expect(shapeColors(shapeData({ fill: '#3a3a3a', fillSlot: null, textColorSlot: 'ink' }), false).text).toBe('var(--paint-ink)');
  });
});

describe('boardPaint', () => {
  it('lists each sticky and paint token with the stored colour the light theme draws it in', () => {
    const paints = boardPaint();
    expect(paints.get('--sticky-yellow')).toBe('#fff3a3');
    expect(paints.get('--paint-ink')).toBe('#2b2a27');
    expect(paints.get('--paint-accent')).toBe('#364fc7');
    expect(paints.size).toBe(STICKY_COLORS.length + 12);
  });
});
