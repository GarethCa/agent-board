import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOARD_BACKGROUND_LABELS, BOARD_BACKGROUNDS, boardBackgroundOf, DEFAULT_BOARD_BACKGROUND } from './board-background';

const css = readFileSync(join(import.meta.dirname, '..', 'app.css'), 'utf8');

describe('boardBackgroundOf', () => {
  it('reads each background as stored', () => {
    for (const background of BOARD_BACKGROUNDS) expect(boardBackgroundOf(background)).toBe(background);
  });

  it('falls back to the standard desk for none or one this version does not know', () => {
    expect(boardBackgroundOf(undefined)).toBe(DEFAULT_BOARD_BACKGROUND);
    expect(boardBackgroundOf('confetti')).toBe('standard');
  });
});

describe('the backgrounds', () => {
  it('each has a name and a hint for its swatch in Settings', () => {
    for (const background of BOARD_BACKGROUNDS) {
      expect(BOARD_BACKGROUND_LABELS[background].name).not.toBe('');
      expect(BOARD_BACKGROUND_LABELS[background].hint).not.toBe('');
    }
  });

  it('are each drawn by a CSS pattern, never an image', () => {
    for (const background of BOARD_BACKGROUNDS.filter((each) => each !== 'plain')) expect(css).toContain(`[data-board-background='${background}']`);
    const rules = css.slice(css.indexOf('[data-board-background]'), css.indexOf('.board {'));
    expect(rules).not.toMatch(/url\(/);
  });
});
