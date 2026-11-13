import { describe, expect, it } from 'vitest';
import type { RemoveAskTile } from '@agent-board/daemon/protocol';
import { allowWords, removeAskList } from './remove-ask';

const tile = (name: string, held: string | null = null): RemoveAskTile => ({ sessionId: `id-${name}`, name, held });
const names = (tiles: RemoveAskTile[]) => tiles.map((t) => t.name);

describe('removeAskList', () => {
  it('names the first three tiles that go, then how many more, and all of them once opened', () => {
    const ask = { tiles: ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => tile(name)) };
    expect(removeAskList(ask, false)).toEqual({ heading: "Wants to remove 6 tiles it didn't start", held: [], heldCount: 0, heldMore: 0, shown: ask.tiles.slice(0, 3), more: 3 });
    expect(names(removeAskList(ask, true).shown)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(removeAskList(ask, true).more).toBe(3);
  });

  it('shows four in full rather than "… 1 more", and says "a tile" for one', () => {
    expect(removeAskList({ tiles: ['a', 'b', 'c', 'd'].map((name) => tile(name)) }, false)).toMatchObject({ more: 0, shown: [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }] });
    expect(removeAskList({ tiles: [tile('a')] }, false).heading).toBe("Wants to remove a tile it didn't start");
  });

  it('lists a held-back tile apart, never among the ones that go', () => {
    const list = removeAskList({ tiles: [tile('a'), tile('live', 'still running: it is mid-turn'), tile('b')] }, false);
    expect(list.held).toEqual([{ why: 'still running: it is mid-turn', tiles: [tile('live', 'still running: it is mid-turn')] }]);
    expect(list.heldCount).toBe(1);
    expect(names(list.shown)).toEqual(['a', 'b']);
  });

  it('groups held-back tiles by why, saying each why once, and cuts them to the first few as it does the rest', () => {
    const idle = 'still running: its session is open and it has not said it is finished';
    const tiles = [...['a', 'b', 'c', 'd', 'e'].map((name) => tile(name, idle)), tile('lead', 'w, an agent it started, is still running'), tile('f', idle)];
    const list = removeAskList({ tiles }, false);
    expect(list.held.map((group) => [group.why, names(group.tiles)])).toEqual([
      [idle, ['a', 'b', 'c']],
      ['w, an agent it started, is still running', ['lead']],
    ]);
    expect(list).toMatchObject({ heldCount: 7, heldMore: 3, shown: [], more: 0 });
    const opened = removeAskList({ tiles }, false, true);
    expect(opened.held.map((group) => names(group.tiles))).toEqual([['a', 'b', 'c', 'd', 'e', 'f'], ['lead']]);
    expect(opened.heldMore).toBe(3);
  });
});

describe('allowWords', () => {
  it('counts what Allow removes: the ticked held-back tiles with the rest', () => {
    const ask = { tiles: [tile('a'), tile('live', 'still running'), tile('lead', 'child is still running')] };
    expect(allowWords(ask, new Set())).toBe('Remove 1');
    expect(allowWords(ask, new Set(['id-live']))).toBe('Remove 2');
    expect(allowWords({ tiles: [tile('live', 'still running')] }, new Set())).toBe('Allow');
  });
});
