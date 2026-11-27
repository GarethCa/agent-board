import { describe, expect, it } from 'vitest';
import { WINDOW_KEYS } from '../renderer/src/keys/menu-bar';
import { takesKeyboard, webKey, type WebKey } from './web-keys';

/** The window key a press is handed to the window as, or what else the page does with it. */
const handed = (key: WebKey) => (typeof key === 'object' ? key.window : key);

const press = (code: string, held: { meta?: boolean; control?: boolean; shift?: boolean; alt?: boolean; key?: string } = {}) => ({
  type: 'keyDown' as const,
  key: held.key ?? '',
  code,
  meta: held.meta ?? false,
  control: held.control ?? false,
  shift: held.shift ?? false,
  alt: held.alt ?? false,
});

describe("a key pressed in a web tab's page", () => {
  it("hands the window's own shortcuts to the window on macOS", () => {
    const ids = { KeyW: 'window.closeTab', KeyT: 'window.newTab', KeyD: 'window.splitBeside', KeyK: 'move.spotlight', KeyF: 'window.find', Digit1: 'window.tab', Digit9: 'window.tab', BracketLeft: 'window.previous', BracketRight: 'window.next', KeyI: 'window.details' };
    for (const [code, id] of Object.entries(ids)) expect(handed(webKey(press(code, { meta: true }), true)), code).toBe(id);
    expect(webKey(press('KeyD', { meta: true, shift: true }), true)).toEqual({ window: 'window.splitBelow' });
    expect(webKey(press('ArrowLeft', { meta: true, alt: true }), true)).toEqual({ window: 'window.paneFocus' });
  });

  it('hands ⌘J, the way out to its header, to the window on macOS and Ctrl+Shift+J elsewhere, never plain Ctrl+J', () => {
    expect(webKey(press('KeyJ', { meta: true }), true)).toEqual({ window: 'window.jumpOut' });
    expect(webKey(press('KeyJ', { control: true, shift: true }), false)).toEqual({ window: 'window.jumpOut' });
    expect(webKey(press('KeyJ', { control: true }), false)).toBeUndefined();
  });

  it('keeps ⌘J for the page with the extended keys off, as before there was a way out, and the rest as ever', () => {
    expect(webKey(press('KeyJ', { meta: true }), true, false, false)).toBeUndefined();
    expect(webKey(press('KeyJ', { control: true, shift: true }), false, false, false)).toBeUndefined();
    expect(webKey(press('KeyK', { meta: true }), true, false, false)).toEqual({ window: 'move.spotlight' });
  });

  it('hands ⌘⇧P, park a thought, to the window on macOS and Ctrl+Shift+P elsewhere; plain ⌘P and Ctrl+P stay the page’s', () => {
    expect(webKey(press('KeyP', { meta: true, shift: true }), true)).toEqual({ window: 'move.parkThought' });
    expect(webKey(press('KeyP', { control: true, shift: true }), false)).toEqual({ window: 'move.parkThought' });
    expect(webKey(press('KeyP', { meta: true }), true)).toBeUndefined();
    expect(webKey(press('KeyP', { control: true }), false)).toBeUndefined();
    expect(webKey(press('KeyP', { meta: true, shift: true }), true, false, false)).toBeUndefined();
  });

  it('hands ⌘I to the window on macOS and Ctrl+Shift+I elsewhere, never plain Ctrl+I or ⇧⌘I', () => {
    expect(webKey(press('KeyI', { control: true, shift: true }), false)).toEqual({ window: 'window.details' });
    expect(webKey(press('KeyI', { control: true }), false)).toBeUndefined();
    expect(webKey(press('KeyI', { meta: true, shift: true }), true)).toBeUndefined();
  });

  it("hands the Simplified design's ⌘⌥T and ⌘. to the window, and under Classic keeps them for the page", () => {
    expect(webKey(press('KeyT', { meta: true, alt: true }), true, true)).toEqual({ window: 'window.terminalView' });
    expect(webKey(press('KeyT', { control: true, shift: true, alt: true }), false, true)).toEqual({ window: 'window.terminalView' });
    expect(webKey(press('Period', { meta: true }), true, true)).toEqual({ window: 'window.stopStep' });
    expect(webKey(press('Period', { control: true, shift: true }), false, true)).toEqual({ window: 'window.stopStep' });
    expect(webKey(press('KeyT', { meta: true, alt: true }), true, false)).toBeUndefined();
    expect(webKey(press('Period', { meta: true }), true, false)).toBeUndefined();
    expect(webKey(press('Period', { control: true }), false, true)).toBeUndefined();
  });

  it('keeps editing keys, and plain typing, for the page', () => {
    for (const code of ['KeyC', 'KeyV', 'KeyX', 'KeyA', 'KeyZ', 'KeyL']) expect(webKey(press(code, { meta: true }), true)).toBeUndefined();
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
    expect(webKey(press('KeyW', { control: true, shift: true }), false)).toEqual({ window: 'window.closeTab' });
    expect(webKey(press('Digit2', { control: true, shift: true }), false)).toEqual({ window: 'window.tab' });
    expect(webKey(press('KeyK', { control: true, shift: true }), false)).toEqual({ window: 'move.spotlight' });
    expect(webKey(press('KeyK', { control: true }), false)).toBeUndefined();
    expect(webKey(press('KeyD', { control: true, shift: true, alt: true }), false)).toEqual({ window: 'window.splitBelow' });
    expect(webKey(press('ArrowUp', { control: true, shift: true, alt: true }), false)).toEqual({ window: 'window.paneFocus' });
    expect(webKey(press('KeyW', { control: true }), false)).toBeUndefined();
    expect(webKey(press('KeyC', { control: true, shift: true }), false)).toBeUndefined();
  });
});

