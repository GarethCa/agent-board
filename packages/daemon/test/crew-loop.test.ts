// A running crew's loop: reviewers start at each hand-off, their reviews go back until every one approves or the round
// limit is reached, and nothing passes on but what the crew's own agents wrote.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SpawnUsed } from '../src/agent-spawns.ts';
import { createCrewLoop, type CrewLoopOptions } from '../src/crew-loop.ts';
import { migrate } from '../src/migrate.ts';
import type { OrchestratorAccess } from '../src/orchestrators.ts';
import { MAX_CREW_CARD_TITLE, type Agent, type CrewPrefab, type PrefabMember, type SpawnAgentParams } from '../src/protocol.ts';
import type { RunStart } from '../src/schedules.ts';

/** Each test's temporary folders, removed after it. */
const made: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-loop-'));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const member = (fields: Partial<PrefabMember> & Pick<PrefabMember, 'id' | 'starts'>): PrefabMember => ({
  role: 'implementer',
  name: null,
  harness: 'claude',
  model: null,
  effort: null,
  template: null,
  subagents: [],
  ...fields,
});

const pair = (fields: Partial<CrewPrefab> = {}): CrewPrefab => ({
  name: 'Pair',
  icon: 'crew',
  purpose: 'One builds, one reviews',
  roundLimit: 3,
  onBoard: 'card',
  members: [member({ id: 'impl', starts: 'prompt' }), member({ id: 'review', role: 'reviewer', harness: 'codex', model: 'gpt-5', effort: 'high', starts: 'handoff' })],
  ...fields,
});

/** Pair with a second reviewer, `design`. */
const trio = (fields: Partial<CrewPrefab> = {}) =>
  pair({ members: [...pair().members, member({ id: 'design', role: 'reviewer', name: 'design', starts: 'handoff' })], ...fields });

const APPROVE = '# Looks right\nVerdict: Approve\n\n## Blocker\n\n## Major\n\n## Minor\n- **A nit** `a.ts:1`: rename it\n';
const CHANGES = '# Not yet\nVerdict: Changes requested\n\n## Blocker\n- **It drops the footer** `footer.ts:12`: render it\n';

interface BoardOptions {
  /** Answers a hand-back; `hear` lets the crew hear an agent meanwhile, as the board's announce does. */
  deliver?: (from: string, to: string, hear: (sessionId: string) => void) => RunStart;
  spawn?: (params: SpawnAgentParams) => void | Promise<void>;
}

