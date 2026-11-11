import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent, AgentAsk, AgentFlag, AgentState, PermissionPrompt, PlanSummary } from '@agent-board/daemon/protocol';
import { heldPrompts, isProblem, stepsLeftWords, stepsWaitKey, stepsWaitLine, needsYou, needsYouEntries, needsYouSections, permissionWaitLine, problemKey, readyToAccept, stillReadyToAccept, secondsLeft, sinceText, sinceTextChangesIn, startSinceClock, toolSummary, unseenCount, waitLeft } from './needs-you';

const agent = (sessionId: string, state: AgentState, fields: Partial<Agent> = {}): Agent => ({
  sessionId,
  zoneId: 'z1',
  repoRoot: '/code/app',
  position: null,
  harness: 'claude',
  model: null,
  effort: null,
  effortPending: null,
  role: null,
  roleName: null,
  reviews: null,
  name: sessionId,
  description: '',
  branch: sessionId,
  ownedBranch: sessionId,
  detached: false,
  worktree: `/tmp/${sessionId}`,
  cwd: `/tmp/${sessionId}`,
  state,
  createdAt: '2026-10-09T10:00:00.000Z',
  endedAt: null,
  exitCode: null,
  shellSessionId: null,
  shellHarness: null,
  clickableLinks: null,
  issue: null,
  notice: null,
  earlierConversations: [],
  hibernated: null,
  muted: false,
  seen: false,
  subagents: [],
  commands: [],
  pullRequests: [],
  pushedPullRequests: [],
  records: [],
  recordedPullRequests: [],
  guessedDoc: null,
  page: null,
  lastMessage: null,
  compactingSince: null,
  stateSince: '2026-10-09T10:00:00.000Z',
  finishedAt: null,
  permissions: [],
  ask: null,
  stepsWait: null,
  plan: null,
  docs: [],
  schedule: null,
  reviewOf: null,
  reviewCap: 3,
  ownsWorktree: true,
  master: false,
  plainFolder: false,
  orchestrate: null,
  spawnedBy: null,
  ledBy: null,
  startup: null,
  unsent: null,
  untypedPrompt: null,
  trustFolder: null,
  trustedByZone: false,
  queuedUntilUp: 0,
  messagesWaiting: 0,
  undelivered: [],
  status: null,
  character: null,
  workFinishedAt: null,
  flag: null,
  ...fields,
});

const prompt: PermissionPrompt = {
  id: 'p1',
  toolName: 'Bash',
  toolInput: { command: 'rm -rf dist' },
  subagent: null,
  requestedAt: '2026-10-09T10:00:00.000Z',
  heldUntil: '2026-10-09T10:00:20.000Z',
  asksInTerminal: false,
  sessionGrant: null, questions: null,
};
const lapsed: PermissionPrompt = { ...prompt, id: 'p2', heldUntil: null };

const ask: AgentAsk = {
  id: 'q1',
  question: 'Postgres or SQLite?',
  options: ['Postgres', 'SQLite'],
  freeText: false,
  askedAt: '2026-10-09T10:03:00.000Z',
  expiresAt: '2026-10-09T10:33:00.000Z',
  onBoard: false,
  questions: [{ question: 'Postgres or SQLite?', options: ['Postgres', 'SQLite'], freeText: false }],
  answers: [null],
  card: null,
};
const flag = (to: AgentFlag['to'], at = '2026-10-09T10:02:00.000Z'): AgentFlag => ({ id: 1, reason: 'PR #241 is ready for review.', at, to, via: null });

describe('the unseen count', () => {
  it('leaves out an ask whose session was opened, but keeps it in the inbox', () => {
    const agents = [agent('a', 'waiting'), agent('b', 'waiting', { seen: true }), agent('c', 'needs-permission', { permissions: [prompt], seen: true })];
    expect(unseenCount(agents, 'turns')).toBe(1);
    expect(needsYou(agents, 'turns')).toHaveLength(3);
  });

  it('counts a flag to the user until it is cleared, as opening the session clears it', () => {
    expect(unseenCount([agent('a', 'idle', { flag: flag('user'), seen: true })], 'explicit')).toBe(1);
  });

  it('counts a flag raised behind a question the user has seen', () => {
    expect(unseenCount([agent('a', 'waiting', { ask, flag: flag('user'), seen: true })], 'explicit')).toBe(1);
    expect(unseenCount([agent('a', 'waiting', { ask, seen: true })], 'explicit')).toBe(0);
  });
});

