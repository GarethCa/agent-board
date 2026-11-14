/** Who has the keyboard as a web tab's page goes to another URL: its address row, its page, or the window at all. */
export interface KeyboardAt {
  rowFocused: boolean;
  pageFocused: boolean;
  windowFocused: boolean;
}

/**
 * Whether what was typed in a web tab's address row stays as its page goes elsewhere. It stays while the row is being
 * typed in, and while nothing in the window has the keyboard: a page that takes it as it loads leaves the row for a
 * moment before the keyboard is given back. It goes once the user has moved on, in the window or into the page.
 */
export function typedOutlasts(at: KeyboardAt): boolean {
  return at.rowFocused || (!at.pageFocused && !at.windowFocused);
}
