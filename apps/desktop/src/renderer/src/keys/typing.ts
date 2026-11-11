/**
 * Whether a key press or paste is typing into a field, rather than a board shortcut: a field (a terminal's is its
 * textarea), editable text, or inside something that has taken the keyboard for its own keys (`data-keys-own`, a steps
 * card stepped into). The board's own keys, and its Esc, leave those alone.
 */
export function isTyping(event: Pick<Event, 'target'>): boolean {
  const target = event.target as HTMLElement | null;
  return target !== null && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.closest?.('[data-keys-own]') != null);
}
