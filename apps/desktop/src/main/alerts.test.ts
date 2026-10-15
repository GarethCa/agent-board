import { describe, expect, it } from 'vitest';
import type { Agent, AgentState, PermissionPrompt } from '@agent-board/daemon/protocol';
import { createAgentAlerts, type AgentNotification } from './alerts';
import type { AppStatus } from './app-state';

const agent = (sessionId: string, state: AgentState, fields: Partial<Agent> = {}): Agent => ({
  sessionId,
  zoneId: 'z1',
  repoRoot: '/code/app',
  position: null,
  harness: 'claude',
  model: null,
  role: null,
  reviews: null,
  name: `Agent ${sessionId}`,
  description: '',
  branch: sessionId,
  worktree: `/tmp/${sessionId}`,
  cwd: `/tmp/${sessionId}`,
  state,
  createdAt: '2026-10-10T10:00:00.000Z',
  endedAt: null,
  exitCode: null,
  shellSessionId: null,
  shellHarness: null,
  issue: null,
  notice: null,
  muted: false,
  seen: false,
  subagents: [],
  pullRequests: [],
  lastMessage: null,
  permissions: [],
  ask: null,
  plan: null,
  schedule: null,
  reviewOf: null,
  reviewCap: 3,
  ownsWorktree: true,
  orchestrate: null,
  spawnedBy: null,
  status: null,
  ...fields,
});

const prompt: PermissionPrompt = {
  id: 'p1',
  toolName: 'Bash',
  toolInput: { command: 'rm -rf dist' },
  subagent: null,
  requestedAt: '2026-10-10T10:00:00.000Z',
  heldUntil: '2026-10-10T10:00:20.000Z',
};

/** Alerts recording what they notify and every app state they show. */
function recorded() {
  const notifications: AgentNotification[] = [];
  const states: AppStatus[] = [];
  const alerts = createAgentAlerts({ notify: (n) => notifications.push(n), showState: (s) => states.push(s) });
  return { alerts, notifications, states };
}

