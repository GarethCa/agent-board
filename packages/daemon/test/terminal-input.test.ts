import { describe, expect, it } from 'vitest';
import { answerInput, draftAfterInput, pastePieces, promptRows, submittedText, submitsDraft } from '../src/terminal-input.ts';

describe('submitsDraft', () => {
  it('is Enter on a draft: one the user had, or text typed before it in the same write', () => {
    expect(submitsDraft(true, '\r')).toBe(true);
    expect(submitsDraft(false, 'Say hi\r')).toBe(true);
    expect(submitsDraft(false, '\x1b[200~pasted\x1b[201~\r')).toBe(true);
  });

  it('is not Enter at an empty prompt or on a screen, nor a draft cleared before its Enter, nor text left unsent', () => {
    expect(submitsDraft(false, '\r')).toBe(false);
    expect(submitsDraft(false, '\rSay hi')).toBe(false);
    expect(submitsDraft(true, '\x15\r')).toBe(false);
    expect(submitsDraft(true, '\x03')).toBe(false);
    expect(submitsDraft(false, '\x1b[B\r')).toBe(false);
  });
});

describe('draftAfterInput', () => {
  it('starts a draft on typed or pasted text', () => {
    expect(draftAfterInput(false, 'h')).toBe(true);
    expect(draftAfterInput(false, 'é')).toBe(true);
    expect(draftAfterInput(false, '\x1b[200~pasted\x1b[201~')).toBe(true);
  });

  it('ignores focus and mouse reports, arrow keys and other control keys', () => {
    for (const data of ['\x1b[I', '\x1b[O', '\x1b[<0;12;5M', '\x1b[M !!', '\x1b[A', '\x1bOP', '\x1b', '\x7f', '\t']) {
      expect(draftAfterInput(false, data), JSON.stringify(data)).toBe(false);
      expect(draftAfterInput(true, data), JSON.stringify(data)).toBe(true);
    }
  });

  it('ends the draft when the line is submitted or cleared, unless more is typed after', () => {
    expect(draftAfterInput(true, '\r')).toBe(false);
    expect(draftAfterInput(true, 'done\r')).toBe(false);
    expect(draftAfterInput(true, '\x03')).toBe(false);
    expect(draftAfterInput(true, '\x15')).toBe(false);
    expect(draftAfterInput(false, 'one\rtwo')).toBe(true);
  });
});

describe('answerInput', () => {
  it('types a one-line message as it is, trimmed, and flattens nothing else', () => {
    expect(answerInput('  Ship it  ')).toBe('Ship it');
  });

  it('pastes a message of several lines as a terminal pastes it: bracketed, each line break a return', () => {
    expect(answerInput('one\r\ntwo\n\nthree\n')).toBe('\x1b[200~one\rtwo\r\rthree\x1b[201~');
  });

  it('pastes one line longer than 512 bytes, which a harness reading it as keys may not keep whole', () => {
    const short = 'é'.repeat(256);
    expect(answerInput(short)).toBe(short);
    expect(answerInput(`${short}a`)).toBe(`\x1b[200~${short}a\x1b[201~`);
  });

  it('pastes one line when asked to', () => {
    expect(answerInput('/tmp/shot.png', true)).toBe('\x1b[200~/tmp/shot.png\x1b[201~');
  });

  it('keeps control characters out of a paste, so its text cannot end it early or press keys', () => {
    expect(answerInput('a\x1b[201~\x03b\tc\nd')).toBe('\x1b[200~a[201~b\tc\rd\x1b[201~');
  });

  it('keeps C1 controls out too, as a one-character CSI could end a paste', () => {
    expect(answerInput('a\x9b201~b\x85c\nd')).toBe('\x1b[200~a201~bc\rd\x1b[201~');
  });

  it('keeps them out of a typed line too, so it cannot press keys or start a paste', () => {
    expect(answerInput('stop\x03 here \x1b[200~please')).toBe('stop here [200~please');
  });
});

