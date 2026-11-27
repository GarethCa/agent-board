import { describe, expect, it } from 'vitest';
import type { Agent, BoardItem } from '../src/protocol.ts';
import { doneLineData, doneLineDataProblem, doneTicketOf, gatheredTo, gatherTo, isFinished, spineJoined } from '../src/zone-clean-up.ts';

const agent = (sessionId: string, fields: Partial<Agent> = {}): Agent =>
  ({ sessionId, name: sessionId, state: 'idle', endedAt: null, shellSessionId: null, shellHarness: null, issue: null, pullRequests: [], ...fields }) as Agent;
const ended = (sessionId: string, fields: Partial<Agent> = {}) => agent(sessionId, { state: 'done', endedAt: '2026-11-15T10:00:00.000Z', ...fields });
const pr = (number: number, state: 'open' | 'merged' | 'closed') => ({ number, title: `pr ${number}`, url: `https://example.test/pull/${number}`, state, checks: 'none' as const });

const item = (kind: BoardItem['kind'], data: Record<string, unknown> = {}): BoardItem => ({
  id: 'n1', kind, zoneId: 'z', ticket: null, x: 0, y: 0, width: 240, height: 100, z: 0, rotation: 0, data, createdAt: '', updatedAt: '',
});
const note = (data: Record<string, unknown> = {}) => item('agent-note', { text: 'hi', agent: { sessionId: 's1' }, editedByUser: false, ...data });

describe('gatherTo', () => {
  it('sends an agent note to the agent that wrote it, or to the one it is about', () => {
    expect(gatherTo(note(), null)).toBe('agent:s1');
    expect(gatherTo(note({ about: 's2' }), 'lead')).toBe('agent:s2');
  });
  it('leaves a note the user edited or dragged where it is', () => {
    expect(gatherTo(note({ editedByUser: true }), null)).toBeNull();
    expect(gatherTo(note({ placedByHand: true }), null)).toBeNull();
  });
  it("sends an agent's docs to the agent that made them, and never the user's own things or the zone's", () => {
    expect(gatherTo(item('document', { title: 'Plan' }), 's3')).toBe('agent:s3');
    expect(gatherTo(item('todo'), 's3')).toBe('agent:s3');
    expect(gatherTo(item('document'), null)).toBeNull();
    for (const kind of ['sticky', 'shape', 'text', 'queue', 'clock'] as const) expect(gatherTo(item(kind), 's3')).toBeNull();
  });
  it('keeps a gathered note with its agent until the user drags it', () => {
    expect(gatheredTo(note({ gatheredTo: 'agent:s1' }))).toBe('agent:s1');
    expect(gatheredTo(note({ gatheredTo: 'agent:s1', placedByHand: true }))).toBeNull();
    expect(gatheredTo(note())).toBeNull();
  });
});

describe('isFinished', () => {
  it('is finished when every agent ended, or a pull request merged with the band at rest', () => {
    expect(isFinished([ended('a'), ended('b')])).toBe(true);
    expect(isFinished([ended('a'), agent('b')])).toBe(false);
    expect(isFinished([agent('a', { pullRequests: [pr(4, 'merged')] }), agent('b')])).toBe(true);
    // A merged pull request, but one of the band still working, or waiting on the user: not yet.
    expect(isFinished([agent('a', { pullRequests: [pr(4, 'merged')] }), agent('b', { state: 'running' })])).toBe(false);
    expect(isFinished([ended('a', { pullRequests: [pr(4, 'merged')] }), agent('b', { state: 'needs-permission' })])).toBe(false);
    expect(isFinished([agent('a', { pullRequests: [pr(4, 'merged')], state: 'hibernated', endedAt: '2026-11-15T10:00:00.000Z' })])).toBe(true);
    // Idle past its merge but flagged to the user: it needs them, so it stays on the board.
    const toUser = { id: 1, reason: 'read this', at: '2026-11-15T10:00:00.000Z', to: 'user' as const, via: null };
    expect(isFinished([agent('a', { pullRequests: [pr(4, 'merged')], flag: toUser })])).toBe(false);
    expect(isFinished([agent('a', { pullRequests: [pr(4, 'merged')], flag: { ...toUser, to: 'orchestrator' } })])).toBe(true);
    expect(isFinished([ended('a', { flag: toUser })])).toBe(false);
    expect(isFinished([agent('a', { pullRequests: [pr(4, 'open')] })])).toBe(false);
    expect(isFinished([])).toBe(false);
  });
  it('counts an agent stopped by a restart, or hibernated, as not ended', () => {
    expect(isFinished([ended('a', { state: 'stopped-by-restart' })])).toBe(false);
    expect(isFinished([ended('a', { state: 'hibernated' })])).toBe(false);
    // A shell left on its tile: the agent ended all the same.
    expect(isFinished([ended('a', { shellSessionId: 'sh1' })])).toBe(true);
  });
});

describe('spineJoined', () => {
  it("reads the agents that joined a Spine zone's bands from its state, none from anything else", () => {
    expect(spineJoined({ places: {}, joined: ['agent:a', 7, 'agent:b'] })).toEqual(['agent:a', 'agent:b']);
    expect(spineJoined({ places: {} })).toEqual([]);
    expect(spineJoined(null)).toEqual([]);
    expect(spineJoined('spine')).toEqual([]);
  });
});

describe('doneTicketOf', () => {
  it("names the chip by its ticket and its merged pull request, and keeps its tiles and notes", () => {
    const issue = { provider: 'linear' as const, id: 'ACME-7', title: 'Cut list foot', url: 'https://example.test/ACME-7' };
    const members = [ended('a', { issue, pullRequests: [pr(9, 'closed'), pr(8, 'merged')] }), ended('b', { issue })];
    expect(doneTicketOf('issue:ACME-7', members, ['n1'], 'now')).toEqual({
      key: 'issue:ACME-7', issue, title: 'Cut list foot', pr: { number: 8, url: 'https://example.test/pull/8' }, members: ['agent:a', 'agent:b'], notes: ['n1'], doneAt: 'now',
    });
  });
  it('names a chip with no ticket by its first agent, and gives it no pull request if it had none', () => {
    expect(doneTicketOf('agent:a', [ended('a', { name: 'Spike' })], [], 'now')).toMatchObject({ issue: null, title: 'Spike', pr: null });
  });
});

describe('doneLineData', () => {
  const ticket = doneTicketOf('agent:a', [ended('a')], [], 'now');
  it('reads its tickets, dropping what is not one', () => {
    expect(doneLineData({ tickets: [ticket, { key: 3 }] })).toEqual({ tickets: [ticket] });
    expect(doneLineData({})).toEqual({ tickets: [] });
  });
  it('refuses data that is not a list of tickets', () => {
    expect(doneLineDataProblem({ tickets: [ticket] })).toBeNull();
    expect(doneLineDataProblem({ tickets: [{ key: 'x' }] })).toMatch(/tickets must be/);
    expect(doneLineDataProblem({})).toMatch(/tickets must be/);
  });
});
