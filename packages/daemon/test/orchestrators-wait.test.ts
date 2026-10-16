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
function host(agents = new Map<string, Agent>()) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  /** Agents only their idle prompt left waiting. */
  const idlePrompted = new Set<string>();
  const add = (sessionId: string, fields: Partial<Agent>) =>
    agents.set(sessionId, {
      sessionId,
      name: sessionId,
      zoneId: 'z',
      repoRoot: '/repo',
      state: 'idle',
      endedAt: null,
      permissions: [],
      ask: null,
      plan: null,
      orchestrate: null,
      spawnedBy: null,
      lastMessage: null,
      workFinishedAt: null,
      pullRequests: [],
      exitCode: null,
      status: null,
      ...fields,
    } as Agent);
  if (agents.size === 0) {
    add('me', { orchestrate: 'zone' });
    add('worker', { state: 'rate-limited', spawnedBy: 'me' });
    add('outsider', { zoneId: 'elsewhere' });
  }
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
      resume: () => Promise.reject(new Error('not here')),
      stop: () => Promise.reject(new Error('not here')),
      finalMessage: () => undefined,
      orchestrateFacts: () => ({ off: false, depth: 0 }),
      idlePrompted: (id) => idlePrompted.has(id),
    },
    zones: () => [],
    flowEdges: {
      create: () => {
        throw new Error('not here');
      },
      link: () => undefined,
      get: () => undefined,
      remove: () => {},
    },
    deleteAgent: async () => {},
    broadcast: () => {},
    log: () => {},
  });
  const handlers = orchestrators.handlers<BoardConnection>();
  /** The worker shows `state`, as the daemon would tell every client. */
  const update = (state: AgentState, fields: Partial<Agent> = {}, sessionId = 'worker', idlePrompt = false) => {
    if (idlePrompt) idlePrompted.add(sessionId);
    else idlePrompted.delete(sessionId);
    add(sessionId, { ...agents.get(sessionId), state, ...fields });
    orchestrators.onEvent({ type: 'agent.updated', agent: agents.get(sessionId)! } as DaemonEvent);
  };
  /** The crew events the orchestrator hears after `since`, as `kind detail` lines, or none once `timeoutMs` passes. */
  const heard = async (since: string, params: Record<string, unknown> = { crew: true }, timeoutMs = 30) => {
    const result = await handlers['orchestrator.wait']({ token: 'me-token', since, timeoutMs, ...params }, {});
    return { ...result, lines: result.events.map((event) => `${event.name} ${event.kind}${event.detail === null ? '' : ` ${event.detail}`}`) };
  };
  /** The agent is deleted, as the daemon would tell every client. */
  const remove = (sessionId: string) => {
    agents.delete(sessionId);
    orchestrators.onEvent({ type: 'agent.removed', sessionId });
  };
  /** The agent's own pull requests are read, as the daemon's watcher would tell the orchestrators. */
  const read = (pullRequests: { number: number; state: string }[], first = false, sessionId = 'worker') =>
    orchestrators.onPullRequestsRead(
      sessionId,
      pullRequests.map(({ number, state }) => ({ number, state, url: `https://github.com/o/r/pull/${number}` }) as Agent['pullRequests'][number]),
      first,
    );
  return { orchestrators, handlers, update, remove, read, agents, heard };
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

