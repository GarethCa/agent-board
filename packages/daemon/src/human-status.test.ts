import { describe, expect, it } from 'vitest';
import { AGENT_STATES, type Agent, type AgentState } from './protocol.ts';
import { asksInWords, HUMAN_STATUS_LABELS, HUMAN_STATUSES, humanStatus, type HumanStatus } from './human-status.ts';

const agent = (patch: Partial<Agent>): Agent =>
  ({
    name: 'impl',
    harness: 'claude',
    state: 'idle',
    endedAt: null,
    exitCode: null,
    permissions: [],
    ask: null,
    plan: null,
    flag: null,
    reviewOf: null,
    lastMessage: null,
    pullRequests: [],
    hibernated: null,
    ...patch,
  }) as Agent;

const ask = { id: 'q1', question: 'Which cache?', options: [], freeText: true, askedAt: '', expiresAt: '', onBoard: false, at: null };
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
  'stopped-by-restart': 'needs-you',
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

  it('is needs you for a finished turn whose last message asks something', () => {
    expect(humanStatus(agent({ state: 'waiting', lastMessage: 'Shall I go ahead?' }), 'explicit')).toEqual({ status: 'needs-you', detail: 'Asks you' });
    expect(humanStatus(agent({ state: 'idle', lastMessage: 'All done. Tests pass.' }), 'explicit').status).toBe('done');
    // Only a turn that has ended: one still working may be thinking aloud.
    expect(humanStatus(agent({ state: 'running', lastMessage: 'Shall I go ahead?' }), 'explicit').status).toBe('working');
  });

  it('is needs you for work waiting for review: a pull request still open', () => {
    expect(humanStatus(agent({ pullRequests: [pr('open')] }), 'explicit')).toEqual({ status: 'needs-you', detail: 'Changes ready to review' });
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
    expect(humanStatus(agent({ state: 'done', endedAt: '1', exitCode: 143 }), 'explicit')).toEqual({ status: 'done', detail: null });
    expect(humanStatus(agent({ state: 'done', endedAt: '1', exitCode: null }), 'explicit').status).toBe('done');
    expect(humanStatus(agent({ state: 'failed', endedAt: '1', exitCode: 1 }), 'explicit')).toEqual({ status: 'problem', detail: 'Ended · exit 1' });
    expect(humanStatus(agent({ state: 'failed', endedAt: '1', exitCode: null }), 'explicit')).toEqual({ status: 'problem', detail: null });
    // A flag that outlived its session still needs the user.
    expect(humanStatus(agent({ state: 'failed', endedAt: '1', exitCode: 1, flag }), 'explicit').status).toBe('needs-you');
    // Paused and stopped agents have ended too, and keep their own.
    expect(humanStatus(agent({ state: 'hibernated', endedAt: '1' }), 'explicit').status).toBe('paused');
  });

  it('is needs you for an ended agent whose pull request is still open, unless it failed', () => {
    expect(humanStatus(agent({ state: 'done', endedAt: '1', exitCode: 0, pullRequests: [pr('open')] }), 'explicit')).toEqual({ status: 'needs-you', detail: 'Changes ready to review' });
    expect(humanStatus(agent({ state: 'failed', endedAt: '1', exitCode: 1, pullRequests: [pr('open')] }), 'explicit').status).toBe('problem');
    // Its question went with its session.
    expect(humanStatus(agent({ state: 'done', endedAt: '1', exitCode: 0, lastMessage: 'Shall I go ahead?' }), 'explicit').status).toBe('done');
  });

  it('shows a reviewer waiting on its implementer as paused, saying whom it waits for', () => {
    const reviewer = agent({ name: 'review', state: 'idle', reviewOf: 'impl-id' });
    expect(humanStatus(reviewer, 'explicit', agent({ name: 'impl', state: 'running' }))).toEqual({ status: 'paused', detail: 'Waits for impl' });
    // Its implementer done too: the pair's work is done.
    expect(humanStatus(reviewer, 'explicit', agent({ name: 'impl', state: 'idle' })).status).toBe('done');
    // Its own question still comes first, asked through the board or in its last message.
    expect(humanStatus({ ...reviewer, ask }, 'explicit', agent({ state: 'running' })).status).toBe('needs-you');
    expect(humanStatus({ ...reviewer, lastMessage: 'Merge it?' }, 'explicit', agent({ state: 'running' }))).toEqual({ status: 'needs-you', detail: 'Asks you' });
    // An implementer paused, at its usage limit or by a pause, still has the reviewer waiting.
    expect(humanStatus(reviewer, 'explicit', agent({ name: 'impl', state: 'rate-limited' }))).toEqual({ status: 'paused', detail: 'Waits for impl' });
    expect(humanStatus(reviewer, 'explicit', agent({ name: 'impl', state: 'hibernated', endedAt: '1' }))).toEqual({ status: 'paused', detail: 'Waits for impl' });
    // One that has ended is waited on no longer.
    expect(humanStatus(reviewer, 'explicit', agent({ name: 'impl', state: 'done', endedAt: '1' })).status).toBe('done');
  });

  it('has a word for each status', () => {
    expect(HUMAN_STATUSES.map((status) => HUMAN_STATUS_LABELS[status])).toEqual(['Needs you', 'Problem', 'Working', 'Done', 'Paused', 'Scheduled']);
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
