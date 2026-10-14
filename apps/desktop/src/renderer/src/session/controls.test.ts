import { describe, expect, it } from 'vitest';
import type { Agent, AgentState } from '@agent-board/daemon/protocol';
import { sessionControls, type ControlId } from './controls';

function agent(state: AgentState, endedAt: string | null = null): Agent {
  return { state, endedAt } as Agent;
}

const enabled = (controls: ReturnType<typeof sessionControls>) =>
  controls.filter((control) => control.enabled).map((control) => control.id);

describe('session window controls', () => {
  it('lists every control in the sidebar, in order, with the ones not built yet disabled', () => {
    const controls = sessionControls({ agent: agent('running'), live: true });

    expect(controls.map((control) => control.id)).toEqual<ControlId[]>(['interrupt', 'pause', 'handOff', 'fork', 'stop', 'connections']);
    for (const id of ['pause', 'handOff', 'fork', 'connections']) {
      expect(controls.find((control) => control.id === id)).toMatchObject({ enabled: false, hint: expect.stringMatching(/not built yet/i) });
    }
  });

  it.each<AgentState>(['running', 'thinking', 'needs-permission'])('interrupts and stops an agent that is %s', (state) => {
    expect(enabled(sessionControls({ agent: agent(state), live: true }))).toEqual(['interrupt', 'stop']);
  });

  it.each<AgentState>(['idle', 'waiting', 'rate-limited'])('only stops an agent that is %s: it has no turn to interrupt', (state) => {
    const controls = sessionControls({ agent: agent(state), live: true });
    expect(enabled(controls)).toEqual(['stop']);
    expect(controls[0]!.hint).toMatch(/no turn/i);
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
