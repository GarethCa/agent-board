import { describe, expect, it } from 'vitest';
import { cardOption, type CardKey, type Focus } from './question-card-keys';

const press = (key: string, fields: Partial<CardKey> = {}): CardKey => ({ key, repeat: false, defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, ...fields });

/** Focus on an element matching `self`, inside the elements `within` (selector → its `data-id`, or null). */
function focusOn(self: string, within: Record<string, string | null> = {}, editable = false): Focus {
  const all: Record<string, string | null> = { [self]: null, ...within };
  return {
    closest: (selector) => {
      const hit = Object.keys(all).find((known) => selector.split(', ').includes(known));
      return hit === undefined ? null : { getAttribute: () => all[hit] ?? null };
    },
    matches: (selector) => selector.split(', ').includes(self),
    isContentEditable: editable,
  };
}

const CARD = 'question:a1';
const body = focusOn('body');
const cardNode = focusOn('.react-flow__node', { '.react-flow__node': CARD });

describe('cardOption: which option a key answers on a question card', () => {
  it('takes 1–9 for its options with the card itself focused, or the board with the card selected alone', () => {
    expect(cardOption(press('2'), cardNode, CARD, false, 2)).toBe(1);
    expect(cardOption(press('1'), body, CARD, true, 2)).toBe(0);
    expect(cardOption(press('1'), focusOn('.react-flow__pane'), CARD, true, 2)).toBe(0);
    expect(cardOption(press('1'), null, CARD, true, 2)).toBe(0);
  });

  it('answers nothing for a key it has no option for, or a chord', () => {
    expect(cardOption(press('3'), cardNode, CARD, true, 2)).toBeUndefined();
    expect(cardOption(press('0'), cardNode, CARD, true, 9)).toBeUndefined();
    expect(cardOption(press('a'), cardNode, CARD, true, 9)).toBeUndefined();
    expect(cardOption(press('1', { metaKey: true }), cardNode, CARD, true, 2)).toBeUndefined();
  });

  it('answers once: never a key another control already took, nor a held key’s repeats', () => {
    // Another question's inbox row picked with this key, and stopped it there.
    expect(cardOption(press('1', { defaultPrevented: true }), body, CARD, true, 2)).toBeUndefined();
    expect(cardOption(press('1', { repeat: true }), cardNode, CARD, true, 2)).toBeUndefined();
  });

  it('leaves the key to whatever else has focus, even with the card selected alone', () => {
    // A button outside the board: the Needs-you pill, an inbox option, a zoom button.
    expect(cardOption(press('1'), focusOn('button'), CARD, true, 2)).toBeUndefined();
    // Another card, or a tile, on the board.
    expect(cardOption(press('1'), focusOn('.react-flow__node', { '.react-flow__node': 'question:a2' }), CARD, true, 2)).toBeUndefined();
    expect(cardOption(press('1'), focusOn('button', { '.react-flow__node': 'agent:a2' }), CARD, true, 2)).toBeUndefined();
  });

  it('never takes a digit typed into a field: the card’s reply, a terminal, a contenteditable note', () => {
    expect(cardOption(press('1'), focusOn('input', { '.react-flow__node': CARD }), CARD, true, 2)).toBeUndefined();
    expect(cardOption(press('1'), focusOn('textarea'), CARD, true, 2)).toBeUndefined();
    expect(cardOption(press('1'), focusOn('div', {}, true), CARD, true, 2)).toBeUndefined();
  });

  it('takes the board’s key only for the card selected alone', () => {
    expect(cardOption(press('1'), body, CARD, false, 2)).toBeUndefined();
  });
});
