import { describe, expect, it } from 'vitest';
import { nowActions } from './now-action';

const running = { endedAt: null, state: 'running' } as const;
const paused = { endedAt: null, state: 'hibernated' } as const;
const ended = { endedAt: '2026-01-01T00:00:00.000Z', state: 'done' } as const;

describe('what the header of an open agent offers for what it is doing now', () => {
  it('offers Stop while it works, and nothing while it waits', () => {
    expect(nowActions(running, { status: 'working', merge: false })).toEqual(['stop']);
    expect(nowActions(running, { status: 'needs-you', merge: false })).toEqual([]);
  });

  it('offers Wake while it is paused', () => {
    expect(nowActions(paused, { status: 'paused', merge: false })).toEqual(['wake']);
  });

  it('never offers Stop once it has ended, whatever its status says', () => {
    expect(nowActions(ended, { status: 'working', merge: false })).toEqual([]);
  });

  it("offers a ticket's Merge once its pull request is ready, after Stop or Wake", () => {
    expect(nowActions(running, { status: 'done', merge: true })).toEqual(['merge']);
    expect(nowActions(running, { status: 'working', merge: true })).toEqual(['stop', 'merge']);
    expect(nowActions(paused, { status: 'paused', merge: true })).toEqual(['wake', 'merge']);
  });
});
