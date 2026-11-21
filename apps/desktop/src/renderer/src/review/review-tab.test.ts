import { describe, expect, it } from 'vitest';
import { newlyAsked, reviewRoute } from './review-tab';

describe('newlyAsked', () => {
  const seen = new Map([['coder', 1]]);
  it('is the one of the ids whose count grew', () => {
    expect(newlyAsked(seen, new Map([['coder', 2]]), ['coder', 'helper'])).toBe('coder');
    expect(newlyAsked(seen, new Map([['coder', 1], ['helper', 1]]), ['coder', 'helper'])).toBe('helper');
  });
  it('is undefined when none of the ids was asked for again', () => {
    expect(newlyAsked(seen, seen, ['coder'])).toBeUndefined();
    expect(newlyAsked(seen, new Map([['coder', 1], ['other', 3]]), ['coder'])).toBeUndefined();
  });
});

describe('reviewRoute', () => {
  it('goes to the window the implementer is popped out in first, a helper of the pop-up too', () => {
    expect(reviewRoute('coder', ['chat', 'coder'], true)).toBe('pop-out');
  });

  it("goes to the board's pop-up when it holds the implementer, else to its session window", () => {
    expect(reviewRoute('coder', ['chat', 'coder'], false)).toBe('pop-up');
    expect(reviewRoute('coder', ['chat'], false)).toBe('window');
  });
});
