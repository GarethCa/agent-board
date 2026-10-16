// A sticky note's text: the little markdown it understands, and the font size that fits it in the note.

/** How wide `text` is, in px, set in the note's font at `size` px. */
export type MeasureText = (text: string, size: number) => number;

export type Inline =
  | { type: 'text' | 'code'; text: string }
  | { type: 'bold' | 'italic'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] };

export type Block =
  | { type: 'paragraph'; lines: Inline[][] }
  | { type: 'list'; ordered: false; items: Inline[][] }
  | { type: 'list'; ordered: true; start: number; items: Inline[][] };

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/;
/** Only https links, the only ones the app opens: anything else (`http:`, `javascript:`, `file:`) stays text. */
const LINK = /^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/;
const WORD_CHARACTER = /\w/;

/**
 * Reads a note's markdown: paragraphs, bulleted and numbered lists, and inside a line **bold**, *italics* (or
 * _italics_), `code` and [links](https://…), https only. Anything else, an unclosed marker included, is plain text.
 */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | undefined;
  for (const line of source.split('\n')) {
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (line.trim() === '') {
      current = undefined;
    } else if (bullet) {
      if (current?.type !== 'list' || current.ordered) blocks.push((current = { type: 'list', ordered: false, items: [] }));
      current.items.push(parseInline(bullet[1]!));
    } else if (numbered) {
      if (current?.type !== 'list' || !current.ordered) {
        blocks.push((current = { type: 'list', ordered: true, start: Number(numbered[1]), items: [] }));
      }
      current.items.push(parseInline(numbered[2]!));
    } else {
      if (current?.type !== 'paragraph') blocks.push((current = { type: 'paragraph', lines: [] }));
      current.lines.push(parseInline(line));
    }
  }
  return blocks;
}

function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const pushText = (piece: string) => {
    const last = out.at(-1);
    if (last?.type === 'text') last.text += piece;
    else out.push({ type: 'text', text: piece });
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const link = LINK.exec(rest);
    if (link) {
      out.push({ type: 'link', href: link[2]!, children: parseInline(link[1]!) });
      i += link[0].length;
      continue;
    }
    if (rest.startsWith('`')) {
      const close = text.indexOf('`', i + 1);
      if (close > i + 1) {
        out.push({ type: 'code', text: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    if (rest.startsWith('**')) {
      const close = text.indexOf('**', i + 2);
      if (close > i + 2) {
        out.push({ type: 'bold', children: parseInline(text.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }
    const marker = text[i]!;
    if (marker === '*' || marker === '_') {
      const close = italicClose(text, i);
      if (close !== undefined) {
        out.push({ type: 'italic', children: parseInline(text.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }
    pushText(marker);
    i += 1;
  }
  return out;
}

/** Where the italics opened at `open` close, if they do. `_` only counts outside words, as in `snake_case`. */
function italicClose(text: string, open: number): number | undefined {
  const marker = text[open]!;
  const isWord = (at: number) => at >= 0 && at < text.length && WORD_CHARACTER.test(text[at]!);
  if (marker === '_' && isWord(open - 1)) return undefined;
  for (let close = text.indexOf(marker, open + 2); close >= 0; close = text.indexOf(marker, close + 1)) {
    if (marker === '_' && isWord(close + 1)) continue;
    return close;
  }
  return undefined;
}

/** The note's text as drawn, markers dropped and bullets drawn, to measure it. */
export function plainText(source: string): string {
  return source
    .split('\n')
    .map((line) => {
      const bullet = BULLET.exec(line);
      if (bullet) return `• ${inlineText(parseInline(bullet[1]!))}`;
      const numbered = NUMBERED.exec(line);
      if (numbered) return `${numbered[1]}. ${inlineText(parseInline(numbered[2]!))}`;
      return inlineText(parseInline(line));
    })
    .join('\n');
}

function inlineText(inlines: Inline[]): string {
  return inlines.map((inline) => ('children' in inline ? inlineText(inline.children) : inline.text)).join('');
}

/**
 * `text` broken into the lines it takes in `width` px at font size `size`: at the user's line breaks, then between
 * words, and inside a word too long for a line of its own.
 */
export function wrapLines(text: string, width: number, size: number, measure: MeasureText): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      const joined = line === '' ? word : `${line} ${word}`;
      if (measure(joined, size) <= width) {
        line = joined;
        continue;
      }
      if (line !== '') lines.push(line);
      line = '';
      for (const character of word) {
        if (line !== '' && measure(line + character, size) > width) {
          lines.push(line);
          line = '';
        }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

export interface FontFit {
  /** The smallest and largest font sizes, px. */
  min: number;
  max: number;
  /** Line height as a multiple of the font size. */
  lineHeight: number;
}

/**
 * The largest whole font size, from `fit.min` to `fit.max`, at which `text` wrapped to the box's width is no taller
 * than the box: a note's font shrinks as its text grows, as on Miro. `fit.min` when nothing fits.
 */
export function fitFontSize(text: string, box: { width: number; height: number }, measure: MeasureText, fit: FontFit): number {
  const fits = (size: number) => wrapLines(text, box.width, size, measure).length * size * fit.lineHeight <= box.height;
  let low = fit.min;
  let high = fit.max;
  if (fits(high)) return high;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) low = middle;
    else high = middle;
  }
  return low;
}
