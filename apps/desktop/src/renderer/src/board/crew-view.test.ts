import { describe, expect, it } from 'vitest';
import { crewLookFrom, nextCrewLook } from './crew-view';

describe('crewLookFrom', () => {
  it('reads a saved look, and shows frames otherwise', () => {
    expect(crewLookFrom('chips')).toBe('chips');
    expect(crewLookFrom('off')).toBe('off');
    expect(crewLookFrom('frames')).toBe('frames');
    expect(crewLookFrom(undefined)).toBe('frames');
    expect(crewLookFrom('bogus')).toBe('frames');
  });
});

describe('nextCrewLook', () => {
  it('cycles frames, chips, off', () => {
    expect(nextCrewLook('frames')).toBe('chips');
    expect(nextCrewLook('chips')).toBe('off');
    expect(nextCrewLook('off')).toBe('frames');
  });
});
