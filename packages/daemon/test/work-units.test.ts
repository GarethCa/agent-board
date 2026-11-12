import { describe, expect, it } from 'vitest';
import { lanesOf, LANE_SLOTS } from '../src/board-arrange.ts';
import type { Agent } from '../src/protocol.ts';
import { isLead, workTilesOf } from '../src/work-units.ts';

const T0 = '2026-01-05T09:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

/** An agent in zone `z`, started by the user, with what a test says. */
function agent(sessionId: string, fields: Partial<Agent> = {}): Agent {
  return {
    sessionId,
    name: sessionId,
    zoneId: 'z',
    branch: `${sessionId}-a1b2c3`,
    reviews: null,
    reviewOf: null,
    role: null,
    roleName: null,
    master: false,
    spawnedBy: null,
    issue: null,
    state: 'idle',
    createdAt: T0,
    ...fields,
  } as Agent;
}

/** Each lane's members, in slot order. */
const units = (agents: readonly Agent[], leadId?: string) =>
  lanesOf(workTilesOf(agents, agents, leadId, {}), []).lanes.map((lane) => LANE_SLOTS.flatMap((slot) => lane.slots[slot]).map((tile) => tile.name));

const issue = (id: string) => ({ id, title: id }) as Agent['issue'];

describe('isLead', () => {
  it('leads by the orchestrator role, as the Captain, or with no role by starting an agent other than its own reviewer', () => {
    expect(isLead(agent('planner', { roleName: 'orchestrator' }), [])).toBe(true);
    expect(isLead(agent('captain', { master: true }), [])).toBe(true);
    const lead = agent('lead');
    expect(isLead(lead, [lead, agent('impl', { role: 'implementer', spawnedBy: 'lead', issue: issue('ACME-1') })])).toBe(true);
    expect(isLead(lead, [lead, agent('worker', { spawnedBy: 'lead' })])).toBe(true);
    expect(isLead(lead, [lead])).toBe(false);
  });

  it('never leads as an agent with a role, custom ones included, or as one that only started its own reviewers', () => {
    const solo = agent('solo');
    expect(isLead(solo, [solo, agent('rev', { role: 'reviewer', reviewOf: 'solo', spawnedBy: 'solo' })])).toBe(false);
    expect(isLead(solo, [solo, agent('rev', { role: 'reviewer', reviews: { branch: solo.branch } as Agent['reviews'], spawnedBy: 'solo' })])).toBe(false);
    const impl = agent('impl', { role: 'implementer' });
    expect(isLead(impl, [impl, agent('helper', { role: 'implementer', spawnedBy: 'impl', issue: issue('ACME-2') })])).toBe(false);
    const designer = agent('des', { role: 'custom', roleName: 'designer' });
    expect(isLead(designer, [designer, agent('helper', { role: 'implementer', spawnedBy: 'des', issue: issue('ACME-2') })])).toBe(false);
  });
});

describe('workTilesOf', () => {
  it('puts the agents an agent started in its unit of work: its implementers and its reviewers', () => {
    const agents = [
      agent('impl', { role: 'implementer', issue: issue('ACME-1') }),
      agent('helper', { role: 'implementer', spawnedBy: 'impl', createdAt: at(1) }),
      agent('rev', { role: 'reviewer', spawnedBy: 'impl', createdAt: at(2) }),
      agent('other', { role: 'implementer', createdAt: at(3) }),
    ];
    expect(units(agents)).toEqual([['impl', 'helper', 'rev'], ['other']]);
    expect(workTilesOf(agents, agents, undefined, {}).find((tile) => tile.name === 'helper')?.startedBy).toBe('agent:impl');
  });

  it('groups an agent with a custom role with the helper and reviewer it started', () => {
    const agents = [
      agent('des', { role: 'custom', roleName: 'designer' }),
      agent('helper', { role: 'implementer', spawnedBy: 'des', createdAt: at(1) }),
      agent('rev', { role: 'reviewer', spawnedBy: 'des', reviewOf: 'des', createdAt: at(2) }),
    ];
    expect(units(agents)).toEqual([['des', 'helper', 'rev']]);
  });

  it('keeps a lead with no role apart from a worker of no ticket, laid out by it or by anyone else, so a map agrees with its arrange', () => {
    const agents = [agent('lead'), agent('worker', { spawnedBy: 'lead', createdAt: at(1) })];
    expect(units(agents, 'lead')).toEqual([['worker']]);
    expect(units(agents)).toEqual([['lead'], ['worker']]);
  });

  it("never puts an agent in its lead's unit: each agent a lead started is a unit of its own, with its reviewers", () => {
    const agents = [
      agent('lead', { state: 'running' }),
      agent('impl-1', { role: 'implementer', spawnedBy: 'lead', issue: issue('ACME-1'), createdAt: at(1) }),
      agent('rev-1', { role: 'reviewer', spawnedBy: 'lead', reviewOf: 'impl-1', createdAt: at(2) }),
      agent('impl-2', { role: 'implementer', spawnedBy: 'lead', issue: issue('ACME-2'), createdAt: at(3) }),
    ];
    // Laid out by the lead, or by no one, as a shelved zone with its lead freed is.
    expect(units(agents, 'lead')).toEqual([['impl-1', 'rev-1'], ['impl-2']]);
    expect(units(agents)).toEqual([['lead'], ['impl-1', 'rev-1'], ['impl-2']]);
    expect(workTilesOf(agents, agents, undefined, {}).find((tile) => tile.name === 'impl-1')?.startedBy).toBeNull();
  });

  it("joins no two tickets' work by a start: a helper on another ticket, or a reviewer of another agent, stays with that", () => {
    const agents = [
      agent('a', { role: 'implementer', issue: issue('ACME-1') }),
      agent('b', { role: 'implementer', issue: issue('ACME-2'), createdAt: at(1) }),
      agent('h', { role: 'implementer', spawnedBy: 'a', issue: issue('ACME-2'), createdAt: at(2) }),
      agent('r', { role: 'reviewer', spawnedBy: 'a', reviewOf: 'b', createdAt: at(3) }),
    ];
    expect(units(agents)).toEqual([['a'], ['b', 'h', 'r']]);
  });

  it('joins only agents here: one whose starter is in another zone is a unit of its own', () => {
    const agents = [agent('impl', { role: 'implementer', zoneId: 'other' }), agent('rev', { role: 'reviewer', spawnedBy: 'impl' })];
    const here = agents.filter((each) => each.zoneId === 'z');
    expect(workTilesOf(agents, here, undefined, {})[0]?.startedBy).toBeNull();
  });
});
