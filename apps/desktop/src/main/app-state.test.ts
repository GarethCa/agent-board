import { describe, expect, it } from 'vitest';
import type { Agent, AgentState } from '@agent-board/daemon/protocol';
import { appIndicator, appStateOf } from './app-state';

const agent = (sessionId: string, state: AgentState, fields: Partial<Agent> = {}): Agent =>
  ({ sessionId, name: `Agent ${sessionId}`, state, endedAt: null, permissions: [], ...fields }) as Agent;

describe('appStateOf', () => {
  it('is needs while any agent waits for input or permission, counting each waiting agent', () => {
    const agents = [agent('a', 'waiting'), agent('b', 'needs-permission'), agent('c', 'running')];
    expect(appStateOf(agents)).toEqual({ state: 'needs', waiting: 2 });
  });

  it('counts a pending permission prompt as waiting, whatever the state', () => {
    const asking = agent('a', 'running', {
      permissions: [{ id: 'p', toolName: 'Bash', toolInput: {}, subagent: null, requestedAt: '', heldUntil: null }],
    });
    expect(appStateOf([asking])).toEqual({ state: 'needs', waiting: 1 });
  });

  it('is working while an agent is mid-turn and none waits', () => {
    for (const state of ['running', 'thinking', 'rate-limited', 'handing-off'] as const) {
      expect(appStateOf([agent('a', 'idle'), agent('b', state)])).toEqual({ state: 'working', waiting: 0 });
    }
  });

  it('is quiet when nothing runs: idle, scheduled, ended or no agents at all', () => {
    expect(appStateOf([])).toEqual({ state: 'quiet', waiting: 0 });
    const resting = ['idle', 'scheduled', 'done', 'failed', 'stopped-by-restart'] as const;
    expect(appStateOf(resting.map((state, i) => agent(String(i), state)))).toEqual({ state: 'quiet', waiting: 0 });
  });

  it('leaves a seen ask out: quiet and not counted, until the agent asks again', () => {
    expect(appStateOf([agent('a', 'waiting', { seen: true })])).toEqual({ state: 'quiet', waiting: 0 });
    expect(appStateOf([agent('a', 'waiting', { seen: true }), agent('b', 'needs-permission')])).toEqual({ state: 'needs', waiting: 1 });
    expect(appStateOf([agent('a', 'waiting', { seen: true }), agent('b', 'running')])).toEqual({ state: 'working', waiting: 0 });
    expect(appStateOf([agent('a', 'waiting', { seen: false })])).toEqual({ state: 'needs', waiting: 1 });
  });

  it('ignores an ended agent, whatever state it was left in', () => {
    expect(appStateOf([agent('a', 'waiting', { endedAt: '2026-10-12T10:00:00.000Z' })])).toEqual({ state: 'quiet', waiting: 0 });
    expect(appStateOf([agent('a', 'running', { endedAt: '2026-10-12T10:00:00.000Z' })])).toEqual({ state: 'quiet', waiting: 0 });
  });
});

describe('appIndicator', () => {
  it('needs: the needs dock icon, the waiting count on the badge, and the menu-bar dot', () => {
    expect(appIndicator({ state: 'needs', waiting: 3 }, 'blue')).toEqual({
      dockIcon: 'dock-blue-needs',
      badge: 3,
      menuBarDot: true,
      tooltip: 'agent-board: 3 agents need you',
    });
    expect(appIndicator({ state: 'needs', waiting: 1 }, 'blue').tooltip).toBe('agent-board: 1 agent needs you');
  });

  it('working: the working dock icon, no badge and no dot', () => {
    expect(appIndicator({ state: 'working', waiting: 0 }, 'blue')).toEqual({
      dockIcon: 'dock-blue-working',
      badge: 0,
      menuBarDot: false,
      tooltip: 'agent-board: agents working',
    });
  });

  it('quiet: the quiet dock icon, no badge and no dot', () => {
    expect(appIndicator({ state: 'quiet', waiting: 0 }, 'blue')).toEqual({
      dockIcon: 'dock-blue-quiet',
      badge: 0,
      menuBarDot: false,
      tooltip: 'agent-board: nothing running',
    });
  });

  it('takes the dark colourway in dark mode', () => {
    expect(appIndicator({ state: 'needs', waiting: 1 }, 'dark').dockIcon).toBe('dock-dark-needs');
    expect(appIndicator({ state: 'working', waiting: 0 }, 'dark').dockIcon).toBe('dock-dark-working');
    expect(appIndicator({ state: 'quiet', waiting: 0 }, 'dark').dockIcon).toBe('dock-dark-quiet');
  });
});
