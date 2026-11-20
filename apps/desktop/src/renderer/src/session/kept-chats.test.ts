import { describe, expect, it } from 'vitest';
import { keptChats } from './kept-chats';
import type { LetGoReason } from './kept-terminals';

/** Kept chat views that note what was made and why each was let go. */
function chats(limit = 5) {
  const made: { sessionId: string; gone: LetGoReason[] }[] = [];
  const keep = keptChats({
    limit,
    make(sessionId) {
      const chat = { sessionId, gone: [] as LetGoReason[], dispose: (reason: LetGoReason) => void chat.gone.push(reason) };
      made.push(chat);
      return chat;
    },
  });
  return { keep, made };
}

describe('kept chat views', () => {
  it('makes a chat view for a pane, and hands the same one back once it was parked', () => {
    const { keep, made } = chats();
    const first = keep.show('a');
    expect(first?.reused).toBe(false);
    keep.park('a');
    expect(keep.parked()).toBe(1);
    const again = keep.show('a');
    expect(again).toEqual({ chat: first?.chat, reused: true });
    expect(made).toHaveLength(1);
    expect(made[0]!.gone).toEqual([]);
  });

  it('leaves a second pane of a session that shows to build its own, not kept', () => {
    const { keep, made } = chats();
    keep.show('a');
    expect(keep.show('a')).toBeUndefined();
    expect(made).toHaveLength(1);
  });

  it('lets go of the longest unseen past its limit, never one that shows', () => {
    const { keep, made } = chats(2);
    for (const id of ['a', 'b', 'c']) keep.show(id);
    keep.park('a');
    keep.park('b');
    expect(made.map((each) => each.gone)).toEqual([[], [], []]);
    keep.park('c');
    expect(made.map((each) => each.gone)).toEqual([['budget'], [], []]);
    expect(keep.parked()).toBe(2);
  });

  it("lets go of a folded zone's chat views, a parked one now and one that shows as it leaves its pane", () => {
    const { keep, made } = chats();
    keep.show('a');
    keep.park('a');
    keep.show('b');
    keep.fold(['a', 'b']);
    expect(made[0]!.gone).toEqual(['folded']);
    expect(made[1]!.gone).toEqual([]);
    keep.park('b');
    expect(made[1]!.gone).toEqual(['folded']);
    // Let go, it comes back as a new one.
    keep.fold([]);
    expect(keep.show('a')?.reused).toBe(false);
  });

  it('lets go of every one when the setting is turned off', () => {
    const { keep, made } = chats();
    keep.show('a');
    keep.park('a');
    keep.show('b');
    keep.forgetAll('setting');
    expect(made[0]!.gone).toEqual(['setting']);
    keep.park('b');
    expect(made[1]!.gone).toEqual(['setting']);
    expect(keep.parked()).toBe(0);
  });

  it('lets go of the chat view of an agent that is gone: a parked one now, one that shows as it leaves its pane', () => {
    const { keep, made } = chats();
    keep.show('a');
    keep.park('a');
    keep.show('b');
    keep.forget('a', 'ended');
    keep.forget('b', 'ended');
    expect(made.map((each) => each.gone)).toEqual([['ended'], []]);
    keep.park('b');
    expect(made.map((each) => each.gone)).toEqual([['ended'], ['ended']]);
    expect(keep.parked()).toBe(0);
    // Forgetting one never kept is nothing.
    keep.forget('c', 'ended');
    expect(made).toHaveLength(2);
  });
});