describe('the needs-you inbox', () => {
  it('lists only explicit requests by default: permission prompts, questions, plans and flags to the user', () => {
    const agents = [
      agent('running', 'running'),
      agent('turn-ended', 'waiting'),
      agent('idle', 'idle'),
      agent('permission', 'needs-permission'),
      agent('asks', 'waiting', { ask }),
      agent('flagged', 'idle', { flag: flag('user') }),
      agent('done', 'done'),
    ];
    expect(needsYouEntries(agents, 'explicit').map(({ agent: { sessionId }, kind }) => [sessionId, kind])).toEqual([
      ['permission', 'permission'],
      ['flagged', 'flagged'],
      ['asks', 'asks'],
    ]);
  });

  it('lists every agent waiting at its prompt too, as before, with turns', () => {
    const agents = [agent('a', 'running'), agent('b', 'waiting'), agent('c', 'idle'), agent('d', 'needs-permission'), agent('e', 'done')];
    expect(needsYou(agents, 'turns').map((a) => a.sessionId)).toEqual(['b', 'd']);
    expect(needsYouEntries(agents, 'turns').map((entry) => entry.kind)).toEqual(['turn', 'permission']);
  });

  it("leaves a crew member's flag to its orchestrator out, but always lists its permission prompts and questions", () => {
    const agents = [
      agent('lead', 'running'),
      agent('crew-flag', 'idle', { spawnedBy: 'lead', flag: flag('orchestrator') }),
      agent('crew-permission', 'needs-permission', { spawnedBy: 'lead', permissions: [prompt] }),
      agent('crew-asks', 'waiting', { spawnedBy: 'lead', ask }),
    ];
    expect(needsYou(agents, 'explicit').map((a) => a.sessionId)).toEqual(['crew-permission', 'crew-asks']);
  });

  it("leaves a crew member's finished turn out while its orchestrator is live, and lists it again once it has ended", () => {
    const agents = [
      agent('crew-turn', 'waiting', { spawnedBy: 'lead', ledBy: 'lead' }),
      agent('orphan-turn', 'waiting', { spawnedBy: 'lead', ledBy: null }),
      agent('loose-turn', 'waiting'),
      agent('crew-permission', 'needs-permission', { spawnedBy: 'lead', ledBy: 'lead', permissions: [prompt] }),
    ];
    expect(needsYou(agents, 'turns').map((a) => a.sessionId)).toEqual(['orphan-turn', 'loose-turn', 'crew-permission']);
    expect(unseenCount(agents, 'turns')).toBe(3);
  });

  it('puts the oldest request first', () => {
    const agents = [agent('later', 'idle', { flag: flag('user', '2026-10-09T10:05:00.000Z') }), agent('sooner', 'waiting', { ask })];
    expect(needsYou(agents, 'explicit').map((a) => a.sessionId)).toEqual(['sooner', 'later']);
  });

  it('lists an agent with any prompt pending, held or asking in its terminal, whatever its state says', () => {
    expect(needsYou([agent('a', 'running', { permissions: [prompt] })], 'explicit')).toHaveLength(1);
    expect(needsYou([agent('a', 'running', { permissions: [lapsed] })], 'explicit')).toHaveLength(1);
  });

  it('lists a scheduled run that needs you, but not a scheduled agent waiting for its next run', () => {
    const schedule = { clockId: 'clock-1', cron: '@daily', prompt: 'Sweep', enabled: true, nextRunAt: '2026-10-10T00:00:00.000Z', lastRun: null };
    const agents = [
      agent('between-runs', 'scheduled', { schedule }),
      agent('asking', 'needs-permission', { schedule, permissions: [prompt] }),
      agent('waiting', 'waiting', { schedule }),
    ];
    expect(needsYou(agents, 'turns').map((a) => a.sessionId)).toEqual(['asking', 'waiting']);
  });

  it('never lists or counts an agent on a command it left running', () => {
    const running = agent('gate', 'on-command', { commands: [{ command: 'pnpm check:pr', startedAt: '2026-10-09T10:00:00.000Z' }] });
    for (const shows of ['explicit', 'turns'] as const) {
      expect(needsYou([running], shows)).toEqual([]);
      expect(unseenCount([running], shows)).toBe(0);
    }
  });

  it('lists an ended agent only for a flag to the user, which the daemon keeps on one only for what was never delivered', () => {
    const ended = { endedAt: '2026-10-09T10:01:00.000Z' };
    expect(needsYou([agent('a', 'waiting', ended)], 'turns')).toEqual([]);
    expect(needsYou([agent('a', 'needs-permission', ended)], 'turns')).toEqual([]);
    const lost = agent('a', 'done', { ...ended, flag: flag('user') });
    expect(needsYou([lost], 'explicit')).toEqual([lost]);
  });

  it("picks the prompts still held for the inbox, and counts down each one's hold", () => {
    expect(heldPrompts(agent('a', 'needs-permission', { permissions: [lapsed, prompt] }))).toEqual([prompt]);
    expect(secondsLeft(prompt, Date.parse('2026-10-09T10:00:05.400Z'))).toBe(15);
    expect(secondsLeft(prompt, Date.parse('2026-10-09T10:00:30.000Z'))).toBe(0);
  });
});

