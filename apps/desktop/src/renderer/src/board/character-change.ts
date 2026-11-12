// When a character on a tile changes, and whether it moves as it does: one 600 ms dip, then it holds still. Nothing loops.

import type { CharacterLook } from "@agent-board/daemon/character";
import type { CharacterPose } from "./character-figures";
import { characterMotionNow } from "./characters";

/** A character changes at most this often: changes within it collapse into the last one. */
const HOLD_MS = 3000;

/** How long one dip lasts: `--motion-dip`. */
export const DIP_MS = 600;

/** At most this many characters dip at once, so a board of agents changing together stays calm. */
const MAX_DIPPING = 4;

/** Below this zoom no character dips: it could not be seen. */
const MIN_DIP_ZOOM = 0.5;

/** What an agent moves between many times a turn: only these wait, or a tile coming to rest would contradict its word. */
const WORKING: ReadonlySet<CharacterPose> = new Set([
  "running",
  "thinking",
  "reading",
  "writing",
  "testing",
]);

/** How long a change from `shown` to `pose` waits, in ms, given when the character last changed. */
export function poseChangeDelay(
  shown: CharacterPose,
  pose: CharacterPose,
  lastChangeAt: number,
  now: number,
): number {
  if (!WORKING.has(pose) || !WORKING.has(shown)) return 0;
  return Math.max(0, lastChangeAt + HOLD_MS - now);
}

/** A look as one string: two looks are the same drawing when theirs are equal. */
export const lookKey = ({ pose, face, prop }: CharacterLook): string =>
  `${pose}/${face ?? ""}/${prop ?? ""}`;

/**
 * How long a change from the look `shown` to `look` waits, in ms, as a change of pose does: a new face or prop on the
 * same working pose waits out the hold too. Null when both are the same drawing, so nothing moves (who set it may still
 * differ, and its tooltip follows at once).
 */
export function lookChangeDelay(
  shown: CharacterLook,
  look: CharacterLook,
  lastChangeAt: number,
  now: number,
): number | null {
  return lookKey(shown) === lookKey(look)
    ? null
    : poseChangeDelay(shown.pose, look.pose, lastChangeAt, now);
}

/**
 * What a tile's character shows as looks come in: a change shows at once, unless the character changed less than the
 * hold ago, when it waits and the last look wanted in the wait is the one shown. The same drawing set by someone else
 * shows at once, as no change of drawing (its tooltip follows; nothing dips).
 */
export class HeldLook {
  /** The look drawn now. */
  shown: CharacterLook;
  #wanted: CharacterLook;
  #lastChangeAt: number;

  constructor(shown: CharacterLook, lastChangeAt: number) {
    this.shown = shown;
    this.#wanted = shown;
    this.#lastChangeAt = lastChangeAt;
  }

  /** Wants `look` from `now`: shows it at once and answers null, or answers how long to wait before `settle`. */
  want(look: CharacterLook, now: number): number | null {
    this.#wanted = look;
    const delay = lookChangeDelay(this.shown, look, this.#lastChangeAt, now);
    if (delay === null) {
      if (this.shown.setBy !== look.setBy) this.shown = look;
      return null;
    }
    if (delay > 0) return delay;
    this.settle(now);
    return null;
  }

  /** The wait is over at `now`: shows the last look wanted. */
  settle(now: number): void {
    if (lookKey(this.#wanted) !== lookKey(this.shown)) this.#lastChangeAt = now;
    this.shown = this.#wanted;
  }
}

let dipping = 0;

/**
 * Takes a place to dip, if motion allows it at this zoom and fewer than four are dipping; undefined if not. Call what it
 * returns once the dip is over.
 */
export function claimDip(
  zoom: number,
  reducedMotion: boolean,
  motion = characterMotionNow(),
): (() => void) | undefined {
  if (
    motion === "still" ||
    reducedMotion ||
    zoom < MIN_DIP_ZOOM ||
    dipping >= MAX_DIPPING
  )
    return undefined;
  dipping++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    dipping--;
  };
}
