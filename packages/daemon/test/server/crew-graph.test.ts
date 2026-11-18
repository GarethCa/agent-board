// A crew run along its prefab's graph by a real daemon, its agents on the fake harness: a loop gate with two deciders
// and a timeout, the word that comes after it went on, an uncapped gate, and Your OK waiting for the user.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import type { Crew, DaemonEvent, HookEvent } from '../../src/protocol.ts';
import { createFakeClock } from '../fake-clock.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from '../helpers.ts';

const MINUTES = 60_000;
const CHANGES = '# Not yet\nVerdict: Changes requested\n\n## Blocker\n- **No footer** `a.ts:1`: add it\n';
const APPROVE = '# Fine\nVerdict: Approve\n';

async function graphDaemon() {
  // An hour behind: the harness stamps its turns with the real time, which stays after the crew's own.
  const clock = createFakeClock(new Date(Date.now() - 60 * MINUTES));
  const daemon = await startTestDaemon({
    dataDir: tempDataDir(),
    worktreesDir: tempDataDir(),
    clock,
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, name: 'web' });
  return { daemon, client, recorder, zone, clock };
}

type Setup = Awaited<ReturnType<typeof graphDaemon>>;

/** Saves a version 2 crew prefab named `name` and starts it on `prompt`. */
async function startGraph(setup: Setup, name: string, file: object) {
  const text = JSON.stringify({ agentBoardCrewPrefab: 2, name, icon: 'crew', purpose: 'Work along the lines', ...file });
  await setup.client.call('orchestrator.savePrefab', { text });
  const started = await setup.client.call('orchestrator.startPrefab', { name, prompt: 'Add a footer', zoneId: setup.zone.id });
  return { crewId: started.crew!, impl: started.started[0]! };
}

/** The crew, once `match` holds of it. */
async function crewOnce(setup: Setup, crewId: string, match: (crew: Crew) => boolean): Promise<Crew> {
  return vi.waitFor(
    async () => {
      const [crew] = await setup.client.call('orchestrator.crews', { crewId });
      if (crew === undefined || !match(crew)) throw new Error(`crew ${crewId} is not there yet: ${JSON.stringify(crew)}`);
      return crew;
    },
    { timeout: 20_000, interval: 50 },
  );
}

/** The prompt `sessionId` was next typed that holds `text`. */
async function promptWith(setup: Setup, sessionId: string, text: string): Promise<string> {
  const event = await setup.recorder.waitFor(
    (e: DaemonEvent): e is HookEvent => e.type === 'hook' && e.sessionId === sessionId && e.event === 'UserPromptSubmit' && String(e.payload.prompt).includes(text),
  );
  return String(event.payload.prompt);
}

/** `sessionId`'s review, written as a reviewer leaves it, and heard as its next update. */
async function reviews(setup: Setup, sessionId: string, review: string) {
  const [agent] = (await setup.client.call('agent.list')).filter((each) => each.sessionId === sessionId);
  mkdirSync(join(agent!.worktree, '.agent-board'), { recursive: true });
  writeFileSync(join(agent!.worktree, '.agent-board', 'review.md'), review);
  await setup.client.call('orchestrator.setStatus', { sessionId, summary: 'Reviewed' });
}

