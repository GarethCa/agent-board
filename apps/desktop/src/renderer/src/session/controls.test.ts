import { describe, expect, it } from 'vitest';
import type { Agent, AgentState } from '@agent-board/daemon/protocol';
import { leadControl, sessionControls, type ControlId } from './controls';

function agent(state: AgentState, endedAt: string | null = null, fields: Partial<Agent> = {}): Agent {
  return { state, endedAt, ask: null, plan: null, permissions: [], ...fields } as Agent;
}

const enabled = (controls: ReturnType<typeof sessionControls>) =>
  controls.filter((control) => control.enabled).map((control) => control.id);

describe('session window controls', () => {
  it('lists only controls that work: interrupt, pause and stop, in order', () => {
    const controls = sessionControls({ agent: agent('running'), live: true });

    expect(controls.map((control) => control.id)).toEqual<ControlId[]>(['interrupt', 'pause', 'stop']);
    expect(controls.some((control) => /not built yet/i.test(control.hint))).toBe(false);
  });

  it.each<AgentState>(['running', 'thinking', 'needs-permission'])('interrupts and stops an agent that is %s', (state) => {
    expect(enabled(sessionControls({ agent: agent(state), live: true }))).toEqual(['interrupt', 'stop']);
  });

  it.each<AgentState>(['idle', 'waiting'])('pauses and stops an agent that is %s: it has no turn to interrupt', (state) => {
    const controls = sessionControls({ agent: agent(state), live: true });
    expect(enabled(controls)).toEqual(['pause', 'stop']);
    expect(controls[0]!.hint).toMatch(/no turn/i);
  });

  it('only stops a rate-limited agent, saying why it does not pause', () => {
    const controls = sessionControls({ agent: agent('rate-limited'), live: true });
    expect(enabled(controls)).toEqual(['stop']);
    expect(controls.find((control) => control.id === 'pause')!.hint).toBe('It is rate-limited');
  });

  it('greys out Pause while the agent is mid-turn, saying why', () => {
    const pause = sessionControls({ agent: agent('running'), live: true }).find((control) => control.id === 'pause')!;
    expect(pause).toMatchObject({ enabled: false, hint: 'It is mid-turn: finish its turn first' });
  });

  it('wakes a paused agent, its session gone, or closes it as it is', () => {
    const controls = sessionControls({ agent: agent('hibernated', '2026-10-10T00:00:00Z'), live: false });
    expect(controls.map((control) => control.id)).toEqual<ControlId[]>(['interrupt', 'wake', 'stop']);
    expect(enabled(controls)).toEqual(['wake', 'stop']);
    expect(controls.at(-1)!.hint).toMatch(/no longer paused/);
  });

  it('interrupts an agent waiting mid-call on a question it asked through the board', () => {
    const ask = { id: 'q1', question: 'Which cache?', options: [], freeText: true, askedAt: '', expiresAt: '', onBoard: false, questions: [{ question: 'Which cache?', options: [], freeText: true }], answers: [null], card: null };
    expect(enabled(sessionControls({ agent: agent('waiting', null, { ask }), live: true }))).toEqual(['interrupt', 'stop']);
  });

  it('offers nothing for an agent that has ended, or a session the window lost', () => {
    expect(enabled(sessionControls({ agent: agent('done', '2026-10-10T00:00:00Z'), live: true }))).toEqual([]);
    expect(enabled(sessionControls({ agent: agent('running'), live: false }))).toEqual([]);
    expect(enabled(sessionControls({ live: false }))).toEqual([]);
  });

  it('interrupts and stops a live shell whatever it is doing', () => {
    expect(enabled(sessionControls({ live: true }))).toEqual(['interrupt', 'stop']);
  });
});

describe('the header’s one state button', () => {
  const lead = (fields: Partial<Agent>, live = true) => leadControl(sessionControls({ agent: { state: 'idle', endedAt: null, ask: null, plan: null, permissions: [], hibernated: null, ...fields } as unknown as Agent, live }))?.id;

  it('is Wake while it is paused', () => {
    expect(lead({ state: 'hibernated', endedAt: '2026-10-30T10:00:00Z' }, false)).toBe('wake');
  });
  it('is Interrupt mid-turn, with Pause and Stop left for ⋯', () => {
    expect(lead({ state: 'running' })).toBe('interrupt');
  });
  it('is Pause between turns', () => {
    expect(lead({ state: 'waiting' })).toBe('pause');
  });
  it('is Wake once it is done or exited, but not for a reviewer whose round ended, nor a harness in its shell', () => {
    const ended = { endedAt: '2026-10-30T10:00:00Z', reviewOf: null, shellHarness: null };
    expect(lead({ ...ended, state: 'done' }, false)).toBe('wake');
    expect(lead({ ...ended, state: 'failed' }, false)).toBe('wake');
    expect(lead({ ...ended, state: 'done', reviewOf: 'impl' }, false)).toBeUndefined();
    expect(lead({ ...ended, state: 'done', shellHarness: 'claude' }, false)).toBeUndefined();
  });
  it('is Wake now for one its clock pauses between runs, which runs its clock', () => {
    const schedule = { clockId: 'c', cron: '30 22 * * *', prompt: 'Sweep', enabled: true, nextRunAt: '2026-10-30T22:30:00Z', lastRun: null, hibernates: true };
    const agent = { state: 'hibernated', endedAt: '2026-10-30T10:00:00Z', reviewOf: null, shellHarness: null, ask: null, plan: null, permissions: [], hibernated: null, schedule } as unknown as Agent;
    expect(leadControl(sessionControls({ agent, live: false }))).toMatchObject({ id: 'wake', label: 'Wake now' });
  });
  it('is none for one that has gone, ended or with its session lost', () => {
    expect(lead({ state: 'done', endedAt: '2026-10-30T10:00:00Z' }, false)).toBeUndefined();
    expect(lead({ state: 'waiting' }, false)).toBeUndefined();
  });
});
