import { describe, expect, it } from 'vitest';
import { itemKindLabel, itemKindTitle } from './kind-labels';

describe('item kind names', () => {
  it('names a known kind as a sentence uses it, and as a row starts with it', () => {
    expect(itemKindLabel('sticky')).toBe('sticky note');
    expect(itemKindTitle('sticky')).toBe('Sticky note');
  });

  it('names a kind this app does not know by its own word', () => {
    expect(itemKindLabel('mod')).toBe('mod item');
    expect(itemKindTitle('mod')).toBe('Mod item');
    // Not a key every object has.
    expect(itemKindLabel('constructor')).toBe('constructor item');
  });
});
