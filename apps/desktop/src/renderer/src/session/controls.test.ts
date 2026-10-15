import { describe, expect, it } from 'vitest';
import type { Agent, AgentState } from '@agent-board/daemon/protocol';
import { sessionControls, type ControlId } from './controls';

function agent(state: AgentState, endedAt: string | null = null, fields: Partial<Agent> = {}): Agent {
  return { state, endedAt, ask: null, plan: null, ...fields } as Agent;
}

const enabled = (controls: ReturnType<typeof sessionControls>) =>
  controls.filter((control) => control.enabled).map((control) => control.id);

describe('session window controls', () => {
  it('lists only controls that work: interrupt and stop, in order', () => {
    const controls = sessionControls({ agent: agent('running'), live: true });

    expect(controls.map((control) => control.id)).toEqual<ControlId[]>(['interrupt', 'stop']);
    expect(controls.some((control) => /not built yet/i.test(control.hint))).toBe(false);
  });

  it.each<AgentState>(['running', 'thinking', 'needs-permission'])('interrupts and stops an agent that is %s', (state) => {
    expect(enabled(sessionControls({ agent: agent(state), live: true }))).toEqual(['interrupt', 'stop']);
  });

  it.each<AgentState>(['idle', 'waiting', 'rate-limited'])('only stops an agent that is %s: it has no turn to interrupt', (state) => {
    const controls = sessionControls({ agent: agent(state), live: true });
    expect(enabled(controls)).toEqual(['stop']);
    expect(controls[0]!.hint).toMatch(/no turn/i);
  });

  it('interrupts an agent waiting mid-call on a question it asked through the board', () => {
    const ask = { id: 'q1', question: 'Which cache?', options: [], freeText: true, askedAt: '', expiresAt: '' };
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
