import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { PAUSE_HINT, pauseControl, pausedLine, WAKE_HINT } from './paused';

const idle: Pick<Agent, 'endedAt' | 'state' | 'ask' | 'plan' | 'permissions'> = { endedAt: null, state: 'idle', ask: null, plan: null, permissions: [] };

describe('pauseControl', () => {
  it('offers Pause for a live agent between turns, and Wake for a paused one', () => {
    expect(pauseControl(idle)).toEqual({ action: 'pause', enabled: true, hint: PAUSE_HINT });
    expect(pauseControl({ ...idle, state: 'waiting' })).toMatchObject({ action: 'pause', enabled: true });
    expect(pauseControl({ ...idle, state: 'hibernated', endedAt: '2026-10-23T08:00:00Z' })).toEqual({ action: 'wake', enabled: true, hint: WAKE_HINT });
  });

  it('greys Pause out with why while the agent is mid-turn, on a command or waiting on you, and offers neither once it has ended', () => {
    expect(pauseControl({ ...idle, state: 'running' })).toEqual({ action: 'pause', enabled: false, hint: 'It is mid-turn: finish its turn first' });
    expect(pauseControl({ ...idle, state: 'on-command' })).toMatchObject({ enabled: false, hint: 'A command it left running still runs' });
    expect(pauseControl({ ...idle, state: 'needs-permission' })).toMatchObject({ enabled: false, hint: 'It is waiting on you' });
    expect(pauseControl({ ...idle, state: 'waiting', ask: { question: 'Which?' } as Agent['ask'] })).toMatchObject({ enabled: false, hint: 'It is waiting on you' });
    expect(pauseControl({ ...idle, state: 'done', endedAt: '2026-10-23T08:00:00Z' })).toBeUndefined();
  });
});

describe('pausedLine', () => {
  const at = '2026-10-23T08:00:00.000Z';
  it('says who paused it and how long ago', () => {
    expect(pausedLine({ at, by: 'Release lead', byId: 'lead' }, Date.parse(at) + 14 * 60_000)).toEqual({ who: 'paused by Release lead', when: ' · 14 min ago' });
    expect(pausedLine({ at, by: null, byId: null }, Date.parse(at))).toEqual({ who: 'paused by you', when: ' · just now' });
  });
});
