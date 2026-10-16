import { describe, expect, it } from 'vitest';
import { clampFontSize, MAX_FONT_SIZE, MIN_FONT_SIZE, sizeKey, terminalSizeKey } from './terminal-size';

describe('terminal text size', () => {
  it('clamps to the limits', () => {
    expect(clampFontSize(2)).toBe(MIN_FONT_SIZE);
    expect(clampFontSize(99)).toBe(MAX_FONT_SIZE);
    expect(clampFontSize(14)).toBe(14);
    expect(clampFontSize(NaN)).toBe(MIN_FONT_SIZE);
  });

  it('reads + (or =, the same key unshifted), - and 0', () => {
    expect(sizeKey('+')).toBe('bigger');
    expect(sizeKey('=')).toBe('bigger');
    expect(sizeKey('-')).toBe('smaller');
    expect(sizeKey('0')).toBe('reset');
    expect(sizeKey('a')).toBeUndefined();
  });
});

describe('the terminal size keys', () => {
  const key = (code: string, key: string, held: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>>) => ({ code, key, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...held });

  it('are ⌘+ ⌘- ⌘0 on macOS', () => {
    expect(terminalSizeKey(key('Equal', '=', { metaKey: true }), true)).toBe('bigger');
    expect(terminalSizeKey(key('Minus', '-', { metaKey: true }), true)).toBe('smaller');
    expect(terminalSizeKey(key('Digit0', '0', { metaKey: true }), true)).toBe('reset');
    expect(terminalSizeKey(key('Minus', '-', { ctrlKey: true }), true)).toBeUndefined();
  });

  it('are Ctrl+Shift elsewhere, so plain Ctrl+- stays undo', () => {
    expect(terminalSizeKey(key('Equal', '+', { ctrlKey: true, shiftKey: true }), false)).toBe('bigger');
    expect(terminalSizeKey(key('Minus', '_', { ctrlKey: true, shiftKey: true }), false)).toBe('smaller');
    expect(terminalSizeKey(key('Digit0', ')', { ctrlKey: true, shiftKey: true }), false)).toBe('reset');
    expect(terminalSizeKey(key('Minus', '-', { ctrlKey: true }), false)).toBeUndefined();
    expect(terminalSizeKey(key('Equal', '=', { ctrlKey: true }), false)).toBeUndefined();
    expect(terminalSizeKey(key('Digit0', '0', { ctrlKey: true }), false)).toBeUndefined();
    expect(terminalSizeKey(key('Minus', '_', { ctrlKey: true, shiftKey: true, altKey: true }), false)).toBeUndefined();
  });
});