/** A board of fake agents the loop drives, recording what it asks of them. */
function crewBoard(options: BoardOptions = {}) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  let clock = Date.parse('2026-11-05T10:00:00.000Z');
  const now = () => new Date(clock);
  const tick = (ms = 1000) => (clock += ms);
  const agents = new Map<string, Agent>();
  const spawned: { params: SpawnAgentParams; spawnedBy: string | undefined; used: SpawnUsed; sessionId: string }[] = [];
  const delivered: { from: string; to: string; name: string; text: string }[] = [];
  const flags: { sessionId: string; reason: string }[] = [];
  const closed: string[] = [];
  const news: { sessionId: string; kind: string; detail: string }[] = [];
  const changed: string[] = [];
  let tries = 0;

  const add = (fields: Partial<Agent> & Pick<Agent, 'sessionId' | 'name'>): Agent => {
    const worktree = tempDir();
    mkdirSync(join(worktree, '.agent-board'));
    const agent = {
      zoneId: 'zone-1',
      worktree,
      branch: `${fields.name}-branch`,
      state: 'running',
      endedAt: null,
      hibernated: null,
      permissions: [],
      ask: null,
      plan: null,
      flag: null,
      workFinishedAt: null,
      pullRequests: [],
      ...fields,
    } as unknown as Agent;
    agents.set(agent.sessionId, agent);
    return agent;
  };
  let reviewers = 0;
  const host: CrewLoopOptions = {
    agent: (sessionId) => agents.get(sessionId),
    spawn: async (params, spawnedBy, used) => {
      await options.spawn?.(params);
      reviewers += 1;
      const agent = add({ sessionId: `reviewer-${reviewers}`, name: params.name!, branch: '' });
      spawned.push({ params, spawnedBy, used, sessionId: agent.sessionId });
      return agent;
    },
    deliver: async (from, to, name, text) => {
      tries += 1;
      const answer = options.deliver?.(from, to, (sessionId) => loop.observe(agents.get(sessionId)!)) ?? { started: true };
      if (answer.started) delivered.push({ from, to, name, text });
      return answer;
    },
    // A flag sits on the agent, as the board's does, until it is cleared.
    flag: (sessionId, reason) => {
      flags.push({ sessionId, reason });
      const agent = agents.get(sessionId);
      if (agent !== undefined) agents.set(sessionId, { ...agent, flag: { id: flags.length, reason, at: now().toISOString(), to: 'user', via: null } });
    },
    clearFlag: (sessionId) => {
      const agent = agents.get(sessionId);
      if (agent !== undefined) agents.set(sessionId, { ...agent, flag: null });
    },
    close: async (sessionId) => {
      closed.push(sessionId);
      agents.delete(sessionId);
    },
    news: (sessionId, kind, detail) => void news.push({ sessionId, kind, detail }),
    changed: (crewId) => void changed.push(crewId),
    dir: tempDir(),
    log: () => {},
    now,
  };
  const loop = createCrewLoop(db, host);

  /** Updates the agent and lets the loop hear it, settling what it then does. */
  const update = async (sessionId: string, fields: Partial<Agent>) => {
    const agent = { ...agents.get(sessionId)!, ...fields } as Agent;
    agents.set(sessionId, agent);
    loop.observe(agent);
    await loop.idle();
    return agent;
  };
  const handOff = (sessionId: string) => update(sessionId, { state: 'idle', workFinishedAt: now().toISOString() });
  /** The reviewer writes its review and ends its turn. */
  const review = (sessionId: string, text: string) => {
    writeFileSync(join(agents.get(sessionId)!.worktree, '.agent-board', 'review.md'), text);
    return update(sessionId, { state: 'idle' });
  };
  /** The builder takes the hand-back and starts on it, so its finish clears, as its next prompt clears it. */
  const takeBack = (sessionId: string) => update(sessionId, { state: 'running', workFinishedAt: null });

  return { db, host, loop, agents, add, update, handOff, review, takeBack, tick, now, spawned, delivered, flags, closed, news, changed, tries: () => tries };
}

/** A crew started from `prefab` around a fresh builder, by `startedBy`. */
function startCrew(board: ReturnType<typeof crewBoard>, prefab = pair(), startedBy: string | null = null) {
  const builder = board.add({ sessionId: 'impl-1', name: 'impl' });
  const crew = board.loop.start(prefab, builder.sessionId, startedBy, 'Add a footer')!;
  board.tick();
  return { builder, crew };
}

const userAccess = {
  caller: () => ({ sessionId: 'user', name: 'the user', zoneId: null, repoRoot: '', orchestrate: 'board', agent: null }),
  logged: (_me: unknown, _action: unknown, _entry: unknown, act: () => unknown) => Promise.resolve().then(act),
  reachesAgent: () => true,
  scopeText: () => 'the whole board',
} as unknown as OrchestratorAccess;
const NO_CONNECTION = {} as never;

