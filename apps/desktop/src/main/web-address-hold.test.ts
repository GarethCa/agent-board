import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { addressRowHold } from './web-address-hold';

/** A page's contents and the window that shows it, as the hold watches them: the page's events, and who has the keyboard. */
function fakes() {
  const page = Object.assign(new EventEmitter(), { focused: false, focus: vi.fn(() => void (page.focused = true)), isFocused: () => page.focused });
  const owner = { focus: vi.fn(() => void (page.focused = false)), isDestroyed: () => false };
  return { page, owner };
}

describe("a web tab's page, watched while its address row is typed in", () => {
  it('gives the keyboard back to the window when it takes it while the row is typed in', () => {
    const hold = addressRowHold();
    const { page, owner } = fakes();
    hold.watch('w1:t1', page, owner);
    page.emit('focus');
    expect(owner.focus).not.toHaveBeenCalled();
    hold.typing('w1:t1', true);
    page.focused = true;
    page.emit('focus');
    expect(owner.focus).toHaveBeenCalledOnce();
    expect(page.isFocused()).toBe(false);
  });

  it('takes the keyboard back for the page on a click in it, which ends the hold', () => {
    const hold = addressRowHold();
    const { page, owner } = fakes();
    hold.watch('w1:t1', page, owner);
    hold.typing('w1:t1', true);
    // The click focuses the page before its press arrives: handed back, then given to the page on the press.
    page.focused = true;
    page.emit('focus');
    page.emit('input-event', {}, { type: 'mouseDown' });
    expect(page.focus).toHaveBeenCalledOnce();
    expect(page.isFocused()).toBe(true);
    page.emit('focus');
    expect(owner.focus).toHaveBeenCalledOnce();
  });

  it('ends on a tap as on a click', () => {
    for (const tap of ['touchStart', 'gestureTapDown']) {
      const hold = addressRowHold();
      const { page, owner } = fakes();
      hold.watch('w1:t1', page, owner);
      hold.typing('w1:t1', true);
      page.emit('input-event', {}, { type: tap });
      expect(page.focus).toHaveBeenCalledOnce();
      page.emit('focus');
      expect(owner.focus).not.toHaveBeenCalled();
    }
  });

  it("doesn't end for a pointer passing over the page, a wheel or a release", () => {
    const hold = addressRowHold();
    const { page, owner } = fakes();
    hold.watch('w1:t1', page, owner);
    hold.typing('w1:t1', true);
    for (const passing of ['mouseMove', 'mouseEnter', 'mouseWheel', 'mouseUp']) page.emit('input-event', {}, { type: passing });
    expect(page.focus).not.toHaveBeenCalled();
    page.emit('focus');
    expect(owner.focus).toHaveBeenCalledOnce();
  });

  it('ends when the window says the row is no longer typed in', () => {
    const hold = addressRowHold();
    const { page, owner } = fakes();
    hold.watch('w1:t1', page, owner);
    hold.typing('w1:t1', true);
    hold.typing('w1:t1', false);
    page.emit('focus');
    expect(owner.focus).not.toHaveBeenCalled();
  });

  it('holds only the tab whose row is typed in', () => {
    const hold = addressRowHold();
    const { page, owner } = fakes();
    hold.watch('w1:t2', page, owner);
    hold.typing('w1:t1', true);
    page.emit('focus');
    expect(owner.focus).not.toHaveBeenCalled();
  });

  it('leaves a page alone on a click when its row was not typed in', () => {
    const hold = addressRowHold();
    const { page, owner } = fakes();
    hold.watch('w1:t1', page, owner);
    page.emit('input-event', {}, { type: 'mouseDown' });
    expect(page.focus).not.toHaveBeenCalled();
    expect(owner.focus).not.toHaveBeenCalled();
  });

  it('lets a page the app gave the keyboard, or one that went, keep it', () => {
    const hold = addressRowHold();
    const { page, owner } = fakes();
    hold.watch('w1:t1', page, owner);
    hold.typing('w1:t1', true);
    hold.release('w1:t1');
    page.emit('focus');
    expect(owner.focus).not.toHaveBeenCalled();
  });

  it("doesn't reach for a window that has gone", () => {
    const hold = addressRowHold();
    const { page } = fakes();
    const owner = { focus: vi.fn(), isDestroyed: () => true };
    hold.watch('w1:t1', page, owner);
    hold.typing('w1:t1', true);
    page.emit('focus');
    expect(owner.focus).not.toHaveBeenCalled();
  });
});
