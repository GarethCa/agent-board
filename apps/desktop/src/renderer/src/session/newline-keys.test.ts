import { describe, expect, it } from 'vitest';
import { NEWLINE_SEQUENCES, newlineKey } from './newline-keys';

const enter = (modifiers: Partial<Pick<KeyboardEvent, 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>> = {}) => ({
  key: 'Enter',
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...modifiers,
});

describe('newlineKey', () => {
  it("gives each harness's newline sequence: ESC CR, which both TUIs read as Alt+Enter, a line break", () => {
    expect(NEWLINE_SEQUENCES).toEqual({ claude: '\x1b\r', codex: '\x1b\r' });
  });

  it('maps Shift+Enter and Option+Enter in an agent terminal to its harness sequence', () => {
    for (const harness of ['claude', 'codex'] as const) {
      expect(newlineKey(harness, enter({ shiftKey: true }))).toBe(NEWLINE_SEQUENCES[harness]);
      expect(newlineKey(harness, enter({ altKey: true }))).toBe(NEWLINE_SEQUENCES[harness]);
    }
  });

  it('leaves plain Enter to submit, and Enter with Ctrl or ⌘ to the terminal', () => {
    expect(newlineKey('claude', enter())).toBeUndefined();
    expect(newlineKey('claude', enter({ ctrlKey: true, shiftKey: true }))).toBeUndefined();
    expect(newlineKey('claude', enter({ metaKey: true, shiftKey: true }))).toBeUndefined();
  });

  it('leaves other keys, and every key in a plain shell, alone', () => {
    expect(newlineKey('claude', { ...enter({ shiftKey: true }), key: 'a' })).toBeUndefined();
    expect(newlineKey(null, enter({ shiftKey: true }))).toBeUndefined();
    expect(newlineKey(null, enter({ altKey: true }))).toBeUndefined();
  });
});