describe('a running crew', () => {
  it('is started only for a prefab with reviewers at the hand-off, and waits for its builder', () => {
    const board = crewBoard();
    const solo = pair({ members: [member({ id: 'one', starts: 'prompt' })] });
    expect(board.loop.start(solo, board.add({ sessionId: 'solo', name: 'solo' }).sessionId, null, 'Go')).toBeNull();

    const { crew } = startCrew(board);

    expect(crew).toMatchObject({ prefab: 'Pair', builder: 'impl-1', round: 1, roundLimit: 3, phase: 'building', stopped: null, reviewers: [] });
    expect(board.spawned).toEqual([]);
  });

  it('starts its reviewers on the builder’s branch at its hand-off, as the prefab says, in the starter’s crew', async () => {
    const board = crewBoard();
    const { builder } = startCrew(board, pair(), 'lead-1');

    await board.handOff(builder.sessionId);

    expect(board.spawned).toEqual([
      {
        sessionId: 'reviewer-1',
        spawnedBy: 'lead-1',
        used: { template: null, crewReview: { round: 1, previous: null } },
        params: expect.objectContaining({
          zoneId: 'zone-1',
          harness: 'codex',
          model: 'gpt-5',
          effort: 'high',
          role: 'reviewer',
          name: 'review (round 1)',
          baseBranch: 'impl-branch',
          prompt: 'Add a footer',
        }),
      },
    ]);
    expect(board.loop.list()[0]).toMatchObject({ phase: 'reviewing', reviewers: [{ member: 'review', sessionId: 'reviewer-1', round: 1, verdict: null }] });
    expect(board.news).toEqual([{ sessionId: 'impl-1', kind: 'round', detail: 'round 1 of 3: review (round 1) reviewing' }]);
  });

  it('takes a turn that ends on a new handover as a hand-off too, but not one on a handover from before', async () => {
    const board = crewBoard();
    const { builder } = startCrew(board);
    const handover = join(builder.worktree, '.agent-board', 'handover.md');
    writeFileSync(handover, 'Old work');
    const before = new Date(Date.parse(board.loop.list()[0]!.startedAt) - 60_000);
    utimesSync(handover, before, before);

    await board.update(builder.sessionId, { state: 'idle' });
    expect(board.spawned).toEqual([]);

    writeFileSync(handover, 'The footer is in');
    utimesSync(handover, board.now(), board.now());
    await board.update(builder.sessionId, { state: 'running' });
    expect(board.spawned).toEqual([]);
    await board.update(builder.sessionId, { state: 'idle' });
    expect(board.spawned).toHaveLength(1);
  });

  it('starts its reviewers at a hand-off flagged as ready for review, as the board asks agents to flag', async () => {
    const board = crewBoard();
    const { builder } = startCrew(board);
    const flagged = { id: 1, reason: 'Ready for review', at: board.now().toISOString(), to: 'user' as const, via: null };

    await board.update(builder.sessionId, { state: 'idle', flag: flagged, workFinishedAt: board.now().toISOString() });

    expect(board.spawned).toHaveLength(1);
    expect(board.loop.list()[0]!.needsYou).toBe(true);
  });

  it('stops at ready to merge once every reviewer approves with no blocker open, and merges nothing', async () => {
    const board = crewBoard();
    const { builder } = startCrew(board);
    await board.handOff(builder.sessionId);

    await board.update('reviewer-1', { state: 'thinking' });
    expect(board.loop.list()[0]!.phase).toBe('reviewing');
    await board.review('reviewer-1', APPROVE);

    expect(board.loop.list()[0]).toMatchObject({ phase: 'stopped', stopped: 'ready-to-merge', reviewers: [{ verdict: 'approve', blockers: 0 }] });
    expect(board.delivered).toEqual([]);
    expect(board.flags).toEqual([{ sessionId: 'impl-1', reason: expect.stringContaining('ready to merge: every reviewer of round 1 approved') }]);
    expect(board.news.at(-1)).toEqual({ sessionId: 'impl-1', kind: 'crew-stopped', detail: 'ready-to-merge: every reviewer of round 1 approved' });
  });

  it('hands the review back as the reviewer’s own hand-off, closes it, and gives the next round’s fresh reviewer its review', async () => {
    const board = crewBoard();
    const { builder, crew } = startCrew(board);
    await board.handOff(builder.sessionId);
    await board.review('reviewer-1', CHANGES);

    expect(board.delivered).toEqual([{ from: 'reviewer-1', to: 'impl-1', name: 'review, round 1', text: CHANGES }]);
    expect(board.closed).toEqual(['reviewer-1']);
    expect(board.loop.list()[0]).toMatchObject({ round: 2, phase: 'building', reviewers: [{ verdict: 'changes-requested', blockers: 1 }] });

    await board.takeBack(builder.sessionId);
    board.tick();
    await board.handOff(builder.sessionId);

    const kept = join(board.host.dir, crew.id, 'round-1-review.md');
    expect(readFileSync(kept, 'utf8')).toBe(CHANGES);
    expect(board.spawned[1]).toMatchObject({
      sessionId: 'reviewer-2',
      used: { crewReview: { round: 2, previous: kept } },
      params: { name: 'review (round 2)', prompt: `Add a footer\n\nThe last round's review is ${kept}: check each of its findings is fixed.` },
    });
    expect(board.loop.list()[0]!.reviewers.map((each) => [each.sessionId, each.round])).toEqual([
      ['reviewer-1', 1],
      ['reviewer-2', 2],
    ]);
    await board.review('reviewer-2', APPROVE);
    expect(board.loop.list()[0]!.stopped).toBe('ready-to-merge');
  });

  it('counts an approval that leaves a blocker open as changes asked for', async () => {
    const board = crewBoard();
    const { builder } = startCrew(board);
    await board.handOff(builder.sessionId);

    await board.review('reviewer-1', CHANGES.replace('Changes requested', 'Approve'));

    expect(board.loop.list()[0]).toMatchObject({ round: 2, stopped: null, reviewers: [{ verdict: 'approve', blockers: 1 }] });
    expect(board.delivered).toHaveLength(1);
  });

  it('gives two reviewers of a round the crew’s round, and sends their reviews back as one hand-off, each under its name', async () => {
    const board = crewBoard();
    const { builder } = startCrew(board, trio());
    await board.handOff(builder.sessionId);

    expect(board.spawned.map((each) => [each.params.name, each.used.crewReview!.round])).toEqual([
      ['review (round 1)', 1],
      ['design (round 1)', 1],
    ]);
    await board.review('reviewer-1', APPROVE);
    expect(board.delivered).toEqual([]);
    await board.review('reviewer-2', CHANGES);

    expect(board.delivered).toEqual([
      { from: 'reviewer-2', to: 'impl-1', name: 'review, round 1', text: `review (round 1)'s review: ${APPROVE}\n\ndesign (round 1)'s review: ${CHANGES}` },
    ]);
  });

  it('stops at its round limit, and one more round hands the reviews back', async () => {
    const board = crewBoard();
    const { builder, crew } = startCrew(board, pair({ roundLimit: 1 }));
    await board.handOff(builder.sessionId);
    await board.review('reviewer-1', CHANGES);

    expect(board.loop.list()[0]).toMatchObject({ round: 1, stopped: 'round-limit' });
    expect(board.delivered).toEqual([]);
    expect(board.flags.at(-1)!.reason).toContain(`stopped at its limit of 1 round, with changes still asked for: agent-board crew round crew:${crew.id}`);

    const handlers = board.loop.handlers(userAccess);
    const more = await handlers['orchestrator.crewRound']({ crewId: `crew:${crew.id}` }, NO_CONNECTION);

    expect(more).toMatchObject({ round: 2, roundLimit: 2, phase: 'building', stopped: null });
    expect(board.agents.get('impl-1')!.flag).toBeNull();
    expect(board.delivered).toEqual([{ from: 'reviewer-1', to: 'impl-1', name: 'review, round 1', text: CHANGES }]);
    await expect(handlers['orchestrator.crewRound']({ crewId: crew.id }, NO_CONNECTION)).rejects.toThrow(/is still running: crew round gives one more round/);
  });

  it('flags a round it couldn’t start, and crew round starts only the reviewers it still lacks, its flag dismissed or not', async () => {
    let refuse = true;
    const board = crewBoard({
      spawn: (params) => {
        if (params.name === 'design (round 1)' && refuse) throw new Error('codex is not set up');
      },
    });
    const { builder, crew } = startCrew(board, trio());
    await board.handOff(builder.sessionId);

    expect(board.flags).toEqual([
      {
        sessionId: 'impl-1',
        reason: `The Pair crew couldn't start round 1's reviewers (codex is not set up): agent-board crew round crew:${crew.id} tries again, and so does impl's next hand-off`,
      },
    ]);
    expect(board.loop.list()[0]).toMatchObject({ phase: 'building', needsYou: false, reviewers: [{ member: 'review', round: 1 }] });

    refuse = false;
    board.host.clearFlag(builder.sessionId);
    await board.loop.handlers(userAccess)['orchestrator.crewRound']({ crewId: crew.id }, NO_CONNECTION);

    expect(board.spawned.map((each) => each.params.name)).toEqual(['review (round 1)', 'design (round 1)']);
    expect(board.agents.get('impl-1')!.flag).toBeNull();
    expect(board.news.at(-1)).toEqual({ sessionId: 'impl-1', kind: 'round', detail: 'round 1 of 3: review (round 1), design (round 1) reviewing' });
  });

  it('starts no more reviewers once stopped while the first was starting', async () => {
    const board = crewBoard();
    const { builder, crew } = startCrew(board, trio());
    const spawn = board.host.spawn;
    let stopped = false;
    board.host.spawn = async (params, spawnedBy, used) => {
      const agent = await spawn(params, spawnedBy, used);
      if (!stopped) {
        stopped = true;
        await board.loop.handlers(userAccess)['orchestrator.stopCrew']({ crewId: crew.id }, NO_CONNECTION);
      }
      return agent;
    };

    await board.handOff(builder.sessionId);

    expect(board.spawned).toHaveLength(1);
    expect(board.news.map((each) => each.kind)).toEqual(['crew-stopped']);
  });

  it('waits while its builder needs the user, and goes on once they have answered', async () => {
    const board = crewBoard();
    const { builder } = startCrew(board);
    await board.update(builder.sessionId, { state: 'needs-permission', workFinishedAt: board.now().toISOString() });

    expect(board.loop.list()[0]).toMatchObject({ needsYou: true, phase: 'building' });
    expect(board.spawned).toEqual([]);

    await board.update(builder.sessionId, { state: 'idle' });
    expect(board.loop.list()[0]!.needsYou).toBe(false);
    expect(board.spawned).toHaveLength(1);
  });

  it('waits for a reviewer paused or stopped by a restart, and counts one ended for good with no review as changes asked for', async () => {
    const board = crewBoard();
    const { builder } = startCrew(board, trio());
    await board.handOff(builder.sessionId);
    const ended = board.now().toISOString();

    await board.update('reviewer-1', { state: 'stopped-by-restart', endedAt: ended });
    await board.update('reviewer-2', { state: 'hibernated', endedAt: ended, hibernated: { at: ended, by: null, byId: null } });
    expect(board.loop.list()[0]).toMatchObject({ phase: 'reviewing', reviewers: [{ verdict: null }, { verdict: null }] });
    expect(board.delivered).toEqual([]);

    await board.review('reviewer-1', APPROVE);
    await board.update('reviewer-2', { state: 'done', hibernated: null });

    expect(board.loop.list()[0]).toMatchObject({ round: 2, reviewers: [{ verdict: 'approve' }, { verdict: null, blockers: 0 }] });
    expect(board.delivered[0]!.text).toBe(`review (round 1)'s review: ${APPROVE}\n\ndesign (round 1)'s review: (none left)`);
  });

  it('takes no step again on what it has already read, so a hand-back that can’t land yet doesn’t spin', async () => {
    let busy = true;
    const board = crewBoard({
      // The board announces the reviewer as handing off while it tries: the crew hears that at once.
      deliver: (from, _to, hear) => {
        hear(from);
        hear(from);
        return busy ? { started: false, reason: 'you are typing at its prompt', busy: true } : { started: true };
      },
    });
    const { builder } = startCrew(board);
    await board.handOff(builder.sessionId);
    await board.review('reviewer-1', CHANGES);

    // Once on reading the review, once more as that changed what it reads, and then no more: it waits for the builder.
    expect(board.tries()).toBe(2);
    expect(board.loop.list()[0]).toMatchObject({ round: 1, phase: 'reviewing' });

    busy = false;
    await board.update(builder.sessionId, { state: 'running' });
    expect(board.delivered).toHaveLength(1);
    expect(board.loop.list()[0]).toMatchObject({ round: 2, phase: 'building' });
  });

  it('moves no crew on once the daemon is closing', async () => {
    const board = crewBoard();
    const { builder } = startCrew(board);
    board.loop.close();

    await board.handOff(builder.sessionId);

    expect(board.spawned).toEqual([]);
  });

  it('closes its agents and their worktrees once its builder’s pull request is merged, unless the user stopped it', async () => {
    const board = crewBoard();
    const { builder } = startCrew(board);
    await board.handOff(builder.sessionId);
    await board.review('reviewer-1', APPROVE);

    await board.update(builder.sessionId, { pullRequests: [{ number: 7, state: 'merged' }] as Agent['pullRequests'] });

    expect(board.closed).toEqual(['reviewer-1', 'impl-1']);
    expect(board.loop.list()[0]!.stopped).toBe('merged');

    const other = crewBoard();
    const taken = startCrew(other);
    await other.loop.handlers(userAccess)['orchestrator.stopCrew']({ crewId: taken.crew.id }, NO_CONNECTION);
    await other.update(taken.builder.sessionId, { pullRequests: [{ number: 8, state: 'merged' }] as Agent['pullRequests'] });
    expect(other.closed).toEqual([]);
    expect(other.loop.list()[0]!.stopped).toBe('stopped');
  });

  it('flags the builder when it can’t close it after the merge', async () => {
    const board = crewBoard();
    board.host.close = async () => {
      throw new Error('it has uncommitted changes');
    };
    const { builder } = startCrew(board);

    await board.update(builder.sessionId, { pullRequests: [{ number: 7, state: 'merged' }] as Agent['pullRequests'] });

    expect(board.flags.at(-1)!.reason).toBe("The Pair crew couldn't close impl (it has uncommitted changes) after the merge: close them yourself");
  });

  it('stops once its builder is gone, and a stopped crew starts no one', async () => {
    const board = crewBoard();
    const { builder, crew } = startCrew(board);
    await board.loop.handlers(userAccess)['orchestrator.stopCrew']({ crewId: crew.id }, NO_CONNECTION);
    await board.handOff(builder.sessionId);
    expect(board.spawned).toEqual([]);

    const second = crewBoard();
    const run = startCrew(second);
    second.agents.delete(run.builder.sessionId);
    second.loop.resume();
    await second.loop.idle();
    expect(second.loop.list()[0]!.stopped).toBe('builder-gone');
  });

  it('carries on after a restart from what its agents wrote meanwhile', async () => {
    const board = crewBoard();
    const { builder } = startCrew(board);
    await board.handOff(builder.sessionId);
    writeFileSync(join(board.agents.get('reviewer-1')!.worktree, '.agent-board', 'review.md'), APPROVE);
    board.agents.set('reviewer-1', { ...board.agents.get('reviewer-1')!, state: 'idle' } as Agent);

    const restarted = createCrewLoop(board.db, board.host);
    restarted.resume();
    await restarted.idle();

    expect(restarted.list()[0]!.stopped).toBe('ready-to-merge');
  });
});

