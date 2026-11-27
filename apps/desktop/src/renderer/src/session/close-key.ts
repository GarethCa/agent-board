// ⌘W on the session window shown on the board (File › Close Tab): it closes that window, wherever the focus is in the
// board's window, the board, the window's header or one of its tabs, and never the board's own window. A tab that can
// be closed, in the focused pane, is closed first, as the window's panes take the press before it gets here; an
// agent's own tab, which can't be, closes the window instead, and a shell's only tab keeps it open with a notice. A
// window holding an unsaved draft stays open, its draft in front, as the leave keys do. Held, the key closes one
// window: Close Tab keeps ⌘W until the key goes up, so the key's repeats never reach Close Window and the board's
// window.
import { createContext, useContext, useEffect, useRef, type RefObject } from 'react';
import { backToDraft, unsavedIn } from '../keys/escape-hatch';
import { heldKey, setMenuBarWhen, useMenuBarWhen } from '../keys/menu-bar-bridge';
import { pressed } from '../keys/registry';
import { closesShownWindow } from './window-keys';

/** A key event as the board's window hears it, with what the controller does to one. */
export type CloseKeyEvent = Parameters<typeof closesShownWindow>[0] &
  Pick<KeyboardEvent, 'key' | 'target'> & { preventDefault(): void; stopImmediatePropagation(): void };

/** The session window shown on the board, as ⌘W closes it. */
export interface ClosingWindow {
  /** Whether an unsaved draft keeps it open: true once the draft is brought back in front. */
  keepsDraft(): boolean;
  close(): void;
}

export interface CloseKeyDeps {
  isMac: boolean;
  /** The window shown on the board now, if any. */
  shown(): ClosingWindow | undefined;
  /** Keeps File › Close Tab on (and so ⌘W off Close Window) while `on`, whether a window is shown or not. */
  hold(on: boolean): void;
  /** Whether the press closing the window now is a key that is down, which goes up later; not a menu item's click. */
  keyDown(): boolean;
  /** Whether a press is in a dialog or menu that has the focus and keeps its keys: any but a session window. */
  inModal(target: EventTarget | null): boolean;
}

/** ⌘W's part of the board's window: the logic, with the window's parts passed in so it is unit-tested. */
export function createCloseKey(deps: CloseKeyDeps) {
  let held = false;
  const release = () => {
    if (!held) return;
    held = false;
    deps.hold(false);
  };
  const isChord = (event: CloseKeyEvent) => pressed('window.closeTab', event, { isMac: deps.isMac });
  return {
    /** Closes the shown window, unless its draft keeps it; ⌘W stays Close Tab's until `released`. */
    close() {
      const shown = deps.shown();
      if (shown === undefined || shown.keepsDraft()) return;
      // A click on the menu item has no key to go up and let go: nothing to hold.
      if (deps.keyDown()) {
        held = true;
        deps.hold(true);
      }
      shown.close();
    },
    /** A key press before anything hears it: the held key's repeats, after a close, are kept from everything, the menu too. */
    repeat(event: CloseKeyEvent) {
      if (!held || !event.repeat || !isChord(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    /** A key press, once whatever has the focus has had it. */
    keydown(event: CloseKeyEvent) {
      if (deps.shown() === undefined || !closesShownWindow(event, deps.isMac) || deps.inModal(event.target)) return;
      event.preventDefault();
      this.close();
    },
    /** The key or its modifier going up, or the window losing the focus: ⌘W is the menu's to give again. */
    released(event?: Pick<KeyboardEvent, 'code' | 'key'>) {
      if (event === undefined || event.code === 'KeyW' || event.key === 'Meta' || event.key === 'Control' || event.key === 'Shift') release();
    },
  };
}

/**
 * ⌘W on a tab that can't be closed. An agent's own tab closes the window shown on the board; a shell's only tab leaves
 * its window open, as a shell's tabs are what ⌘W closes there. Anywhere else, or for a shell, it says why nothing
 * closed, once however long the key is held.
 */
export function pressOwnTab(owner: 'agent' | 'shell', repeat: boolean, closeWindow: (() => void) | undefined, notice: () => void): void {
  if (repeat) return;
  if (owner === 'agent' && closeWindow !== undefined) closeWindow();
  else notice();
}

/** How the session window shown on the board closes, for its panes; none anywhere else (an expanded tile, a pop-up, a window of its own). */
const ShownWindowClose = createContext<(() => void) | undefined>(undefined);
export const ShownWindowCloseProvider = ShownWindowClose.Provider;
export const useShownWindowClose = (): (() => void) | undefined => useContext(ShownWindowClose);

/** Whether the focus is in a dialog or menu that keeps its keys: any but a session window, a dialog too. */
const inModal = (target: EventTarget | null): boolean => {
  const held = target instanceof Element ? target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') : null;
  return held !== null && !held.matches('.session-window');
};

const HELD = Symbol('closing');
let shown: ClosingWindow | undefined;
let closer: ReturnType<typeof createCloseKey> | undefined;
let hearing: KeyboardEvent | undefined;

/** The board's window's one controller, its listeners added once: they outlive the window they close. */
function boardCloser(): ReturnType<typeof createCloseKey> {
  if (closer !== undefined) return closer;
  const made = createCloseKey({
    isMac: navigator.platform.startsWith('Mac'),
    shown: () => shown,
    hold: (on) => setMenuBarWhen('sessionWindow', HELD, on),
    // Every close runs as a key press is heard, the window's own or its panes' for their own tab: the last the window heard.
    keyDown: () => hearing !== undefined && heldKey(hearing),
    inModal,
  });
  window.addEventListener(
    'keydown',
    (event) => {
      hearing = event;
      made.repeat(event);
    },
    true,
  );
  window.addEventListener('keydown', (event) => made.keydown(event));
  window.addEventListener('keyup', (event) => made.released(event), true);
  window.addEventListener('blur', () => made.released());
  closer = made;
  return made;
}

/**
 * While `onClose` is given (the window is shown on the board), turns File › Close Tab on and closes the window on ⌘W,
 * a press nothing in the window took first, as its menu item presses it where the focus is. Returns how the window
 * closes for its panes' own ⌘W, with the same draft guard and hold.
 */
export function useCloseKey(root: RefObject<HTMLElement | null>, onClose: (() => void) | undefined): (() => void) | undefined {
  const on = onClose !== undefined;
  useMenuBarWhen('sessionWindow', on);
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!on) return;
    const self: ClosingWindow = {
      keepsDraft: () => {
        const draft = root.current && unsavedIn(root.current);
        if (!draft) return false;
        backToDraft(draft);
        return true;
      },
      close: () => latest.current?.(),
    };
    boardCloser();
    shown = self;
    return () => {
      if (shown === self) shown = undefined;
    };
  }, [on, root]);
  return on ? () => boardCloser().close() : undefined;
}
