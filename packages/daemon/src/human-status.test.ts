import { describe, expect, it } from 'vitest';
import { AGENT_STATES, needsYouKind, needsYouReading, REQUEST_WORDS, type Agent, type AgentState } from './protocol.ts';
import { asksInWords, CARRYING_ON_STATES, standsOut, HUMAN_STATUS_LABELS, HUMAN_STATUSES, humanStatus, WORKING_STATES, type HumanStatus } from './human-status.ts';

const agent = (patch: Partial<Agent>): Agent =>
  ({
    name: 'impl',
    harness: 'claude',
    state: 'idle',
    endedAt: null,
    exitCode: null,
    permissions: [],
    ask: null,
    removeAsk: null,
    plan: null,
    flag: null,
    ledBy: null,
    reviewOf: null,
    lastMessage: null,
    pullRequests: [],
    hibernated: null,
    ...patch,
  }) as Agent;

const ask = { id: 'q1', question: 'Which cache?', options: [], freeText: true, askedAt: '', expiresAt: '', onBoard: false, questions: [{ question: 'Which cache?', options: [], freeText: true }], answers: [null], card: null };
const plan = { id: 'p1', version: 1, title: 'Plan', format: 'markdown' as const, presentedAt: '', expiresAt: '', decision: null, left: false, author: 'agent' as const, path: null };
const flag = { id: 1, reason: 'Ready for review', at: '', to: 'user' as const, via: null };
const permission = { id: 'p', tool: 'Bash', input: {}, at: '' } as unknown as Agent['permissions'][number];
const pr = (state: 'open' | 'draft' | 'merged' | 'closed') => ({ number: 7, title: 'Fix', url: '', state, checks: 'passing' }) as Agent['pullRequests'][number];

/** What each of today's states shows on its own: a live agent, asking nothing, whose last message asks nothing. */
const BY_STATE: Record<AgentState, HumanStatus> = {
  running: 'working',
  thinking: 'working',
  starting: 'working',
  'handing-off': 'working',
  'on-command': 'working',
  waiting: 'done',
  idle: 'done',
  done: 'done',
  'needs-permission': 'needs-you',
  'stopped-by-restart': 'paused',
  failed: 'problem',
  'rate-limited': 'paused',
  hibernated: 'paused',
  scheduled: 'scheduled',
};

