import xtermHeadless from '@xterm/headless';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { describe, expect, test } from 'vitest';
import { bufferLinks, type BufferRow } from './terminal-links';

const COLS = 60;

/** A terminal with the widths `TerminalPane` gives it, written `data`, its rows read the way the link provider reads them. */
async function written(data: string) {
  const terminal = new xtermHeadless.Terminal({ cols: COLS, rows: 4, allowProposedApi: true });
  terminal.loadAddon(new UnicodeGraphemesAddon());
  await new Promise<void>((done) => terminal.write(data, done));
  const rowAt = (y: number): BufferRow | undefined => {
    const row = terminal.buffer.active.getLine(y - 1);
    if (row === undefined) return undefined;
    const cells = Array.from({ length: row.length }, (_, x) => {
      const cell = row.getCell(x);
      return cell === undefined || cell.getWidth() === 0 ? undefined : cell.getChars();
    });
    return { cells, wrapped: row.isWrapped };
  };
  return { terminal, rowAt };
}

/** One of each kind of emoji the TUIs draw two cells wide. */
const EMOJI = {
  'a single code point': '🚀',
  'a symbol with a variation selector (❤️)': '❤️',
  'another with a variation selector (⚠️)': '⚠️',
  'a skin tone': '👍🏽',
  'a ZWJ family': '👨‍👩‍👧',
  'a flag': '🇬🇧',
};

describe('emoji in the terminal', () => {
  test.each(Object.entries(EMOJI))('%s takes two cells, so the text after it is in the third', async (_kind, emoji) => {
    const { terminal } = await written(`${emoji}x`);
    const line = terminal.buffer.active.getLine(0)!;
    expect(line.getCell(0)!.getWidth()).toBe(2);
    expect(line.getCell(2)!.getChars()).toBe('x');
  });

  test('a link after a line of every kind is at the column it is drawn at', async () => {
    const url = 'https://example.com/docs';
    // 2 cells for each of six emoji and 1 for each of the six spaces: the address starts in column 19 (1-based).
    const { rowAt } = await written(`${Object.values(EMOJI).join(' ')} ${url}`);
    const [link] = bufferLinks(rowAt, 1, COLS);
    expect(link).toEqual({ url, start: { x: 19, y: 1 }, end: { x: 19 + url.length - 1, y: 1 } });
  });
});
