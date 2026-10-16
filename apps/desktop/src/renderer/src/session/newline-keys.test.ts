import { describe, expect, it } from 'vitest';
import { macLineEditKey, NEWLINE_SEQUENCES, newlineKey } from './newline-keys';

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

const key = (name: string, modifiers: Partial<Pick<KeyboardEvent, 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey'>> = {}) => ({
  key: name,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  ...modifiers,
});

const onMac = (event: Parameters<typeof macLineEditKey>[0]) => macLineEditKey(event, true);

describe('macLineEditKey', () => {
  it('maps ⌘⌫ to Ctrl-U, ⌘← to Ctrl-A and ⌘→ to Ctrl-E', () => {
    expect(onMac(key('Backspace', { metaKey: true }))).toBe('\x15');
    expect(onMac(key('ArrowLeft', { metaKey: true }))).toBe('\x01');
    expect(onMac(key('ArrowRight', { metaKey: true }))).toBe('\x05');
  });

  it('maps ⌥← and ⌥→ to ESC b and ESC f, and leaves ⌥⌫ to xterm, which sends ESC DEL', () => {
    expect(onMac(key('ArrowLeft', { altKey: true }))).toBe('\x1bb');
    expect(onMac(key('ArrowRight', { altKey: true }))).toBe('\x1bf');
    expect(onMac(key('Backspace', { altKey: true }))).toBeUndefined();
  });

  it('maps nothing off macOS, where ⌘ and ⌥ are not the line-editing keys', () => {
    expect(macLineEditKey(key('Backspace', { metaKey: true }), false)).toBeUndefined();
    expect(macLineEditKey(key('ArrowLeft', { altKey: true }), false)).toBeUndefined();
  });

  it('leaves plain keys and any other modifier mix to xterm', () => {
    expect(onMac(key('Backspace'))).toBeUndefined();
    expect(onMac(key('ArrowLeft'))).toBeUndefined();
    expect(onMac(key('Backspace', { metaKey: true, altKey: true }))).toBeUndefined();
    expect(onMac(key('Backspace', { metaKey: true, shiftKey: true }))).toBeUndefined();
    expect(onMac(key('ArrowLeft', { altKey: true, shiftKey: true }))).toBeUndefined();
    expect(onMac(key('ArrowLeft', { ctrlKey: true }))).toBeUndefined();
    expect(onMac(key('ArrowLeft', { metaKey: true, ctrlKey: true }))).toBeUndefined();
    expect(onMac(key('a', { metaKey: true }))).toBeUndefined();
  });
});
