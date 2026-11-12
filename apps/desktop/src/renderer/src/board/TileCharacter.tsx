import { memo, useEffect, useRef, useState, type RefObject } from "react";
import type { CharacterLook } from "@agent-board/daemon/character";
import type { Harness } from "@agent-board/daemon/protocol";
import { Character, POSE_LABELS } from "./Character";
import { claimDip, DIP_MS, HeldLook, lookKey } from "./character-change";
import type { DrawnStyle } from "./characters";

/** Holds `look` back while the character changed less than three seconds ago (`HeldLook`), and says what to show. */
function useHeldLook(look: CharacterLook): CharacterLook {
  const [held] = useState(() => new HeldLook(look, 0));
  const [shown, setShown] = useState(look);
  const wanted = useRef(look);
  wanted.current = look;
  const key = lookKey(look);
  useEffect(() => {
    const wait = held.want(wanted.current, Date.now());
    setShown(held.shown);
    if (wait === null) return;
    const timer = setTimeout(() => {
      held.settle(Date.now());
      setShown(held.shown);
    }, wait);
    return () => clearTimeout(timer);
  }, [held, key, look.setBy]);
  return shown;
}

/** Plays one dip on `element` whenever `key` (what is drawn) changes, not when it first shows. Set on the element, so no redraw. */
function useDip(element: RefObject<HTMLElement | null>, key: string): void {
  const previous = useRef(key);
  useEffect(() => {
    if (previous.current === key) return;
    previous.current = key;
    const span = element.current;
    if (span === null) return;
    // Not laid out, it has nothing to show a dip on.
    if (span.offsetHeight === 0) return;
    // How big the board draws it: the zoom, read only as it changes (at most every three seconds), so nothing hears the
    // board's every move.
    const zoom = span.getBoundingClientRect().height / span.offsetHeight;
    const release = claimDip(
      zoom,
      matchMedia("(prefers-reduced-motion: reduce)").matches,
    );
    if (release === undefined) return;
    span.setAttribute("data-dip", "");
    const timer = setTimeout(() => {
      span.removeAttribute("data-dip");
      release();
    }, DIP_MS);
    return () => {
      clearTimeout(timer);
      span.removeAttribute("data-dip");
      release();
    };
  }, [element, key]);
}

/** What hovering the character says: whose pose it is, when it is the agent's own. The board's says nothing more than its word. */
function characterTitle({ pose, setBy }: CharacterLook): string | undefined {
  if (setBy === undefined) return undefined;
  // The agent's own word where the board's differs: it set "running a tool", drawn as the board's running.
  const label = pose === "running" ? "running a tool" : POSE_LABELS[pose];
  const word = label.charAt(0).toUpperCase() + label.slice(1);
  return setBy === null
    ? `${word} · set by the agent`
    : `${word} · set by ◎ ${setBy}`;
}

/**
 * An agent's own character on its tile, in the picked style: `pose` as the tile's word says it, or the agent's own pose
 * with its face and prop, held and dipped as the rules for a change say.
 */
export const TileCharacter = memo(function TileCharacter({
  harness,
  pose,
  face,
  prop,
  setBy,
  style,
  height,
}: CharacterLook & { harness: Harness; style: DrawnStyle; height: number }) {
  const shown = useHeldLook({
    pose,
    ...(face === undefined ? {} : { face }),
    ...(prop === undefined ? {} : { prop }),
    ...(setBy === undefined ? {} : { setBy }),
  });
  const element = useRef<HTMLSpanElement>(null);
  useDip(element, lookKey(shown));
  return (
    <span
      ref={element}
      className="tile-character"
      data-pose={shown.pose}
      title={characterTitle(shown)}
    >
      {/* The tile's name and its status word say what this does. */}
      <Character
        harness={harness}
        pose={shown.pose}
        face={shown.face}
        prop={shown.prop}
        style={style}
        height={height}
        testId="tile-character"
        decorative
      />
    </span>
  );
});
