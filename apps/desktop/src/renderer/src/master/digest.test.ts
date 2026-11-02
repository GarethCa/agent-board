import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { askingIds, isEmptyDigest, lookedAt, sinceLastLooked } from './digest';

const at = (minute: number) => new Date(Date.UTC(2026, 9, 31, 12, minute)).toISOString();

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return { sessionId: id, name: id, master: false, endedAt: null, workFinishedAt: null, status: null, ...over } as Agent;
}

const none = new Set<string>();

describe('sinceLastLooked', () => {
  it('lists the agents that finished after the last look, oldest first', () => {
    const digest = sinceLastLooked(
      [agent('late', { workFinishedAt: at(30) }), agent('early', { workFinishedAt: at(20) }), agent('before', { workFinishedAt: at(5) }), agent('working')],
      Date.parse(at(10)),
      none,
    );
    expect(digest.done.map((entry) => entry.agent.sessionId)).toEqual(['early', 'late']);
  });

  it('leaves out the Captain and any agent that is asking, which the list above holds', () => {
    const digest = sinceLastLooked(
      [agent('captain', { master: true, workFinishedAt: at(20) }), agent('asking', { workFinishedAt: at(20) }), agent('quiet', { workFinishedAt: at(20) })],
      Date.parse(at(10)),
      new Set(['asking']),
    );
    expect(digest.done.map((entry) => entry.agent.sessionId)).toEqual(['quiet']);
  });

  it('says what an agent did only when its status was set as it finished', () => {
    const status = (updatedAt: string) => ({ summary: 'Wrote the plan', progress: null, updatedAt, setBy: null });
    const digest = sinceLastLooked(
      [agent('says', { workFinishedAt: at(20), status: status(at(20)) }), agent('stale', { workFinishedAt: at(21), status: status(at(15)) })],
      Date.parse(at(10)),
      none,
    );
    expect(digest.done.map((entry) => entry.summary)).toEqual(['Wrote the plan', null]);
  });

  it('takes Up next from the live Captain, only when it wrote the line after the last look', () => {
    const line = (updatedAt: string) => ({ summary: 'Review starts next', progress: 40, updatedAt, setBy: null });
    const since = Date.parse(at(10));
    expect(sinceLastLooked([agent('c', { master: true, status: line(at(20)) })], since, none).upNext).toEqual({ text: 'Review starts next · 40%', at: at(20) });
    expect(sinceLastLooked([agent('c', { master: true, status: line(at(5)) })], since, none).upNext).toBeNull();
    expect(sinceLastLooked([agent('c', { master: true, endedAt: at(15), status: line(at(20)) })], since, none).upNext).toBeNull();
    expect(sinceLastLooked([agent('c', { master: true })], since, none).upNext).toBeNull();
    expect(sinceLastLooked([agent('a', { status: line(at(20)) })], since, none).upNext).toBeNull();
  });

  it('is empty when nothing happened: it shows nothing rather than an empty card', () => {
    expect(isEmptyDigest(sinceLastLooked([agent('a'), agent('c', { master: true })], Date.parse(at(10)), none))).toBe(true);
  });
});

describe('lookedAt', () => {
  it('is the time of day for a look today, and names the day for an earlier one', () => {
    const now = new Date(2026, 9, 31, 18, 0).getTime();
    expect(lookedAt(new Date(2026, 9, 31, 9, 5).getTime(), now)).toBe('09:05');
    expect(lookedAt(new Date(2026, 9, 29, 16, 40).getTime(), now)).toMatch(/29.*16:40$/);
  });
});

describe('askingIds', () => {
  const waiting = (id: string, over: Partial<Agent> = {}) =>
    agent(id, { state: 'waiting', createdAt: at(0), finishedAt: null, permissions: [], ask: null, plan: null, flag: null, ledBy: null, seen: false, ...over } as Partial<Agent>);

  it('leaves a finished agent waiting at its prompt out, so it is Done under "every agent waiting" too', () => {
    const finished = waiting('finished', { workFinishedAt: at(20) });
    const asks = waiting('asks', { ask: { question: 'Which?', askedAt: at(1) } as Agent['ask'] });
    expect(askingIds([finished, asks], 'turns')).toEqual(new Set(['asks']));
    expect(sinceLastLooked([finished, asks], Date.parse(at(10)), askingIds([finished, asks], 'turns')).done.map((entry) => entry.agent.sessionId)).toEqual(['finished']);
  });
});
