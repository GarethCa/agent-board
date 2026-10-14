import { describe, expect, it } from 'vitest';
import { clampTextHeight, layoutText, resizedText, textItemSize, type TextBox } from './text-layout';

// Every character is 10px wide.
const measure = (text: string) => text.length * 10;
const box: TextBox = { padding: 5, lineHeight: 20, minWidth: 40, slack: 2 };

describe('layoutText', () => {
  it('keeps the lines it is given when nothing limits the width', () => {
    expect(layoutText('one two\nthree', measure)).toEqual({
      lines: ['one two', 'three'],
      width: 70,
    });
  });

  it('wraps at spaces to fit the width', () => {
    expect(layoutText('aa bb cc dd', measure, 50).lines).toEqual(['aa bb', 'cc dd']);
  });

  it('gives a word wider than the width a line of its own', () => {
    expect(layoutText('a bbbbbbbb c', measure, 30).lines).toEqual(['a', 'bbbbbbbb', 'c']);
  });

  it('keeps blank lines', () => {
    expect(layoutText('a\n\nb', measure, 100).lines).toEqual(['a', '', 'b']);
  });
});

describe('textItemSize', () => {
  it('is as wide as the longest line, plus padding and caret room, and as tall as the lines', () => {
    expect(textItemSize('hello\nhi', measure, box)).toEqual({
      width: 50 + 2 + 10,
      height: 2 * 20 + 10,
    });
  });

  it('is never under the minimum width', () => {
    expect(textItemSize('', measure, box)).toEqual({ width: 40, height: 30 });
  });

  it('keeps a fixed width and grows taller as the text wraps', () => {
    expect(textItemSize('aa bb cc dd', measure, box, 60)).toEqual({
      width: 60,
      height: 2 * 20 + 10,
    });
    expect(textItemSize('aa bb cc dd', measure, box, 40)).toEqual({
      width: 40,
      height: 4 * 20 + 10,
    });
  });
});

describe('resizedText', () => {
  const from = { width: 200, height: 40 };
  it('holds the box to the height it was dragged to, when that is taller than its text', () => {
    expect(resizedText({ from, to: { width: 200, height: 150 }, minHeight: 0, needs: 40 })).toEqual({ widthChanged: false, minHeight: 150 });
  });

  it('lets the box fit its text again when dragged down to it', () => {
    expect(resizedText({ from: { width: 200, height: 150 }, to: { width: 200, height: 40 }, minHeight: 150, needs: 40 }).minHeight).toBe(0);
  });

  it('keeps what was held, or nothing, when a drag changes only the width', () => {
    expect(resizedText({ from, to: { width: 300, height: 40 }, minHeight: 0, needs: 20 })).toEqual({ widthChanged: true, minHeight: 0 });
    expect(resizedText({ from: { width: 200, height: 150 }, to: { width: 300, height: 150 }, minHeight: 150, needs: 20 }).minHeight).toBe(150);
  });

  it('is not a width change when only the height moved', () => {
    expect(resizedText({ from, to: { width: 200.4, height: 90 }, minHeight: 0, needs: 40 }).widthChanged).toBe(false);
  });
});

describe('clampTextHeight', () => {
  it('is as tall as the text, or as the height dragged to if more', () => {
    expect(clampTextHeight(0, 60)).toBe(60);
    expect(clampTextHeight(200, 60)).toBe(200);
  });
});
