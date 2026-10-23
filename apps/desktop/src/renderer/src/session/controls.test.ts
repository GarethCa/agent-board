import { describe, expect, it } from 'vitest';
import type { Agent, AgentState } from '@agent-board/daemon/protocol';
import { sessionControls, type ControlId } from './controls';

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
    const ask = { id: 'q1', question: 'Which cache?', options: [], freeText: true, askedAt: '', expiresAt: '', onBoard: false, at: null };
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
