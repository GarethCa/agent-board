import { describe, expect, it } from 'vitest';
import { chipsToFold, foldedNext } from './zone-tab-fold';

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

describe('foldedNext', () => {
  it('folds as chipsToFold does when more has to fold', () => {
    expect(foldedNext(new Set(), 251, 100, chips, 4)).toEqual(new Set(['tidy']));
    expect(foldedNext(new Set(['tidy']), 217, 100, chips, 4)).toEqual(new Set(['tidy', 'tracker']));
  });

  it('leaves a tab that fits to the pixel as it is, whichever way it stands, instead of folding and unfolding a chip for ever', () => {
    // Everything on the tab takes 252 of 251: `tidy` folds. Measured again with it folded, the rest reads a pixel less.
    const folded = foldedNext(new Set(), 251, 100, chips, 4);
    expect(folded).toEqual(new Set(['tidy']));
    expect(foldedNext(folded, 251, 99, chips, 4)).toEqual(folded);
  });

  it('unfolds a chip once there is room to spare for it', () => {
    expect(foldedNext(new Set(['tidy']), 255, 100, chips, 4)).toEqual(new Set());
  });

  it('unfolds only as far as the room to spare goes', () => {
    // With `tidy` still folded the tab takes 218: `tracker` unfolds at 221, not at 220.
    expect(foldedNext(new Set(['tidy', 'tracker']), 221, 100, chips, 4)).toEqual(new Set(['tidy']));
    expect(foldedNext(new Set(['tidy', 'tracker']), 220, 100, chips, 4)).toEqual(new Set(['tidy', 'tracker']));
  });

  it('folds the chips that fold first by the order now, not the ones folded before it changed', () => {
    const raised = [chips[1]!, chips[2]!, chips[0]!];
    // `tidy` is folded, but by this order `tracker` goes first; they fit only with one folded, the same one whichever way it is held.
    expect(foldedNext(new Set(['tidy']), 217, 100, raised, 4)).toEqual(new Set(['tracker']));
  });

  it('drops a chip that is no longer on the tab', () => {
    // Everything fits at 252 but with no room to spare, which would keep one chip folded: it is not `gone`, which is not on the tab.
    expect(foldedNext(new Set(['gone']), 252, 100, chips, 4)).toEqual(new Set());
  });

  it('holds the tab that looped in the app: room 545, six chips, the rest reading 162 then 161', () => {
    const real = [['priority', 51], ['tidy', 54], ['tracker', 63], ['bind', 61], ['shell', 54], ['agent', 59]].map(([key, width]) => ({ key: key as string, width: width as number }));
    const folded = foldedNext(new Set(), 545, 162, real, 7);
    expect(folded).toEqual(new Set(['priority']));
    expect(foldedNext(folded, 545, 161, real, 7)).toEqual(folded);
  });
});
