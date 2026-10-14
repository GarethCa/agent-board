import { describe, expect, it } from 'vitest';
import { layoutText, textItemSize, type TextBox } from './text-layout';

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