describe('the needs-you list in its sections', () => {
  const at = (minute: number) => `2026-10-09T10:${String(minute).padStart(2, '0')}:00.000Z`;
  const pr = { number: 35, title: 'Tidy the docs', url: 'https://github.com/acme/app/pull/35', state: 'open', checks: 'passing' } as const;
  const asking = (sessionId: string, minute: number) => agent(sessionId, 'waiting', { ask: { ...ask, id: sessionId, askedAt: at(minute) } });
  const permitting = (sessionId: string, minute: number) =>
    agent(sessionId, 'needs-permission', { permissions: [{ ...prompt, id: sessionId, requestedAt: at(minute) }] });
  const flagging = (sessionId: string, minute: number): Agent => agent(sessionId, 'running', { flag: flag('user', at(minute)) });
  const plan: PlanSummary = { id: 'p', version: 1, title: 'Split the cart', format: 'markdown', presentedAt: at(0), expiresAt: null, left: true, decision: null, author: 'agent', path: null };
  const changes = (sessionId: string, minute: number, fields: Partial<Agent> = {}) =>
    agent(sessionId, 'idle', { pullRequests: [{ ...pr }], finishedAt: at(minute), workFinishedAt: at(minute), ...fields });
  const ids = (agents: Agent[], shows: 'explicit' | 'turns' = 'explicit') =>
    needsYouSections(agents, shows).map((section) => [section.title, section.rows.map((row) => `${row.agent.sessionId}:${row.kind}`)]);

  it('lists a steps card an agent waits on: its set to answer with the questions, a to-do of yours with the work', () => {
    const wait = (kind: 'steps' | 'todo', minute: number) => ({ kind, itemId: `card-${kind}`, title: 'Release 1.4', stepId: 's1', text: 'Which database?', open: kind === 'steps' ? 2 : 0, since: at(minute) });
    expect(
      ids([
        agent('setting', 'waiting', { stepsWait: wait('steps', 6) }),
        agent('keys', 'idle', { stepsWait: wait('todo', 1) }),
        asking('db', 9),
        // What it asks or plans comes before a card it waits on.
        agent('planner', 'waiting', { plan: { ...plan, presentedAt: at(2) }, stepsWait: wait('steps', 0) }),
      ]),
    ).toEqual([
      ['Continues the work', ['keys:todo', 'planner:plan']],
      ['Reaching out to you', ['setting:steps', 'db:asks']],
    ]);
  });

  it('puts what unblocks an agent first, then what reaches out, what is ready to accept and the problems, each oldest first', () => {
    expect(
      ids([
        asking('db', 9),
        changes('docs', 2),
        agent('crashed', 'failed', { endedAt: at(4), exitCode: 1 }),
        permitting('tests', 7),
        flagging('stuck', 3),
        agent('plan', 'waiting', { plan: { ...plan, presentedAt: at(5) } }),
      ]),
    ).toEqual([
      ['Continues the work', ['plan:plan', 'tests:permission']],
      ['Reaching out to you', ['stuck:flagged', 'db:asks']],
      ['Ready for you to accept', ['docs:accept']],
      ['Problems', ['crashed:problem']],
    ]);
  });

  it("puts a finished turn, listed only when the setting says so, with what reaches out, and leaves out an empty section", () => {
    const turn = agent('done-turn', 'waiting', { finishedAt: at(1) });
    expect(ids([turn], 'turns')).toEqual([['Reaching out to you', ['done-turn:turn']]]);
    expect(ids([turn])).toEqual([]);
  });

  it('counts as a problem an agent that failed, one a restart stopped and one at its usage limit, and nothing else', () => {
    expect(isProblem(agent('a', 'failed', { endedAt: at(1) }))).toBe(true);
    expect(isProblem(agent('a', 'stopped-by-restart', { endedAt: at(1) }))).toBe(true);
    expect(isProblem(agent('a', 'rate-limited'))).toBe(true);
    for (const state of ['running', 'idle', 'done', 'hibernated', 'scheduled'] as const) expect(isProblem(agent('a', state))).toBe(false);
  });

  it("leaves out a failure the user dismissed, but lists the same agent's next one, and never a stopped or stuck one's", () => {
    const failed = agent('a', 'failed', { endedAt: at(1) });
    const dismissed = new Set([problemKey(failed)!]);
    expect(ids([failed])).toEqual([['Problems', ['a:problem']]]);
    expect(needsYouSections([failed], 'explicit', dismissed)).toEqual([]);
    expect(ids([{ ...failed, endedAt: at(9) }])).toEqual([['Problems', ['a:problem']]]);
    expect(needsYouSections([{ ...failed, endedAt: at(9) }], 'explicit', dismissed)).toHaveLength(1);
    expect(problemKey(agent('b', 'stopped-by-restart', { endedAt: at(1) }))).toBeUndefined();
    expect(problemKey(agent('c', 'rate-limited'))).toBeUndefined();
  });

  it('is ready to accept with an open pull request of its own branch, at its prompt or ended, asking nothing', () => {
    expect(readyToAccept(changes('a', 1), 'explicit')).toBe(true);
    expect(readyToAccept(changes('a', 1, { state: 'done', endedAt: at(2) }), 'explicit')).toBe(true);
    expect(readyToAccept(changes('a', 1, { pullRequests: [{ ...pr, state: 'draft' }] }), 'explicit')).toBe(true);
    // Still at work, asking for something, led by an orchestrator that takes its changes, or with nothing open.
    expect(readyToAccept(changes('a', 1, { state: 'running' }), 'explicit')).toBe(false);
    expect(readyToAccept(changes('a', 1, { ask: { ...ask, askedAt: at(1) } }), 'explicit')).toBe(false);
    expect(readyToAccept(changes('a', 1, { ledBy: 'lead' }), 'explicit')).toBe(false);
    expect(readyToAccept(changes('a', 1, { pullRequests: [{ ...pr, state: 'merged' }] }), 'explicit')).toBe(false);
    // Not a branch of its own to merge: a folder of the user's, or one outside git.
    expect(readyToAccept(changes('a', 1, { ownsWorktree: false }), 'explicit')).toBe(false);
    expect(readyToAccept(changes('a', 1, { plainFolder: true }), 'explicit')).toBe(false);
  });

  it('still accepts when the moment is up only if nothing changed: still ready, no new turn since the click', () => {
    const clicked = changes('a', 1);
    expect(stillReadyToAccept(clicked, changes('a', 1), 'explicit')).toBe(true);
    // The user sent it more work: it is at it, or it has already finished that turn, or it ended, or it went.
    expect(stillReadyToAccept(clicked, changes('a', 1, { state: 'running' }), 'explicit')).toBe(false);
    expect(stillReadyToAccept(clicked, changes('a', 1, { finishedAt: at(3) }), 'explicit')).toBe(false);
    expect(stillReadyToAccept(clicked, changes('a', 1, { ask: { ...ask, askedAt: at(2) } }), 'explicit')).toBe(false);
    expect(stillReadyToAccept(clicked, undefined, 'explicit')).toBe(false);
  });

  it('lists an agent once, under what it asks for before its changes or its problem', () => {
    expect(ids([changes('a', 1, { ask: { ...ask, askedAt: at(3) } })])).toEqual([['Reaching out to you', ['a:asks']]]);
    expect(ids([agent('b', 'rate-limited', { pullRequests: [{ ...pr }] })])).toEqual([['Problems', ['b:problem']]]);
  });
});