describe('pastePieces', () => {
  const inside = (piece: string) => piece.slice('\x1b[200~'.length, -'\x1b[201~'.length);
  const breaks = (piece: string) => piece.split('\r').length - 1;

  it('leaves alone what a harness keeps as it is: typed text, and a paste too short to fold', () => {
    expect(pastePieces('Ship it')).toEqual(['Ship it']);
    expect(pastePieces('\x1b[200~one\rtwo\rthree\x1b[201~')).toEqual(['\x1b[200~one\rtwo\rthree\x1b[201~']);
    const fits = 'a'.repeat(600);
    expect(pastePieces(`\x1b[200~${fits}\x1b[201~`)).toEqual([`\x1b[200~${fits}\x1b[201~`]);
  });

  it('cuts a long line at spaces, every piece its own paste, and loses nothing', () => {
    const text = Array.from({ length: 800 }, (_, index) => `word${index}`).join(' ');
    const pieces = pastePieces(answerInput(text));
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.startsWith('\x1b[200~') && piece.endsWith('\x1b[201~')).toBe(true);
      expect(inside(piece).length).toBeLessThanOrEqual(600);
    }
    expect(pieces.map(inside).join('')).toBe(text);
    // Every cut falls just after a space: no word is split.
    for (const piece of pieces.slice(0, -1)) expect(inside(piece).endsWith(' ')).toBe(true);
    expect(submittedText(pieces.join(''))).toBe(text);
  });

  it('cuts many short lines so no piece has more than two line breaks, keeping them all', () => {
    const text = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const pieces = pastePieces(answerInput(text));
    for (const piece of pieces) expect(breaks(piece)).toBeLessThanOrEqual(2);
    expect(pieces.map(inside).join('').replaceAll('\r', '\n')).toBe(text);
  });

  it('keeps a run of blank lines, and cuts a word with no space in it without halving a character', () => {
    const blank = pastePieces(answerInput(`a${'\n'.repeat(9)}b`));
    for (const piece of blank) expect(breaks(piece)).toBeLessThanOrEqual(2);
    expect(blank.map(inside).join('')).toBe(`a${'\r'.repeat(9)}b`);

    const emoji = '😀'.repeat(700);
    const cut = pastePieces(answerInput(emoji));
    expect(cut.length).toBeGreaterThan(1);
    for (const piece of cut) expect(inside(piece)).toMatch(/^(😀)+$/u);
    expect(cut.map(inside).join('')).toBe(emoji);
  });

  it('counts a tab as the four spaces a harness makes of it, but writes it as it is', () => {
    const text = `start${'\t'.repeat(300)}\nend`;
    const pieces = pastePieces(answerInput(text));
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(inside(piece).replaceAll('\t', '    ').length).toBeLessThanOrEqual(600);
    expect(pieces.map(inside).join('').replaceAll('\r', '\n')).toBe(text);
  });

  it('leaves whole a message longer than was ever tried in pieces', () => {
    const inputOf = (length: number) => answerInput('word '.repeat(length / 5));
    expect(pastePieces(inputOf(30_000)).length).toBeGreaterThan(1);
    expect(pastePieces(inputOf(30_100))).toEqual([inputOf(30_100)]);
    const tabs = answerInput(`a${'\t'.repeat(7_600)}b`);
    expect(pastePieces(tabs)).toEqual([tabs]);
  });

  it('leaves whole a message of more pieces than were ever tried in one write', () => {
    const linesOf = (count: number) => answerInput(Array.from({ length: count }, () => 'x').join('\n'));
    expect(pastePieces(linesOf(398))).toHaveLength(199);
    expect(pastePieces(linesOf(400))).toEqual([linesOf(400)]);
  });

  it('leaves whole a long message starting with ! or /, as a small first piece of one could run as a command', () => {
    for (const mark of ['!', '/']) {
      const input = answerInput(`${mark}${'word '.repeat(300)}`);
      expect(pastePieces(input)).toEqual([input]);
    }
  });
});

describe('promptRows', () => {
  it('counts the lines of what was typed, and the rows a long one may wrap to, however it was pasted', () => {
    expect(promptRows('one line')).toBe(1);
    expect(promptRows('\x1b[200~one\rtwo\x1b[201~\x1b[200~\rthree\x1b[201~')).toBe(3);
    expect(promptRows('x'.repeat(100))).toBe(6);
  });
});
