import { describe, expect, it } from 'vitest';
import { webKey } from './web-keys';

const press = (code: string, held: { meta?: boolean; control?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  type: 'keyDown' as const,
  code,
  meta: held.meta ?? false,
  control: held.control ?? false,
  shift: held.shift ?? false,
  alt: held.alt ?? false,
});

describe("a key pressed in a web tab's page", () => {
  it("hands the window's own shortcuts to the window on macOS", () => {
    for (const code of ['KeyW', 'KeyT', 'KeyD', 'KeyK', 'Digit1', 'Digit9', 'BracketLeft', 'BracketRight', 'KeyI']) expect(webKey(press(code, { meta: true }), true)).toBe('window');
    expect(webKey(press('KeyD', { meta: true, shift: true }), true)).toBe('window');
    expect(webKey(press('ArrowLeft', { meta: true, alt: true }), true)).toBe('window');
  });

  it('keeps editing keys, and plain typing, for the page', () => {
    for (const code of ['KeyC', 'KeyV', 'KeyX', 'KeyA', 'KeyZ', 'KeyL', 'KeyF']) expect(webKey(press(code, { meta: true }), true)).toBeUndefined();
    expect(webKey(press('KeyW'), true)).toBeUndefined();
    expect(webKey(press('KeyW', { control: true }), true)).toBeUndefined();
    expect(webKey({ ...press('KeyW', { meta: true }), type: 'keyUp' }, true)).toBeUndefined();
  });

  it('reloads the page, not the app, on ⌘R, and skips its cache on ⇧⌘R', () => {
    expect(webKey(press('KeyR', { meta: true }), true)).toBe('reload');
    expect(webKey(press('KeyR', { control: true }), false)).toBe('reload');
    expect(webKey(press('KeyR', { meta: true, shift: true }), true)).toBe('hardReload');
    expect(webKey(press('KeyR', { control: true, shift: true }), false)).toBe('hardReload');
  });

  it("off macOS, hands over Ctrl+Shift chords and leaves Ctrl's own keys to the page", () => {
    expect(webKey(press('KeyW', { control: true, shift: true }), false)).toBe('window');
    expect(webKey(press('Digit2', { control: true, shift: true }), false)).toBe('window');
    expect(webKey(press('KeyK', { control: true, shift: true }), false)).toBe('window');
    expect(webKey(press('KeyK', { control: true }), false)).toBeUndefined();
    expect(webKey(press('KeyD', { control: true, shift: true, alt: true }), false)).toBe('window');
    expect(webKey(press('ArrowUp', { control: true, shift: true, alt: true }), false)).toBe('window');
    expect(webKey(press('KeyW', { control: true }), false)).toBeUndefined();
    expect(webKey(press('KeyC', { control: true, shift: true }), false)).toBeUndefined();
  });
});
