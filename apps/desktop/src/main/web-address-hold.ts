/** The inputs that are the user moving into a page: a click or a tap in it. */
const INTO_PAGE = new Set(['mouseDown', 'touchStart', 'gestureTapDown']);

/** A web tab's page, as the hold watches it: when it takes the keyboard, the inputs it gets, and giving it the keyboard. */
export interface HeldPage {
  on(event: 'focus', listener: () => void): unknown;
  on(event: 'input-event', listener: (event: unknown, input: { type: string }) => void): unknown;
  focus(): void;
  isFocused(): boolean;
}

/** The window's renderer the page is drawn in, which has the address row. */
export interface HeldWindow {
  focus(): void;
  isDestroyed(): boolean;
}

/**
 * Keeps the keyboard in a web tab's address row while the user types there. A page can take the keyboard by itself
 * as it loads, which would move the typing into the page; while the row is typed in, a page that takes the keyboard
 * gives it back to the window. A click or tap in the page is the user's own move there, and ends the hold, as does
 * the app giving the page the keyboard, or the page going. Tabs are named by their key: the window that opened them and their id.
 */
export function addressRowHold() {
  const typing = new Set<string>();
  return {
    /** The window says whether the tab's address row holds the keyboard and text typed in it. */
    typing(key: string, on: boolean): void {
      if (on) typing.add(key);
      else typing.delete(key);
    },
    /** Watches the tab's page, drawn in `window`, for taking the keyboard from its address row. */
    watch(key: string, page: HeldPage, window: HeldWindow): void {
      page.on('focus', () => {
        if (typing.has(key) && !window.isDestroyed()) window.focus();
      });
      // On macOS a click focuses the page before its press arrives, so the page was just handed back: the press ends
      // the hold here and gives the page the keyboard, whatever the window says after. The window's own `typing`
      // messages, sent as the row blurs, refocuses and blurs again, arrive in order and end with false.
      page.on('input-event', (_event, input) => {
        if (INTO_PAGE.has(input.type) && typing.delete(key) && !page.isFocused()) page.focus();
      });
    },
    /** The app gives the tab's page the keyboard itself (the ⌘K switcher closing over it, the find bar), or the page goes. */
    release(key: string): void {
      typing.delete(key);
    },
  };
}
