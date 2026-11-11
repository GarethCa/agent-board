import { describe, expect, it } from 'vitest';
import { isTyping } from './typing';

const at = (tagName: string, inside: string[] = [], isContentEditable = false) =>
  ({ target: { tagName, isContentEditable, closest: (selector: string) => (selector.split(', ').some((one) => inside.includes(one)) ? {} : null) } }) as unknown as Event;

describe('where keys are typed', () => {
  it("is a field (a terminal's too, its textarea), editable text, or a control that keeps its keys", () => {
    expect(isTyping(at('INPUT'))).toBe(true);
    expect(isTyping(at('TEXTAREA'))).toBe(true);
    expect(isTyping(at('SELECT'))).toBe(true);
    expect(isTyping(at('DIV', [], true))).toBe(true);
    expect(isTyping(at('BUTTON', ['[data-keys-own]']))).toBe(true);
  });

  it('is not a button, the board, or no target at all', () => {
    expect(isTyping(at('BUTTON'))).toBe(false);
    expect(isTyping(at('DIV'))).toBe(false);
    expect(isTyping({ target: null } as Event)).toBe(false);
    expect(isTyping({ target: {} } as unknown as Event)).toBe(false);
  });
});
