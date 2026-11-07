// A page's terminals that outlive their panes, when the setting asks for it (off by default). A terminal that leaves its pane stays alive and attached, parked, so a
// pane mounted again for its session shows it at once rather than building a terminal and parsing the session's whole
// scrollback again. Parked terminals share a memory budget, measured by the scrollback they hold: past it, the longest
// unseen is let go, and its session comes back the slower way, from the daemon's snapshot. A terminal that shows is never
// let go for the budget. Each window is its own page, with its own budget.

/**
 * Why a terminal was let go: past the budget; its session ended; its connection dropped or its attach failed; another
 * window resized its session while it was parked; it followed an earlier run of a relaunched session; it never showed; or
 * the setting was turned off.
 */
export type LetGoReason = 'budget' | 'ended' | 'disconnected' | 'resized' | 'relaunched' | 'hidden' | 'setting';

/** The saved keep-terminals setting, off unless it was turned on. */
export function keepTerminalsFrom(saved: unknown): boolean {
  return saved === true;
}

/** A kept terminal, as far as the budget goes. */
export interface KeptEntry {
  /** What it holds in memory now. It grows as its session prints, up to the scrollback limit. */
  bytes(): number;
  /** Lets it go: detaches from its session and frees the terminal. */
  dispose(reason: LetGoReason): void;
}

/** xterm's buffer holds three 32-bit words a cell, whatever the cell shows. */
const BYTES_PER_CELL = 12;

/**
 * What a terminal costs before any scrollback: its objects, DOM and daemon connection. The rendering deep dive measured
 * 2–3 MB of heap for a kept terminal.
 */
const TERMINAL_BYTES = 3_000_000;

/** An estimate of what a terminal of this size holds, for the budget: its buffer's rows and columns, and the terminal. */
export function terminalBytes({ rows, cols }: { rows: number; cols: number }): number {
  return TERMINAL_BYTES + rows * cols * BYTES_PER_CELL;
}

export interface KeptTerminals<Entry extends KeptEntry> {
  /** Adds a terminal that shows now. */
  add(sessionId: string, entry: Entry): void;
  /** Whether a terminal of this session is kept, parked or showing. */
  has(sessionId: string): boolean;
  /**
   * Takes back a parked terminal to show it, if there is one. One that `usable` turns down followed an earlier run of
   * the session, and is let go.
   */
  take(sessionId: string, usable?: (entry: Entry) => boolean): Entry | undefined;
  /** Parks a terminal that left its pane, as the most recently seen; one that has been forgotten is let go instead. */
  park(sessionId: string): void;
  /** It can no longer serve its session: lets go of it now if parked, or as it leaves its pane. */
  forget(sessionId: string, reason: LetGoReason): void;
  /** The setting was turned off: lets go of every parked terminal now, and of each that shows as it leaves its pane. */
  forgetAll(reason: LetGoReason): void;
  /** A parked terminal took more output: checks the budget soon, once however much arrives. */
  grew(): void;
  /** Lets go of the longest unseen until the parked terminals fit the budget. */
  trim(): void;
  /** How many are parked, and what they hold. */
  parked(): { count: number; bytes: number };
}

interface Held<Entry> {
  entry: Entry;
  shown: boolean;
  /** Forgotten while it showed: why it goes as it leaves its pane. */
  forgotten?: LetGoReason;
}

export function keptTerminals<Entry extends KeptEntry>({ budget, growthCheckMs = 1000 }: { budget: number; growthCheckMs?: number }): KeptTerminals<Entry> {
  /** By session id, the longest unseen first: each moves to the end as it leaves its pane. */
  const held = new Map<string, Held<Entry>>();
  let check: ReturnType<typeof setTimeout> | undefined;

  const parkedOnes = () => [...held].filter(([, each]) => !each.shown);

  const letGo = (sessionId: string, { entry }: Held<Entry>, reason: LetGoReason) => {
    held.delete(sessionId);
    entry.dispose(reason);
  };

  const trim = () => {
    const parked = parkedOnes().map(([sessionId, each]) => ({ sessionId, each, bytes: each.entry.bytes() }));
    let total = parked.reduce((sum, { bytes }) => sum + bytes, 0);
    for (const { sessionId, each, bytes } of parked) {
      if (total <= budget) return;
      letGo(sessionId, each, 'budget');
      total -= bytes;
    }
  };

  return {
    add(sessionId, entry) {
      held.set(sessionId, { entry, shown: true });
    },
    has: (sessionId) => held.has(sessionId),
    take(sessionId, usable) {
      const each = held.get(sessionId);
      if (each === undefined || each.shown) return undefined;
      if (usable !== undefined && !usable(each.entry)) {
        letGo(sessionId, each, 'relaunched');
        return undefined;
      }
      each.shown = true;
      return each.entry;
    },
    park(sessionId) {
      const each = held.get(sessionId);
      if (each === undefined) return;
      if (each.forgotten !== undefined) {
        letGo(sessionId, each, each.forgotten);
        return;
      }
      each.shown = false;
      held.delete(sessionId);
      held.set(sessionId, each);
      trim();
    },
    forget(sessionId, reason) {
      const each = held.get(sessionId);
      if (each === undefined) return;
      if (each.shown) each.forgotten ??= reason;
      else letGo(sessionId, each, reason);
    },
    forgetAll(reason) {
      for (const [sessionId, each] of [...held]) {
        if (each.shown) each.forgotten ??= reason;
        else letGo(sessionId, each, reason);
      }
    },
    grew() {
      if (check !== undefined || parkedOnes().length === 0) return;
      check = setTimeout(() => {
        check = undefined;
        trim();
      }, growthCheckMs);
    },
    trim,
    parked() {
      const parked = parkedOnes();
      return { count: parked.length, bytes: parked.reduce((sum, [, each]) => sum + each.entry.bytes(), 0) };
    },
  };
}
