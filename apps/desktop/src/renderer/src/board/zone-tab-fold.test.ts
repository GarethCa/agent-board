import { describe, expect, it } from 'vitest';
import { chipsToFold } from './zone-tab-fold';

const chips = [
  { key: 'tidy', width: 30 },
  { key: 'tracker', width: 60 },
  { key: 'shell', width: 50 },
];

describe('chipsToFold', () => {
  it('folds nothing when everything fits', () => {
    // 100 + (30 + 4) + (60 + 4) + (50 + 4) = 252.
    expect(chipsToFold(252, 100, chips, 4)).toEqual(new Set());
  });

  it('folds the least needed chips first, only as many as it takes', () => {
    expect(chipsToFold(251, 100, chips, 4)).toEqual(new Set(['tidy']));
    expect(chipsToFold(218, 100, chips, 4)).toEqual(new Set(['tidy']));
    expect(chipsToFold(217, 100, chips, 4)).toEqual(new Set(['tidy', 'tracker']));
  });

  it('folds every chip when even then it does not fit, leaving the name to give way', () => {
    expect(chipsToFold(120, 100, chips, 4)).toEqual(new Set(['tidy', 'tracker', 'shell']));
    expect(chipsToFold(10, 100, chips, 4)).toEqual(new Set(['tidy', 'tracker', 'shell']));
  });

  it('folds nothing with no chips to fold', () => {
    expect(chipsToFold(10, 100, [], 4)).toEqual(new Set());
  });
});
