import { describe, expect, it } from 'vitest';
import type { ITerminalAddon } from '@xterm/xterm';
import { GPU_TERMINAL_BUDGET, gpuPool, gpuTerminalsFrom, type GpuAddon, type GpuTerminal, type TerminalRenderer } from './terminal-gpu';

/** A WebGL addon that records what is done to it, and can lose its context. */
class FakeAddon implements GpuAddon {
  disposed = false;
  cleared = 0;
  private lossListeners = new Set<() => void>();
  activate(): void {}
  dispose(): void {
    this.disposed = true;
  }
  clearTextureAtlas(): void {
    this.cleared++;
  }
  onContextLoss = (listener: () => void) => {
    this.lossListeners.add(listener);
    return { dispose: () => this.lossListeners.delete(listener) };
  };
  loseContext(): void {
    for (const listener of [...this.lossListeners]) listener();
  }
}

/** A terminal that activates what it loads, as xterm does, and lists it. */
class FakeTerminal implements GpuTerminal {
  loaded: ITerminalAddon[] = [];
  loadAddon(addon: ITerminalAddon): void {
    addon.activate(undefined as never);
    this.loaded.push(addon);
  }
}

function pool(options: { budget?: number; enabled?: boolean; fail?: () => boolean } = {}) {
  const made: FakeAddon[] = [];
  const created = gpuPool({
    budget: options.budget,
    enabled: options.enabled,
    createAddon: () => {
      if (options.fail?.()) throw new Error('WebGL2 not supported');
      const addon = new FakeAddon();
      made.push(addon);
      return addon;
    },
  });
  return { pool: created, made };
}

