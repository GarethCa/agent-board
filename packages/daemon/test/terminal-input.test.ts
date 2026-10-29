import { describe, expect, it } from 'vitest';
import { answerInput, draftAfterInput, submitsDraft } from '../src/terminal-input.ts';

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
