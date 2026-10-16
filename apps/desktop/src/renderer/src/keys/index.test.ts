import { describe, expect, it } from 'vitest';
import { historyStep, paneFocusShortcut, windowShortcut, withPaneFocusShortcut, withWindowShortcut } from '.';

const press = (code: string, keys: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...keys,
});

describe("a session window's shortcuts", () => {
  it('are ⌘ on macOS, with Shift told apart, and leave Ctrl to the terminal', () => {
    expect(windowShortcut(press('KeyT', { metaKey: true }), true)).toBe('KeyT');
    expect(windowShortcut(press('KeyD', { metaKey: true, shiftKey: true }), true)).toBe('Shift+KeyD');
    expect(windowShortcut(press('KeyD', { ctrlKey: true }), true)).toBeUndefined();
    expect(windowShortcut(press('KeyD', { metaKey: true, altKey: true }), true)).toBeUndefined();
  });

  it('are Ctrl+Shift elsewhere: Ctrl alone (EOF, transpose, Esc) and the Windows key stay the terminal’s', () => {
    expect(windowShortcut(press('KeyD', { ctrlKey: true, shiftKey: true }), false)).toBe('KeyD');
    expect(windowShortcut(press('Digit1', { ctrlKey: true, shiftKey: true }), false)).toBe('Digit1');
    expect(windowShortcut(press('KeyD', { ctrlKey: true }), false)).toBeUndefined();
    expect(windowShortcut(press('KeyT', { metaKey: true }), false)).toBeUndefined();
  });

  it('are written as the platform presses them', () => {
    expect([withWindowShortcut('T', true), withWindowShortcut('T', false)]).toEqual(['⌘T', 'Ctrl+Shift+T']);
  });
});

describe("moving between a session window's panes", () => {
  it('is ⌘⌥ and an arrow on macOS, nothing else held', () => {
    expect(paneFocusShortcut(press('ArrowLeft', { metaKey: true, altKey: true }), true)).toBe('left');
    expect(paneFocusShortcut(press('ArrowDown', { metaKey: true, altKey: true }), true)).toBe('down');
    expect(paneFocusShortcut(press('ArrowLeft', { metaKey: true }), true)).toBeUndefined();
    expect(paneFocusShortcut(press('ArrowLeft', { metaKey: true, altKey: true, shiftKey: true }), true)).toBeUndefined();
    expect(paneFocusShortcut(press('KeyA', { metaKey: true, altKey: true }), true)).toBeUndefined();
  });

  it('is Ctrl+Shift+Alt and an arrow elsewhere, leaving Ctrl+arrow and Ctrl+Shift+arrow to the terminal', () => {
    expect(paneFocusShortcut(press('ArrowUp', { ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe('up');
    expect(paneFocusShortcut(press('ArrowUp', { ctrlKey: true, shiftKey: true }), false)).toBeUndefined();
    expect(paneFocusShortcut(press('ArrowUp', { ctrlKey: true, altKey: true }), false)).toBeUndefined();
  });

  it('is written as the platform presses it', () => {
    expect([withPaneFocusShortcut('←', true), withPaneFocusShortcut('←', false)]).toEqual(['⌘⌥←', 'Ctrl+Shift+Alt+←']);
  });
});

describe('the history keys', () => {
  // The command key held either way, whichever platform runs the test.
  const command = (key: string, more: { shiftKey?: boolean; altKey?: boolean } = {}) => ({ key, metaKey: true, ctrlKey: true, shiftKey: false, altKey: false, ...more });

  it('are ⌘Z to undo, and ⇧⌘Z or ⌘Y to redo', () => {
    expect(historyStep(command('z'))).toBe('undo');
    expect(historyStep(command('Z', { shiftKey: true }))).toBe('redo');
    expect(historyStep(command('y'))).toBe('redo');
  });

  it('are nothing else: no command key, Alt held, or another key', () => {
    expect(historyStep({ ...command('z'), metaKey: false, ctrlKey: false })).toBeUndefined();
    expect(historyStep(command('z', { altKey: true }))).toBeUndefined();
    expect(historyStep(command('y', { shiftKey: true }))).toBeUndefined();
    expect(historyStep(command('x'))).toBeUndefined();
  });
});
