import { describe, expect, it } from 'vitest';
import { isRunGateKey, ownTabNotice, runGateShortcut, windowPaneKey } from './window-keys';

const press = (code: string, keys: Partial<Record<'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey', boolean>> = {}) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...keys,
});

describe("a session window's pane keys", () => {
  it('are ⌘T, ⌘W, ⌘D, ⇧⌘D, ⌘1–9 and ⌘⌥ arrows on macOS', () => {
    const mac = (code: string, keys = {}) => windowPaneKey(press(code, { metaKey: true, ...keys }), true);
    expect(mac('KeyT')).toEqual({ kind: 'newTab' });
    expect(mac('KeyW')).toEqual({ kind: 'close' });
    expect(mac('KeyD')).toEqual({ kind: 'split', direction: 'horizontal' });
    expect(mac('KeyD', { shiftKey: true })).toEqual({ kind: 'split', direction: 'vertical' });
    expect(mac('Digit3')).toEqual({ kind: 'tab', digit: 3 });
    expect(mac('ArrowRight', { altKey: true })).toEqual({ kind: 'focus', direction: 'right' });
    expect(mac('KeyX')).toBeUndefined();
    expect(windowPaneKey(press('KeyD', { ctrlKey: true }), true)).toBeUndefined();
  });

  it('are Ctrl+Shift elsewhere, with Ctrl+Shift+Alt+D below and Ctrl+Shift+Alt arrows, leaving Ctrl alone to the terminal', () => {
    const other = (code: string, keys = {}) => windowPaneKey(press(code, { ctrlKey: true, shiftKey: true, ...keys }), false);
    expect(other('KeyT')).toEqual({ kind: 'newTab' });
    expect(other('KeyW')).toEqual({ kind: 'close' });
    expect(other('KeyD')).toEqual({ kind: 'split', direction: 'horizontal' });
    expect(other('KeyD', { altKey: true })).toEqual({ kind: 'split', direction: 'vertical' });
    expect(other('Digit9')).toEqual({ kind: 'tab', digit: 9 });
    expect(other('ArrowLeft', { altKey: true })).toEqual({ kind: 'focus', direction: 'left' });
    expect(windowPaneKey(press('KeyD', { ctrlKey: true }), false)).toBeUndefined();
    expect(windowPaneKey(press('KeyW', { ctrlKey: true }), false)).toBeUndefined();
  });
});

describe('Run gate', () => {
  const key = (fields: Partial<KeyboardEvent>) => ({ metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, code: 'KeyG', ...fields });

  it('is ⌘⇧G on macOS and Ctrl+Shift+G elsewhere, and nothing else', () => {
    expect(isRunGateKey(key({ metaKey: true, shiftKey: true }), true)).toBe(true);
    expect(isRunGateKey(key({ metaKey: true }), true)).toBe(false);
    expect(isRunGateKey(key({ ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isRunGateKey(key({ ctrlKey: true }), false)).toBe(false);
    expect(isRunGateKey(key({ metaKey: true, shiftKey: true, code: 'KeyD' }), true)).toBe(false);
    expect(runGateShortcut(true)).toBe('⌘⇧G');
    expect(runGateShortcut(false)).toBe('Ctrl+Shift+G');
  });
});

describe('the close key on a tab that cannot be closed', () => {
  it('says whose it is: an agent\'s own tab, or a shell\'s only one', () => {
    expect(ownTabNotice('agent')).toBe("An agent's own tab can't be closed.");
    expect(ownTabNotice('shell')).toBe("A shell's only tab can't be closed.");
  });
});
