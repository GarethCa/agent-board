import { describe, expect, it } from 'vitest';
import type { Agent, AgentAsk, AgentFlag, AgentState, PermissionPrompt } from '@agent-board/daemon/protocol';
import { heldPrompts, needsYou, needsYouEntries, secondsLeft, toolSummary, unseenCount, waitLeft } from './needs-you';

const agent = (sessionId: string, state: AgentState, fields: Partial<Agent> = {}): Agent => ({
  sessionId,
  zoneId: 'z1',
  repoRoot: '/code/app',
  position: null,
  harness: 'claude',
  model: null,
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
  lastMessage: null,
  compactingSince: null,
  finishedAt: null,
  permissions: [],
  ask: null,
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
  startup: null,
  unsent: null,
  untypedPrompt: null,
  trustFolder: null,
  trustedByZone: false,
  queuedUntilUp: 0,
  messagesWaiting: 0,
  undelivered: [],
  status: null,
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
  at: null,
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
