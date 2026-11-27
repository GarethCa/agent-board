import { describe, expect, it, vi } from 'vitest';
import type { RemoveAsk, RemoveAskResult } from '../src/protocol.ts';
import { createRemoveAskStore, keptAll, type RemoveAskEnd } from '../src/remove-asks.ts';
import { removeAskEndedText, removeAskLeftText, removeAskToldText } from '../src/remove-ask-told.ts';

/**
 * A remove ask outlives the call and the turn that asked it: it stays up until the user answers or it times out, and
 * an answer no call waits on is told to the orchestrator as a message.
 */

const tiles = [{ sessionId: 'old', name: 'old-a', held: null }];

/** What `finish` makes of an end: the user's Allow removes everything, else nothing. */
const finish = async (end: RemoveAskEnd): Promise<RemoveAskResult> =>
  end === null
    ? keptAll(tiles, 'denied', 'the board is stopping')
    : end === 'timed-out'
      ? keptAll(tiles, 'timed-out', 'no answer came')
      : end.allow
        ? { outcome: 'allowed', removed: [{ sessionId: 'old', name: 'old-a' }], kept: [] }
        : keptAll(tiles, 'denied', 'the user denied it');

function store() {
  const told: [string, string][] = [];
  const changes: [string, boolean][] = [];
  const asks = createRemoveAskStore({ changed: (sessionId, began) => changes.push([sessionId, began]), told: (...args) => told.push(args) });
  return { asks, told, changes };
}

/** Lets settled promises run their callbacks. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a remove ask a call waits on', () => {
  it('answers the call, and tells no one else', async () => {
    const { asks, told } = store();
    const call = asks.ask('m', tiles, 60_000, finish, new AbortController().signal);
    const ask = asks.pending('m')!;
    expect(ask.left).toBe(false);
    await asks.decide('m', ask.id, true, []);
    expect(await call).toEqual({ outcome: 'allowed', removed: [{ sessionId: 'old', name: 'old-a' }], kept: [] });
    await flush();
    expect(told).toEqual([]);
    expect(asks.pending('m')).toBeNull();
  });

  it('stays up when the call ends, and the answer is told', async () => {
    const { asks, told, changes } = store();
    const controller = new AbortController();
    const call = asks.ask('m', tiles, 60_000, finish, controller.signal);
    const asked = asks.pending('m')!;
    const { id } = asked;
    controller.abort();
    expect(await call).toEqual({ left: expect.objectContaining({ id, left: true }) });
    expect(asks.pending('m')).toMatchObject({ id, left: true });
    expect(changes).toEqual([['m', true], ['m', false]]);

    const result = await asks.decide('m', id, false, []);
    await flush();
    expect(told).toEqual([['m', removeAskToldText({ ...asked, left: true }, result)]]);
    expect(asks.pending('m')).toBeNull();
  });

  it('stays up when its next turn begins: the call returns with it left', async () => {
    const { asks } = store();
    const call = asks.ask('m', tiles, 60_000, finish, new AbortController().signal);
    asks.leave('m');
    expect(await call).toMatchObject({ left: { left: true } });
    expect(asks.pending('m')).not.toBeNull();
  });

  it('times out after it was left, and the orchestrator is told nothing was removed', async () => {
    vi.useFakeTimers();
    try {
      const { asks, told } = store();
      const controller = new AbortController();
      void asks.ask('m', tiles, 60_000, finish, controller.signal);
      controller.abort();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(told.map(([, text]) => text)).toEqual(['The answer to your ask to remove old-a: The user did not answer, so nothing was removed: ask again later, or tell them why.']);
      expect(asks.pending('m')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends with nothing told when the orchestrator goes, or the daemon does', async () => {
    const { asks, told } = store();
    void asks.ask('m', tiles, 60_000, finish);
    void asks.ask('n', tiles, 60_000, finish);
    asks.drop('m');
    asks.close();
    await flush();
    expect(told).toEqual([]);
    expect([asks.pending('m'), asks.pending('n')]).toEqual([null, null]);
  });
});

describe('a remove ask asked without waiting', () => {
  it('resolves at once with the ask, held until the user answers, then told', async () => {
    const { asks, told } = store();
    const left = await asks.ask('m', tiles, 60_000, finish);
    expect(left).toEqual({ left: expect.objectContaining({ left: true, tiles }) });
    expect(() => asks.ask('m', tiles, 60_000, finish)).toThrow(/already ask/);
    const ask = asks.pending('m')!;
    await asks.decide('m', ask.id, true, []);
    await flush();
    expect(told.map(([, text]) => text)).toEqual(['The answer to your ask to remove old-a: The user allowed it. Removed old-a, with their worktrees and branches.']);
  });

  it('tells the orchestrator when removing what the user allowed fails', async () => {
    const { asks, told } = store();
    await asks.ask('m', tiles, 60_000, () => Promise.reject(new Error('the board is gone')));
    await expect(asks.decide('m', asks.pending('m')!.id, true, [])).rejects.toThrow('the board is gone');
    await flush();
    expect(told).toEqual([['m', 'The user answered your ask to remove old-a, but removing failed: the board is gone']]);
  });
});

describe("a remove ask whose orchestrator's session ends", () => {
  it('ends with nothing removed, the orchestrator told so, and a call still waiting returns', async () => {
    const { asks, told } = store();
    const ends: RemoveAskEnd[] = [];
    const call = asks.ask('m', tiles, 60_000, (end) => (ends.push(end), finish(end)), new AbortController().signal);
    const ask = asks.pending('m')!;
    asks.ended('m');
    expect(await call).toMatchObject({ left: { id: ask.id } });
    await flush();
    expect(ends).toEqual([null]);
    expect(told).toEqual([['m', removeAskEndedText({ ...ask, left: true })]]);
    expect(told[0]![1]).toBe('Your ask to remove old-a ended when your session did, unanswered: nothing was removed. Ask again if they should still go.');
    expect(asks.pending('m')).toBeNull();
  });
});

describe('what the orchestrator reads of an ask it left', () => {
  const ask: RemoveAsk = { id: 'r', askedAt: '2026-01-01T10:00:00.000Z', expiresAt: '2026-01-01T10:30:00.000Z', tiles: [...tiles, { sessionId: 'b', name: 'old-b', held: null }], left: true };

  it('says the answer comes as a message, and how long the ask stays up', () => {
    expect(removeAskLeftText(ask, false)).toMatch(/^Asked the user to remove old-a and old-b, .*comes to your prompt as a message.*within 30 minutes/);
    expect(removeAskLeftText(ask, true)).toMatch(/^Your next turn began before the user answered.*stays up/);
  });

  it('says a restart ends the ask, and that asking again is then safe', () => {
    expect(removeAskLeftText(ask, false)).toMatch(/the board restarted, say, which ends it\): asking again is refused while it is up\.$/);
  });
});
