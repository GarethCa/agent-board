import { describe, expect, it } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import { galleryAgent } from './TileGallery';
import { asleep, endedAs, frostedClasses, frozenChip, frozenKind, PAUSE_HINT, pauseControl, pausedLine, WAKE_ENDED_HINT, WAKE_HINT, WAKE_NOW_HINT, wakeAct, wakeLabel } from './paused';

const idle: Pick<Agent, 'endedAt' | 'state' | 'ask' | 'removeAsk' | 'plan' | 'permissions'> = { endedAt: null, state: 'idle', ask: null, removeAsk: null, plan: null, permissions: [] };

describe('pauseControl', () => {
  it('offers Pause for a live agent between turns, and Wake for a paused one', () => {
    expect(pauseControl(idle)).toEqual({ action: 'pause', enabled: true, hint: PAUSE_HINT });
    expect(pauseControl({ ...idle, state: 'waiting' })).toMatchObject({ action: 'pause', enabled: true });
    expect(pauseControl({ ...idle, state: 'hibernated', endedAt: '2026-10-23T08:00:00Z' })).toEqual({ action: 'wake', enabled: true, hint: WAKE_HINT });
  });

  it('offers the same Wake for an agent a restart stopped', () => {
    expect(pauseControl({ ...idle, state: 'stopped-by-restart', endedAt: '2026-10-23T08:00:00Z' })).toEqual({ action: 'wake', enabled: true, hint: WAKE_HINT });
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

describe('the frost', () => {
  const ENDED = '2026-10-23T08:00:00Z';
  const clock = { clockId: 'c', cron: '30 22 * * *', prompt: 'Sweep', enabled: true, nextRunAt: '2026-10-23T22:30:00Z', lastRun: null, hibernates: false };
  const agent = (fields: Partial<Agent>): Agent => ({ ...galleryAgent('idle'), pullRequests: [], ...fields });
  const cases: [string, Agent, ReturnType<typeof frozenKind>][] = [
    ['paused', agent({ state: 'hibernated', endedAt: ENDED }), 'paused'],
    ['restart-stopped', agent({ state: 'stopped-by-restart', endedAt: ENDED }), 'paused'],
    ['restart-stopped, its clock on (it asks to be woken)', agent({ state: 'stopped-by-restart', endedAt: ENDED, schedule: clock }), 'paused'],
    ['at its prompt for its next run', agent({ state: 'scheduled', schedule: clock }), 'scheduled'],
    ['paused, its clock on', agent({ state: 'hibernated', endedAt: ENDED, schedule: clock }), 'scheduled'],
    ['done, its clock on', agent({ state: 'done', endedAt: ENDED, schedule: clock }), 'scheduled'],
    ['exited, its clock on', agent({ state: 'failed', endedAt: ENDED, exitCode: 1, schedule: clock }), 'scheduled'],
    ['paused, its clock off', agent({ state: 'hibernated', endedAt: ENDED, schedule: { ...clock, enabled: false } }), 'paused'],
    ['done', agent({ state: 'done', endedAt: ENDED }), 'done'],
    ['ended in another state, closed by hand', agent({ state: 'idle', endedAt: ENDED }), 'done'],
    ['an ended reviewer, its clock on', agent({ state: 'done', endedAt: ENDED, reviewOf: 'impl', schedule: clock }), 'done'],
    ['exited with code 1', agent({ state: 'failed', endedAt: ENDED, exitCode: 1 }), 'exited'],
    ['exited with code 0', agent({ state: 'failed', endedAt: ENDED, exitCode: 0 }), 'exited'],
    ['exited with no code', agent({ state: 'failed', endedAt: ENDED }), 'exited'],
    ['failed while live (a turn failed)', agent({ state: 'failed' }), undefined],
    ['at work', agent({ state: 'running' }), undefined],
    ['idle', agent({ state: 'idle' }), undefined],
    ['at its prompt, its clock off', agent({ state: 'scheduled', schedule: { ...clock, enabled: false } }), undefined],
    // Needing you stays bright and raised: never frozen.
    ['done, its changes open for review', agent({ state: 'done', endedAt: ENDED, pullRequests: [{ number: 4, title: 'Fix', url: '', state: 'open', checks: 'passing' }] }), undefined],
    ['done, a merged pull request', agent({ state: 'done', endedAt: ENDED, pullRequests: [{ number: 4, title: 'Fix', url: '', state: 'merged', checks: 'passing' }] }), 'done'],
    ['ended, flagging you', agent({ state: 'done', endedAt: ENDED, flag: { to: 'user', reason: 'Look', at: ENDED } as Agent['flag'] }), undefined],
    ['exited, flagging you', agent({ state: 'failed', endedAt: ENDED, exitCode: 1, flag: { to: 'user', reason: 'Look', at: ENDED } as Agent['flag'] }), undefined],
    ['at its prompt for its clock, flagging you', agent({ state: 'scheduled', schedule: clock, flag: { to: 'user', reason: 'Look', at: ENDED } as Agent['flag'] }), undefined],
    // Asleep, it keeps its frost even waiting on you: the frost says it.
    ['paused, flagging you', agent({ state: 'hibernated', endedAt: ENDED, flag: { to: 'user', reason: 'Look', at: ENDED } as Agent['flag'] }), 'paused'],
    ['restart-stopped, flagging you', agent({ state: 'stopped-by-restart', endedAt: ENDED, flag: { to: 'user', reason: 'Look', at: ENDED } as Agent['flag'] }), 'paused'],
    ['paused, its clock on, flagging you (stays Scheduled)', agent({ state: 'hibernated', endedAt: ENDED, schedule: clock, flag: { to: 'user', reason: 'Look', at: ENDED } as Agent['flag'] }), 'scheduled'],
    // A failed start is a problem with Try again, not a frozen agent.
    ['a failed start', agent({ state: 'failed', endedAt: ENDED, exitCode: 1, startup: { failed: true, output: 'claude: not found' } as Agent['startup'] }), undefined],
  ];

  it.each(cases)('%s', (_name, each, kind) => {
    expect(frozenKind(each, 'explicit')).toBe(kind);
    expect(frostedClasses('tile', each, 'explicit')).toBe(kind === undefined ? 'tile' : `tile tile-frosted tile-frost-${kind}`);
  });

  it('calls only a paused or restart-stopped agent asleep', () => {
    for (const state of ['idle', 'running', 'done', 'failed', 'scheduled'] as const) expect(asleep({ state })).toBe(false);
    for (const state of ['hibernated', 'stopped-by-restart'] as const) expect(asleep({ state })).toBe(true);
  });
});

describe('the frozen chip', () => {
  const ENDED = '2026-10-23T18:02:00';
  const NOW = Date.parse('2026-10-23T19:00:00');
  const clock = { clockId: 'c', cron: '30 22 * * *', prompt: 'Sweep', enabled: true, nextRunAt: '2026-10-23T22:30:00', lastRun: null, hibernates: false };
  const agent = (fields: Partial<Agent>): Agent => ({ ...galleryAgent('idle'), pullRequests: [], ...fields });

  it('says when a scheduled agent wakes', () => {
    expect(frozenChip(agent({ state: 'scheduled', schedule: clock }), 'explicit', NOW)).toBe('Scheduled · wakes 22:30');
    expect(frozenChip(agent({ state: 'failed', endedAt: ENDED, exitCode: 1, schedule: { ...clock, nextRunAt: '2026-10-24T09:00:00' } }), 'explicit', NOW)).toBe('Scheduled · wakes tomorrow 09:00');
  });

  it('says when a done agent finished, and when an exited one hit its error', () => {
    expect(frozenChip(agent({ state: 'done', endedAt: ENDED }), 'explicit', NOW)).toBe('Done · finished 18:02');
    expect(frozenChip(agent({ state: 'failed', endedAt: ENDED, exitCode: 1 }), 'explicit', NOW)).toBe('Exited · error 18:02');
    expect(frozenChip(agent({ state: 'failed', endedAt: ENDED, exitCode: 0 }), 'explicit', NOW)).toBe('Exited · error 18:02');
  });

  it('says Paused or Stopped for one asleep, and nothing while it is live', () => {
    expect(frozenChip(agent({ state: 'hibernated', endedAt: ENDED }), 'explicit', NOW)).toBe('Paused');
    expect(frozenChip(agent({ state: 'stopped-by-restart', endedAt: ENDED }), 'explicit', NOW)).toBe('Stopped by a restart');
    expect(frozenChip(agent({ state: 'running' }), 'explicit', NOW)).toBeUndefined();
  });
});

describe('what Wake does', () => {
  const ENDED = '2026-10-23T08:00:00Z';
  const clock = { clockId: 'c', cron: '30 22 * * *', prompt: 'Sweep', enabled: true, nextRunAt: '2026-10-23T22:30:00Z', lastRun: null, hibernates: false };
  type WakeFields = Parameters<typeof wakeAct>[0];
  const agent = (fields: Partial<WakeFields>): WakeFields => ({ endedAt: null, state: 'idle', reviewOf: null, shellHarness: null, schedule: null, ...fields });
  const cases: [string, WakeFields, ReturnType<typeof wakeAct>, ReturnType<typeof endedAs>][] = [
    ['paused', agent({ state: 'hibernated', endedAt: ENDED }), 'resume', undefined],
    ['restart-stopped', agent({ state: 'stopped-by-restart', endedAt: ENDED }), 'resume', undefined],
    ['scheduled', agent({ state: 'scheduled', schedule: clock }), 'run-now', undefined],
    ['paused by its clock between runs', agent({ state: 'hibernated', endedAt: ENDED, schedule: { ...clock, hibernates: true } }), 'run-now', undefined],
    ['done, its clock on', agent({ state: 'done', endedAt: ENDED, schedule: clock }), 'run-now', 'done'],
    ['an ended reviewer, its clock on', agent({ state: 'done', endedAt: ENDED, reviewOf: 'impl', schedule: clock }), undefined, 'done'],
    ['restart-stopped, its clock on', agent({ state: 'stopped-by-restart', endedAt: ENDED, schedule: clock }), 'resume', undefined],
    ['scheduled, no next time', agent({ state: 'scheduled', schedule: { ...clock, nextRunAt: null } }), undefined, undefined],
    ['scheduled, its clock off', agent({ state: 'scheduled', schedule: { ...clock, enabled: false } }), undefined, undefined],
    ['done', agent({ state: 'done', endedAt: ENDED }), 'restart', 'done'],
    ['exited', agent({ state: 'failed', endedAt: ENDED }), 'restart', 'exited'],
    ['an ended reviewer', agent({ state: 'done', endedAt: ENDED, reviewOf: 'impl' }), undefined, 'done'],
    ['a harness in its shell', agent({ state: 'done', endedAt: ENDED, shellHarness: 'claude' }), undefined, 'done'],
    ['at work', agent({ state: 'running' }), undefined, undefined],
    ['failed while live', agent({ state: 'failed' }), undefined, undefined],
  ];

  it.each(cases)('%s', (_name, each, act, ended) => {
    expect(wakeAct(each)).toBe(act);
    expect(endedAs(each)).toBe(ended);
  });

  it('reads Wake now for one its clock wakes, else Wake, each with what it does', () => {
    expect(wakeLabel('run-now')).toEqual({ label: 'Wake now', hint: WAKE_NOW_HINT });
    expect(wakeLabel('restart')).toEqual({ label: 'Wake', hint: WAKE_ENDED_HINT });
    expect(wakeLabel('resume')).toEqual({ label: 'Wake', hint: WAKE_HINT });
  });
});
