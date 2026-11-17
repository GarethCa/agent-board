import { describe, expect, it } from 'vitest';
import { pressClosesPeek, type Pressed } from './peek-press';

/** A press target inside the elements matching `within`. */
const inside = (...within: string[]): Pressed => ({ closest: (selector) => (within.includes(selector) ? {} : null) });

describe('a press that closes a list card peek', () => {
  it('is a main-button press on the board: empty board, a zone body or a tile', () => {
    expect(pressClosesPeek(inside('.react-flow'), 0)).toBe(true);
  });

  it('is not a press in the peek itself', () => {
    expect(pressClosesPeek(inside('.react-flow', '.listcard-peek-popover'), 0)).toBe(false);
    expect(pressClosesPeek(inside('.listcard-peek-popover'), 0)).toBe(false);
  });

  it('is not a press off the board, such as a toast, a menu or a dialog, which the popover judges for itself', () => {
    expect(pressClosesPeek(inside(), 0)).toBe(false);
  });

  it('is not a press with another button, or on nothing', () => {
    expect(pressClosesPeek(inside('.react-flow'), 1)).toBe(false);
    expect(pressClosesPeek(inside('.react-flow'), 2)).toBe(false);
    expect(pressClosesPeek(null, 0)).toBe(false);
  });
});
