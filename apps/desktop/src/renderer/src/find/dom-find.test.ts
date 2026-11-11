import { describe, expect, it } from 'vitest';
import { matchOffsets, stepIndex } from './dom-find';
import { findCount } from './FindBar';

describe('finding text in a shown document', () => {
  it('finds every match in any case, never overlapping', () => {
    expect(matchOffsets('Alpha beta ALPHA alpha', 'alpha')).toEqual([0, 11, 17]);
    expect(matchOffsets('aaaa', 'aa')).toEqual([0, 2]);
    expect(matchOffsets('Alpha', '')).toEqual([]);
    // A letter whose lower case is longer (İ is two units in lower case) keeps every offset where it was.
    expect(matchOffsets('İİ cat', 'cat')).toEqual([3]);
    expect(matchOffsets('İİ CAT', 'cat')).toEqual([3]);
    expect(matchOffsets('Alpha', 'gamma')).toEqual([]);
  });

  it('steps through the matches, wrapping round either end', () => {
    expect([stepIndex(0, 3, 'next'), stepIndex(2, 3, 'next'), stepIndex(0, 3, 'previous'), stepIndex(1, 3, 'first'), stepIndex(0, 0, 'next')]).toEqual([1, 0, 2, 0, 0]);
  });

  it('says what it found', () => {
    expect(findCount('', { active: 0, total: 0 })).toBe('');
    expect(findCount('x', { active: 0, total: 0 })).toBe('No matches');
    expect(findCount('x', { active: 2, total: 5 })).toBe('2 of 5');
  });
});
