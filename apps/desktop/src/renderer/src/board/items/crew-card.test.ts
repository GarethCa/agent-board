import { describe, expect, it } from 'vitest';
import type { Agent, Crew, CrewCardData, CrewCardMember, CrewReviewer, PullRequest } from '@agent-board/daemon/protocol';
import { crewCardModel } from './crew-card';

const member = (id: string, fields: Partial<CrewCardMember> = {}): CrewCardMember => ({ id, name: id, role: 'reviewer', harness: 'claude', model: null, starts: 'handoff', ...fields });
const MEMBERS = [member('builder', { name: 'Builder', role: 'implementer', starts: 'prompt' }), member('code-review'), member('design-review')];

const agent = (sessionId: string, fields: Partial<Agent> = {}): Agent =>
  ({
    sessionId,
    name: sessionId,
    state: 'running',
    endedAt: null,
    exitCode: null,
    seen: false,
    permissions: [],
    ask: null,
    plan: null,
    flag: null,
    ledBy: null,
    reviewOf: null,
    lastMessage: null,
    status: null,
    pullRequests: [],
    ...fields,
  }) as unknown as Agent;

const reviewer = (key: string, round: number, fields: Partial<CrewReviewer> = {}): CrewReviewer => ({ member: key, sessionId: `${key}-${round}`, name: `${key} (round ${round})`, round, verdict: null, blockers: null, ...fields });

const card = (crew: Partial<Crew> = {}, fields: Partial<CrewCardData> = {}): CrewCardData => ({
  crewId: 'c1',
  title: 'Fix the login redirect after SSO',
  icon: 'crew',
  tiles: false,
  members: MEMBERS,
  crew: {
    id: 'c1',
    prefab: 'Trio',
    zoneId: 'z1',
    startedBy: null,
    builder: 'b1',
    round: 1,
    roundLimit: 3,
    phase: 'building',
    needsYou: false,
    stopped: null,
    startedAt: new Date(2026, 10, 5, 10, 0).toISOString(),
    stoppedAt: null,
    reviewers: [],
    ...crew,
  },
  phaseAt: new Date(2026, 10, 5, 10, 22).toISOString(),
  startFailed: false,
  startError: null,
  ...fields,
});

const flag = (reason: string, to: 'user' | 'orchestrator' = 'user') => ({ id: 1, reason, at: '2026-11-05T10:00:00.000Z', to, via: null });
const rowsOf = (model: ReturnType<typeof crewCardModel>) => model.rows.map((row) => `${row.name}: ${row.pill.label}${row.detail === '' ? '' : ` · ${row.detail}`}`);

