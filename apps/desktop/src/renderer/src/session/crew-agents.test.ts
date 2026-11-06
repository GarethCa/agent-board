import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { crewAgents, crewTracker, directoryTracker } from './crew-agents';

const agent = (sessionId: string, spawnedBy: string | null = null) => ({ sessionId, spawnedBy }) as Agent;

describe('the agents a details strip needs', () => {
  const all = [agent('lead'), agent('a', 'lead'), agent('b', 'other'), agent('c', 'lead'), agent('rec', null)];

  it('are those it started, and those it recorded starting, in the board order', () => {
    expect(crewAgents(all, 'lead', new Set(['rec'])).map((each) => each.sessionId)).toEqual(['a', 'c', 'rec']);
  });

  it('are none for an agent that started no one', () => {
    expect(crewAgents(all, 'solo', new Set())).toEqual([]);
  });
});

describe('a crew tracker, which a details strip renders from', () => {
  const lead = 'lead';
  const base = [agent('lead'), agent('a', lead), agent('b', 'other')];

  it('is undefined until the agents are listed', () => {
    expect(crewTracker(lead).snapshot()).toBeUndefined();
  });

  it('gives a new array when a crew member changes, and the same one for any other agent', () => {
    const tracker = crewTracker(lead);
    tracker.load(base);
    const first = tracker.snapshot()!;
    tracker.hear({ put: { ...agent('b', 'other'), name: 'changed' } as Agent });
    tracker.hear({ put: agent('stranger') });
    tracker.hear({ removed: 'b' });
    expect(tracker.snapshot()).toBe(first);
    const updated = { ...agent('a', lead), state: 'running' } as Agent;
    tracker.hear({ put: updated });
    expect(tracker.snapshot()).not.toBe(first);
    expect(tracker.snapshot()).toEqual([updated]);
  });

  it('adds a new crew member, and drops one that is removed', () => {
    const tracker = crewTracker(lead);
    tracker.load(base);
    tracker.hear({ put: agent('c', lead) });
    expect(tracker.snapshot()!.map((each) => each.sessionId)).toEqual(['a', 'c']);
    tracker.hear({ removed: 'a' });
    expect(tracker.snapshot()!.map((each) => each.sessionId)).toEqual(['c']);
  });

  it('plays the changes heard before the list over it', () => {
    const tracker = crewTracker(lead);
    tracker.hear({ put: agent('late', lead) });
    tracker.hear({ removed: 'a' });
    tracker.load(base);
    expect(tracker.snapshot()!.map((each) => each.sessionId)).toEqual(['late']);
  });

  it('counts an agent a crew record names, once the keys are set', () => {
    const tracker = crewTracker(lead);
    tracker.load(base);
    const first = tracker.snapshot()!;
    tracker.setKeys(['b']);
    expect(tracker.snapshot()!.map((each) => each.sessionId)).toEqual(['a', 'b']);
    expect(tracker.snapshot()).not.toBe(first);
    const withKeys = tracker.snapshot();
    tracker.setKeys(['b']);
    expect(tracker.snapshot()).toBe(withKeys);
  });
});

describe("a window's agent directory", () => {
  const named = (sessionId: string, name: string, fields: Partial<Agent> = {}) => ({ sessionId, name, state: 'idle', ...fields }) as Agent;
  const base = [named('own', 'Own'), named('shown', 'Shown'), named('other', 'Other')];

  it('is the same array when an agent it does not watch changes but its name', () => {
    const tracker = directoryTracker();
    tracker.watch(['own', 'shown']);
    tracker.load(base);
    const first = tracker.snapshot()!;
    tracker.hear({ put: named('other', 'Other', { state: 'running' }) });
    expect(tracker.snapshot()).toBe(first);
  });

  it('is a new array when a watched agent changes, with the live object', () => {
    const tracker = directoryTracker();
    tracker.watch(['own', 'shown']);
    tracker.load(base);
    const first = tracker.snapshot()!;
    const running = named('shown', 'Shown', { state: 'running' });
    tracker.hear({ put: running });
    expect(tracker.snapshot()).not.toBe(first);
    expect(tracker.snapshot()!.find((each) => each.sessionId === 'shown')).toBe(running);
  });

  it('is a new array when an agent comes, goes or is renamed', () => {
    const tracker = directoryTracker();
    tracker.load(base);
    let last = tracker.snapshot()!;
    for (const change of [{ put: named('new', 'New') }, { removed: 'new' }, { put: named('other', 'Renamed') }]) {
      tracker.hear(change);
      expect(tracker.snapshot()).not.toBe(last);
      last = tracker.snapshot()!;
    }
    expect(last.map((each) => each.name)).toEqual(['Own', 'Shown', 'Renamed']);
  });

  it('gives an agent its live object once it is watched, though it changed meanwhile', () => {
    const tracker = directoryTracker();
    tracker.load(base);
    const running = named('other', 'Other', { state: 'running' });
    tracker.hear({ put: running });
    tracker.watch(['other']);
    expect(tracker.snapshot()!.find((each) => each.sessionId === 'other')).toBe(running);
  });
});
