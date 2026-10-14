// Arranging a selection: aligning and distributing it, and changing what is on top.

import type { Rect } from '../../geometry';
import { boundsOf } from './snap';

type Box = Rect & { id: string };
type Place = { x: number; y: number };

export type Alignment = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';
export type Reorder = 'front' | 'back' | 'forward' | 'backward';

/** The new top-left corners of the boxes that `alignment` moves, by id: to the selection's own edge or middle. */
export function align(boxes: readonly Box[], alignment: Alignment): Map<string, Place> {
  const bounds = boundsOf(boxes);
  if (bounds === undefined) return new Map();
  const { x: left, y: top } = bounds;
  const right = left + bounds.width;
  const bottom = top + bounds.height;
  const to = (box: Box): Place => {
    switch (alignment) {
      case 'left':
        return { x: left, y: box.y };
      case 'centre':
        return { x: (left + right) / 2 - box.width / 2, y: box.y };
      case 'right':
        return { x: right - box.width, y: box.y };
      case 'top':
        return { x: box.x, y: top };
      case 'middle':
        return { x: box.x, y: (top + bottom) / 2 - box.height / 2 };
      case 'bottom':
        return { x: box.x, y: bottom - box.height };
    }
  };
  return movedOnly(boxes, to);
}

/**
 * The new top-left corners of the boxes spaced evenly along `axis`, by id: the first and last stay, and the ones
 * between are moved so the gaps between neighbours are equal.
 */
export function distribute(boxes: readonly Box[], axis: 'x' | 'y'): Map<string, Place> {
  if (boxes.length < 3) return new Map();
  const size = (box: Box) => (axis === 'x' ? box.width : box.height);
  const sorted = boxes.toSorted((a, b) => a[axis] - b[axis]);
  const first = sorted[0]!;
  const last = sorted.at(-1)!;
  const span = last[axis] + size(last) - first[axis];
  const gap = (span - sorted.reduce((sum, box) => sum + size(box), 0)) / (sorted.length - 1);
  const at = new Map<string, number>();
  let next = first[axis];
  for (const box of sorted) {
    at.set(box.id, next);
    next += size(box) + gap;
  }
  return movedOnly(boxes, (box) => ({ ...box, [axis]: at.get(box.id)! }));
}

function movedOnly(boxes: readonly Box[], to: (box: Box) => Place): Map<string, Place> {
  const moved = new Map<string, Place>();
  for (const box of boxes) {
    const { x, y } = to(box);
    if (x !== box.x || y !== box.y) moved.set(box.id, { x, y });
  }
  return moved;
}

/**
 * The new stacking orders that bring the `selected` of `stack` to the front or send them to the back, or move each one
 * past the next not selected, by id: only those that change. The z values there are reused where they can be; when two
 * tie, or one has none yet (drawn under the rest), every one is numbered afresh.
 */
export function reorder(stack: readonly { id: string; z: number | null }[], selected: ReadonlySet<string>, how: Reorder): Map<string, number> {
  const z = (entry: { z: number | null }) => entry.z ?? -Infinity;
  const before = stack.toSorted((a, b) => z(a) - z(b)).map((entry) => entry.id);
  const picked = (id: string) => selected.has(id);
  let after: string[];
  if (how === 'front') after = [...before.filter((id) => !picked(id)), ...before.filter(picked)];
  else if (how === 'back') after = [...before.filter(picked), ...before.filter((id) => !picked(id))];
  else {
    after = [...before];
    // Forward walks down from the top, so a run of selected ones moves up together; backward walks up from the bottom.
    const forward = how === 'forward';
    const step = forward ? 1 : -1;
    for (let index = forward ? after.length - 2 : 1; forward ? index >= 0 : index < after.length; index -= step) {
      const id = after[index]!;
      const next = after[index + step]!;
      if (picked(id) && !picked(next)) {
        after[index] = next;
        after[index + step] = id;
      }
    }
  }
  const values = stack.map(z).toSorted((a, b) => a - b);
  const reusable = values.every((value, index) => Number.isFinite(value) && (index === 0 || value !== values[index - 1]));
  const changes = new Map<string, number>();
  after.forEach((id, index) => {
    const value = reusable ? values[index]! : index + 1;
    if (value !== stack.find((entry) => entry.id === id)!.z) changes.set(id, value);
  });
  return changes;
}
