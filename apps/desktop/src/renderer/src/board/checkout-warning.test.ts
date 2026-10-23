import type { CheckoutState } from '@agent-board/daemon/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkoutWarning, createCheckoutWatcher } from './checkout-warning';

describe('checkoutWarning', () => {
  it('has none for a clean checkout of the default branch, or one whose default branch is unknown', () => {
    expect(checkoutWarning({ branch: 'main', defaultBranch: 'main', dirty: false })).toBeUndefined();
    expect(checkoutWarning({ branch: 'anything', defaultBranch: null, dirty: false })).toBeUndefined();
  });

  it('says the checkout has uncommitted changes', () => {
    expect(checkoutWarning({ branch: 'main', defaultBranch: 'main', dirty: true })).toBe('main checkout has uncommitted changes');
  });

  it('names a branch other than the default', () => {
    expect(checkoutWarning({ branch: 'fix-login-flake', defaultBranch: 'main', dirty: false })).toBe('main checkout is on fix-login-flake');
  });

  it('says both, and names a detached HEAD', () => {
    expect(checkoutWarning({ branch: 'fix-login-flake', defaultBranch: 'main', dirty: true })).toBe('main checkout has uncommitted changes and is on fix-login-flake');
    expect(checkoutWarning({ branch: null, defaultBranch: 'main', dirty: false })).toBe('main checkout is on a detached HEAD');
  });
});

describe('createCheckoutWatcher', () => {
  const DIRTY: CheckoutState = { branch: 'main', defaultBranch: 'main', dirty: true };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = (state: CheckoutState = DIRTY) => {
    const read = vi.fn<(path: string) => Promise<CheckoutState>>(async () => state);
    return { read, watch: createCheckoutWatcher(read, 5_000) };
  };

  it('tells a listener the warning, and shares one read per interval between tiles on one repo', async () => {
    const { read, watch } = setup();
    const seen: (string | undefined)[][] = [[], [], []];
    const stops = seen.map((into) => watch('/repo', true, (warning) => into.push(warning)));
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(seen.map((into) => into.at(-1))).toEqual(Array(3).fill('main checkout has uncommitted changes'));

    await vi.advanceTimersByTimeAsync(50_000);
    expect(read).toHaveBeenCalledTimes(11);
    stops.forEach((stop) => stop());
  });

  it('reads each repo on its own', async () => {
    const { read, watch } = setup();
    const stops = [watch('/a', true, () => {}), watch('/b', true, () => {})];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read.mock.calls.map(([path]) => path).sort()).toEqual(['/a', '/a', '/a', '/b', '/b', '/b']);
    stops.forEach((stop) => stop());
  });

  it('adds no polling when a dialog opens and closes during a tile’s watch', async () => {
    const { read, watch } = setup();
    const stopTile = watch('/repo', true, () => {});
    await vi.advanceTimersByTimeAsync(2_000);
    for (let n = 0; n < 3; n++) {
      watch('/repo', false, () => {})();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await vi.advanceTimersByTimeAsync(50_000);
    // 55 s in: the tile read at 0, 5 … 55 s (12), and the three dialogs each looked afresh once. With a chain per dialog it was 4x.
    expect(read).toHaveBeenCalledTimes(12 + 3);
    stopTile();
  });

  it('reads once for a dialog on its own, and keeps nothing running', async () => {
    const { read, watch } = setup();
    const stop = watch('/repo', false, () => {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);
    stop();
  });

  it('keeps reading for a tile while a dialog is also listening, and after the dialog goes', async () => {
    const { read, watch } = setup();
    const stopDialog = watch('/repo', false, () => {});
    const stopTile = watch('/repo', true, () => {});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
    stopDialog();
    const before = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(read.mock.calls.length - before).toBe(2);
    stopTile();
  });

  it('stops reading when the last listener leaves, even with a read in flight, and starts afresh after', async () => {
    let settle: (state: CheckoutState) => void = () => {};
    const read = vi.fn(() => new Promise<CheckoutState>((resolve) => (settle = resolve)));
    const watch = createCheckoutWatcher(read, 5_000);
    const stop = watch('/repo', true, () => {});
    stop();
    settle(DIRTY);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(1);

    const again = watch('/repo', true, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    again();
  });

  it('shows no warning when a read fails, and tries again', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('gone')).mockResolvedValue(DIRTY);
    const watch = createCheckoutWatcher(read, 5_000);
    const seen: (string | undefined)[] = [];
    const stop = watch('/repo', true, (warning) => seen.push(warning));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(seen).toEqual([undefined, 'main checkout has uncommitted changes']);
    stop();
  });
});
