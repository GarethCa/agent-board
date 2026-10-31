import { describe, expect, it } from 'vitest';
import type { Agent, AgentFlag, AgentState, PermissionPrompt } from '@agent-board/daemon/protocol';
import { createAgentAlerts, DEFAULT_ALERT_SETTINGS, type AgentAlerts, type AgentNotification, type AlertSettings } from './alerts';
import type { AppStatus } from './app-state';

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
  name: `Agent ${sessionId}`,
  description: '',
  branch: sessionId,
  ownedBranch: sessionId,
  detached: false,
  worktree: `/tmp/${sessionId}`,
  cwd: `/tmp/${sessionId}`,
  state,
  createdAt: '2026-10-10T10:00:00.000Z',
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
  requestedAt: '2026-10-10T10:00:00.000Z',
  heldUntil: '2026-10-10T10:00:20.000Z',
};

/** As before explicit requests: Needs you lists every finished turn too. */
const TURNS: AlertSettings = { ...DEFAULT_ALERT_SETTINGS, needsYouShows: 'turns' };

/** Alerts under `settings` (Needs you listing every finished turn, by default), recording what they notify and every app state they show. */
function recorded(settings: AlertSettings = TURNS, inFront = false) {
  const notifications: AgentNotification[] = [];
  const states: AppStatus[] = [];
  const created = createAgentAlerts({ notify: (n) => notifications.push(n), showState: (s) => states.push(s), inFront: () => inFront });
  // A listing comes with the settings, as `followAgents` reads them.
  const alerts: AgentAlerts = { ...created, reset: (agents, given = settings) => created.reset(agents, given) };
  return { alerts, notifications, states };
}

let flagIds = 0;
const flag = (at: string, via: string | null = null, id = ++flagIds): AgentFlag => ({ id, reason: 'PR #241 is ready for review.', at, to: 'user', via });