describe('a crew card', () => {
  it('shows a crew at work: its round, a row for each member of its prefab, and how it started', () => {
    const model = crewCardModel(card(), [agent('b1', { status: { summary: 'writing the redirect' } as Agent['status'] })], 'explicit');

    expect(model).toMatchObject({ tone: 'running', label: null, roundText: 'round 1 of 3', why: null, actions: [], agents: 1 });
    expect(model.rounds).toEqual([
      { round: 1, state: 'now' },
      { round: 2, state: 'next' },
      { round: 3, state: 'next' },
    ]);
    expect(rowsOf(model)).toEqual(['Builder: running · writing the redirect', 'Code review: waits · for Builder’s hand-off', 'Design review: waits · for Builder’s hand-off']);
    expect(model.rows.map((row) => row.sessionId)).toEqual(['b1', undefined, undefined]);
    expect(model.last).toBe('10:22 Started from Trio');
  });

  it('says whose turn it is as the builder hands off, and as its reviews go back', () => {
    const reviewing = card({ phase: 'reviewing', reviewers: [reviewer('code-review', 1), reviewer('design-review', 1)] });
    const first = crewCardModel(reviewing, [agent('b1', { state: 'idle' }), agent('code-review-1', { status: { summary: 'reading the diff' } as Agent['status'] }), agent('design-review-1')], 'explicit');
    expect(rowsOf(first)).toEqual(['Builder: waits · for the reviews', 'Code review: running · reading the diff', 'Design review: running · r1']);
    expect(first.last).toBe('10:22 Builder handed off (round 1)');
    expect(first.agents).toBe(3);

    // Round 2: code review asked for changes, design review approved, and both agents were closed.
    const back = card({ round: 2, reviewers: [reviewer('code-review', 1, { verdict: 'changes-requested', blockers: 3 }), reviewer('design-review', 1, { verdict: 'approve', blockers: 0 })] });
    const second = crewCardModel(back, [agent('b1')], 'explicit');
    expect(rowsOf(second)).toEqual(['Builder: running', 'Code review: waits · for the fixes', 'Design review: approved · r1']);
    expect(second.rows.map((row) => row.mark)).toEqual([undefined, 'waits', 'approved']);
    expect(second.rounds.map((chip) => chip.state)).toEqual(['done', 'now', 'next']);
    expect(second).toMatchObject({ roundText: 'round 2 of 3', last: '10:22 Reviews went to Builder (round 2)', agents: 1 });
  });

  it('names a member by its own name, else its key in words, and says when its agent is gone', () => {
    const data = card({ phase: 'reviewing', reviewers: [reviewer('code-review', 1)] }, { members: [member('impl', { starts: 'prompt', role: 'implementer' }), member('code-review', { name: 'Sceptic' })] });
    const model = crewCardModel(data, [], 'explicit');
    expect(rowsOf(model)).toEqual(['Impl: gone', 'Sceptic: gone · r1']);
    expect(model.agents).toBe(0);
    expect(model.last).toBe('10:22 Impl handed off (round 1)');
  });

  it('needs you while one of its agents whose turn it is asks, waits on a permission, a plan or a flag of its own', () => {
    const ask = { id: 1, question: 'Keep the old ?next= param?', options: [], freeText: true } as unknown as Agent['ask'];
    const asks = crewCardModel(card({ round: 2 }), [agent('b1', { state: 'waiting', ask })], 'explicit');
    expect(asks).toMatchObject({ tone: 'needs', label: 'Needs you', roundText: 'paused in round 2', last: null });
    expect(asks.why).toBe('Builder asks: “Keep the old ?next= param?”');
    expect(asks.actions).toEqual([{ id: 'agent', label: 'Answer', primary: true, sessionId: 'b1' }]);

    const permission = crewCardModel(card({ phase: 'reviewing', reviewers: [reviewer('code-review', 1)] }), [agent('b1', { state: 'idle' }), agent('code-review-1', { state: 'needs-permission' })], 'explicit');
    expect(permission.why).toBe('Code review waits for you to allow a step.');
    expect(permission.actions).toEqual([{ id: 'agent', label: 'Open Code review', primary: true, sessionId: 'code-review-1' }]);

    const flagged = crewCardModel(card(), [agent('b1', { state: 'idle', flag: flag('the staging key is missing') })], 'explicit');
    expect(flagged).toMatchObject({ tone: 'needs', why: 'Builder flagged: the staging key is missing' });
  });

  it('does not need you for a turn that only ended, a reviewer of an earlier round, or a flag for an orchestrator', () => {
    const quiet = [agent('b1', { state: 'waiting' })];
    expect(crewCardModel(card(), quiet, 'turns').tone).toBe('running');
    // The builder's turn: a reviewer still on the board from the round before holds nothing up.
    const stale = card({ round: 2, reviewers: [reviewer('code-review', 1, { verdict: 'changes-requested', blockers: 1 })] });
    expect(crewCardModel(stale, [agent('b1'), agent('code-review-1', { state: 'needs-permission' })], 'explicit').tone).toBe('running');
    expect(crewCardModel(card(), [agent('b1', { state: 'idle', flag: flag('ready', 'orchestrator'), ledBy: 'lead' })], 'explicit').tone).toBe('running');
  });

  it('reads an agent whose turn is on by its status under the Simplified design, and where the crew has a member the same in both', () => {
    const reviewing = card({ phase: 'reviewing', reviewers: [reviewer('code-review', 1), reviewer('design-review', 1)] });
    const agents = [agent('b1', { state: 'idle' }), agent('code-review-1', { state: 'thinking' }), agent('design-review-1', { state: 'needs-permission' })];

    const human = crewCardModel(reviewing, agents, 'explicit', true);
    expect(rowsOf(human)).toEqual(['Builder: waits · for the reviews', 'Code review: Working · r1', 'Design review: Needs you · r1']);
    expect(human.rows.map((row) => row.status)).toEqual([undefined, 'working', 'needs-you']);
    expect(human.rows.map((row) => row.mark)).toEqual(['waits', undefined, undefined]);
    // Its builder at work, and at its prompt with nothing asked.
    expect(rowsOf(crewCardModel(card(), [agent('b1', { state: 'running' })], 'explicit', true))).toContain('Builder: Working');
    expect(rowsOf(crewCardModel(card(), [agent('b1', { state: 'idle' })], 'explicit', true))).toContain('Builder: Done');

    // Classic, and Simplified with its technical details shown: the agent's own state.
    const classic = crewCardModel(reviewing, agents, 'explicit');
    expect(rowsOf(classic)).toEqual(['Builder: waits · for the reviews', 'Code review: thinking · r1', 'Design review: allow? · r1']);
    expect(classic.rows.map((row) => row.status)).toEqual([undefined, undefined, undefined]);
  });

  it('asks you to try again when its round’s reviewers did not start, though the crew’s own flag sits on its builder', () => {
    const builder = agent('b1', { state: 'idle', flag: flag('The Trio crew couldn’t start round 1’s reviewers') });
    const model = crewCardModel(card({}, { startFailed: true }), [builder], 'explicit');
    expect(model).toMatchObject({ tone: 'needs', label: 'Needs you', roundText: 'paused in round 1' });
    expect(model.why).toBe('Round 1’s reviewers could not be started. Nothing was sent.');
    expect(model.actions).toEqual([{ id: 'round', label: 'Try again', primary: true }]);
    // No reason was kept.
    expect(model.error).toBeNull();

    // Why they did not start, as the daemon said it.
    const said = crewCardModel(card({}, { startFailed: true, startError: 'The crew’s zone has no room for another agent.' }), [builder], 'explicit');
    expect(said.error).toBe('The crew’s zone has no room for another agent.');
    expect(said.why).toBe('Round 1’s reviewers could not be started. Nothing was sent.');
    // A reason left over from a start that has since worked says nothing.
    expect(crewCardModel(card(), [agent('b1')], 'explicit').error).toBeNull();
  });

  it('stops at ready to merge with the way to its pull request, when it has one, and to its builder', () => {
    const pr = { number: 231, title: 'Fix the redirect', state: 'open', checks: 'passing', url: 'https://example.test/pr/231' } as unknown as PullRequest;
    const approved = [reviewer('code-review', 1, { verdict: 'changes-requested', blockers: 1 }), reviewer('code-review', 2, { verdict: 'approve', blockers: 0 }), reviewer('design-review', 2, { verdict: 'approve', blockers: 0 })];
    const data = card({ round: 2, phase: 'stopped', stopped: 'ready-to-merge', reviewers: approved });
    // The crew's own flag on its builder is not it asking for anything else.
    const builder = agent('b1', { state: 'idle', flag: flag('The Trio crew is ready to merge'), pullRequests: [pr] });
    const model = crewCardModel(data, [builder], 'explicit');

    expect(model).toMatchObject({ tone: 'ready', label: 'Ready to merge', roundText: 'done in 2 rounds', last: null });
    expect(model.why).toBe('Both reviewers approve round 2, with no blocker open. Merging stays your click.');
    expect(model.rounds.map((chip) => chip.state)).toEqual(['done', 'done', 'next']);
    expect(model.actions).toEqual([
      { id: 'pull-request', label: 'Open pull request', primary: true },
      { id: 'agent', label: 'Open Builder', primary: false, sessionId: 'b1' },
    ]);
    expect(model.pullRequest).toEqual({ pr, sessionId: 'b1' });
    expect(rowsOf(model)).toEqual(['Builder: needs you', 'Code review: approved · r2', 'Design review: approved · r2']);

    // Checks that fail, or still run, are said where the user decides to merge.
    const checks = (state: PullRequest['checks']) => crewCardModel(data, [agent('b1', { state: 'idle', pullRequests: [{ ...pr, checks: state }] })], 'explicit');
    expect(checks('failing')).toMatchObject({ tone: 'ready', why: 'Both reviewers approve round 2, with no blocker open. #231’s checks are failing. Merging stays your click.' });
    expect(checks('failing').pullRequest?.pr.checks).toBe('failing');
    expect(checks('pending').why).toBe('Both reviewers approve round 2, with no blocker open. #231’s checks are still running. Merging stays your click.');
    expect(checks('none').why).toBe('Both reviewers approve round 2, with no blocker open. Merging stays your click.');

    const solo = crewCardModel(card({ phase: 'stopped', stopped: 'ready-to-merge', reviewers: [reviewer('code-review', 1, { verdict: 'approve', blockers: 0 })] }), [agent('b1', { state: 'idle' })], 'explicit');
    expect(solo.why).toBe('Code review approves round 1, with no blocker open. Merging stays your click.');
    expect(solo.roundText).toBe('done in 1 round');
    expect(solo.actions).toEqual([{ id: 'agent', label: 'Open Builder', primary: true, sessionId: 'b1' }]);
  });

  it('stops at its round limit saying who still asks for what, with one more round or taking over', () => {
    const last = [reviewer('code-review', 3, { verdict: 'changes-requested', blockers: 1 }), reviewer('design-review', 3, { verdict: 'approve', blockers: 0 })];
    const model = crewCardModel(card({ round: 3, phase: 'stopped', stopped: 'round-limit', reviewers: last }), [agent('b1', { state: 'idle' })], 'explicit');

    expect(model).toMatchObject({ tone: 'limit', label: 'Round limit', roundText: 'stopped at round 3 of 3' });
    expect(model.why).toBe('Code review still has 1 blocker open. Nothing more was sent.');
    expect(model.rounds.map((chip) => chip.state)).toEqual(['done', 'done', 'done']);
    expect(model.actions).toEqual([
      { id: 'round', label: 'One more round', primary: true },
      { id: 'agent', label: 'Take over', primary: false, sessionId: 'b1' },
    ]);
    expect(rowsOf(model)).toEqual(['Builder: idle', 'Code review: changes · r3 · 1 blocker', 'Design review: approved · r3']);

    const both = [reviewer('code-review', 1, { verdict: 'changes-requested', blockers: 2 }), reviewer('design-review', 1, { verdict: 'changes-requested', blockers: 0 })];
    const one = crewCardModel(card({ roundLimit: 1, phase: 'stopped', stopped: 'round-limit', reviewers: both }), [], 'explicit');
    expect(one.why).toBe('Code review and Design review still have 2 blockers open. Nothing more was sent.');
    // With its builder gone, there is no one to take over from.
    expect(one.actions.map((action) => action.id)).toEqual(['round']);
  });

  it('says how it ended once it is over, with nothing to press', () => {
    const over = (stopped: Crew['stopped'], crew: Partial<Crew> = {}) => crewCardModel(card({ round: 2, phase: 'stopped', stopped, ...crew }), [], 'explicit');
    expect(over('stopped')).toMatchObject({ tone: 'over', label: 'Stopped', roundText: 'stopped in round 2', actions: [], last: null });
    // The round it was stopped in was cut short: neither done nor still to come.
    expect(over('stopped').rounds.map((chip) => chip.state)).toEqual(['done', 'cut', 'next']);
    expect(over('builder-gone', { round: 1 }).rounds.map((chip) => chip.state)).toEqual(['cut', 'next', 'next']);
    expect(over('merged').rounds.map((chip) => chip.state)).toEqual(['done', 'done', 'next']);
    expect(over('merged')).toMatchObject({ tone: 'over', label: 'Merged', roundText: 'done in 2 rounds' });
    expect(over('builder-gone')).toMatchObject({ tone: 'over', label: 'Builder gone', why: 'Builder was closed, so the crew stopped.' });
    // A reviewer that never started says so, not that it waits.
    expect(rowsOf(over('stopped', { round: 1 }))).toEqual(['Builder: gone', 'Code review: not started', 'Design review: not started']);
  });

  it('gives a long round limit in words alone', () => {
    const model = crewCardModel(card({ round: 4, roundLimit: 8 }), [agent('b1')], 'explicit');
    expect(model.rounds).toEqual([]);
    expect(model.roundText).toBe('round 4 of 8');
  });
});
