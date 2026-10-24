import type { ReactFlowState } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import type { Rect } from '../../geometry';
import { samplePath } from '../connectors/geometry';
import { routeSelector } from '../connectors/line';
import { crossesAny, routeLine } from '../connectors/route';
import { endsOf, tetherPath } from './TetherEdge';

const note: Rect = { x: 0, y: 40, width: 200, height: 100 };
const agent: Rect = { x: 600, y: 40, width: 256, height: 136 };
/** A tile on the straight line from the note to the agent. */
const between: Rect = { x: 300, y: 20, width: 200, height: 140 };

/** The path a tether draws between `from` and `to` with `others` on the board, through the router's entry point. */
function drawn(from: Rect, to: Rect, others: Rect[]): string {
  const ends = endsOf(from, to);
  return tetherPath(ends, routeLine(ends, samplePath(tetherPath(ends)), others, { source: from, target: to }));
}

/** A board of nodes `a` (the note), `b` (the agent) and `c` (the tile between), as the store holds them. */
const boardOf = (rects: { a: Rect; b: Rect; c: Rect }) =>
  ({
    nodeLookup: new Map(
      Object.entries(rects).map(([id, { x, y, width, height }]) => [id, { id, internals: { positionAbsolute: { x, y } }, measured: { width, height }, data: {} }]),
    ),
  }) as unknown as ReactFlowState;

describe('a tether between a note and its agent', () => {
  it('joins the sides that face each other', () => {
    expect(endsOf(note, agent)).toMatchObject({ sourceSide: 'right', targetSide: 'left' });
  });

  it('stays straight with nothing in its way', () => {
    expect(drawn(note, agent, [])).toBe(tetherPath(endsOf(note, agent)));
    expect(drawn(note, agent, [{ x: 300, y: 400, width: 200, height: 100 }])).toBe(tetherPath(endsOf(note, agent)));
  });

  it('goes round a tile between them, clear of it', () => {
    const path = drawn(note, agent, [between]);
    expect(path).not.toBe(tetherPath(endsOf(note, agent)));
    expect(crossesAny(samplePath(path), [between])).toBe(false);
  });

  it('falls back to the straight line when nothing is clear', () => {
    // A wall of tiles shutting the agent in on every side, meeting at the corners.
    const boxed = [
      { x: 560, y: -40, width: 20, height: 460 },
      { x: 580, y: -40, width: 400, height: 20 },
      { x: 580, y: 400, width: 400, height: 20 },
      { x: 900, y: -40, width: 20, height: 460 },
      between,
    ];
    expect(drawn(note, agent, boxed)).toBe(tetherPath(endsOf(note, agent)));
  });

  it('routes again, on the board as the store holds it, when its note is resized into the way of a tile', () => {
    // A tile just above the note's level: the straight line from a short note's middle runs under it.
    const above: Rect = { x: 300, y: -60, width: 200, height: 120 };
    const lineFor = (from: Rect) => {
      const ends = endsOf(from, agent);
      const select = routeSelector(ends, tetherPath(ends), 'a', 'b');
      return select(boardOf({ a: from, b: agent, c: above }));
    };
    expect(lineFor(note)).toBeUndefined();
    // Resized upwards, its middle is level with that tile, and the tether goes round it.
    const taller: Rect = { ...note, y: -100, height: 240 };
    expect(lineFor(taller)).toBeDefined();
    expect(crossesAny(samplePath(drawn(taller, agent, [above])), [above])).toBe(false);
  });

  it("is routed again by the same selector when the note's size changes, and not when another tile moves clear of it", () => {
    const above: Rect = { x: 300, y: -60, width: 200, height: 120 };
    const taller: Rect = { ...note, y: -100, height: 240 };
    // The ends are those of the tall note, but the note is short at first: it is its own object that has changed.
    const ends = endsOf(taller, agent);
    const select = routeSelector(ends, tetherPath(ends), 'a', 'b');
    const first = select(boardOf({ a: note, b: agent, c: { x: 300, y: 900, width: 10, height: 10 } }));
    expect(select(boardOf({ a: note, b: agent, c: { x: 300, y: 950, width: 10, height: 10 } }))).toBe(first);
    expect(select(boardOf({ a: taller, b: agent, c: above }))).toBeDefined();
  });
});
