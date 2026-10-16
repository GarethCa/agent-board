import { describe, expect, it } from 'vitest';
import { fitFontSize, parseMarkdown, plainText, wrapLines, type MeasureText } from './sticky-text';

/** Every character half as wide as the font is tall, like a monospace font. */
const mono: MeasureText = (text, size) => text.length * size * 0.5;
const fit = { min: 8, max: 40, lineHeight: 1.25 };

describe('wrapLines', () => {
  it('breaks text into lines at spaces, so each fits the width', () => {
    // 10 px a character: 5 characters to a line.
    expect(wrapLines('aa bb cc dd', 50, 20, mono)).toEqual(['aa bb', 'cc dd']);
  });

  it('keeps line breaks the user typed, and empty lines', () => {
    expect(wrapLines('one\n\ntwo', 100, 20, mono)).toEqual(['one', '', 'two']);
  });

  it('breaks a word too long for the width between characters', () => {
    expect(wrapLines('abcdefghijkl', 50, 20, mono)).toEqual(['abcde', 'fghij', 'kl']);
  });
});

describe('fitFontSize', () => {
  it('uses the largest size for short text', () => {
    expect(fitFontSize('Hi', { width: 200, height: 200 }, mono, fit)).toBe(40);
  });

  it('shrinks the font as the text grows, so it wraps inside the box', () => {
    const box = { width: 200, height: 200 };
    const short = fitFontSize('a few words here', box, mono, fit);
    const long = fitFontSize('a few words here '.repeat(8), box, mono, fit);

    expect(long).toBeLessThan(short);
    const lines = wrapLines('a few words here '.repeat(8), box.width, long, mono);
    expect(lines.length * long * fit.lineHeight).toBeLessThanOrEqual(box.height);
    expect(Math.max(...lines.map((line) => mono(line, long)))).toBeLessThanOrEqual(box.width);
  });

  it('picks the largest size that fits: one size up overflows', () => {
    const box = { width: 160, height: 120 };
    const text = 'the quick brown fox jumps over the lazy dog';
    const size = fitFontSize(text, box, mono, fit);
    const bigger = size + 1;

    expect(wrapLines(text, box.width, bigger, mono).length * bigger * fit.lineHeight).toBeGreaterThan(box.height);
  });

  it('stops at the smallest size when even that overflows', () => {
    expect(fitFontSize('word '.repeat(500), { width: 100, height: 100 }, mono, fit)).toBe(8);
  });

  it('fits an empty note at the largest size', () => {
    expect(fitFontSize('', { width: 100, height: 100 }, mono, fit)).toBe(40);
  });
});

describe('parseMarkdown', () => {
  it('reads paragraphs of plain text', () => {
    expect(parseMarkdown('hello\nworld\n\nagain')).toEqual([
      { type: 'paragraph', lines: [[{ type: 'text', text: 'hello' }], [{ type: 'text', text: 'world' }]] },
      { type: 'paragraph', lines: [[{ type: 'text', text: 'again' }]] },
    ]);
  });

  it('reads bold, italics and links inside a line', () => {
    expect(parseMarkdown('a **b** _c_ *d* [e](https://example.com/x)')).toEqual([
      {
        type: 'paragraph',
        lines: [
          [
            { type: 'text', text: 'a ' },
            { type: 'bold', children: [{ type: 'text', text: 'b' }] },
            { type: 'text', text: ' ' },
            { type: 'italic', children: [{ type: 'text', text: 'c' }] },
            { type: 'text', text: ' ' },
            { type: 'italic', children: [{ type: 'text', text: 'd' }] },
            { type: 'text', text: ' ' },
            { type: 'link', href: 'https://example.com/x', children: [{ type: 'text', text: 'e' }] },
          ],
        ],
      },
    ]);
  });

  it('reads italics inside bold', () => {
    expect(parseMarkdown('**a _b_**')).toEqual([
      {
        type: 'paragraph',
        lines: [
          [
            {
              type: 'bold',
              children: [
                { type: 'text', text: 'a ' },
                { type: 'italic', children: [{ type: 'text', text: 'b' }] },
              ],
            },
          ],
        ],
      },
    ]);
  });

  it('reads bulleted and numbered lists', () => {
    expect(parseMarkdown('- one\n* two\n\n1. first\n2) second')).toEqual([
      { type: 'list', ordered: false, items: [[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]] },
      { type: 'list', ordered: true, start: 1, items: [[{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }]] },
    ]);
  });

  it('leaves unclosed markers and non-web links as text', () => {
    expect(parseMarkdown('**open _x [y](javascript:alert(1))')).toEqual([
      { type: 'paragraph', lines: [[{ type: 'text', text: '**open _x [y](javascript:alert(1))' }]] },
    ]);
  });

  it('only reads https links as links: http stays text', () => {
    expect(parseMarkdown('[a](http://example.com/x)')).toEqual([
      { type: 'paragraph', lines: [[{ type: 'text', text: '[a](http://example.com/x)' }]] },
    ]);
  });

  it('reads `code` inside a line as it is, markers and all', () => {
    expect(parseMarkdown('run `pnpm **check**` now')).toEqual([
      { type: 'paragraph', lines: [[{ type: 'text', text: 'run ' }, { type: 'code', text: 'pnpm **check**' }, { type: 'text', text: ' now' }]] },
    ]);
    expect(parseMarkdown('a `b')).toEqual([{ type: 'paragraph', lines: [[{ type: 'text', text: 'a `b' }]] }]);
    expect(plainText('see `R2`')).toBe('see R2');
  });

  it('does not read underscores inside words as italics', () => {
    expect(parseMarkdown('snake_case_name')).toEqual([
      { type: 'paragraph', lines: [[{ type: 'text', text: 'snake_case_name' }]] },
    ]);
  });
});

describe('plainText', () => {
  it('drops the markdown markers, leaving what is drawn', () => {
    expect(plainText('**Plan** for _today_:\n- [docs](https://x.dev)\n2. ship')).toBe('Plan for today:\n• docs\n2. ship');
  });
});