describe("the window's keys from the key list", () => {
  it('hands each over as the key it is', () => {
    expect(handed(webKey(press('KeyW', { meta: true }), true))).toBe('window.closeTab');
    expect(handed(webKey(press('Digit3', { meta: true }), true))).toBe('window.tab');
    expect(handed(webKey(press('ArrowUp', { meta: true, alt: true }), true))).toBe('window.paneFocus');
    expect(handed(webKey(press('KeyD', { meta: true, shift: true }), true))).toBe('window.splitBelow');
  });

  it('hands over run the gate, leave, the regions and the tab keys, as a terminal does', () => {
    expect(handed(webKey(press('KeyG', { meta: true, shift: true }), true))).toBe('window.runGate');
    expect(handed(webKey(press('KeyG', { control: true, shift: true }), false))).toBe('window.runGate');
    expect(handed(webKey(press('Escape', { meta: true, key: 'Escape' }), true))).toBe('window.leave');
    expect(handed(webKey(press('F6', { key: 'F6' }), true))).toBe('window.regions');
    expect(handed(webKey(press('F6', { shift: true, key: 'F6' }), false))).toBe('window.regions');
    expect(handed(webKey(press('Tab', { control: true, key: 'Tab' }), true))).toBe('window.nextTab');
    expect(handed(webKey(press('Tab', { control: true, shift: true, key: 'Tab' }), false))).toBe('window.previousTab');
  });

  it('hands over the keys that work from anywhere: the Captain and the cheat sheet', () => {
    expect(handed(webKey(press('KeyM', { meta: true, shift: true }), true))).toBe('move.master');
    expect(handed(webKey(press('Slash', { meta: true }), true))).toBe('move.cheatSheetAnywhere');
  });

  it("keeps a key that is off for the page: the extended keys' with the setting off", () => {
    for (const [code, key] of [['Escape', 'Escape'], ['F6', 'F6'], ['Tab', 'Tab']] as const) {
      expect(webKey(press(code, { meta: code === 'Escape', control: code === 'Tab', key }), true, false, false)).toBeUndefined();
    }
    expect(webKey(press('KeyF', { meta: true }), true, false, false)).toBeUndefined();
    expect(handed(webKey(press('KeyG', { meta: true, shift: true }), true, false, false))).toBe('window.runGate');
  });

  it("keeps bare keys, the terminal's text size, the Overview and a document's keys for the page", () => {
    for (const key of ['Escape', 'Enter']) expect(webKey(press(key, { key }), true)).toBeUndefined();
    expect(webKey(press('Equal', { meta: true, key: '+' }), true)).toBeUndefined();
    expect(webKey(press('Digit0', { meta: true, key: '0' }), true)).toBeUndefined();
    expect(webKey(press('KeyO', { meta: true, shift: true, key: 'o' }), true)).toBeUndefined();
    // The app menu's own: Settings and Close Window, which the menu must still get.
    expect(webKey(press('Comma', { meta: true, key: ',' }), true)).toBeUndefined();
    expect(webKey(press('KeyW', { meta: true, shift: true, key: 'w' }), true)).toBeUndefined();
    expect(webKey(press('KeyS', { meta: true, key: 's' }), true)).toBeUndefined();
    expect(webKey(press('Backslash', { meta: true, key: '\\' }), true)).toBeUndefined();
  });
});

describe("a web tab in a session window of its own", () => {
  it("keeps the keys that window has no handler for, the Captain's, for the page; the switcher, the cheat sheet and Park a thought go to it", () => {
    const popOut = (code: string, held: Parameters<typeof press>[1]) => handed(webKey(press(code, held), true, false, true, WINDOW_KEYS.popOut));
    expect(popOut('KeyM', { meta: true, shift: true })).toBeUndefined();
    expect(popOut('KeyK', { meta: true })).toBe('move.spotlight');
    expect(popOut('Slash', { meta: true })).toBe('move.cheatSheetAnywhere');
    expect(popOut('KeyP', { meta: true, shift: true })).toBe('move.parkThought');
    expect(popOut('KeyW', { meta: true })).toBe('window.closeTab');
  });
});

describe('the keys that take the keyboard from the page', () => {
  it('are those whose field over the window is typed in next, or that move the keyboard in it; the rest leave it with the page', () => {
    for (const id of ['move.spotlight', 'window.jumpOut', 'move.parkThought', 'move.master', 'move.cheatSheetAnywhere', 'window.regions'] as const) expect(takesKeyboard(id)).toBe(true);
    for (const id of ['window.newTab', 'window.closeTab', 'window.splitBeside', 'window.find', 'window.tab', 'window.previous', 'window.details', 'window.runGate'] as const) expect(takesKeyboard(id)).toBe(false);
  });
});
