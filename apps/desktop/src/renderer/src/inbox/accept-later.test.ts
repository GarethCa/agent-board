import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCEPT_AFTER_MS } from '../../../shared/accept';
import { acceptLater, onAcceptChange, pendingAccept, undoAccept } from './accept-later';

describe('accepting changes after a moment, with Undo', () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000 }));
  afterEach(() => {
    undoAccept('a');
    undoAccept('b');
    vi.useRealTimers();
  });

  it('accepts once, ten seconds after the click, and is no longer pending', () => {
    const accept = vi.fn();
    acceptLater('a', accept);
    expect(pendingAccept('a')).toBe(1_000 + ACCEPT_AFTER_MS);
    vi.advanceTimersByTime(ACCEPT_AFTER_MS - 1);
    expect(accept).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(accept).toHaveBeenCalledTimes(1);
    expect(pendingAccept('a')).toBeUndefined();
    vi.advanceTimersByTime(ACCEPT_AFTER_MS * 3);
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it('never accepts once undone, and says whether there was anything to undo', () => {
    const accept = vi.fn();
    acceptLater('a', accept);
    vi.advanceTimersByTime(ACCEPT_AFTER_MS - 1);
    expect(undoAccept('a')).toBe(true);
    vi.advanceTimersByTime(ACCEPT_AFTER_MS);
    expect(accept).not.toHaveBeenCalled();
    expect(pendingAccept('a')).toBeUndefined();
    expect(undoAccept('a')).toBe(false);
  });

  it("keeps each agent's apart, and a second click before the first fires doesn't accept twice", () => {
    const first = vi.fn();
    const again = vi.fn();
    const other = vi.fn();
    acceptLater('a', first);
    acceptLater('a', again);
    acceptLater('b', other);
    undoAccept('b');
    vi.advanceTimersByTime(ACCEPT_AFTER_MS);
    expect(first).toHaveBeenCalledTimes(1);
    expect(again).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
  });

  it('waits as long as it is told to, where a test shortens the moment', () => {
    const accept = vi.fn();
    acceptLater('a', accept, 500);
    expect(pendingAccept('a')).toBe(1_500);
    vi.advanceTimersByTime(500);
    expect(accept).toHaveBeenCalledTimes(1);
  });

  it('tells its listeners when one starts, is undone and fires', () => {
    const heard = vi.fn();
    const stop = onAcceptChange(heard);
    acceptLater('a', () => {});
    undoAccept('a');
    acceptLater('a', () => {});
    vi.advanceTimersByTime(ACCEPT_AFTER_MS);
    expect(heard).toHaveBeenCalledTimes(4);
    stop();
    acceptLater('a', () => {});
    expect(heard).toHaveBeenCalledTimes(4);
  });
});
