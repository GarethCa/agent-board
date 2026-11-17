// Which presses close a list card's peek that its popover doesn't hear as outside presses itself.

/** Something a press lands on: an element, as far as this needs. */
export interface Pressed {
  closest(selector: string): unknown;
}

/**
 * Whether a press closes the peek: a main-button press anywhere on the board (empty board, a zone, a tile, its own card)
 * but in the peek. The popover waits for the press's click and lets a press be when anything on the way stops it, as a
 * zone or tile being made ready to drag does; so a press on a zone's empty body would leave the peek open.
 */
export function pressClosesPeek(target: Pressed | null, button: number): boolean {
  if (target === null || button !== 0) return false;
  return target.closest('.react-flow') !== null && target.closest('.listcard-peek-popover') === null;
}
