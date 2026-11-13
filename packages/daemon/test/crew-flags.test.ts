import { describe, expect, it } from 'vitest';
import { CREW_FLAG_GATHER_MS, createCrewFlags } from '../src/crew-flags.ts';
import type { Agent, AgentFlag, AgentState } from '../src/protocol.ts';
import type { RunStart } from '../src/schedules.ts';
import { createFakeClock } from './fake-clock.ts';

const LEAD = 'lead-0000-0000';

/** The little of an agent crew flags read. */
function agentOf(sessionId: string, fields: { state?: AgentState; flag?: Pick<AgentFlag, 'id' | 'reason'> | null; spawnedBy?: string | null; name?: string }): Agent {
  const { state = 'idle', flag = null, spawnedBy = null, name = sessionId } = fields;
  return {
    sessionId,
    name,
    state,
    endedAt: null,
    spawnedBy,
    flag: flag === null ? null : { ...flag, at: '2026-11-12T00:00:00.000Z', via: null, to: 'orchestrator' },
  } as Agent;
}

/** Crew flags over a board of agents the test changes, with the lead's every `tell` recorded and answered by `answer`. */
function board(leadState: AgentState) {
  const clock = createFakeClock(new Date(2026, 10, 12, 21, 0));
  const agents = new Map<string, Agent>([[LEAD, agentOf(LEAD, { state: leadState, name: 'lead' })]]);
  const told: string[] = [];
  let answer: () => Promise<RunStart> = () => Promise.resolve({ started: true });
  const flags = createCrewFlags({
    agent: (sessionId) => agents.get(sessionId),
    crewOf: (sessionId) => [...agents.values()].filter((agent) => agent.spawnedBy === sessionId),
    tell: (_sessionId, text) => {
      told.push(text);
      return answer();
    },
    clock,
    log: () => {},
  });
  const set = (agent: Agent) => {
    agents.set(agent.sessionId, agent);
    flags.observe(agent);
  };
  let nextId = 1;
  return {
    clock,
    told,
    answerWith: (next: () => Promise<RunStart>) => (answer = next),
    /** A crew member of the lead raising a flag. */
    flag: (sessionId: string, reason: string) => set(agentOf(sessionId, { spawnedBy: LEAD, flag: { id: nextId++, reason }, name: `crew ${sessionId}` })),
    close: () => flags.close(),
    /** The lead moving to `state`. */
    lead: (state: AgentState) => set(agentOf(LEAD, { state, name: 'lead' })),
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('crew flags', () => {
  it.each<AgentState>(['running', 'thinking', 'needs-permission', 'handing-off', 'starting'])('leave a lead %s alone', async (state) => {
    const b = board(state);
    b.flag('crew-1', 'PR #12 is ready for review');
    b.clock.advance(CREW_FLAG_GATHER_MS);
    await settle();
    expect(b.told).toEqual([]);
  });

  it('type nothing once closed, a gather under way or not', async () => {
    const b = board('idle');
    b.flag('crew-1', 'PR #12 is ready for review');
    b.close();
    b.clock.advance(CREW_FLAG_GATHER_MS);
    await settle();
    expect(b.told).toEqual([]);
    expect(b.clock.pending()).toBe(0);
  });

  it.each<AgentState>(['idle', 'waiting', 'scheduled', 'on-command', 'failed'])('wake a lead %s at its prompt, without waiting for its next update', async (state) => {
    const b = board(state);
    b.flag('crew-1', 'PR #12 is ready for review');
    b.clock.advance(CREW_FLAG_GATHER_MS);
    await settle();
    expect(b.told).toEqual([expect.stringMatching(/crew crew-1 \(agent:crew-1\) needs you: PR #12 is ready for review/)]);
  });

  it('gather a burst of flags into one message', async () => {
    const b = board('scheduled');
    b.flag('crew-1', 'PR #12 is ready for review');
    b.clock.advance(CREW_FLAG_GATHER_MS / 2);
    b.flag('crew-2', 'asks: Postgres or SQLite?');
    // The lead's own update in the burst doesn't start a message of its own.
    b.lead('scheduled');
    await settle();
    expect(b.told).toEqual([]);

    b.clock.advance(CREW_FLAG_GATHER_MS);
    await settle();
    expect(b.told).toHaveLength(1);
    expect(b.told[0]).toContain('needs you: PR #12 is ready for review');
    expect(b.told[0]).toContain('needs you: asks: Postgres or SQLite?');
  });

  it('wait for a lead mid-turn to end it, then tell every flag raised meanwhile as one message', async () => {
    const b = board('running');
    b.flag('crew-1', 'PR #12 is ready for review');
    b.clock.advance(CREW_FLAG_GATHER_MS);
    b.flag('crew-2', 'Blocked on the fixture');
    b.clock.advance(CREW_FLAG_GATHER_MS);
    await settle();
    expect(b.told).toEqual([]);

    b.lead('idle');
    await settle();
    expect(b.told).toHaveLength(1);
    expect(b.told[0]).toContain('PR #12 is ready for review');
    expect(b.told[0]).toContain('Blocked on the fixture');
  });

  it('keep a flag the lead was too busy for, and tell it once the lead is back at its prompt', async () => {
    const b = board('idle');
    b.answerWith(() => Promise.resolve({ started: false, reason: 'you were typing in its terminal', busy: true }));
    b.flag('crew-1', 'Which fixture?');
    b.clock.advance(CREW_FLAG_GATHER_MS);
    await settle();
    expect(b.told).toHaveLength(1);

    b.answerWith(() => Promise.resolve({ started: true }));
    b.lead('scheduled');
    await settle();
    expect(b.told).toHaveLength(2);
    // Told, it isn't told again.
    b.lead('idle');
    await settle();
    expect(b.told).toHaveLength(2);
  });

  it('tell a flag raised while the last message was being typed after the turn that message starts', async () => {
    const b = board('idle');
    let typed!: (start: RunStart) => void;
    b.answerWith(() => new Promise((resolve) => (typed = resolve)));
    b.flag('crew-1', 'First');
    b.clock.advance(CREW_FLAG_GATHER_MS);
    b.flag('crew-2', 'Second');
    b.clock.advance(CREW_FLAG_GATHER_MS);
    await settle();
    expect(b.told).toHaveLength(1);

    b.answerWith(() => Promise.resolve({ started: true }));
    typed({ started: true });
    await settle();
    b.lead('running');
    expect(b.told).toHaveLength(1);
    b.lead('idle');
    await settle();
    expect(b.told).toHaveLength(2);
    expect(b.told[1]).toContain('Second');
    expect(b.told[1]).not.toContain('First');
  });
});