describe('crew events', () => {
  it("hears an agent finish once, not each turn it ends while its background work runs, nor its idle prompt", async () => {
    const { update, heard, handlers } = host();
    const { cursor: start } = await heard('now');
    const finished = handlers['orchestrator.wait']({ token: 'me-token', sessionIds: ['worker'], states: ['finished'], timeoutMs: 5_000 }, {});
    let answered = false;
    void Promise.resolve(finished).then(() => (answered = true));

    update('running');
    update('idle');
    // Claude's idle_prompt, a minute later: the same ended turn.
    update('waiting', {}, 'worker', true);
    update('running');
    update('idle');
    await Promise.resolve();
    expect(answered).toBe(false);

    update('running');
    update('running', { workFinishedAt: '2026-10-16T10:00:00.000Z', status: { summary: 'PR open', progress: null, updatedAt: '' } });
    update('idle');
    update('waiting', {}, 'worker', true);
    expect((await heard(start)).lines).toEqual(['worker turn-ended', 'worker turn-ended', 'worker finished PR open']);
    expect(await finished).toMatchObject({ timedOut: false, agents: [{ workFinishedAt: '2026-10-16T10:00:00.000Z' }] });
  });

  it('hears what needs the user, a failed or rate-limited turn, a pull request and the session ending, each once', async () => {
    const { update, heard, read } = host();
    read([], true);
    const { cursor: start } = await heard('now');
    update('running');
    update('needs-permission', { permissions: [{ toolName: 'Bash' }] as Agent['permissions'] });
    update('needs-permission', { permissions: [{ toolName: 'Bash' }, { toolName: 'Edit' }] as Agent['permissions'] });
    update('running', { permissions: [] });
    update('waiting', { ask: { question: 'Which branch?' } as Agent['ask'] });
    update('running', { ask: null });
    update('failed');
    update('rate-limited');
    read([{ number: 7, state: 'open' }]);
    read([{ number: 7, state: 'open' }]);
    update('idle', { endedAt: '2026-10-16T10:00:00.000Z', exitCode: 0 });
    update('done');
    expect((await heard(start)).lines).toEqual([
      'worker needs-you permission for Bash',
      'worker needs-you Which branch?',
      'worker failed',
      'worker rate-limited',
      'worker pr-opened #7 https://github.com/o/r/pull/7',
      'worker ended exited 0',
    ]);
  });

  it('answers as soon as one comes, with a cursor to hear only what came next', async () => {
    const { update, heard } = host();
    const { cursor: start, events } = await heard('now');
    expect(events).toEqual([]);
    const waiting = heard(start, { crew: true }, 5_000);
    update('running');
    update('failed');
    const first = await waiting;
    expect(first).toMatchObject({ timedOut: false, lines: ['worker failed'] });
    expect(await heard(first.cursor)).toMatchObject({ timedOut: true, lines: [] });
  });

  it('keeps to the kinds asked for', async () => {
    const { update, heard } = host();
    const { cursor: start } = await heard('now');
    update('running');
    update('idle');
    update('running', { workFinishedAt: '2026-10-16T10:00:00.000Z' });
    expect((await heard(start, { crew: true, kinds: ['finished'] })).lines).toEqual(['worker finished']);
  });

  it("hears its crew's agents alone, and refuses an agent outside its scope as read does", async () => {
    const { update, heard, handlers } = host();
    const { cursor: start } = await heard('now');
    update('failed', {}, 'outsider');
    update('failed');
    expect((await heard(start)).lines).toEqual(['worker failed']);
    await expect(handlers['orchestrator.wait']({ token: 'me-token', sessionIds: ['outsider'], since: 'now', timeoutMs: 30 }, {})).rejects.toThrow(
      /outside your scope/,
    );
  });

  it('waits on its whole crew without naming them', async () => {
    const { update, handlers } = host();
    const waited = handlers['orchestrator.wait']({ token: 'me-token', crew: true, states: ['finished'], timeoutMs: 5_000 }, {});
    update('running', { workFinishedAt: '2026-10-16T10:00:00.000Z' });
    expect(await waited).toMatchObject({ timedOut: false, agents: [{ sessionId: 'worker' }] });
  });

  it("does not take an agent its idle prompt left waiting as waiting on the user", async () => {
    const { update, handlers } = host();
    update('running');
    update('idle');
    update('waiting', {}, 'worker', true);
    expect(await handlers['orchestrator.wait']({ token: 'me-token', sessionIds: ['worker'], states: ['waiting'], timeoutMs: 30 }, {})).toMatchObject({
      timedOut: true,
    });
    expect(await handlers['orchestrator.wait']({ token: 'me-token', sessionIds: ['worker'], states: ['idle'], timeoutMs: 30 }, {})).toMatchObject({
      timedOut: false,
    });
  });
});

