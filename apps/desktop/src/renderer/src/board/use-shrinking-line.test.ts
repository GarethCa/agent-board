import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AT_THE_CAP } from './PortholeTileGallery';
import { fitLine, LINE_STEPS, type LineMeasure } from './use-shrinking-line';

const tokensCss = readFileSync(join(import.meta.dirname, '..', 'tokens.css'), 'utf8');

/** The tokens of one block of tokens.css: the first `:root {` is Classic's, and the Simplified design has its own. */
const blockOf = (selector: string) => {
  const start = tokensCss.indexOf(`${selector} {`);
  return tokensCss.slice(start, tokensCss.indexOf('\n}', start));
};
const CLASSIC = blockOf(':root');
const SIMPLIFIED = blockOf(":root[data-design='simplified']");

/** A token's value under a design, through any token it names: Simplified's own, else Classic's. */
function tokenOf(design: 'classic' | 'simplified', name: string): string {
  const pattern = new RegExp(`${name}:\\s*([^;]+);`);
  const value = ((design === 'simplified' ? SIMPLIFIED.match(pattern) : null) ?? CLASSIC.match(pattern))?.[1]?.trim();
  if (value === undefined) throw new Error(`no ${name} in tokens.css`);
  return value.startsWith('var(') ? tokenOf(design, value.slice(4, -1)) : value;
}

const WIDTH = 184; // a Porthole line beside its robot
const BOX = 60;

/**
 * Lays `text` out in whole words on lines `width` px wide, each character about 0.47 of the text size wide (the app's
 * font, Manrope, as drawn: the gallery's line at the cap takes five lines at 12px, so more than 0.465, and four at
 * 11.5px, so at most 0.485), and gives the height it takes. A wider font gives its own `charWidth`.
 */
function wrapped(text: string, fontSize: number, lineHeight: number, charWidth = 0.47, width = WIDTH): number {
  const perLine = Math.floor(width / (fontSize * charWidth));
  let lines = 1;
  let used = 0;
  for (const word of text.split(' ')) {
    const wants = used === 0 ? word.length : used + 1 + word.length;
    if (wants <= perLine) used = wants;
    else {
      lines += Math.ceil(word.length / perLine);
      used = word.length % perLine || perLine;
    }
  }
  return lines * lineHeight;
}

/** The fitter as a tile runs it, its steps resolved from a design's tokens; `tried` lists the sizes it drew. */
function fit(text: string, { design = 'classic', command = false, charWidth = 0.47 }: { design?: 'classic' | 'simplified'; command?: boolean; charWidth?: number } = {}) {
  const token = (name: string) => tokenOf(design, name);
  const steps = LINE_STEPS[command ? 'command' : 'sans'];
  const tried: string[] = [];
  const result = fitLine(BOX, steps.length, (step): LineMeasure => {
    const [size, line] = steps[step]!;
    const fontSize = token(size);
    const lineHeight = parseFloat(token(line));
    tried.push(fontSize);
    return { fontSize, lineHeight, textHeight: wrapped(text, parseFloat(fontSize), lineHeight, charWidth) };
  });
  return { ...result, size: token(steps[result.step]![0]), tried };
}

const words = (count: number, word: string) => Array.from({ length: count }, () => word).join(' ');

describe("a glance tile's line in its fixed box", () => {
  it('draws a short line at body size, on up to three lines', () => {
    expect(fit('Running checks: 2 of 3 suites passed')).toEqual({ step: 0, size: '13px', tried: ['13px'] });
  });

  it('takes the next size down for a line of about 110 characters', () => {
    const line = 'Moving the session ids into the daemon so every window reads one list, then the tests for it all';
    expect(line.length).toBeGreaterThan(90);
    expect(fit(`${line} to go.`)).toMatchObject({ step: 1, size: '12px' });
  });

  it('takes a smaller step for a 120-character line of long words, and it still fits', () => {
    const line = words(8, 'reconfigurations').slice(0, 120);
    expect(line).toHaveLength(120);
    expect(fit(line)).not.toHaveProperty('clamp');
  });

  it("fits the gallery's line at the cap, in the app's font, two steps down", () => {
    expect(AT_THE_CAP).toHaveLength(120);
    expect(fit(AT_THE_CAP)).toEqual({ step: 2, size: '11.5px', tried: ['13px', '12px', '11.5px'] });
  });

  it('fits it at the last step in a wide font, one whose characters are about 0.52 of its size', () => {
    // DejaVu Sans as drawn: the line takes five lines at 11px (so more than 0.507) and four at 10.5px (so at most 0.531).
    expect(fit(AT_THE_CAP, { charWidth: 0.52 })).toEqual({ step: 3, size: '10.5px', tried: ['13px', '12px', '11.5px', '10.5px'] });
  });

  it('counts whole lines, so a last line that overhangs its box by a pixel still fits', () => {
    expect(fitLine(BOX, 1, () => ({ fontSize: '12px', lineHeight: 15, textHeight: 61 }))).toEqual({ step: 0 });
  });

  it('clamps past the last step to the lines that fit, for text no cap holds', () => {
    expect(fit(words(40, 'question'))).toEqual({ step: 3, clamp: 4, size: '10.5px', tried: ['13px', '12px', '11.5px', '10.5px'] });
  });

  it("under Simplified steps 13, 12, 11 then 10.5, and a command's mono steps collapse to 12 then 11", () => {
    expect(fit(words(40, 'question'), { design: 'simplified' })).toMatchObject({ step: 3, clamp: 4, size: '10.5px', tried: ['13px', '12px', '11px', '10.5px'] });
    expect(fit(words(40, 'pnpm'), { design: 'simplified', command: true })).toMatchObject({ step: 1, clamp: 4, size: '11px', tried: ['12px', '11px', '11px'] });
    expect(fit(words(40, 'pnpm'), { command: true })).toMatchObject({ step: 2, tried: ['12px', '11.5px', '11px'] });
  });
});
