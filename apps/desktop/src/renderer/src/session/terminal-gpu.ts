// Which terminals draw with the GPU. xterm's WebGL renderer paints a terminal into one canvas from a glyph atlas, with
// no per-row layout, and a block of colour has no seams between rows at a board zoom below 100%. Each such terminal
// holds a WebGL context, and Chromium keeps about 16 live in a page, losing the oldest past that; so a page's terminals
// share a budget well under it. The terminals that show get it, the focused one first, then the most recently shown;
// one out of view keeps its context until a shown one needs the slot. The rest draw with xterm's DOM renderer, as does a terminal whose context was lost (until it next comes into view)
// and every terminal of a page where WebGL fails (until the setting is turned on again).
import type { IDisposable, ITerminalAddon } from '@xterm/xterm';

/** How many terminals of a page draw with WebGL at once: under Chromium's 16, leaving room for a context it needs itself. */
export const GPU_TERMINAL_BUDGET = 12;

/** The WebGL addon, as far as the pool uses it. */
export interface GpuAddon extends ITerminalAddon {
  readonly onContextLoss: (listener: () => void) => IDisposable;
  clearTextureAtlas(): void;
}

/** A terminal, as far as the pool uses it: what an xterm `Terminal` has. */
export interface GpuTerminal {
  loadAddon(addon: ITerminalAddon): void;
}

export type TerminalRenderer = 'webgl' | 'dom';

/** One terminal's place in the pool. */
export interface GpuSeat {
  /** Whether the terminal shows: in its page's view, laid out. A terminal out of view gives its context back once one in view needs it. */
  setShown(shown: boolean): void;
  /** Whether the terminal has the keyboard, which puts it first for a context. */
  setFocused(focused: boolean): void;
  /** Its canvas lost its context: it draws with the DOM renderer at once, and while it stays in view. */
  contextLost(): void;
  /** What it draws with now. */
  renderer(): TerminalRenderer;
  /** Leaves the pool, giving its context back. */
  dispose(): void;
}

export interface GpuPool {
  /** Seats a terminal that has been opened in its element. It starts unshown, on the DOM renderer. */
  seat(terminal: GpuTerminal, onRenderer?: (renderer: TerminalRenderer) => void): GpuSeat;
  /**
   * Whether terminals may draw with WebGL at all: the setting. Off, every terminal goes back to the DOM renderer; on
   * again, even those whose context was lost try WebGL once more.
   */
  setEnabled(enabled: boolean): void;
  /** Clears every WebGL terminal's glyph atlas, so a font that loaded after it drew is drawn in that font. */
  clearAtlases(): void;
  /** How many terminals draw with WebGL now. */
  live(): number;
  /** Whether WebGL turned out not to work in this page, so no terminal tries it again until the setting is turned on again. */
  unavailable(): boolean;
}

interface Seat {
  terminal: GpuTerminal;
  shown: boolean;
  focused: boolean;
  /** When it last came into view, for the most recently shown to go first. */
  shownAt: number;
  /** When it last left the view, for the longest unseen to give up its context first. */
  hiddenAt: number;
  /** Lost its context: it stays on the DOM renderer until it comes back into view, or the setting is turned on again. */
  failed: boolean;
  addon?: GpuAddon;
  loss?: IDisposable;
  onRenderer?: (renderer: TerminalRenderer) => void;
}

export interface GpuPoolOptions {
  /** Makes the WebGL addon; throwing, or its activation throwing, means WebGL is unavailable here. */
  createAddon(): GpuAddon;
  budget?: number;
  enabled?: boolean;
}

