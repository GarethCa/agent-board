import { describe, expect, it } from 'vitest';
import { keepUnfolded, unfoldedFrom, withUnfolded } from './fold';

const agent = (sessionId: string, endedAt: string | null, state = 'done', shellSessionId: string | null = null) =>
  ({ sessionId, endedAt, state, shellSessionId, shellHarness: null }) as never;
const closed = [agent('a', 'then')];

describe('withUnfolded', () => {
  it('adds and removes the id of a closed agent, and returns the same list when nothing changes', () => {
    const open = withUnfolded([], 'agent:a', true, closed);
    expect(open).toEqual(['agent:a']);
    expect(withUnfolded(open, 'agent:a', true, closed)).toBe(open);
    expect(withUnfolded(open, 'agent:a', false, closed)).toEqual([]);
    expect(withUnfolded([], 'agent:a', false, closed)).toEqual([]);
  });

  it("never puts in an agent that isn't closed: an undo can't leave a live agent's entry to keep it from folding when it ends", () => {
    const live = [agent('a', null, 'idle')];
    expect(withUnfolded([], 'agent:a', true, live)).toEqual([]);
    expect(withUnfolded([], 'agent:a', true, [agent('a', 'then', 'done', 'shell-1')])).toEqual([]);
    expect(withUnfolded([], 'agent:gone', true, closed)).toEqual([]);
  });
});

describe('keepUnfolded', () => {
  it('drops agents that are running again, stopped by a restart, in a live shell or gone', () => {
    const agents = [agent('a', 'then'), agent('b', null, 'idle'), agent('c', 'then', 'stopped-by-restart'), agent('d', 'then', 'done', 'shell-1')];
    expect(keepUnfolded(['agent:a', 'agent:b', 'agent:c', 'agent:d', 'agent:gone'], agents)).toEqual(['agent:a']);
  });
  it('returns the same list when every entry stays', () => {
    const list = ['agent:a'];
    expect(keepUnfolded(list, closed)).toBe(list);
  });
});

describe('unfoldedFrom', () => {
  it('is the daemon’s reading of the saved list', () => {
    expect(unfoldedFrom(['agent:a', 'agent:a'])).toEqual(['agent:a']);
  });
});