// The mapping reads no harness: Claude's and Codex's agents share today's states, so each case holds for both.
describe("an agent's status, one of six", () => {
  it.each(AGENT_STATES.map((state) => [state, BY_STATE[state]] as const))('shows %s as %s', (state, status) => {
    expect(humanStatus(agent({ state }), 'explicit').status).toBe(status);
  });

  it('is needs you, never done, while it waits on the user: a permission prompt, a question, a plan or a flag', () => {
    for (const patch of [{ permissions: [permission] }, { ask }, { plan }, { flag }] satisfies Partial<Agent>[]) {
      expect(humanStatus(agent({ state: 'waiting', ...patch }), 'explicit').status).toBe('needs-you');
    }
    expect(humanStatus(agent({ state: 'idle', flag }), 'explicit').detail).toBe('Ready for review');
    // A flag to its orchestrator is not the user's.
    expect(humanStatus(agent({ flag: { ...flag, to: 'orchestrator' } }), 'explicit').status).toBe('done');
  });

  it('is Done, cued Asks you, for a finished turn whose last message asks something', () => {
    expect(humanStatus(agent({ state: 'waiting', lastMessage: 'Shall I go ahead?' }), 'explicit')).toEqual({ status: 'done', detail: 'Its last message asks you', cue: 'asks-in-words' });
    expect(humanStatus(agent({ state: 'idle', lastMessage: 'All done. Tests pass.' }), 'explicit').status).toBe('done');
    // Only a turn that has ended: one still working may be thinking aloud.
    expect(humanStatus(agent({ state: 'running', lastMessage: 'Shall I go ahead?' }), 'explicit').status).toBe('working');
  });

  it('is Done, cued To review, for work waiting for review: a pull request still open', () => {
    expect(humanStatus(agent({ pullRequests: [pr('open')] }), 'explicit')).toEqual({ status: 'done', detail: 'Changes ready to review', cue: 'pr-ready' });
    expect(humanStatus(agent({ pullRequests: [pr('draft')] }), 'explicit').status).toBe('done');
    expect(humanStatus(agent({ pullRequests: [pr('merged')] }), 'explicit').status).toBe('done');
  });

  it('lists every finished turn as needs you when the inbox does', () => {
    expect(humanStatus(agent({ state: 'waiting' }), 'turns').status).toBe('needs-you');
    expect(humanStatus(agent({ state: 'idle' }), 'turns').status).toBe('done');
  });

  it('says why a paused agent is paused, and how one a restart stopped can go on', () => {
    expect(humanStatus(agent({ state: 'rate-limited' }), 'explicit').detail).toBe('Usage limit');
    expect(humanStatus(agent({ state: 'stopped-by-restart', endedAt: '1' }), 'explicit').detail).toBe('Stopped when the app restarted');
  });

  it("takes an ended agent's verdict from the daemon: done is Done whatever its exit code, failed a Problem", () => {
    expect(humanStatus(agent({ state: 'done', endedAt: '1', exitCode: 0 }), 'explicit').status).toBe('done');
    // Stopped by the user, or ended by its own session, with an exit code all the same (a pty kill on Windows reports one).
    expect(humanStatus(agent({ state: 'done', endedAt: '1', exitCode: 143 }), 'explicit')).toEqual({ status: 'done', detail: null, cue: null });
    expect(humanStatus(agent({ state: 'done', endedAt: '1', exitCode: null }), 'explicit').status).toBe('done');
    expect(humanStatus(agent({ state: 'failed', endedAt: '1', exitCode: 1 }), 'explicit')).toEqual({ status: 'problem', detail: 'Ended · exit 1', cue: null });
    expect(humanStatus(agent({ state: 'failed', endedAt: '1', exitCode: null }), 'explicit')).toEqual({ status: 'problem', detail: null, cue: null });
    // A flag that outlived its session still needs the user.
    expect(humanStatus(agent({ state: 'failed', endedAt: '1', exitCode: 1, flag }), 'explicit').status).toBe('needs-you');
    // Paused and stopped agents have ended too, and keep their own.
    expect(humanStatus(agent({ state: 'hibernated', endedAt: '1' }), 'explicit').status).toBe('paused');
  });

  it('is Done, cued To review, for an ended agent whose pull request is still open, unless it failed', () => {
    expect(humanStatus(agent({ state: 'done', endedAt: '1', exitCode: 0, pullRequests: [pr('open')] }), 'explicit')).toEqual({ status: 'done', detail: 'Changes ready to review', cue: 'pr-ready' });
    expect(humanStatus(agent({ state: 'failed', endedAt: '1', exitCode: 1, pullRequests: [pr('open')] }), 'explicit').status).toBe('problem');
    // Its question went with its session.
    expect(humanStatus(agent({ state: 'done', endedAt: '1', exitCode: 0, lastMessage: 'Shall I go ahead?' }), 'explicit').status).toBe('done');
  });

  it('shows a reviewer waiting on its implementer as paused, saying whom it waits for', () => {
    const reviewer = agent({ name: 'review', state: 'idle', reviewOf: 'impl-id' });
    expect(humanStatus(reviewer, 'explicit', agent({ name: 'impl', state: 'running' }))).toEqual({ status: 'paused', detail: 'Waits for impl', cue: null });
    // Its implementer done too: the pair's work is done.
    expect(humanStatus(reviewer, 'explicit', agent({ name: 'impl', state: 'idle' })).status).toBe('done');
    // Its own question still comes first, asked through the board or in its last message.
    expect(humanStatus({ ...reviewer, ask }, 'explicit', agent({ state: 'running' })).status).toBe('needs-you');
    expect(humanStatus({ ...reviewer, lastMessage: 'Merge it?' }, 'explicit', agent({ state: 'running' }))).toEqual({ status: 'done', detail: 'Its last message asks you', cue: 'asks-in-words' });
    // An implementer paused, at its usage limit or by a pause, still has the reviewer waiting.
    expect(humanStatus(reviewer, 'explicit', agent({ name: 'impl', state: 'rate-limited' }))).toEqual({ status: 'paused', detail: 'Waits for impl', cue: null });
    expect(humanStatus(reviewer, 'explicit', agent({ name: 'impl', state: 'hibernated', endedAt: '1' }))).toEqual({ status: 'paused', detail: 'Waits for impl', cue: null });
    // One that has ended is waited on no longer.
    expect(humanStatus(reviewer, 'explicit', agent({ name: 'impl', state: 'done', endedAt: '1' })).status).toBe('done');
  });

  describe("a crew member's orchestrator takes its turns, questions and changes", () => {
    const flagToLead = { ...flag, to: 'orchestrator' as const };
    const crew = (patch: Partial<Agent>) => agent({ spawnedBy: 'lead-id', ledBy: 'Release lead', ...patch });
    const openChanges = [pr('open')];
    const withLead = { status: 'working', detail: 'With Release lead', cue: null };

    it.each([
      ['an open PR', { state: 'idle', pullRequests: openChanges }, 'explicit', withLead],
      ['a last message that asks', { state: 'waiting', lastMessage: 'Shall I merge it?' }, 'explicit', withLead],
      ['a finished turn the inbox lists', { state: 'waiting' }, 'turns', withLead],
      ['a finished turn, idle', { state: 'idle' }, 'turns', withLead],
      ['a flag to its orchestrator', { state: 'idle', flag: flagToLead }, 'explicit', withLead],
      ['a permission prompt', { state: 'needs-permission', permissions: [permission] }, 'explicit', { status: 'needs-you', detail: 'Needs your permission', cue: null }],
      ['a flag to the user', { state: 'idle', flag }, 'explicit', { status: 'needs-you', detail: 'Ready for review', cue: null }],
      ['a restart that stopped it', { state: 'stopped-by-restart', endedAt: '1' }, 'explicit', { status: 'paused', detail: 'Stopped when the app restarted', cue: 'stopped-by-restart' }],
      ['having failed', { state: 'failed', endedAt: '1', exitCode: 1 }, 'turns', { status: 'problem', detail: 'Ended · exit 1', cue: null }],
      ['working on a turn', { state: 'running' }, 'turns', { status: 'working', detail: null, cue: null }],
      ['its usage limit', { state: 'rate-limited' }, 'turns', { status: 'paused', detail: 'Usage limit', cue: null }],
    ] as const)('with %s reads %j under %s', (_what, patch, shows, expected) => {
      expect(humanStatus(crew(patch as Partial<Agent>), shows)).toEqual(expected);
    });

    it("keeps today's rules once its orchestrator has ended, and for an agent the user started", () => {
      for (const orphan of [agent({ spawnedBy: 'lead-id', ledBy: null }), agent({ spawnedBy: null, ledBy: null })]) {
        expect(humanStatus({ ...orphan, state: 'idle', pullRequests: openChanges }, 'explicit')).toEqual({ status: 'done', detail: 'Changes ready to review', cue: 'pr-ready' });
        expect(humanStatus({ ...orphan, state: 'waiting', lastMessage: 'Shall I merge it?' }, 'explicit')).toEqual({ status: 'done', detail: 'Its last message asks you', cue: 'asks-in-words' });
        expect(humanStatus({ ...orphan, state: 'waiting' }, 'turns').status).toBe('needs-you');
        expect(humanStatus({ ...orphan, state: 'idle' }, 'explicit').status).toBe('done');
      }
    });

    it("is Done after it has ended, its open changes still its orchestrator's", () => {
      expect(humanStatus(crew({ state: 'done', endedAt: '1', pullRequests: openChanges }), 'explicit')).toEqual({ status: 'done', detail: null, cue: null });
    });

    it('stays Paused for a reviewer that waits on a working implementer', () => {
      const reviewer = crew({ state: 'idle', reviewOf: 'impl-id' });
      expect(humanStatus(reviewer, 'explicit', agent({ name: 'impl', state: 'running' }))).toEqual({ status: 'paused', detail: 'Waits for impl', cue: null });
      expect(humanStatus(reviewer, 'explicit', agent({ name: 'impl', state: 'done', endedAt: '1' }))).toEqual(withLead);
    });
  });

  it('marks a tile with a cue that nothing counts: last words that ask, open changes, a restart that stopped it', () => {
    for (const patch of [{ state: 'waiting', lastMessage: 'Shall I go ahead?' }, { pullRequests: [pr('open')] }, { state: 'stopped-by-restart', endedAt: '1' }] satisfies Partial<Agent>[]) {
      const reading = humanStatus(agent(patch), 'explicit');
      expect(reading.cue).not.toBeNull();
      expect(reading.status).not.toBe('needs-you');
      expect(needsYouKind(agent(patch), 'explicit')).toBeNull();
    }
    expect(standsOut(humanStatus(agent({ pullRequests: [pr('open')] }), 'explicit'))).toBe(true);
    // A request comes before a cue, and is counted.
    expect(humanStatus(agent({ ask, pullRequests: [pr('open')] }), 'explicit')).toEqual({ status: 'needs-you', detail: 'Asks you', cue: null });
    // Stopped, it sleeps: its tile stands out no more than a paused one's.
    expect(standsOut(humanStatus(agent({ state: 'stopped-by-restart', endedAt: '1' }), 'explicit'))).toBe(false);
  });

  it('has a word for each status', () => {
    expect(HUMAN_STATUSES.map((status) => HUMAN_STATUS_LABELS[status])).toEqual(['Needs you', 'Problem', 'Working', 'Done', 'Paused', 'Scheduled']);
  });
});

