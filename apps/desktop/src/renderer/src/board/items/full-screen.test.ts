import { describe, expect, it } from 'vitest';
import { focusBack, iconPress } from './full-screen';

describe('a press on a folded icon', () => {
  it('opens the peek on one click', () => expect(iconPress(1, true)).toBe('peek'));
  it('opens full screen on the second click of a double-click', () => expect(iconPress(2, true)).toBe('full'));
  it('stays full screen on a third click', () => expect(iconPress(3, true)).toBe('full'));
  it('opens the peek from a key, which has no clicks', () => expect(iconPress(0, true)).toBe('peek'));
  it('opens the peek on a double-click when the object has no full screen', () => expect(iconPress(2, false)).toBe('peek'));
});

describe('where the focus goes as a full screen closes', () => {
  const el = (connected: boolean) => ({ isConnected: connected }) as HTMLElement;
  it('goes back where it was, when that is still on the page', () => {
    const opener = el(true);
    expect(focusBack(opener, () => el(true))).toBe(opener);
  });
  it('goes to the object when what opened it went (the peek closed)', () => {
    const object = el(true);
    expect(focusBack(el(false), () => object)).toBe(object);
  });
  it('goes to the object when nothing had the focus', () => {
    const object = el(true);
    expect(focusBack(null, () => object)).toBe(object);
  });
});
