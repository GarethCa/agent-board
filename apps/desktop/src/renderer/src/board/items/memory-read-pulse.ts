import type { Rect } from '../../geometry';

/** A read's pulse on the board: where it sets out (the memory's middle) and how far it goes (to the reader's middle). */
export interface ReadPulse {
  key: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
}

const middle = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });

/** The pulse from a memory to the tile of the agent that read it; none if either is off this board. */
export function readPulse(key: number, memory: Rect | undefined, reader: Rect | undefined): ReadPulse | undefined {
  if (memory === undefined || reader === undefined) return undefined;
  const from = middle(memory);
  const to = middle(reader);
  return { key, x: from.x, y: from.y, dx: to.x - from.x, dy: to.y - from.y };
}