describe('crew events across a restart, a question, pull requests and a removal', () => {
  it('replays the whole new run, marked missed, to a cursor from before the daemon restarted', async () => {
    const first = host();
    const { cursor: old } = await first.heard('now');
    first.update('running');
    first.update('failed');
    const { cursor: before } = await first.heard(old);
    // The daemon restarts: a new host over the same agents, whose run's events outnumber the old cursor's.
    const second = host(first.agents);
    for (let turn = 0; turn < 3; turn++) {
      second.update('running');
      second.update('idle');
    }
    second.update('running');
    second.update('failed');
    const replayed = await second.heard(before);
    expect(replayed).toMatchObject({ missed: true, timedOut: false });
    expect(replayed.lines).toEqual(['worker turn-ended', 'worker turn-ended', 'worker turn-ended', 'worker failed']);
    expect(await second.heard(replayed.cursor)).toMatchObject({ missed: false, lines: [] });
    await expect(second.handlers['orchestrator.wait']({ token: 'me-token', crew: true, since: 'nonsense', timeoutMs: 30 }, {})).rejects.toThrow(
      /not a cursor/,
    );
  });

  it("hears Claude's own question mid-turn as needing the user, and a wait takes it as waiting", async () => {
    const { update, heard, handlers } = host();
    const { cursor: start } = await heard('now');
    update('running');
    // agent_needs_input: waiting, with no ask of the board's, and not its idle prompt.
    update('waiting', { lastMessage: 'Which branch should I use?' });
    expect((await heard(start)).lines).toEqual(['worker needs-you Which branch should I use?']);
    expect(await handlers['orchestrator.wait']({ token: 'me-token', sessionIds: ['worker'], states: ['waiting'], timeoutMs: 30 }, {})).toMatchObject({
      timedOut: false,
    });

    // From idle too: a question is no idle prompt.
    const { cursor: next } = await heard('now');
    update('idle');
    update('waiting', { lastMessage: 'Still there?' });
    expect((await heard(next)).lines).toEqual(['worker needs-you Still there?']);
  });

  it('takes what its first read finds as known, and hears an open pull request new since, never a merged one', async () => {
    const { heard, read } = host();
    const { cursor: start } = await heard('now');
    // The first read after a restart finds what was there.
    read([{ number: 7, state: 'open' }], true);
    read([{ number: 7, state: 'open' }, { number: 8, state: 'merged' }, { number: 9, state: 'draft' }]);
    expect((await heard(start)).lines).toEqual(['worker pr-opened #9 https://github.com/o/r/pull/9']);
  });

  it('hears a pull request opened after a first read that found none and told no one (review 2)', async () => {
    const { heard, read } = host();
    const { cursor: start } = await heard('now');
    // No pull requests at the first read: nothing changed, so no agent update came.
    read([], true);
    read([{ number: 9, state: 'open' }]);
    expect((await heard(start)).lines).toEqual(['worker pr-opened #9 https://github.com/o/r/pull/9']);
  });

  it('hears the pull request of an agent started after the daemon, read first as it started', async () => {
    const { update, heard, read } = host();
    const { cursor: start } = await heard('now');
    update('running', { name: 'late', spawnedBy: 'me' }, 'late');
    read([], true, 'late');
    update('idle', {}, 'late');
    read([{ number: 11, state: 'open' }], false, 'late');
    expect((await heard(start)).lines).toEqual(['late turn-ended', 'late pr-opened #11 https://github.com/o/r/pull/11']);
  });

  it('keeps each event to one line: a question over many lines is folded and cut short', async () => {
    const { update, heard } = host();
    const { cursor: start } = await heard('now');
    update('running');
    update('waiting', { lastMessage: `I changed X.\n\nShould I also do Y?\n${'and more '.repeat(40)}` });
    const [line] = (await heard(start)).lines;
    expect(line).toMatch(/^worker needs-you I changed X\. Should I also do Y\? and more/);
    expect(line).not.toContain('\n');
    expect(line!.length).toBeLessThanOrEqual('worker needs-you '.length + 200);
    expect(line!.endsWith('…')).toBe(true);
  });

  it("still hears a removed agent's last events between waits, and its end once", async () => {
    const { update, remove, heard } = host();
    const { cursor: start } = await heard('now');
    update('running', { workFinishedAt: '2026-10-16T10:00:00.000Z' });
    remove('worker');
    expect((await heard(start)).lines).toEqual(['worker finished', 'worker ended removed']);
  });

  it('says a deliberate close closed it, not a signal', async () => {
    const { update, heard } = host();
    const { cursor: start } = await heard('now');
    update('done', { endedAt: '2026-10-16T10:00:00.000Z', exitCode: null });
    expect((await heard(start)).lines).toEqual(['worker ended closed']);
  });

  it('answers at most 100 events at once, the rest from its cursor', async () => {
    const { update, heard } = host();
    const { cursor: start } = await heard('now');
    for (let turn = 0; turn < 120; turn++) {
      update('running');
      update('idle');
    }
    const first = await heard(start);
    expect(first.lines).toHaveLength(100);
    expect((await heard(first.cursor)).lines).toHaveLength(20);
  });
});
