import { describe, expect, it, vi } from 'vitest';
import { createCwdLookup } from '../src/cwd-lookup.ts';

const setup = (answer: () => Promise<string | undefined> = async () => '/a') => {
  let now = 1_000;
  const find = vi.fn(answer);
  const lookup = createCwdLookup({ find, maxAgeMs: 500, now: () => now });
  return { find, lookup, advance: (ms: number) => (now += ms) };
};

describe('createCwdLookup', () => {
  it('asks once for lookups that arrive together', async () => {
    const { find, lookup } = setup();
    expect(await Promise.all([lookup('s', 1), lookup('s', 1), lookup('s', 1)])).toEqual(['/a', '/a', '/a']);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('answers from the last lookup while it is fresh, and asks again once it is stale', async () => {
    const { find, lookup, advance } = setup();
    await lookup('s', 1);
    advance(499);
    await lookup('s', 1);
    expect(find).toHaveBeenCalledTimes(1);
    advance(2);
    await lookup('s', 1);
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('keeps sessions apart', async () => {
    const { find, lookup } = setup();
    await lookup('s', 1);
    await lookup('t', 2);
    expect(find.mock.calls).toEqual([[1], [2]]);
  });

  it('does not cache a miss, and forgets a session', async () => {
    const answers = [undefined, '/b', '/b'];
    const { find, lookup } = setup(async () => answers.shift());
    expect(await lookup('s', 1)).toBeUndefined();
    expect(await lookup('s', 1)).toBe('/b');
    lookup.forget('s');
    await lookup('s', 1);
    expect(find).toHaveBeenCalledTimes(3);
  });
});
