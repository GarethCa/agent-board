import { describe, expect, it } from 'vitest';
import { foldedFrom, withFold } from './shelf-folds';

describe('the folded sections of the shelves', () => {
  it('are read from what was stored: only sections the shelves have, once each, nothing from a broken value', () => {
    expect(foldedFrom(undefined)).toEqual([]);
    expect(foldedFrom('not json')).toEqual([]);
    expect(foldedFrom('{"crew-agents":true}')).toEqual([]);
    expect(foldedFrom('["crew-agents","gone","crew-agents",3]')).toEqual(['crew-agents']);
  });

  it('keep the shelves order, whichever was folded first', () => {
    expect(withFold(withFold([], 'setup-where', true), 'made-shown', true)).toEqual(['made-shown', 'setup-where']);
  });

  it('open a section again, leaving the others folded, and are empty once every one is open', () => {
    expect(withFold(['made-shown', 'setup-where'], 'made-shown', false)).toEqual(['setup-where']);
    expect(withFold(['made-shown'], 'made-shown', false)).toEqual([]);
    expect(withFold(['made-shown'], 'made-shown', true)).toEqual(['made-shown']);
  });
});