describe('agent notifications for explicit requests only, the default', () => {
  it('stays quiet as a turn ends, and notifies once per flag, with its reason', () => {
    const { alerts, notifications } = recorded(DEFAULT_ALERT_SETTINGS);
    alerts.reset([agent('a', 'running'), agent('b', 'running')]);

    alerts.updated(agent('a', 'waiting', { lastMessage: 'Done.' }));
    const first = flag('2026-10-10T10:01:00.000Z');
    alerts.updated(agent('b', 'running', { flag: first }));
    alerts.updated(agent('b', 'idle', { flag: first }));
    alerts.updated(agent('b', 'idle', { flag: flag('2026-10-10T10:02:00.000Z', 'Fix checkout flake') }));

    expect(notifications).toEqual([
      { sessionId: 'b', title: 'Agent b needs you', body: 'PR #241 is ready for review.' },
      { sessionId: 'b', title: 'Agent b needs you', body: 'PR #241 is ready for review. (via Fix checkout flake)' },
    ]);
  });

  it('notifies of a standing flag once, however many prompts and questions come and go while it stands', () => {
    const { alerts, notifications } = recorded(DEFAULT_ALERT_SETTINGS);
    alerts.reset([agent('a', 'running')]);
    const standing = flag('2026-10-10T10:01:00.000Z');
    const ask = { id: 'q1', question: 'Redis?', options: [], freeText: true, askedAt: '', expiresAt: '', onBoard: false, at: null };

    alerts.updated(agent('a', 'running', { flag: standing }));
    alerts.updated(agent('a', 'needs-permission', { flag: standing, permissions: [prompt] }));
    alerts.updated(agent('a', 'running', { flag: standing }));
    alerts.updated(agent('a', 'waiting', { flag: standing, ask }));
    alerts.updated(agent('a', 'idle', { flag: standing }));

    expect(notifications.map((n) => n.title)).toEqual(['Agent a needs you', 'Agent a needs your permission', 'Agent a asks you']);
  });

  it('notifies of a flag raised while a question waits, and of the same reason raised again', () => {
    const { alerts, notifications } = recorded(DEFAULT_ALERT_SETTINGS);
    const ask = { id: 'q1', question: 'Redis?', options: [], freeText: true, askedAt: '', expiresAt: '', onBoard: false, at: null };
    alerts.reset([agent('a', 'waiting', { ask })]);
    alerts.updated(agent('a', 'waiting', { ask, flag: flag('2026-10-10T10:01:00.000Z', null, 7) }));
    alerts.updated(agent('a', 'waiting', { ask }));
    alerts.updated(agent('a', 'waiting', { ask, flag: flag('2026-10-10T10:01:00.000Z', null, 8) }));
    expect(notifications.map((n) => n.title)).toEqual(['Agent a needs you', 'Agent a needs you']);
  });

  it("never notifies of a crew member's flag to its orchestrator, a failure or an end", () => {
    const { alerts, notifications } = recorded(DEFAULT_ALERT_SETTINGS);
    alerts.reset([agent('a', 'running', { spawnedBy: 'lead' }), agent('b', 'running'), agent('c', 'running')]);

    alerts.updated(agent('a', 'idle', { spawnedBy: 'lead', flag: { ...flag('2026-10-10T10:01:00.000Z'), to: 'orchestrator' } }));
    alerts.updated(agent('b', 'failed'));
    alerts.updated(agent('c', 'done', { endedAt: '2026-10-10T10:05:00.000Z' }));

    expect(notifications).toEqual([]);
  });

  it('notifies of a permission prompt or a question, whoever started the agent', () => {
    const { alerts, notifications } = recorded(DEFAULT_ALERT_SETTINGS);
    alerts.reset([agent('a', 'running', { spawnedBy: 'lead' })]);
    alerts.updated(agent('a', 'needs-permission', { spawnedBy: 'lead', permissions: [prompt] }));
    expect(notifications.map((n) => n.title)).toEqual(['Agent a needs your permission']);
  });

  it('raises none with notifications off, and none while the app is in front unless asked', () => {
    for (const [settings, inFront, expected] of [
      [{ ...DEFAULT_ALERT_SETTINGS, notifications: false }, false, 0],
      [DEFAULT_ALERT_SETTINGS, true, 0],
      [{ ...DEFAULT_ALERT_SETTINGS, notifyInFront: true }, true, 1],
    ] as const) {
      const { alerts, notifications, states } = recorded(settings, inFront);
      alerts.reset([agent('a', 'running')]);
      alerts.updated(agent('a', 'idle', { flag: flag('2026-10-10T10:01:00.000Z') }));
      expect(notifications).toHaveLength(expected);
      // The badge counts it all the same.
      expect(states.at(-1)).toEqual({ state: 'needs', waiting: 1 });
    }
  });

  it('recounts the badge when the setting changes what Needs you lists', () => {
    const { alerts, states } = recorded(DEFAULT_ALERT_SETTINGS);
    alerts.reset([agent('a', 'waiting')]);
    alerts.settingsChanged(TURNS);
    expect(states).toEqual([
      { state: 'quiet', waiting: 0 },
      { state: 'needs', waiting: 1 },
    ]);
  });
});

describe('agent notifications for every finished turn too', () => {
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

  it('notifies when it needs permission, with what it wants', () => {
    const { alerts, notifications } = recorded();
    alerts.reset([agent('a', 'running')]);

    alerts.updated(agent('a', 'needs-permission', { permissions: [prompt] }));

    expect(notifications).toEqual([{ sessionId: 'a', title: 'Agent a needs your permission', body: 'Bash: rm -rf dist' }]);
  });

  it('says something when the agent left no message', () => {
    const { alerts, notifications } = recorded();
    alerts.reset([agent('a', 'running')]);

    alerts.updated(agent('a', 'waiting'));

    expect(notifications.map((n) => n.body)).toEqual(['It is waiting for your answer.']);
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
    const ask = { id: 'q1', question: 'Which cache should the product pages use?', options: ['Redis', 'CDN only'], freeText: false, askedAt: '', expiresAt: '', onBoard: false, at: null };
    const plan = { id: 'p1', version: 2, title: 'Cache product pages in Redis', format: 'markdown' as const, presentedAt: '', expiresAt: '2026-10-23T19:00:00.000Z', decision: null, left: false, author: 'agent' as const, path: null };

    alerts.updated(agent('a', 'waiting', { ask }));
    alerts.updated(agent('a', 'waiting', { plan }));
    // The user's own edit of it is the same request.
    alerts.updated(agent('a', 'waiting', { plan: { ...plan, id: 'p2', version: 3, author: 'user' } }));
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
