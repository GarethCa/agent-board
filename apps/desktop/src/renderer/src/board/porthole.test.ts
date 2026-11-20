import { describe, expect, it } from 'vitest';
import { galleryAgent } from './TileGallery';
import { GLANCE_LEVELS, GLANCE_STATES, glanceFace, type GlanceState } from './glance-tile';
import { portholeRing as ringOf, portholeWordTone as toneOf } from './porthole';

// A state at its own level, as every live agent's face is.
const portholeRing = (state: GlanceState) => ringOf({ state, level: GLANCE_LEVELS[state] });
const portholeWordTone = (state: GlanceState) => toneOf({ state, level: GLANCE_LEVELS[state] });

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

describe('an exited agent on a porthole', () => {
  it('draws no problem ring and no red chip, whatever its exit code', () => {
    for (const exitCode of [1, 0]) {
      const face = glanceFace({ ...galleryAgent('failed'), endedAt: '2026-10-23T08:00:00Z', exitCode }, 'explicit');
      expect(face.state).toBe('failed');
      expect(ringOf(face)).toBe('plain');
      expect(toneOf(face)).toBe('quiet');
    }
  });

  it('keeps the loud ring for a failed start, which asks for Try again', () => {
    const face = glanceFace({ ...galleryAgent('failed'), endedAt: '2026-10-23T08:00:00Z', exitCode: 1, startup: { failed: true, output: null } }, 'explicit');
    expect(ringOf(face)).toBe('problem');
    expect(toneOf(face)).toBe('chip');
  });
});
