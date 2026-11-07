import { memo, useEffect, useRef, useState, type RefObject } from 'react';
import type { Harness } from '@agent-board/daemon/protocol';
import { Character } from './Character';
import { claimDip, DIP_MS, poseChangeDelay } from './character-change';
import type { CharacterPose } from './character-figures';
import type { DrawnStyle } from './characters';

/** Holds `pose` back while the character changed less than three seconds ago, and says what to show. */
function useHeldPose(pose: CharacterPose): CharacterPose {
  const [shown, setShown] = useState(pose);
  const lastChangeAt = useRef(0);
  useEffect(() => {
    if (pose === shown) return;
    const change = () => {
      lastChangeAt.current = Date.now();
      setShown(pose);
    };
    const delay = poseChangeDelay(shown, pose, lastChangeAt.current, Date.now());
    if (delay === 0) return change();
    const timer = setTimeout(change, delay);
    return () => clearTimeout(timer);
  }, [pose, shown]);
  return shown;
}

/** Plays one dip on `element` whenever `pose` changes, not when it first shows. Set on the element, so no redraw. */
function useDip(element: RefObject<HTMLElement | null>, pose: CharacterPose): void {
  const previous = useRef(pose);
  useEffect(() => {
    if (previous.current === pose) return;
    previous.current = pose;
    const span = element.current;
    if (span === null) return;
    // Not laid out, it has nothing to show a dip on.
    if (span.offsetHeight === 0) return;
    // How big the board draws it: the zoom, read only as it changes (at most every three seconds), so nothing hears the
    // board's every move.
    const zoom = span.getBoundingClientRect().height / span.offsetHeight;
    const release = claimDip(zoom, matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (release === undefined) return;
    span.setAttribute('data-dip', '');
    const timer = setTimeout(() => {
      span.removeAttribute('data-dip');
      release();
    }, DIP_MS);
    return () => {
      clearTimeout(timer);
      span.removeAttribute('data-dip');
      release();
    };
  }, [element, pose]);
}

/**
 * An agent's own character on its tile, in the picked style: `pose` as the tile's word says it, held and dipped as the
 * rules for a change say.
 */
export const TileCharacter = memo(function TileCharacter({ harness, pose, style, height }: { harness: Harness; pose: CharacterPose; style: DrawnStyle; height: number }) {
  const shown = useHeldPose(pose);
  const element = useRef<HTMLSpanElement>(null);
  useDip(element, shown);
  return (
    <span ref={element} className="tile-character" data-pose={shown}>
      {/* The tile's name and its status word say what this does. */}
      <Character harness={harness} pose={shown} style={style} height={height} testId="tile-character" decorative />
    </span>
  );
});
