import { describe, expect, it, vi } from 'vitest';
import { createCloseKey, pressOwnTab, type CloseKeyDeps, type CloseKeyEvent } from './close-key';

const cmdW = (more: Partial<CloseKeyEvent> = {}): CloseKeyEvent & { prevented: boolean; stopped: boolean } => {
  const event = {
    key: 'w',
    code: 'KeyW',
    metaKey: true,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    target: null,
    prevented: false,
    stopped: false,
    preventDefault() {
      event.prevented = true;
      event.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      event.stopped = true;
    },
    ...more,
  };
  return event;
};

function setUp(more: Partial<CloseKeyDeps> = {}, draft = false) {
  const close = vi.fn();
  const holds: boolean[] = [];
  let open = true;
  const window = { keepsDraft: vi.fn(() => draft), close: () => (close(), (open = false)) };
  const closer = createCloseKey({ isMac: true, shown: () => (open ? window : undefined), hold: (on) => holds.push(on), keyDown: () => true, inModal: () => false, ...more });
  return { closer, close, holds, window, reopen: () => (open = true) };
}

describe('⌘W on the session window shown on the board', () => {
  it('closes it when nothing in it took the press: the focus on the board or in its header', () => {
    const { closer, close } = setUp();
    const press = cmdW();
    closer.keydown(press);
    expect(close).toHaveBeenCalledOnce();
    expect(press.prevented).toBe(true);
  });

  it("leaves it open for a press a tab's close took, in a dialog or menu with the focus, or with no window shown", () => {
    const { closer, close } = setUp();
    closer.keydown(cmdW({ defaultPrevented: true }));
    expect(close).not.toHaveBeenCalled();
    const modal = setUp({ inModal: () => true });
    modal.closer.keydown(cmdW());
    expect(modal.close).not.toHaveBeenCalled();
    const none = setUp({ shown: () => undefined });
    const press = cmdW();
    none.closer.keydown(press);
    expect(press.prevented).toBe(false);
  });

  it('keeps a window holding an unsaved draft open, the draft brought back', () => {
    const { closer, close, holds, window } = setUp({}, true);
    closer.keydown(cmdW());
    expect(window.keepsDraft).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(holds).toEqual([]);
  });

  it("held, closes one window: ⌘W stays Close Tab's, and its repeats are kept from the menu, until the key goes up", () => {
    const { closer, close, holds } = setUp();
    closer.keydown(cmdW());
    expect(holds).toEqual([true]);
    const repeat = cmdW({ repeat: true });
    closer.repeat(repeat);
    expect(repeat.prevented && repeat.stopped).toBe(true);
    closer.keydown(repeat);
    expect(close).toHaveBeenCalledOnce();
    // Another key going up keeps the hold; W, or ⌘, lets it go.
    closer.released({ code: 'KeyA', key: 'a' });
    expect(holds).toEqual([true]);
    closer.released({ code: 'KeyW', key: 'w' });
    expect(holds).toEqual([true, false]);
    const later = cmdW({ repeat: true });
    closer.repeat(later);
    expect(later.prevented).toBe(false);
  });

  it("holds nothing for a click on File › Close Tab, which no key goes up after, so the next ⌘W is Close Window's", () => {
    const { closer, close, holds } = setUp({ keyDown: () => false });
    closer.keydown(cmdW());
    expect(close).toHaveBeenCalledOnce();
    expect(holds).toEqual([]);
    const repeat = cmdW({ repeat: true });
    closer.repeat(repeat);
    expect(repeat.prevented).toBe(false);
  });

  it('lets the hold go when the window loses the focus, and keeps no repeat it never closed for', () => {
    const { closer, holds } = setUp();
    const repeat = cmdW({ repeat: true });
    closer.repeat(repeat);
    expect(repeat.prevented).toBe(false);
    closer.close();
    closer.released();
    expect(holds).toEqual([true, false]);
  });
});

describe("⌘W on a tab that can't be closed", () => {
  it("closes the window shown on the board from an agent's own tab, once for a held key", () => {
    const closeWindow = vi.fn();
    const notice = vi.fn();
    pressOwnTab('agent', false, closeWindow, notice);
    pressOwnTab('agent', true, closeWindow, notice);
    expect(closeWindow).toHaveBeenCalledOnce();
    expect(notice).not.toHaveBeenCalled();
  });

  it("keeps the window open on a shell's only tab, and says so once for a held key", () => {
    const closeWindow = vi.fn();
    const notice = vi.fn();
    pressOwnTab('shell', false, closeWindow, notice);
    pressOwnTab('shell', true, closeWindow, notice);
    expect(closeWindow).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledOnce();
  });

  it('says why nothing closed anywhere else: an expanded tile, a pop-up, a window of its own', () => {
    const notice = vi.fn();
    pressOwnTab('agent', false, undefined, notice);
    pressOwnTab('agent', true, undefined, notice);
    pressOwnTab('shell', false, undefined, notice);
    expect(notice).toHaveBeenCalledTimes(2);
  });
});
