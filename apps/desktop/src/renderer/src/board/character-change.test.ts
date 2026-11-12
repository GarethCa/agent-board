import { describe, expect, it } from "vitest";
import {
  claimDip,
  HeldLook,
  lookChangeDelay,
  lookKey,
  poseChangeDelay,
} from "./character-change";

describe("a change of pose", () => {
  it("waits out the three seconds since the last change", () => {
    expect(poseChangeDelay("thinking", "running", 1000, 2000)).toBe(2000);
    expect(poseChangeDelay("thinking", "running", 1000, 4000)).toBe(0);
  });

  it("never holds up a tile coming to rest, so the character never contradicts its word", () => {
    expect(poseChangeDelay("thinking", "idle", 1000, 1001)).toBe(0);
    expect(poseChangeDelay("running", "done", 1000, 1001)).toBe(0);
    expect(poseChangeDelay("idle", "thinking", 1000, 1001)).toBe(0);
  });

  it("never holds off what the board must show, or holds it up as it goes", () => {
    expect(poseChangeDelay("thinking", "waiting", 1000, 1001)).toBe(0);
    expect(poseChangeDelay("failed", "running", 1000, 1001)).toBe(0);
  });
});

describe("a change of the agent's face or prop", () => {
  it("moves as a change of pose does: a new face or prop on the same working pose waits out the hold too", () => {
    expect(
      lookChangeDelay(
        { pose: "reading" },
        { pose: "reading", face: "puzzled" },
        1000,
        2000,
      ),
    ).toBe(2000);
    expect(
      lookChangeDelay(
        { pose: "reading", prop: "book" },
        { pose: "reading", prop: "magnifier" },
        1000,
        4000,
      ),
    ).toBe(0);
    expect(
      lookChangeDelay(
        { pose: "waiting-on-review" },
        { pose: "waiting-on-review", face: "sleepy" },
        1000,
        1001,
      ),
    ).toBe(0);
  });

  it("does not move for the same drawing set by someone else", () => {
    expect(
      lookChangeDelay(
        { pose: "testing", prop: "flask", setBy: null },
        { pose: "testing", prop: "flask", setBy: "lead" },
        1000,
        1001,
      ),
    ).toBeNull();
  });
});

describe("a tile's character as looks come in", () => {
  /** Wants each look at its time, and records each drawing shown: a tile dips once for each new one. */
  const drawingsOf = (held: HeldLook) => {
    const drawn = [lookKey(held.shown)];
    const note = () => {
      if (lookKey(held.shown) !== drawn.at(-1)) drawn.push(lookKey(held.shown));
    };
    return {
      drawn,
      want: (look: Parameters<HeldLook["want"]>[0], now: number) => {
        const wait = held.want(look, now);
        note();
        return wait;
      },
      settle: (now: number) => {
        held.settle(now);
        note();
      },
    };
  };

  it("shows a new face or prop on the same pose at once, as one change, when nothing changed in the hold", () => {
    const held = new HeldLook({ pose: "reading", setBy: null }, 0);
    const tile = drawingsOf(held);
    expect(
      tile.want({ pose: "reading", face: "puzzled", setBy: null }, 10_000),
    ).toBeNull();
    expect(held.shown).toEqual({
      pose: "reading",
      face: "puzzled",
      setBy: null,
    });
    expect(tile.drawn).toEqual(["reading//", "reading/puzzled/"]);
  });

  it("holds a second change in the hold, then shows the last one wanted, as one more change", () => {
    const held = new HeldLook({ pose: "reading", setBy: null }, 0);
    const tile = drawingsOf(held);
    tile.want({ pose: "reading", face: "puzzled", setBy: null }, 10_000);
    expect(
      tile.want({ pose: "reading", prop: "magnifier", setBy: null }, 11_000),
    ).toBe(2000);
    expect(
      tile.want(
        { pose: "reading", face: "focused", prop: "magnifier", setBy: null },
        11_500,
      ),
    ).toBe(1500);
    expect(held.shown.face).toBe("puzzled");
    tile.settle(13_000);
    expect(held.shown).toEqual({
      pose: "reading",
      face: "focused",
      prop: "magnifier",
      setBy: null,
    });
    expect(tile.drawn).toEqual([
      "reading//",
      "reading/puzzled/",
      "reading/focused/magnifier",
    ]);
  });

  it("shows the same drawing set by someone else at once, with no change to dip for", () => {
    const held = new HeldLook(
      { pose: "testing", prop: "flask", setBy: null },
      0,
    );
    const tile = drawingsOf(held);
    tile.want({ pose: "testing", face: "happy", setBy: null }, 10_000);
    expect(
      tile.want({ pose: "testing", face: "happy", setBy: "lead" }, 10_500),
    ).toBeNull();
    expect(held.shown.setBy).toBe("lead");
    expect(tile.drawn).toEqual(["testing//flask", "testing/happy/"]);
  });

  it("never holds off the board's own state", () => {
    const held = new HeldLook(
      { pose: "reading", face: "puzzled", setBy: null },
      9_000,
    );
    expect(held.want({ pose: "needs-permission" }, 10_000)).toBeNull();
    expect(held.shown).toEqual({ pose: "needs-permission" });
  });
});

describe("a dip", () => {
  it("stays still under Still, reduced motion and below half zoom", () => {
    expect(claimDip(1, false, "still")).toBeUndefined();
    expect(claimDip(1, true, "move")).toBeUndefined();
    expect(claimDip(0.49, false, "move")).toBeUndefined();
  });

  it("lets four dip at once, and another once one is over", () => {
    const dips = [1, 2, 3, 4].map(() => claimDip(0.5, false, "move"));
    expect(dips.every((release) => release !== undefined)).toBe(true);
    expect(claimDip(1, false, "move")).toBeUndefined();
    dips[0]!();
    dips[0]!();
    const next = claimDip(1, false, "move");
    expect(next).toBeDefined();
    expect(claimDip(1, false, "move")).toBeUndefined();
    next!();
    for (const release of dips) release!();
  });
});