describe('the GPU terminal pool', () => {
  it('gives a terminal WebGL once it shows, and keeps it out of view while the budget has room, so it never changes renderer', () => {
    const { pool: gpu, made } = pool();
    const renderers: TerminalRenderer[] = [];
    const seat = gpu.seat(new FakeTerminal(), (renderer) => renderers.push(renderer));
    expect(seat.renderer()).toBe('dom');

    seat.setShown(true);
    expect(seat.renderer()).toBe('webgl');
    seat.setShown(false);
    seat.setShown(true);
    expect(made).toHaveLength(1);
    expect(made[0]!.disposed).toBe(false);
    expect(renderers).toEqual(['webgl']);

    seat.dispose();
    expect(made[0]!.disposed).toBe(true);
  });

  it('takes the context of the terminal out of view longest, not the one shown longest ago', () => {
    const { pool: gpu } = pool({ budget: 2 });
    const [a, b, c] = [gpu.seat(new FakeTerminal()), gpu.seat(new FakeTerminal()), gpu.seat(new FakeTerminal())];
    a.setShown(true);
    b.setShown(true);
    // b left the view first, though a was shown before it.
    b.setShown(false);
    a.setShown(false);
    c.setShown(true);
    expect([a.renderer(), b.renderer(), c.renderer()]).toEqual(['webgl', 'dom', 'webgl']);
  });

  it('takes the context of the longest unseen terminal only when one in view needs the slot', () => {
    const { pool: gpu } = pool({ budget: 2 });
    const [a, b, c] = [gpu.seat(new FakeTerminal()), gpu.seat(new FakeTerminal()), gpu.seat(new FakeTerminal())];
    a.setShown(true);
    b.setShown(true);
    a.setShown(false);
    b.setShown(false);
    expect([a.renderer(), b.renderer()]).toEqual(['webgl', 'webgl']);
    expect(gpu.live()).toBe(2);

    c.setShown(true);
    // a left the view first: it gives its context to c; b keeps its own.
    expect([a.renderer(), b.renderer(), c.renderer()]).toEqual(['dom', 'webgl', 'webgl']);
    expect(gpu.live()).toBe(2);
  });

  it('keeps to its budget, the focused terminal first, then the most recently shown', () => {
    const { pool: gpu } = pool({ budget: 2 });
    const [a, b, c] = [gpu.seat(new FakeTerminal()), gpu.seat(new FakeTerminal()), gpu.seat(new FakeTerminal())];
    a.setShown(true);
    b.setShown(true);
    c.setShown(true);
    expect([a, b, c].map((seat) => seat.renderer())).toEqual(['dom', 'webgl', 'webgl']);
    expect(gpu.live()).toBe(2);

    a.setFocused(true);
    expect([a, b, c].map((seat) => seat.renderer())).toEqual(['webgl', 'dom', 'webgl']);

    c.dispose();
    expect([a, b].map((seat) => seat.renderer())).toEqual(['webgl', 'webgl']);
  });

  it('at 40 terminals on a page, never holds more contexts than its budget, and frees one before making another', () => {
    const { pool: gpu, made } = pool();
    const seats = Array.from({ length: 40 }, () => gpu.seat(new FakeTerminal()));
    let most = 0;
    for (const seat of seats) {
      seat.setShown(true);
      most = Math.max(most, made.filter((addon) => !addon.disposed).length);
    }
    for (const seat of seats.slice(0, 20)) {
      seat.setFocused(true);
      most = Math.max(most, made.filter((addon) => !addon.disposed).length);
      seat.setFocused(false);
    }
    expect(gpu.live()).toBe(GPU_TERMINAL_BUDGET);
    expect(most).toBe(GPU_TERMINAL_BUDGET);
    expect(GPU_TERMINAL_BUDGET).toBeLessThan(16);
  });

  it('falls back to the DOM renderer when WebGL is unavailable, and tries it again in the page only once the setting is turned on again', () => {
    let attempts = 0;
    const { pool: gpu } = pool({ fail: () => (attempts++, true) });
    const first = gpu.seat(new FakeTerminal());
    first.setShown(true);
    expect(first.renderer()).toBe('dom');
    expect(gpu.unavailable()).toBe(true);

    const second = gpu.seat(new FakeTerminal());
    second.setShown(true);
    expect(second.renderer()).toBe('dom');
    expect(attempts).toBe(1);

    gpu.setEnabled(false);
    gpu.setEnabled(true);
    expect(attempts).toBe(2);
  });

  it('falls back to the DOM renderer when activating the addon throws, and lets the half-made addon go', () => {
    const made: FakeAddon[] = [];
    const gpu = gpuPool({ createAddon: () => (made.push(new FakeAddon()), made.at(-1)!) });
    const terminal: GpuTerminal = {
      loadAddon() {
        throw new Error('could not create a WebGL2 context');
      },
    };
    const seat = gpu.seat(terminal);
    seat.setShown(true);
    expect(seat.renderer()).toBe('dom');
    expect(gpu.unavailable()).toBe(true);
    expect(made[0]!.disposed).toBe(true);
  });

  it('puts a terminal whose context is lost back on the DOM renderer at once, and while it stays in view, giving its slot to another', () => {
    const { pool: gpu, made } = pool({ budget: 1 });
    const renderers: TerminalRenderer[] = [];
    const lost = gpu.seat(new FakeTerminal(), (renderer) => renderers.push(renderer));
    const waiting = gpu.seat(new FakeTerminal());
    waiting.setShown(true);
    lost.setShown(true);
    expect([lost.renderer(), waiting.renderer()]).toEqual(['webgl', 'dom']);

    const lostAddon = made.at(-1)!;
    lostAddon.loseContext();
    expect(lost.renderer()).toBe('dom');
    expect(lostAddon.disposed).toBe(true);
    expect(renderers).toEqual(['webgl', 'dom']);
    expect(waiting.renderer()).toBe('webgl');

    // While it stays in view it keeps to the DOM renderer, so a context lost again can't loop.
    lost.setFocused(true);
    expect(lost.renderer()).toBe('dom');
    // Back into view (a GPU process restart loses every context, and the new one works), it tries WebGL again.
    lost.setShown(false);
    lost.setShown(true);
    expect(lost.renderer()).toBe('webgl');
  });

  it('takes a context-lost report from the canvas too, before the addon gives up waiting for a restore', () => {
    const { pool: gpu, made } = pool();
    const seat = gpu.seat(new FakeTerminal());
    seat.setShown(true);
    seat.contextLost();
    expect(seat.renderer()).toBe('dom');
    expect(made[0]!.disposed).toBe(true);
    // The addon's own report, later, changes nothing.
    made[0]!.loseContext();
    expect(seat.renderer()).toBe('dom');
  });

  it('turned off, puts every terminal on the DOM renderer, and turned on again, gives the shown ones WebGL', () => {
    const { pool: gpu } = pool();
    const [a, b] = [gpu.seat(new FakeTerminal()), gpu.seat(new FakeTerminal())];
    a.setShown(true);
    gpu.setEnabled(false);
    b.setShown(true);
    expect([a.renderer(), b.renderer()]).toEqual(['dom', 'dom']);
    gpu.setEnabled(true);
    expect([a.renderer(), b.renderer()]).toEqual(['webgl', 'webgl']);
  });

  it('turned off and on again, gives a terminal whose context was lost another try', () => {
    const { pool: gpu, made } = pool();
    const seat = gpu.seat(new FakeTerminal());
    seat.setShown(true);
    made[0]!.loseContext();
    expect(seat.renderer()).toBe('dom');
    gpu.setEnabled(false);
    gpu.setEnabled(true);
    expect(seat.renderer()).toBe('webgl');
  });

  it('starts off when told, and clears only the live atlases', () => {
    const { pool: gpu, made } = pool({ enabled: false });
    const seat = gpu.seat(new FakeTerminal());
    seat.setShown(true);
    expect(made).toHaveLength(0);
    gpu.setEnabled(true);
    gpu.clearAtlases();
    expect(made[0]!.cleared).toBe(1);
  });

  it('leaves a disposed terminal alone', () => {
    const { pool: gpu, made } = pool();
    const seat = gpu.seat(new FakeTerminal());
    seat.setShown(true);
    seat.dispose();
    seat.contextLost();
    seat.dispose();
    expect(made).toHaveLength(1);
    expect(gpu.live()).toBe(0);
  });
});

describe('the GPU-accelerated terminals setting', () => {
  it('is on unless it was turned off', () => {
    expect(gpuTerminalsFrom(undefined)).toBe(true);
    expect(gpuTerminalsFrom('garbage')).toBe(true);
    expect(gpuTerminalsFrom(true)).toBe(true);
    expect(gpuTerminalsFrom(false)).toBe(false);
  });
});
