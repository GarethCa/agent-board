// How a connector's line meets its end shapes: a hollow one is drawn empty, so the line stops at its back rather than
// running on through it to the tip, which is where the line's own path ends.
import type { ConnectorLineEnd, EdgePoint } from '@agent-board/daemon/protocol';
import type { ConnectorLabelPlace } from './actions';
import { distanceAlong, lengthOf } from './geometry';

/**
 * How far short of its end the line stops, under each end shape: the length of a hollow one, as `ConnectorMarkers` draws
 * it, from its tip to its back. Under an open arrow, a dot or a filled shape the line runs to the end.
 */
export const END_TRIM: Record<ConnectorLineEnd, number> = { none: 0, arrow: 0, dot: 0, triangle: 10, diamond: 16, 'filled-diamond': 0 };

/** A dashed line's dash, and the gap after it. */
const DASH = 5;
const GAP = 4;

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * The `stroke-dasharray` that draws a line `length` long (its `pathLength`) dashed or solid, stopping `start` short of
 * its start and `end` short of its end; none for a solid line drawn to both.
 */
export function lineDashes(length: number, start: number, end: number, dashed: boolean): string | undefined {
  if (start === 0 && end === 0) return dashed ? `${DASH} ${GAP}` : undefined;
  const visible = Math.max(0, length - start - end);
  // Nothing drawn for `start`, then the line, then a gap past its end, so the pattern never comes round again.
  const parts = [0, start];
  if (!dashed) parts.push(visible, end + 1);
  for (let left = visible; dashed && left > 0; ) {
    const dash = Math.min(DASH, left);
    left -= dash;
    const gap = Math.min(GAP, left);
    left -= gap;
    parts.push(dash, left > 0 ? gap : gap + end + 1);
  }
  return parts.map(round).join(' ');
}

/** How near one of its ends, along it, a double-click on a line types that end's label: at most this… */
const END_LABEL_REACH = 40;
/** …and at most this share of the line, so a short line keeps a middle that types its middle label. */
const END_LABEL_REACH_SHARE = 0.25;

/** Which label a double-click at `point` on the line `samples` types: an end's, if near it along the line, else the middle one. */
export function labelNear(point: EdgePoint, samples: readonly EdgePoint[]): ConnectorLabelPlace {
  const length = lengthOf(samples);
  const reach = Math.min(END_LABEL_REACH, length * END_LABEL_REACH_SHARE);
  const along = distanceAlong(samples, point);
  if (along <= reach) return 'startLabel';
  if (length - along <= reach) return 'endLabel';
  return 'label';
}
