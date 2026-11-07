// When a character on a tile changes, and whether it moves as it does: one 600 ms dip, then it holds still. Nothing loops.

import type { CharacterPose } from './character-figures';
import { characterMotionNow } from './characters';

/** A character changes at most this often: changes within it collapse into the last one. */
const HOLD_MS = 3000;

/** How long one dip lasts: `--motion-dip`. */
export const DIP_MS = 600;

/** At most this many characters dip at once, so a board of agents changing together stays calm. */
const MAX_DIPPING = 4;

/** Below this zoom no character dips: it could not be seen. */
const MIN_DIP_ZOOM = 0.5;

/** What an agent moves between many times a turn: only these wait, or a tile coming to rest would contradict its word. */
const WORKING: ReadonlySet<CharacterPose> = new Set(['running', 'thinking', 'reading', 'writing', 'testing']);

/** How long a change from `shown` to `pose` waits, in ms, given when the character last changed. */
export function poseChangeDelay(shown: CharacterPose, pose: CharacterPose, lastChangeAt: number, now: number): number {
  if (!WORKING.has(pose) || !WORKING.has(shown)) return 0;
  return Math.max(0, lastChangeAt + HOLD_MS - now);
}

let dipping = 0;

/**
 * Takes a place to dip, if motion allows it at this zoom and fewer than four are dipping; undefined if not. Call what it
 * returns once the dip is over.
 */
export function claimDip(zoom: number, reducedMotion: boolean, motion = characterMotionNow()): (() => void) | undefined {
  if (motion === 'still' || reducedMotion || zoom < MIN_DIP_ZOOM || dipping >= MAX_DIPPING) return undefined;
  dipping++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    dipping--;
  };
}
