/** A key press, as far as a question card cares. */
export interface CardKey {
  key: string;
  repeat: boolean;
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/** Where focus is, as far as a question card cares: an element's `closest` and `matches`, and whether it takes text. */
export interface Focus {
  closest(selector: string): { getAttribute(name: string): string | null } | null;
  matches(selector: string): boolean;
  isContentEditable?: boolean;
}

/** Elements that take typing: a digit there is a word. */
const TEXT = 'input, textarea, select';

/**
 * The option a key press answers on the card `cardId`, as a 0-based index, or undefined. Keys 1–9 pick an option
 * once, only while the card itself has focus (its node on the board, or a control in it that let the key through), or
 * the board has it (`board`: focus on nothing, or on the board's own surface) with this card the only selection. A
 * key some other control took (`defaultPrevented`), a held key's repeats, a chord and a digit typed into a field
 * answer nothing: one press answers at most one question.
 */
export function cardOption(event: CardKey, focus: Focus | null, cardId: string, onlySelected: boolean, options: number): number | undefined {
  if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return undefined;
  const option = Number(event.key) - 1;
  if (!/^[1-9]$/.test(event.key) || option >= options) return undefined;
  if (focus !== null && (focus.isContentEditable === true || focus.closest(TEXT) !== null)) return undefined;
  const node = focus?.closest('.react-flow__node');
  if (node != null) return node.getAttribute('data-id') === cardId ? option : undefined;
  const board = focus === null || focus.matches('body, .react-flow, .react-flow__pane, .react-flow__renderer');
  return board && onlySelected ? option : undefined;
}