/** A page's pool of WebGL contexts for its terminals. */
export function gpuPool({ createAddon, budget = GPU_TERMINAL_BUDGET, enabled: startEnabled = true }: GpuPoolOptions): GpuPool {
  const seats = new Set<Seat>();
  let enabled = startEnabled;
  let broken = false;
  let clock = 0;

  const release = (seat: Seat) => {
    if (seat.addon === undefined) return;
    const addon = seat.addon;
    seat.addon = undefined;
    seat.loss?.dispose();
    seat.loss = undefined;
    // Disposing the addon puts the terminal back on xterm's DOM renderer and redraws it.
    try {
      addon.dispose();
    } catch {
      // A context already gone may fail to tidy; the terminal is back on the DOM renderer all the same.
    }
    seat.onRenderer?.('dom');
  };

  const acquire = (seat: Seat): boolean => {
    let addon: GpuAddon | undefined;
    try {
      addon = createAddon();
      seat.terminal.loadAddon(addon);
    } catch {
      // A half-made renderer may hold a context: let it go.
      try {
        addon?.dispose();
      } catch {
        // Nothing more to free.
      }
      // No WebGL2 in this page (no GPU, or blocked): nobody tries again until the setting is turned on again.
      broken = true;
      return false;
    }
    seat.addon = addon;
    seat.loss = addon.onContextLoss(() => lose(seat));
    seat.onRenderer?.('webgl');
    return true;
  };

  const lose = (seat: Seat) => {
    seat.failed = true;
    release(seat);
    assign();
  };

  /**
   * Gives the budget to the shown terminals, focused first, then most recently shown, and takes it from shown ones it
   * no longer reaches. A terminal out of view keeps its context until one in view needs the slot, the longest unseen
   * first: so a pane panned out and back, with room in the budget, never changes renderer (which would refit it and
   * resize its session).
   */
  function assign(): void {
    if (!enabled || broken) {
      for (const seat of seats) release(seat);
      return;
    }
    const wanted = [...seats].filter((seat) => seat.shown && !seat.failed).toSorted((a, b) => Number(b.focused) - Number(a.focused) || b.shownAt - a.shownAt);
    const chosen = new Set(wanted.slice(0, budget));
    // Releasing first, so a context is free before another is made: shown terminals past the budget, and lost ones.
    for (const seat of seats) if (seat.addon !== undefined && (seat.failed || (seat.shown && !chosen.has(seat)))) release(seat);
    const needing = [...chosen].filter((seat) => seat.addon === undefined);
    const unseen = [...seats].filter((seat) => seat.addon !== undefined && !seat.shown).toSorted((a, b) => a.hiddenAt - b.hiddenAt);
    for (let live = holding(); live + needing.length > budget && unseen.length > 0; live--) release(unseen.shift()!);
    for (const seat of needing) {
      if (!acquire(seat)) {
        for (const each of seats) release(each);
        return;
      }
    }
  }

  const holding = () => [...seats].filter((seat) => seat.addon !== undefined).length;

  return {
    seat(terminal, onRenderer) {
      const seat: Seat = { terminal, shown: false, focused: false, shownAt: 0, hiddenAt: 0, failed: false, onRenderer };
      seats.add(seat);
      return {
        setShown(shown) {
          if (shown === seat.shown) return;
          seat.shown = shown;
          if (shown) {
            seat.shownAt = ++clock;
            // A terminal whose context was lost (a GPU process restart loses every one) tries again as it comes back
            // into view: it stays on the DOM renderer until it leaves the view, so a context lost again can't loop.
            seat.failed = false;
          } else seat.hiddenAt = ++clock;
          assign();
        },
        setFocused(focused) {
          if (focused === seat.focused) return;
          seat.focused = focused;
          assign();
        },
        contextLost() {
          if (seats.has(seat)) lose(seat);
        },
        renderer: () => (seat.addon === undefined ? 'dom' : 'webgl'),
        dispose() {
          if (!seats.delete(seat)) return;
          release(seat);
          assign();
        },
      };
    },
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      // Turned on again, a page where WebGL failed, and each terminal that lost its context, try once more.
      if (enabled) {
        broken = false;
        for (const seat of seats) seat.failed = false;
      }
      assign();
    },
    clearAtlases() {
      for (const seat of seats) seat.addon?.clearTextureAtlas();
    },
    live: holding,
    unavailable: () => broken,
  };
}

/** The saved GPU-accelerated terminals setting, on unless it was turned off. */
export function gpuTerminalsFrom(saved: unknown): boolean {
  return saved !== false;
}
