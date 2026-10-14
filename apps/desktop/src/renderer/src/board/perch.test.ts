import { describe, expect, it } from 'vitest';
import type { SessionState, Subagent } from '@agent-board/daemon/protocol';
import { LEAVE_MS, MAX_LEAVING_PAST_CAP, MAX_PERCHED, perch, poseOf } from './perch';

const NOW = Date.parse('2026-10-09T10:00:00.000Z');

function subagent(id: string, state: SessionState = 'running', endedMsAgo?: number, result: string | null = null): Subagent {
  return {
    id,
    type: 'Explore',
    state,
    startedAt: new Date(NOW - 60_000).toISOString(),
    endedAt: endedMsAgo === undefined ? null : new Date(NOW - endedMsAgo).toISOString(),
    result,
  };
}

const ids = (subagents: readonly Subagent[]) => subagents.map((s) => s.id);

describe('perching subagents on a tile', () => {
  it('perches every live subagent, oldest first, when they fit', () => {
    const { perched, overflow } = perch([subagent('a'), subagent('b')], NOW);
    expect(ids(perched)).toEqual(['a', 'b']);
    expect(overflow).toBe(0);
  });

  it(`perches at most ${MAX_PERCHED} and counts the rest as overflow`, () => {
    const many = Array.from({ length: MAX_PERCHED + 7 }, (_, i) => subagent(`s${i}`));
    const { perched, overflow } = perch(many, NOW);
    expect(perched).toHaveLength(MAX_PERCHED);
    expect(overflow).toBe(7);
  });

  it('keeps the ones that need you in view when there are too many', () => {
    const many = [...Array.from({ length: MAX_PERCHED }, (_, i) => subagent(`s${i}`)), subagent('asks', 'needs-permission')];
    expect(ids(perch(many, NOW).perched)).toContain('asks');
  });

  it(`shows a finished subagent leaving for ${LEAVE_MS} ms, then drops it`, () => {
    expect(ids(perch([subagent('a', 'done', 0)], NOW).perched)).toEqual(['a']);
    expect(ids(perch([subagent('a', 'done', LEAVE_MS - 1)], NOW).perched)).toEqual(['a']);
    expect(perch([subagent('a', 'done', LEAVE_MS)], NOW).perched).toEqual([]);
  });

  it('leaves a finishing subagent in its place, so no character swaps places', () => {
    expect(ids(perch([subagent('a', 'done', 10), subagent('b')], NOW).perched)).toEqual(['a', 'b']);
  });

  it(`lets up to ${MAX_LEAVING_PAST_CAP} leaving subagents past the cap, so even a full tile shows them go`, () => {
    const live = Array.from({ length: MAX_PERCHED }, (_, i) => subagent(`s${i}`));
    const leaving = ['g1', 'g2', 'g3'].map((id) => subagent(id, 'done', 10));
    const { perched, overflow } = perch([...leaving, ...live], NOW);
    expect(ids(perched)).toEqual([...ids(leaving.slice(0, MAX_LEAVING_PAST_CAP)), ...ids(live)]);
    expect(overflow).toBe(0);
  });

  it('fills free places with leaving subagents, and never counts them as overflow', () => {
    const leaving = Array.from({ length: MAX_PERCHED + 3 }, (_, i) => subagent(`g${i}`, 'done', 10));
    const { perched, overflow } = perch([subagent('a'), ...leaving], NOW);
    expect(ids(perched)).toEqual(['a', ...ids(leaving.slice(0, MAX_PERCHED - 1))]);
    expect(overflow).toBe(0);
  });

  it('says when the next leaving subagent will be gone, so the tile can redraw then', () => {
    expect(perch([subagent('a')], NOW).nextChangeInMs).toBeUndefined();
    expect(perch([subagent('a', 'done', 400), subagent('b', 'done', 100)], NOW).nextChangeInMs).toBe(LEAVE_MS - 400);
  });
});

describe('a subagent character pose', () => {
  it('is its state while it runs', () => {
    expect(poseOf(subagent('a', 'thinking'))).toBe('thinking');
    expect(poseOf(subagent('a', 'needs-permission'))).toBe('needs-permission');
  });

  it('hands off its result when it finishes with one, or shows a tick without', () => {
    expect(poseOf(subagent('a', 'done', 0, 'Found it.'))).toBe('handing-off');
    expect(poseOf(subagent('a', 'done', 0))).toBe('done');
  });

  it('is toppled when it ended with a failed agent', () => {
    expect(poseOf(subagent('a', 'failed', 0))).toBe('failed');
  });
});