describe("a permission prompt's one timer line", () => {
  const now = Date.parse('2026-10-09T10:00:00.000Z');
  const heldFor = (ms: number): PermissionPrompt => ({ ...prompt, heldUntil: new Date(now + ms).toISOString() });

  it('says how long the inbox has before the agent waits in its own window, in seconds, then in minutes', () => {
    expect(permissionWaitLine(heldFor(14_200), 'Write docs', now)).toBe("If you don't answer within 15 seconds, it waits for you in Write docs.");
    expect(permissionWaitLine(heldFor(1_000), 'Write docs', now)).toBe("If you don't answer within 1 second, it waits for you in Write docs.");
    expect(permissionWaitLine(heldFor(90_000), 'Write docs', now)).toBe("If you don't answer within 2 minutes, it waits for you in Write docs.");
  });

  it('says it waits there once the hold is over, and that its terminal asks too where the harness asks at once', () => {
    expect(permissionWaitLine(heldFor(-1), 'Write docs', now)).toBe('It waits for you in Write docs.');
    expect(permissionWaitLine({ ...heldFor(14_000), asksInTerminal: true }, 'Write docs', now)).toBe('Its terminal asks too.');
  });
});

describe('tool summaries', () => {
  it("shows a shell call's command, a file tool's path, and anything else as JSON", () => {
    expect(toolSummary({ ...prompt, toolInput: { command: 'rm -rf dist', description: 'Remove build output' } })).toBe(
      'rm -rf dist',
    );
    expect(toolSummary({ ...prompt, toolName: 'Write', toolInput: { file_path: '/tmp/a.ts', content: 'x' } })).toBe('/tmp/a.ts');
    expect(toolSummary({ ...prompt, toolName: 'WebFetch', toolInput: { url: 'https://example.com' } })).toBe(
      '{"url":"https://example.com"}',
    );
    expect(toolSummary({ ...prompt, toolInput: null })).toBe('');
  });

  it('cuts a long summary short', () => {
    const summary = toolSummary({ ...prompt, toolInput: { command: 'x'.repeat(1_000) } });
    expect(summary.length).toBeLessThanOrEqual(300);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe("Claude's question tool in the inbox", () => {
  const questions: PermissionPrompt = {
    ...lapsed,
    id: 'p3',
    toolName: 'AskUserQuestion',
    asksInTerminal: true,
    questions: [{ question: 'Which cache?', header: 'Cache', options: [{ label: 'Redis', description: '' }, { label: 'In memory', description: '' }], multiSelect: false }],
  };

  it('sums its call up as its questions and their options, not its input', () => {
    expect(toolSummary(questions)).toBe('Which cache? (Redis · In memory)');
  });

  it('lists the agent as asking you, since its call came', () => {
    const asking = agent('questions', 'waiting', { permissions: [questions] });
    expect(needsYouEntries([asking], 'explicit').map(({ kind, since }) => [kind, since])).toEqual([['asks', questions.requestedAt]]);
  });
});

describe('how long a question or plan still waits', () => {
  const at = Date.parse('2026-10-14T14:00:00.000Z');
  it('says it in minutes, then in seconds, then that it is over', () => {
    expect(waitLeft('2026-10-14T14:28:00.000Z', at)).toBe('28 more minutes');
    expect(waitLeft('2026-10-14T14:01:00.000Z', at)).toBe('1 more minute');
    expect(waitLeft('2026-10-14T14:00:59.000Z', at)).toBe('59 more seconds');
    expect(waitLeft('2026-10-14T14:00:01.000Z', at)).toBe('1 more second');
    expect(waitLeft('2026-10-14T13:59:00.000Z', at)).toBe('no longer');
  });
});

describe('how long ago, and when that next changes', () => {
  const at = '2026-11-03T10:00:00.000Z';
  const after = (ms: number) => Date.parse(at) + ms;

  it('changes at each whole minute since, and never between them', () => {
    expect(sinceTextChangesIn(at, after(0))).toBe(60_000);
    expect(sinceTextChangesIn(at, after(59_000))).toBe(1_000);
    expect(sinceTextChangesIn(at, after(60_000))).toBe(60_000);
    expect(sinceTextChangesIn(at, after(185_500))).toBe(54_500);
    for (const elapsed of [0, 30_000, 59_999, 60_000, 61_000, 3_599_000, 3_600_000, 90_061_000]) {
      const next = sinceTextChangesIn(at, after(elapsed));
      expect(sinceText(at, after(elapsed + next - 1))).toBe(sinceText(at, after(elapsed)));
    }
  });

  it('waits for the moment itself first when it is still to come, as a clock behind the daemon sees it', () => {
    expect(sinceTextChangesIn(at, after(-5_000))).toBe(65_000);
  });

  it('looks again in a minute when the moment does not parse, never at once', () => {
    expect(sinceTextChangesIn('not a time', after(0))).toBe(60_000);
  });
});

describe('the clock behind a "how long ago" line', () => {
  const at = '2026-11-03T10:00:00.000Z';

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ticks at once, then at each whole minute since the moment, and not on the seconds between', () => {
    vi.useFakeTimers({ now: Date.parse(at) + 20_000 });
    const ticks: number[] = [];
    const stop = startSinceClock(at, (now) => ticks.push(now - Date.parse(at)));

    expect(ticks).toEqual([20_000]);
    vi.advanceTimersByTime(39_999);
    expect(ticks).toEqual([20_000]);
    vi.advanceTimersByTime(1);
    expect(ticks).toEqual([20_000, 60_000]);
    vi.advanceTimersByTime(120_000);
    expect(ticks).toEqual([20_000, 60_000, 120_000, 180_000]);

    stop();
    vi.advanceTimersByTime(600_000);
    expect(ticks).toHaveLength(4);
  });

  it('ticks once a minute for a moment that does not parse', () => {
    vi.useFakeTimers({ now: Date.parse(at) });
    let ticks = 0;
    const stop = startSinceClock('not a time', () => ticks++);
    vi.advanceTimersByTime(60_000 * 3);
    stop();
    expect(ticks).toBe(4);
  });
});


describe('a steps wait in words', () => {
  const wait = (kind: 'steps' | 'todo', open: number, stepId = 's1') => ({ kind, itemId: 'card-1', title: 'Release 1.4', stepId, text: 'Rotate the key', open, since: '' });

  it('leads with how many questions are left, in the singular and plural, or the to-do waited on', () => {
    expect(stepsWaitLine(wait('steps', 2))).toBe('2 questions for you · “Release 1.4”');
    expect(stepsWaitLine(wait('steps', 1))).toBe('1 question for you · “Release 1.4”');
    expect(stepsWaitLine(wait('steps', 0))).toBe('Every answer in, ready to send · “Release 1.4”');
    expect(stepsWaitLine(wait('todo', 0))).toBe('Waits on your to-do: Rotate the key');
    expect(stepsLeftWords({ open: 3 })).toBe('3 questions for you');
  });

  it("names a set by its card, whatever question it is on, and a to-do by its step", () => {
    expect(stepsWaitKey(wait('steps', 2, 's1'))).toBe(stepsWaitKey(wait('steps', 1, 's2')));
    expect(stepsWaitKey(wait('todo', 0, 's1'))).not.toBe(stepsWaitKey(wait('todo', 0, 's2')));
    expect(stepsWaitKey(wait('steps', 2))).not.toBe(stepsWaitKey(wait('todo', 0)));
  });
});