describe('a crew run along its graph', () => {
  it('goes on without the reviewer missing at its loop gate’s timeout, uncapped, and hands its late word back marked late', async () => {
    const setup = await graphDaemon();
    const { crewId, impl } = await startGraph(setup, 'Two deciders', {
      members: [
        { id: 'impl', role: 'implementer', harness: 'claude' },
        { id: 'code', role: 'reviewer', harness: 'claude' },
        { id: 'tests', role: 'reviewer', harness: 'claude' },
      ],
      inputs: [
        { id: 'prompt', kind: 'prompt' },
        { id: 'end', kind: 'end', as: 'ready' },
      ],
      gates: [{ id: 'loop', rule: 'done', cap: null, atCap: 'ask', timeout: 30 }],
      lines: [
        { from: 'prompt', to: 'impl' },
        { from: 'impl', to: 'code', carries: 'handoff' },
        { from: 'impl', to: 'tests', carries: 'handoff' },
        { from: 'code', to: 'loop', carries: 'review' },
        { from: 'tests', to: 'loop', carries: 'review' },
        { from: 'loop', to: 'impl', way: 'again' },
        { from: 'loop', to: 'end', way: 'done' },
      ],
    });

    // The fake builder hands over as its turn ends: both deciders of round 1 start on its branch.
    const reviewing = await crewOnce(setup, crewId, (crew) => crew.reviewers.length === 2);
    expect(reviewing).toMatchObject({ roundLimit: 0, phase: 'reviewing', gates: [{ id: 'loop', round: 1, limit: null }] });
    const [code, tests] = reviewing.reviewers.map((each) => each.sessionId);

    await reviews(setup, code!, CHANGES);
    const waiting = await crewOnce(setup, crewId, (crew) => (crew.waiting ?? []).length === 1 && crew.reviewers[0]!.verdict !== null);
    expect(waiting.waiting).toEqual([{ kind: 'gate', at: 'loop', since: expect.any(String), missing: ['tests (round 1)'], until: expect.any(String) }]);
    expect(Date.parse(waiting.waiting![0]!.until!) - Date.parse(waiting.waiting![0]!.since)).toBe(30 * MINUTES);

    setup.clock.advance(30 * MINUTES);
    const handedBack = await promptWith(setup, impl.sessionId, "tests (round 1) hasn't reported yet, so this goes on without it after 30 min.");
    expect(handedBack).toContain('Verdict: Changes requested');
    // No cap: round 2 opens as the builder hands over again, and nothing stops.
    await crewOnce(setup, crewId, (crew) => crew.gates![0]!.round === 2 && crew.reviewers.some((each) => each.round === 2));
    expect((await crewOnce(setup, crewId, () => true)).stopped).toBeNull();

    await reviews(setup, tests!, APPROVE);
    const late = await promptWith(setup, impl.sessionId, "Late: tests (round 1)'s review of round 1, after loop gate loop went on without it.");
    expect(late).toContain('Verdict: Approve');
    // Its word was all it had left to give: the late reviewer closes once it lands.
    await setup.recorder.waitFor((e: DaemonEvent): e is DaemonEvent => e.type === 'agent.removed' && e.sessionId === tests);
  });

  it('counts the next round’s word of a decider kept each round, after it was late for one', async () => {
    const setup = await graphDaemon();
    const { crewId, impl } = await startGraph(setup, 'Kept decider', {
      members: [
        { id: 'impl', role: 'implementer', harness: 'claude' },
        { id: 'code', role: 'reviewer', harness: 'claude' },
        { id: 'slow', role: 'reviewer', harness: 'claude', fresh: false },
      ],
      inputs: [
        { id: 'prompt', kind: 'prompt' },
        { id: 'end', kind: 'end', as: 'ready' },
      ],
      gates: [{ id: 'loop', rule: 'done', cap: null, atCap: 'ask', timeout: 30 }],
      lines: [
        { from: 'prompt', to: 'impl' },
        { from: 'impl', to: 'code', carries: 'handoff' },
        { from: 'impl', to: 'slow', carries: 'handoff' },
        { from: 'code', to: 'loop', carries: 'review' },
        { from: 'slow', to: 'loop', carries: 'review' },
        { from: 'loop', to: 'impl', way: 'again' },
        { from: 'loop', to: 'end', way: 'done' },
      ],
    });

    const reviewing = await crewOnce(setup, crewId, (crew) => crew.reviewers.length === 2);
    const code = reviewing.reviewers.find((each) => each.member === 'code')!.sessionId;
    const slow = reviewing.reviewers.find((each) => each.member === 'slow')!.sessionId;
    await reviews(setup, code, CHANGES);
    await crewOnce(setup, crewId, (crew) => (crew.waiting ?? []).length === 1 && crew.reviewers.some((each) => each.verdict !== null));
    setup.clock.advance(30 * MINUTES);
    // Named by its member, as it is the same agent each round.
    await promptWith(setup, impl.sessionId, "slow hasn't reported yet, so this goes on without it after 30 min.");

    // The builder hands over again: round 2 reaches the same slow agent, and its word now is round 2's.
    const round2 = await crewOnce(setup, crewId, (crew) => crew.gates![0]!.round === 2 && crew.reviewers.filter((each) => each.round === 2).length === 2);
    expect(round2.reviewers.find((each) => each.member === 'slow' && each.round === 2)!.sessionId).toBe(slow);
    await promptWith(setup, slow, '⟨hand-off from');
    await reviews(setup, round2.reviewers.find((each) => each.member === 'code' && each.round === 2)!.sessionId, APPROVE);
    await reviews(setup, slow, APPROVE);
    expect(await crewOnce(setup, crewId, (crew) => crew.stopped !== null)).toMatchObject({ stopped: 'ready-to-merge', waiting: [] });
  });

  it('waits at Your OK for the user, who sends the work back and then lets it go on, each logged, and an agent may not', async () => {
    const setup = await graphDaemon();
    const { crewId, impl } = await startGraph(setup, 'Your OK', {
      members: [{ id: 'impl', role: 'implementer', harness: 'claude' }],
      inputs: [
        { id: 'prompt', kind: 'prompt' },
        { id: 'ok', kind: 'user' },
        { id: 'end', kind: 'end', as: 'ready' },
      ],
      gates: [],
      lines: [
        { from: 'prompt', to: 'impl' },
        { from: 'impl', to: 'ok' },
        { from: 'ok', to: 'end' },
      ],
    });

    const waits = await crewOnce(setup, crewId, (crew) => (crew.waiting ?? []).length === 1);
    expect(waits).toMatchObject({ needsYou: true, stopped: null, waiting: [{ kind: 'user', at: 'ok', missing: ['the user'], until: null }] });
    expect((await setup.client.call('agent.list')).find((each) => each.sessionId === impl.sessionId)!.flag).toMatchObject({
      reason: 'The Your OK crew waits for your OK on the work of Add a footer: Go on or Send back',
    });

    // An agent answers for no user: one connected with its board token is refused.
    const agent = await setup.client.call('agent.spawn', { zoneId: setup.zone.id, prompt: 'Print your board identity', cols: 120, rows: 40 });
    await setup.client.call('session.attach', { sessionId: agent.sessionId });
    await setup.recorder.waitForText(agent.sessionId, ':end\r\n');
    const token = /identity:(.*):end\r\n/.exec(setup.recorder.screenText(agent.sessionId))![1]!;
    const asAgent = await connectTestClient(setup.daemon);
    await asAgent.call('board.identify', { token });
    await expect(asAgent.call('orchestrator.crewGoOn', { crewId })).rejects.toThrow(/orchestrator.crewGoOn is not open to a session's board token/);

    await setup.client.call('orchestrator.crewSendBack', { crewId, note: 'Add a test' });
    await promptWith(setup, impl.sessionId, 'The user sent your work back from Your OK: Add a test');
    // The fake builder hands over again as that turn ends: it waits once more.
    await crewOnce(setup, crewId, (crew) => (crew.waiting ?? []).length === 1 && crew.needsYou);

    await setup.client.call('orchestrator.crewGoOn', { crewId, note: 'Ship it' });
    expect(await crewOnce(setup, crewId, (crew) => crew.stopped !== null)).toMatchObject({ stopped: 'ready-to-merge', waiting: [] });
    const actions = (await setup.client.call('orchestrator.activity', { limit: 10 })).map((line) => line.action);
    expect(actions).toEqual(expect.arrayContaining(['crew-send-back', 'crew-go-on']));
  });
});
