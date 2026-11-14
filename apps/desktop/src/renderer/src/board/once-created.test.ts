import { describe, expect, it, vi } from 'vitest';
import { runOnceCreated } from './once-created';

/** A create the daemon has not answered yet, and how to answer it. */
function pendingCreate() {
  let done!: () => void;
  const pending = new Promise<void>((resolve) => (done = resolve));
  return { pending, done };
}

describe('runOnceCreated', () => {
  it('runs the call at once for an item with no create waiting', async () => {
    const call = vi.fn(async () => 'saved');

    const result = runOnceCreated(undefined, false, call);

    expect(call).toHaveBeenCalledOnce();
    await expect(result).resolves.toBe('saved');
  });

  it('waits for the create the window sent before running the call', async () => {
    const { pending, done } = pendingCreate();
    const call = vi.fn(async () => 'saved');

    const result = runOnceCreated(pending, false, call);
    await Promise.resolve();
    expect(call).not.toHaveBeenCalled();

    done();
    await expect(result).resolves.toBe('saved');
    expect(call).toHaveBeenCalledOnce();
  });

  it('runs the call at once as the window goes, though the create has not been answered', async () => {
    const { pending } = pendingCreate();
    const call = vi.fn(async () => 'saved');

    const result = runOnceCreated(pending, true, call);

    expect(call).toHaveBeenCalledOnce();
    await expect(result).resolves.toBe('saved');
  });
});