describe('what needs the user, read once', () => {
  const at = (minute: number) => `2026-11-26T10:0${minute}:00.000Z`;
  const base = { createdAt: at(0), finishedAt: at(1) } as Partial<Agent>;

  it('gives its kind, since when, and its words, from the one table', () => {
    expect(needsYouReading(agent({ ...base, flag: { ...flag, at: at(4) } }), 'explicit')).toEqual({ kind: 'flagged', since: at(4), words: REQUEST_WORDS.flagged });
    expect(needsYouReading(agent({ ...base, ask: { ...ask, askedAt: at(3) } }), 'explicit')).toMatchObject({ kind: 'asks', since: at(3) });
    expect(needsYouReading(agent({ ...base, plan: { ...plan, presentedAt: at(2) } }), 'explicit')).toMatchObject({ kind: 'plan', since: at(2) });
    expect(needsYouReading(agent({ ...base, state: 'waiting' }), 'turns')).toMatchObject({ kind: 'turn', since: at(1) });
  });

  it('is nothing for what only marks a tile', () => {
    expect(needsYouReading(agent({ ...base, state: 'waiting', lastMessage: 'Shall I?' }), 'explicit')).toBeNull();
    expect(needsYouReading(agent({ ...base, pullRequests: [pr('open')] }), 'explicit')).toBeNull();
    expect(needsYouReading(agent({ ...base, state: 'stopped-by-restart', endedAt: at(5) }), 'explicit')).toBeNull();
  });

  it('has words for every kind', () => {
    for (const words of Object.values(REQUEST_WORDS)) expect(words.tag && words.says && words.why).toBeTruthy();
  });
});

describe('the working states', () => {
  it('are the states whose status is Working, and carrying on adds its usage limit', () => {
    expect([...WORKING_STATES].sort()).toEqual(AGENT_STATES.filter((state) => BY_STATE[state] === 'working').sort());
    expect([...CARRYING_ON_STATES].sort()).toEqual([...WORKING_STATES, 'rate-limited'].sort());
  });
});

describe('a message that asks the user something', () => {
  it.each([
    ['Shall I go ahead?', true],
    ['Which one do you want: A or B?  \n', true],
    ['Should I merge it?**', true],
    ['Proceed? (y/n)', true],
    ['Want me to "merge?"', true],
    ['Shall I go ahead? 🙂', true],
    ['Ready to merge? 👍🏽', true],
    ['Ship it? 🧑‍💻', true],
    ['どうしますか？', true],
    ['Done. Why did it fail? A missing import.', false],
    ['', false],
  ])('%j asks: %s', (message, asks) => {
    expect(asksInWords(message)).toBe(asks);
  });
});
