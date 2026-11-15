import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { crewAgents, directoryTracker, shelvesTracker, type AgentChange } from './crew-agents';

const agent = (sessionId: string, spawnedBy: string | null = null) => ({ sessionId, spawnedBy }) as Agent;

describe('the agents a crew is', () => {
  const all = [agent('lead'), agent('a', 'lead'), agent('b', 'other'), agent('c', 'lead'), agent('rec', null)];

  it('are those it started, and those it recorded starting, in the board order', () => {
    expect(crewAgents(all, 'lead', new Set(['rec'])).map((each) => each.sessionId)).toEqual(['a', 'c', 'rec']);
  });

  it('are none for an agent that started no one', () => {
    expect(crewAgents(all, 'solo', new Set())).toEqual([]);
  });
});

describe('a crew tracker, which the shelves render from', () => {
  const lead = 'lead';
  const base = [agent('lead'), agent('a', lead), agent('b', 'other')];

  it('is undefined until the agents are listed', () => {
    expect(shelvesTracker(lead, null).snapshot()).toBeUndefined();
  });

  it('gives a new array when a crew member changes, and the same one for any other agent', () => {
    const tracker = shelvesTracker(lead, null);
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
    const tracker = shelvesTracker(lead, null);
    tracker.load(base);
    tracker.hear({ put: agent('c', lead) });
    expect(tracker.snapshot()!.map((each) => each.sessionId)).toEqual(['a', 'c']);
    tracker.hear({ removed: 'a' });
    expect(tracker.snapshot()!.map((each) => each.sessionId)).toEqual(['c']);
  });

  it('plays the changes heard before the list over it', () => {
    const tracker = shelvesTracker(lead, null);
    tracker.hear({ put: agent('late', lead) });
    tracker.hear({ removed: 'a' });
    tracker.load(base);
    expect(tracker.snapshot()!.map((each) => each.sessionId)).toEqual(['late']);
  });

  it('counts an agent a crew record names, once the keys are set', () => {
    const tracker = shelvesTracker(lead, null);
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

describe("the agents an agent's shelves need", () => {
  const named = (sessionId: string, fields: Partial<Agent> = {}) => ({ sessionId, name: sessionId, master: false, spawnedBy: null, state: 'idle', ...fields }) as Agent;
  const base = [named('boss'), named('own', { spawnedBy: 'boss' }), named('kid', { spawnedBy: 'own' }), named('other', { spawnedBy: 'boss' })];

  it('are its crew and the agent that started it', () => {
    const tracker = shelvesTracker('own', 'boss');
    tracker.load(base);
    expect(tracker.snapshot()!.map((each) => each.sessionId)).toEqual(['boss', 'kid']);
  });

  it('are its crew alone when no agent started it', () => {
    const tracker = shelvesTracker('own', null);
    tracker.load(base);
    expect(tracker.snapshot()!.map((each) => each.sessionId)).toEqual(['kid']);
  });

  it('keep the same array while the agent that started it changes but its name or role', () => {
    const tracker = shelvesTracker('own', 'boss');
    tracker.load(base);
    const first = tracker.snapshot()!;
    tracker.hear({ put: named('boss', { state: 'running' }) });
    expect(tracker.snapshot()).toBe(first);
    tracker.hear({ put: named('boss', { name: 'Renamed' }) });
    expect(tracker.snapshot()!.find((each) => each.sessionId === 'boss')!.name).toBe('Renamed');
    const renamed = tracker.snapshot();
    tracker.hear({ put: named('boss', { name: 'Renamed', master: true }) });
    expect(tracker.snapshot()).not.toBe(renamed);
  });

  it('give the starter its live object when it is crew as well', () => {
    const tracker = shelvesTracker('own', 'boss');
    tracker.setKeys(['boss']);
    tracker.load(base);
    const running = named('boss', { state: 'running' });
    tracker.hear({ put: running });
    expect(tracker.snapshot()!.filter((each) => each.sessionId === 'boss')).toEqual([running]);
  });

  it('render a sidebar for its own crew only, where every agent would render it for each change', () => {
    // A 40-agent board: one orchestrator with crews of its own, and 200 changes spread over every agent.
    const board = [named('boss'), named('own', { spawnedBy: 'boss' })];
    for (let i = 0; i < 3; i++) board.push(named(`kid${i}`, { spawnedBy: 'own' }));
    for (let i = 0; i < 35; i++) board.push(named(`a${i}`, { spawnedBy: 'boss' }));
    const changes: AgentChange[] = Array.from({ length: 200 }, (_, i) => ({ put: { ...board[i % board.length]!, state: i % 2 === 0 ? 'running' : 'idle' } as Agent }));
    const renders = (first: unknown, snapshotAfter: (change: AgentChange) => unknown) => {
      let count = 0;
      let last = first;
      for (const change of changes) {
        const next = snapshotAfter(change);
        if (next !== last) count++;
        last = next;
      }
      return count;
    };
    // Before: the sidebar's state was the whole list, a new array on every change: an assumed baseline, not measured.
    let all = board;
    const before = renders(all, (change) => (all = all.map((each) => ('put' in change && each.sessionId === change.put.sessionId ? change.put : each))));
    const tracker = shelvesTracker('own', 'boss');
    tracker.load(board);
    const after = renders(tracker.snapshot(), (change) => {
      tracker.hear(change);
      return tracker.snapshot();
    });
    expect(before).toBe(200);
    // Its three crew members change 15 times each; the starter's state changes don't count.
    expect(after).toBe(15);
  });
});
