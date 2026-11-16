import { describe, expect, it } from 'vitest';
import { GLANCE_STATES } from './glance-tile';
import { portholeRing, portholeWordTone } from './porthole';

describe("a porthole's ring", () => {
  it('fills with colour only for the work waiting for the user: amber when it asks, red for a problem', () => {
    expect(portholeRing('needs')).toBe('ask');
    expect(portholeRing('permission')).toBe('ask');
    expect(portholeRing('failed')).toBe('problem');
  });

  it('is a thin accent ring while it works, a thin green one once done, and plain otherwise', () => {
    expect(portholeRing('working')).toBe('work');
    expect(portholeRing('thinking')).toBe('work');
    expect(portholeRing('done')).toBe('done');
    for (const state of ['idle', 'paused', 'limit', 'review', 'scheduled'] as const) expect(portholeRing(state), state).toBe('plain');
  });

  it('has a ring for every glance state', () => {
    for (const state of GLANCE_STATES) expect(portholeRing(state), state).toBeDefined();
  });
});

describe("a porthole's state word", () => {
  it('is a chip for the states that want the user, and a coloured word for work, done and a usage limit', () => {
    expect(portholeWordTone('needs')).toBe('chip');
    expect(portholeWordTone('failed')).toBe('chip');
    expect(portholeWordTone('thinking')).toBe('work');
    expect(portholeWordTone('done')).toBe('done');
    expect(portholeWordTone('limit')).toBe('limit');
    expect(portholeWordTone('review')).toBe('quiet');
  });
});