describe('agent notifications', () => {
  it('notifies once when an agent starts waiting, however often it is updated while it waits', () => {
    const { alerts, notifications } = recorded();
    alerts.reset([agent('a', 'running')]);

    alerts.updated(agent('a', 'waiting', { lastMessage: 'Postgres or SQLite?' }));
    alerts.updated(agent('a', 'waiting', { lastMessage: 'Postgres or SQLite?', pullRequests: [] }));

    expect(notifications).toEqual([{ sessionId: 'a', title: 'Agent a is waiting for you', body: 'Postgres or SQLite?' }]);
  });

  it('notifies again each time it comes back to a state after leaving it', () => {
    const { alerts, notifications } = recorded();
    alerts.reset([agent('a', 'running')]);

    alerts.updated(agent('a', 'waiting'));
    alerts.updated(agent('a', 'thinking'));
    alerts.updated(agent('a', 'waiting'));

    expect(notifications.map((n) => n.title)).toEqual(['Agent a is waiting for you', 'Agent a is waiting for you']);
  });

  it('notifies when it needs permission, fails or is done, with what it wants or why', () => {
    const { alerts, notifications } = recorded();
    alerts.reset([agent('a', 'running'), agent('b', 'running'), agent('c', 'running'), agent('d', 'idle')]);

    alerts.updated(agent('a', 'needs-permission', { permissions: [prompt] }));
    alerts.updated(agent('b', 'failed', { notice: 'agent-board stopped this agent.' }));
    alerts.updated(agent('c', 'failed'));
    alerts.updated(agent('d', 'done', { endedAt: '2026-10-10T10:05:00.000Z', lastMessage: 'Shipped it.' }));

    expect(notifications).toEqual([
      { sessionId: 'a', title: 'Agent a needs your permission', body: 'Bash: rm -rf dist' },
      { sessionId: 'b', title: 'Agent b failed', body: 'agent-board stopped this agent.' },
      { sessionId: 'c', title: 'Agent c failed', body: 'Open it to see what went wrong.' },
      { sessionId: 'd', title: 'Agent d is done', body: 'Shipped it.' },
    ]);
  });

  it('says something when the agent left no message', () => {
    const { alerts, notifications } = recorded();
    alerts.reset([agent('a', 'running'), agent('b', 'idle')]);

    alerts.updated(agent('a', 'waiting'));
    alerts.updated(agent('b', 'done', { endedAt: '2026-10-10T10:05:00.000Z' }));

    expect(notifications.map((n) => n.body)).toEqual(['It is waiting for your answer.', 'Its session has ended.']);
  });

  it("counts a pending permission prompt as needing permission whatever the agent's state says", () => {
    const { alerts, notifications } = recorded();
    alerts.reset([agent('a', 'running')]);

    alerts.updated(agent('a', 'running', { permissions: [{ ...prompt, subagent: { id: 's1', type: 'Explore' } }] }));
    alerts.updated(agent('a', 'needs-permission', { permissions: [prompt] }));

    expect(notifications).toEqual([
      { sessionId: 'a', title: 'Agent a needs your permission', body: 'Its Explore subagent: Bash: rm -rf dist' },
    ]);
  });

  it('says so when the permission is asked in its terminal, with no prompt the inbox knows', () => {
    const { alerts, notifications } = recorded();
    alerts.reset([agent('a', 'running')]);

    alerts.updated(agent('a', 'needs-permission'));

    expect(notifications).toEqual([{ sessionId: 'a', title: 'Agent a needs your permission', body: 'It is asking in its terminal.' }]);
  });

  it('notifies as an agent asks you something or has a plan to review, each a new ask', () => {
    const { alerts, notifications } = recorded();
    alerts.reset([agent('a', 'waiting', { lastMessage: 'Postgres or SQLite?' })]);
    const ask = { id: 'q1', question: 'Which cache should the product pages use?', options: ['Redis', 'CDN only'], freeText: false, askedAt: '', expiresAt: '' };
    const plan = { id: 'p1', version: 2, title: 'Cache product pages in Redis', format: 'markdown' as const, presentedAt: '', expiresAt: '', decision: null };

    alerts.updated(agent('a', 'waiting', { ask }));
    alerts.updated(agent('a', 'waiting', { plan }));
    alerts.updated(agent('a', 'running', { plan: { ...plan, decision: { outcome: 'approved', comments: '', decidedAt: '' } } }));

    expect(notifications).toEqual([
      { sessionId: 'a', title: 'Agent a asks you', body: 'Which cache should the product pages use? (Redis · CDN only)' },
      { sessionId: 'a', title: 'Agent a has a plan to review', body: 'Cache product pages in Redis · v2' },
    ]);
  });

  it('stays quiet while it works, idles or is rate-limited', () => {
    const { alerts, notifications } = recorded();
    alerts.reset([agent('a', 'idle')]);

    for (const state of ['running', 'thinking', 'idle', 'rate-limited'] as const) {
      alerts.updated(agent('a', state));
    }

    expect(notifications).toEqual([]);
  });

  it('stays quiet about the state an agent is in when first heard of, and notifies on changes from there', () => {
    const { alerts, notifications } = recorded();
    alerts.reset([agent('a', 'waiting'), agent('b', 'done', { endedAt: '2026-10-10T10:05:00.000Z' })]);
    alerts.updated(agent('c', 'needs-permission'));
    expect(notifications).toEqual([]);

    alerts.updated(agent('c', 'running'));
    alerts.updated(agent('c', 'waiting'));
    expect(notifications.map((n) => n.sessionId)).toEqual(['c']);
  });

  it('notifies for a change a new listing shows, but not again for one it already notified', () => {
    const { alerts, notifications } = recorded();
    alerts.reset([agent('a', 'running'), agent('b', 'running')]);
    alerts.updated(agent('b', 'waiting'));

    alerts.reset([agent('a', 'waiting'), agent('b', 'waiting')]);

    expect(notifications.map((n) => n.sessionId)).toEqual(['b', 'a']);
  });

  it('never notifies for a muted agent, and picks up again once it is unmuted', () => {
    const { alerts, notifications } = recorded();
    alerts.reset([agent('a', 'running', { muted: true })]);

    alerts.updated(agent('a', 'waiting', { muted: true }));
    alerts.updated(agent('a', 'done', { muted: true, endedAt: '2026-10-10T10:05:00.000Z' }));
    alerts.reset([agent('b', 'running', { muted: true })]);
    alerts.updated(agent('b', 'running'));
    alerts.updated(agent('b', 'waiting'));

    expect(notifications.map((n) => n.sessionId)).toEqual(['b']);
  });
});

describe('the app state', () => {
  it('counts the agents in the needs-you inbox, muted ones too, and follows every change live', () => {
    const { alerts, states } = recorded();
    alerts.reset([agent('a', 'waiting'), agent('b', 'running', { muted: true }), agent('c', 'done')]);
    alerts.updated(agent('b', 'needs-permission', { muted: true }));
    alerts.updated(agent('a', 'waiting', { lastMessage: 'Still there?' }));
    alerts.updated(agent('a', 'running'));
    alerts.removed('b');

    // Shown when it changes only.
    expect(states).toEqual([
      { state: 'needs', waiting: 1 },
      { state: 'needs', waiting: 2 },
      { state: 'needs', waiting: 1 },
      { state: 'working', waiting: 0 },
    ]);
  });

  it('goes quiet once nothing runs', () => {
    const { alerts, states } = recorded();
    alerts.reset([agent('a', 'running')]);
    alerts.updated(agent('a', 'thinking'));
    alerts.updated(agent('a', 'idle'));

    expect(states).toEqual([
      { state: 'working', waiting: 0 },
      { state: 'quiet', waiting: 0 },
    ]);
  });

  it('leaves ended agents out, whatever state they ended in', () => {
    const { alerts, states } = recorded();
    alerts.reset([agent('a', 'waiting', { endedAt: '2026-10-10T10:05:00.000Z' })]);

    expect(states).toEqual([{ state: 'quiet', waiting: 0 }]);
  });

  it('forgets a removed agent, so it is new again if it comes back', () => {
    const { alerts, notifications } = recorded();
    alerts.reset([agent('a', 'running')]);
    alerts.removed('a');

    alerts.updated(agent('a', 'waiting'));

    expect(notifications).toEqual([]);
  });
});
