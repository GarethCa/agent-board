import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { BoardConnection } from '../src/board.ts';
import { migrate } from '../src/migrate.ts';
import { createOrchestratorHost } from '../src/orchestrators.ts';
import type { Agent, AgentState, DaemonEvent } from '../src/protocol.ts';

/**
 * An orchestrator host over agents kept in a map, so a test says exactly which updates arrive and when: what a wait
 * makes of them can't depend on how fast a fake harness runs.
 */
function host() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const agents = new Map<string, Agent>();
  const add = (sessionId: string, fields: Partial<Agent>) =>
    agents.set(sessionId, {
      sessionId,
      name: sessionId,
      zoneId: 'z',
      repoRoot: '/repo',
      state: 'idle',
      endedAt: null,
      permissions: [],
      orchestrate: null,
      spawnedBy: null,
      lastMessage: null,
      ...fields,
    } as Agent);
  add('me', { orchestrate: 'zone' });
  add('worker', { state: 'rate-limited', spawnedBy: 'me' });
  const orchestrators = createOrchestratorHost({
    db,
    sessions: { sessionForBoardToken: (token) => (token === 'me-token' ? 'me' : undefined) },
    shells: { list: () => [] },
    agents: {
      get: (id) => agents.get(id),
      list: () => [...agents.values()],
      fallbackOwner: () => undefined,
      answer: async () => {},
      spawn: () => Promise.reject(new Error('not here')),
      interrupt: () => {
        throw new Error('not here');
      },
      stop: () => Promise.reject(new Error('not here')),
      finalMessage: () => undefined,
    },
    zones: () => [],
    flowEdges: {
      create: () => {
        throw new Error('not here');
      },
      get: () => undefined,
      remove: () => {},
    },
    deleteAgent: async () => {},
    broadcast: () => {},
    log: () => {},
  });
  const handlers = orchestrators.handlers<BoardConnection>();
  /** The worker shows `state`, as the daemon would tell every client. */
  const update = (state: AgentState, fields: Partial<Agent> = {}) => {
    add('worker', { ...agents.get('worker'), state, ...fields });
    orchestrators.onEvent({ type: 'agent.updated', agent: agents.get('worker')! } as DaemonEvent);
  };
  return { orchestrators, handlers, update, agents };
}

describe('refused calls in the log', () => {
  it('keeps at most 20 a minute from one tile, so a looping agent can not grow the log without bound', async () => {
    const { orchestrators, handlers } = host();
    for (let i = 0; i < 25; i++) orchestrators.refused('worker', 'orchestrator.send', { text: `try ${i}` }, 'only for an orchestrator');
    const log = await handlers['orchestrator.activity']({ limit: 100 }, {});
    expect(log).toHaveLength(20);
    expect(log.every((line) => line.outcome === 'refused' && line.orchestratorId === 'worker')).toBe(true);
  });
});

describe('waiting for the turn an orchestrator caused', () => {
  it('takes no update but a turn under way as its start: a rename after a send to a rate-limited agent is not one', async () => {
    const { handlers, update } = host();
    const connection: BoardConnection = {};
    await handlers['orchestrator.send']({ token: 'me-token', sessionId: 'worker', text: 'continue' }, connection);

    // Renamed, still rate-limited: the turn hasn't begun.
    update('rate-limited', { name: 'renamed' });
    expect(await handlers['orchestrator.wait']({ token: 'me-token', sessionIds: ['worker'], timeoutMs: 30 }, connection)).toMatchObject({
      timedOut: true,
    });

    const waited = handlers['orchestrator.wait']({ token: 'me-token', sessionIds: ['worker'], timeoutMs: 5_000 }, connection);
    update('running');
    update('idle');
    expect(await waited).toMatchObject({ timedOut: false, agents: [{ state: 'idle' }] });
  });

  it('ends a wait once its connection has closed', async () => {
    const { handlers } = host();
    const closing = new AbortController();
    const connection: BoardConnection = { closed: closing.signal };
    const started = Date.now();
    const waited = handlers['orchestrator.wait']({ token: 'me-token', sessionIds: ['worker'], states: ['done'], timeoutMs: 60_000 }, connection);
    closing.abort();
    expect(await waited).toMatchObject({ timedOut: true });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('answers every wait as timed out when the daemon closes', async () => {
    const { handlers, orchestrators } = host();
    const waited = handlers['orchestrator.wait']({ token: 'me-token', sessionIds: ['worker'], states: ['done'], timeoutMs: 60_000 }, {});
    orchestrators.close();
    expect(await waited).toMatchObject({ timedOut: true });
  });

  it('fails a wait on an agent deleted meanwhile', async () => {
    const { handlers, orchestrators, agents } = host();
    const waited = handlers['orchestrator.wait']({ token: 'me-token', sessionIds: ['worker'], states: ['done'], timeoutMs: 60_000 }, {});
    agents.delete('worker');
    orchestrators.onEvent({ type: 'agent.removed', sessionId: 'worker' });
    await expect(waited).rejects.toThrow(/was deleted/);
  });
});
