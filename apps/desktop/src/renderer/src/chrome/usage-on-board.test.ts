import { describe, expect, it } from 'vitest';
import { usageOnBoardFrom } from './usage-on-board';

describe('usageOnBoardFrom', () => {
  it('is on only when saved on, so existing users get the default off', () => {
    expect(usageOnBoardFrom(true)).toBe(true);
    expect(usageOnBoardFrom(false)).toBe(false);
    expect(usageOnBoardFrom(undefined)).toBe(false);
    expect(usageOnBoardFrom(null)).toBe(false);
    expect(usageOnBoardFrom('true')).toBe(false);
  });
});
