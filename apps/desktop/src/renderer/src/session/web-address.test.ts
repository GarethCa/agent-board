import { describe, expect, it } from 'vitest';
import { typedOutlasts } from './web-address';

const at = (row: boolean, page: boolean, window: boolean) => ({ rowFocused: row, pageFocused: page, windowFocused: window });

describe('what is typed in a web tab\'s address row, as its page goes elsewhere', () => {
  it('stays while the row is being typed in: a page that loads while the user types', () => {
    expect(typedOutlasts(at(true, false, true))).toBe(true);
  });

  it('goes once the user has moved on in the window, or into the page (a link clicked there)', () => {
    expect(typedOutlasts(at(false, false, true))).toBe(false);
    expect(typedOutlasts(at(false, true, false))).toBe(false);
  });

  it('stays while nothing in the window has the keyboard: the moment a loading page took it, before it is given back', () => {
    expect(typedOutlasts(at(false, false, false))).toBe(true);
  });
});