describe('a crew’s card', () => {
  it('shows the crew from its own record: its prompt’s first line, its members as the prefab named them, and the crew as it is', async () => {
    const board = crewBoard();
    const builder = board.add({ sessionId: 'impl-1', name: 'impl' });
    const crew = board.loop.start(trio({ icon: 'spark', onBoard: 'tiles' }), builder.sessionId, null, '\n  Add a footer  \nwith the year in it')!;

    expect(board.loop.card(crew.id)).toEqual({
      crewId: crew.id,
      title: 'Add a footer',
      icon: 'spark',
      tiles: true,
      members: [
        { id: 'impl', name: 'impl', role: 'implementer', harness: 'claude', model: null, starts: 'prompt' },
        { id: 'review', name: 'review', role: 'reviewer', harness: 'codex', model: 'gpt-5', starts: 'handoff' },
        { id: 'design', name: 'design', role: 'reviewer', harness: 'claude', model: null, starts: 'handoff' },
      ],
      crew: board.loop.list()[0],
      phaseAt: crew.startedAt,
      startFailed: false,
      startError: null,
    });
    expect(board.loop.card('nope')).toBeUndefined();

    board.tick();
    await board.handOff(builder.sessionId);
    const reviewing = board.loop.card(crew.id)!;
    expect(reviewing.crew).toMatchObject({ phase: 'reviewing', reviewers: [{ member: 'review' }, { member: 'design' }] });
    expect(Date.parse(reviewing.phaseAt)).toBeGreaterThan(Date.parse(crew.startedAt));
  });

  it('is titled by its prefab for a prompt of no words, and keeps a long line short', () => {
    const board = crewBoard();
    const blank = board.loop.start(pair(), board.add({ sessionId: 'a', name: 'a' }).sessionId, null, ' \n ')!;
    const long = board.loop.start(pair(), board.add({ sessionId: 'b', name: 'b' }).sessionId, null, 'é'.repeat(MAX_CREW_CARD_TITLE + 1))!;

    expect(board.loop.card(blank.id)!.title).toBe('Pair');
    expect(board.loop.card(long.id)!.title).toBe(`${'é'.repeat(MAX_CREW_CARD_TITLE - 1)}…`);
  });

  it('says a round that couldn’t start and why, until it does', async () => {
    let refuse = true;
    const board = crewBoard({
      spawn: () => {
        if (refuse) throw new Error('codex is not set up');
      },
    });
    const { builder, crew } = startCrew(board);
    await board.handOff(builder.sessionId);
    expect(board.loop.card(crew.id)).toMatchObject({ startFailed: true, startError: 'codex is not set up', crew: { phase: 'building' } });

    refuse = false;
    await board.loop.handlers(userAccess)['orchestrator.crewRound']({ crewId: crew.id }, NO_CONNECTION);
    expect(board.loop.card(crew.id)).toMatchObject({ startFailed: false, startError: null, crew: { phase: 'reviewing' } });
  });

  it('is said to have changed as its crew starts, at each step it takes and as it is stopped, but not once the daemon is closing', async () => {
    const board = crewBoard();
    const { builder, crew } = startCrew(board);
    expect(board.changed).toEqual([crew.id]);

    board.changed.length = 0;
    await board.handOff(builder.sessionId);
    expect(board.changed.length).toBeGreaterThan(0);
    expect(new Set(board.changed)).toEqual(new Set([crew.id]));

    board.changed.length = 0;
    await board.loop.handlers(userAccess)['orchestrator.stopCrew']({ crewId: crew.id }, NO_CONNECTION);
    expect(board.changed).toContain(crew.id);

    const closing = crewBoard();
    const run = startCrew(closing);
    closing.changed.length = 0;
    closing.loop.close();
    await closing.handOff(run.builder.sessionId);
    expect(closing.changed).toEqual([]);
  });

  it('takes no further step once the daemon closes while a step is under way, nor reads its closed database', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let spawning!: () => void;
    const started = new Promise<void>((resolve) => (spawning = resolve));
    const board = crewBoard({ spawn: () => (spawning(), held) });
    const { builder } = startCrew(board);
    board.agents.set(builder.sessionId, { ...builder, state: 'idle', workFinishedAt: board.now().toISOString() });
    board.loop.observe(board.agents.get(builder.sessionId)!);
    await started;
    // Heard while the step waits on its reviewer: another step is due once this one is done.
    board.loop.observe({ ...board.agents.get(builder.sessionId)!, state: 'running' });

    board.loop.close();
    board.db.close();
    release();
    await expect(board.loop.idle()).resolves.toBeUndefined();
  });
});
