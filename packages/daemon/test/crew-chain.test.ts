import { describe, expect, it } from 'vitest';
import { chainUp } from '../src/crew-chain.ts';

/** A `startedBy` from a map of who started whom. */
const startedBy = (leads: Record<string, string | null>) => (sessionId: string) => leads[sessionId];

describe('chainUp', () => {
  it('walks from an agent to the top of its crew, at any depth', () => {
    const leads = { a: null, b: 'a', c: 'b', d: 'c', e: 'd', f: 'e', g: 'f' };
    expect(chainUp('g', startedBy(leads))).toEqual(['g', 'f', 'e', 'd', 'c', 'b', 'a']);
    expect(chainUp('a', startedBy(leads))).toEqual(['a']);
    expect(chainUp(null, startedBy(leads))).toEqual([]);
  });

  it('stops at an agent no longer on the board', () => {
    expect(chainUp('b', startedBy({ b: 'gone' }))).toEqual(['b', 'gone']);
  });

  it('stops where the chain comes back on itself', () => {
    expect(chainUp('a', startedBy({ a: 'b', b: 'c', c: 'a' }))).toEqual(['a', 'b', 'c']);
    expect(chainUp('a', startedBy({ a: 'a' }))).toEqual(['a']);
  });
});
