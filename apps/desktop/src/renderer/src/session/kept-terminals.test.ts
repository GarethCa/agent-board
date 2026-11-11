import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keepTerminalsFrom, keptTerminals, terminalBytes, type KeptEntry, type LetGoReason } from './kept-terminals';

/** A terminal holding `bytes`, which notes why it was let go. */
function entry(bytes: number): KeptEntry & { bytes: () => number; gone: LetGoReason[] } {
  const gone: LetGoReason[] = [];
  return { gone, bytes: () => bytes, dispose: (reason) => void gone.push(reason) };
}

describe('kept terminals', () => {
  it('keeps a parked terminal, and hands it back once', () => {
    const keep = keptTerminals({ budget: 100 });
    const one = entry(10);
    keep.add('a', one);
    expect(keep.take('a')).toBeUndefined();
    keep.park('a');
    expect(keep.take('a')).toBe(one);
    expect(keep.take('a')).toBeUndefined();
    expect(one.gone).toEqual([]);
  });

  it('knows a terminal that shows, so a second pane of its session builds its own', () => {
    const keep = keptTerminals({ budget: 100 });
    keep.add('a', entry(10));
    expect(keep.has('a')).toBe(true);
    expect(keep.has('b')).toBe(false);
  });

  it('never lets go of one that shows, however far over the budget', () => {
    const keep = keptTerminals({ budget: 10 });
    const shown = entry(1000);
    keep.add('a', shown);
    keep.trim();
    expect(shown.gone).toEqual([]);
    expect(keep.parked()).toEqual({ count: 0, bytes: 0 });
  });

  it('lets go of the longest unseen first, until the parked ones fit the budget', () => {
    const keep = keptTerminals({ budget: 100 });
    const [first, second, third] = [entry(60), entry(30), entry(40)];
    keep.add('a', first);
    keep.add('b', second);
    keep.add('c', third);
    keep.park('a');
    keep.park('b');
    expect(keep.parked()).toEqual({ count: 2, bytes: 90 });
    keep.park('c');
    expect(first.gone).toEqual(['budget']);
    expect(second.gone).toEqual([]);
    expect(third.gone).toEqual([]);
    expect(keep.parked()).toEqual({ count: 2, bytes: 70 });
  });

  it('counts unseen from when it last left its pane, not from when it was first parked', () => {
    const keep = keptTerminals({ budget: 100 });
    const [first, second, third] = [entry(50), entry(50), entry(50)];
    keep.add('a', first);
    keep.add('b', second);
    keep.add('c', third);
    keep.park('a');
    keep.park('b');
    keep.take('a');
    keep.park('a');
    keep.park('c');
    expect(second.gone).toEqual(['budget']);
    expect(first.gone).toEqual([]);
  });

  it('lets go of a lone terminal larger than the budget as it parks', () => {
    const keep = keptTerminals({ budget: 100 });
    const big = entry(101);
    keep.add('a', big);
    keep.park('a');
    expect(big.gone).toEqual(['budget']);
    expect(keep.has('a')).toBe(false);
  });

  it('lets go of a parked terminal when its session ends', () => {
    const keep = keptTerminals({ budget: 100 });
    const one = entry(10);
    keep.add('a', one);
    keep.park('a');
    keep.forget('a', 'ended');
    expect(one.gone).toEqual(['ended']);
    expect(keep.take('a')).toBeUndefined();
    expect(keep.has('a')).toBe(false);
  });

  it('leaves a shown terminal whose session ended on screen, and lets go of it as it leaves', () => {
    const keep = keptTerminals({ budget: 100 });
    const one = entry(10);
    keep.add('a', one);
    keep.forget('a', 'ended');
    expect(one.gone).toEqual([]);
    keep.park('a');
    expect(one.gone).toEqual(['ended']);
    expect(keep.take('a')).toBeUndefined();
    expect(keep.parked().count).toBe(0);
  });

  it('forgets a session it never kept, and parks nothing for one it has no terminal of', () => {
    const keep = keptTerminals({ budget: 100 });
    keep.forget('nobody', 'ended');
    keep.park('nobody');
    expect(keep.parked().count).toBe(0);
  });

  it('adds a new terminal for a session whose last one has gone, so a relaunched session starts afresh', () => {
    const keep = keptTerminals({ budget: 100 });
    const old = entry(10);
    keep.add('a', old);
    keep.park('a');
    keep.forget('a', 'ended');
    const fresh = entry(10);
    keep.add('a', fresh);
    keep.park('a');
    expect(keep.take('a')).toBe(fresh);
    expect(fresh.gone).toEqual([]);
  });

  it('says why it let go of one forgotten while it showed, the first reason standing', () => {
    const keep = keptTerminals({ budget: 100 });
    const one = entry(10);
    keep.add('a', one);
    keep.forget('a', 'resized');
    keep.forget('a', 'ended');
    keep.park('a');
    expect(one.gone).toEqual(['resized']);
  });

  it('hands back a parked terminal only if it suits, letting go of one that does not', () => {
    const keep = keptTerminals({ budget: 100 });
    const [one, two] = [entry(10), entry(10)];
    keep.add('a', one);
    keep.add('b', two);
    keep.park('a');
    keep.park('b');
    expect(keep.take('a', (each) => each === one)).toBe(one);
    expect(keep.take('b', (each) => each === one)).toBeUndefined();
    expect(two.gone).toEqual(['relaunched']);
    expect(keep.has('b')).toBe(false);
  });

  it('lets go of every parked terminal when told, and of one that shows as it leaves', () => {
    const keep = keptTerminals({ budget: 100 });
    const [parked, shown] = [entry(10), entry(10)];
    keep.add('a', parked);
    keep.add('b', shown);
    keep.park('a');
    keep.forgetAll('setting');
    expect(parked.gone).toEqual(['setting']);
    expect(shown.gone).toEqual([]);
    keep.park('b');
    expect(shown.gone).toEqual(['setting']);
    expect(keep.has('b')).toBe(false);
  });

  it('lets go of the terminals of sessions in folded zones: one parked now, one that shows as it leaves', () => {
    const keep = keptTerminals({ budget: 100 });
    const [parked, shown, other] = [entry(10), entry(10), entry(10)];
    keep.add('a', parked);
    keep.add('b', shown);
    keep.add('c', other);
    keep.park('a');
    keep.park('c');
    keep.fold(['a', 'b']);
    expect(parked.gone).toEqual(['folded']);
    expect(shown.gone).toEqual([]);
    expect(other.gone).toEqual([]);
    keep.park('b');
    expect(shown.gone).toEqual(['folded']);
    expect(keep.parked().count).toBe(1);
  });

  it('never parks one opened while its zone stays folded, and keeps one again once its zone is unfolded', () => {
    const keep = keptTerminals({ budget: 100 });
    keep.fold(['a', 'b']);
    // Its window was opened from a list, and closed.
    const opened = entry(10);
    keep.add('a', opened);
    keep.park('a');
    expect(opened.gone).toEqual(['folded']);
    expect(keep.has('a')).toBe(false);

    // Unfolded while its terminal showed: it is kept as it leaves.
    const showing = entry(10);
    keep.add('b', showing);
    keep.fold(['b']);
    keep.fold([]);
    keep.park('b');
    expect(showing.gone).toEqual([]);
    expect(keep.take('b')).toBe(showing);
  });

  it('lets one forgotten for another reason go for that reason, folded or unfolded since', () => {
    const keep = keptTerminals({ budget: 100 });
    const ended = entry(10);
    keep.add('a', ended);
    keep.forget('a', 'ended');
    keep.fold(['a']);
    keep.fold([]);
    keep.park('a');
    expect(ended.gone).toEqual(['ended']);
  });

  describe('a parked terminal that keeps growing', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('is held to the budget soon after it grows, checked once however much arrives', () => {
      const keep = keptTerminals({ budget: 100, growthCheckMs: 1000 });
      let bytes = 60;
      const growing: KeptEntry = { bytes: () => bytes, dispose: vi.fn() };
      const other = entry(30);
      keep.add('a', growing);
      keep.add('b', other);
      keep.park('a');
      keep.park('b');
      bytes = 200;
      const read = vi.spyOn(growing, 'bytes');
      for (let write = 0; write < 50; write++) keep.grew();
      expect(growing.dispose).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(growing.dispose).toHaveBeenCalledExactlyOnceWith('budget');
      expect(read.mock.calls.length).toBeLessThanOrEqual(2);
      expect(keep.parked()).toEqual({ count: 1, bytes: 30 });
    });

    it('sets no timer while nothing is parked', () => {
      const keep = keptTerminals({ budget: 100, growthCheckMs: 1000 });
      keep.add('a', entry(10));
      keep.grew();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe('the setting', () => {
  it('is off unless it was turned on', () => {
    expect(keepTerminalsFrom(undefined)).toBe(false);
    expect(keepTerminalsFrom(false)).toBe(false);
    expect(keepTerminalsFrom('yes')).toBe(false);
    expect(keepTerminalsFrom(true)).toBe(true);
  });
});

describe('what a terminal holds', () => {
  it('is its rows by its columns at 12 bytes a cell, over what any terminal costs', () => {
    const empty = terminalBytes({ rows: 0, cols: 100 });
    expect(terminalBytes({ rows: 10_000, cols: 100 }) - empty).toBe(12_000_000);
    expect(terminalBytes({ rows: 10_000, cols: 200 }) - empty).toBe(24_000_000);
    expect(empty).toBeGreaterThan(0);
  });
});
