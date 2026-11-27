import { describe, expect, it, vi } from 'vitest';
import type { Agent } from '@agent-board/daemon/protocol';
import type { RestartAgentResult } from '../../../preload/api';
import { NO_TILE_ACTIONS } from '../board/tile';
import { gateSurfaceOf } from '../session/tabs';
import { doBoardAgentAction, popOutActions, wakeFromWindow, type PopOutParts } from './pop-out-actions';

const agent = { sessionId: 'coder', schedule: null } as unknown as Agent;

function parts() {
  const resolved = () => vi.fn<(...args: unknown[]) => Promise<never>>(async () => ({}) as never);
  const api = {
    agents: { interrupt: resolved(), pause: resolved(), restart: vi.fn<(sessionId: string, force?: boolean) => Promise<RestartAgentResult>>(async () => ({ status: 'restarted', agent })), continueOnCredits: resolved(), setMuted: resolved(), setEffort: resolved(), setRole: resolved() },
    reviews: { start: resolved() },
    gates: { run: resolved() },
    items: { update: resolved() },
    trackers: { openLink: resolved() },
    windows: { requestBoard: resolved(), popOut: resolved() },
    orchestrators: { setTicketChat: resolved() },
  };
  const given = { api, sessionId: 'coder', requestTab: vi.fn(), requestReviewTab: vi.fn(), report: vi.fn(() => () => {}) } satisfies PopOutParts;
  return { ...given, actions: popOutActions(NO_TILE_ACTIONS, given) };
}

describe('popOutActions', () => {
  it('does in the window what needs no board: a pause, a mute, the gate in its tab, the Review view', async () => {
    const { api, actions, requestTab, requestReviewTab } = parts();
    await actions.pauseAgent('coder');
    actions.setMuted('coder', true);
    actions.openGate(agent, true);
    actions.openReview('coder');
    expect(api.agents.pause).toHaveBeenCalledWith('coder');
    expect(api.agents.setMuted).toHaveBeenCalledWith('coder', true);
    expect(api.gates.run).toHaveBeenCalledWith('coder');
    expect(requestTab).toHaveBeenCalledWith('coder', gateSurfaceOf('coder'));
    expect(requestReviewTab).toHaveBeenCalledWith('coder');
    expect(api.windows.requestBoard).not.toHaveBeenCalled();
  });

  it("brings another agent's window forward, or pops it out", () => {
    const { api, actions } = parts();
    actions.openAgent({ sessionId: 'builder', name: 'Builder' } as Agent);
    expect(api.windows.popOut).toHaveBeenCalledWith({ kind: 'session', id: 'builder', title: 'Builder' });
  });

  it('asks the board for what asks first or opens a dialog', () => {
    const { api, actions } = parts();
    actions.deleteAgent('coder');
    actions.stopAgent('coder');
    actions.restartAgent('coder');
    actions.restartWith(agent);
    actions.scheduleAgent(agent);
    actions.closeTicket('coder');
    expect(api.windows.requestBoard.mock.calls.map(([request]) => request)).toEqual([
      { kind: 'agent', sessionId: 'coder', action: 'delete' },
      { kind: 'agent', sessionId: 'coder', action: 'stop' },
      { kind: 'agent', sessionId: 'coder', action: 'restart' },
      { kind: 'agent', sessionId: 'coder', action: 'restart-with' },
      { kind: 'agent', sessionId: 'coder', action: 'schedule' },
      { kind: 'agent', sessionId: 'coder', action: 'close-ticket' },
    ]);
  });

  it("wakes the agent in the window, and asks the board's confirm only when its shell is running something", async () => {
    const { api, actions } = parts();
    await actions.resumeAgent('coder');
    expect(api.agents.restart).toHaveBeenCalledWith('coder');
    expect(api.windows.requestBoard).not.toHaveBeenCalled();
    api.agents.restart.mockResolvedValueOnce({ status: 'busy', message: 'its shell is running something' });
    await actions.resumeAgent('coder');
    expect(api.windows.requestBoard).toHaveBeenCalledWith({ kind: 'agent', sessionId: 'coder', action: 'restart' });
  });

  it("wakes from a window's header the same way, and fails as the wake does", async () => {
    const { api } = parts();
    api.agents.restart.mockResolvedValueOnce({ status: 'busy', message: 'its shell is running something' });
    await wakeFromWindow(api, 'coder');
    expect(api.windows.requestBoard).toHaveBeenCalledWith({ kind: 'agent', sessionId: 'coder', action: 'restart' });
    api.agents.restart.mockRejectedValueOnce(new Error('gone'));
    await expect(wakeFromWindow(api, 'coder')).rejects.toThrow('gone');
  });

  it("asks the board for a reviewer's Open review, of an implementer this window doesn't show", () => {
    const { api, actions, requestReviewTab } = parts();
    actions.openReview('builder');
    expect(requestReviewTab).not.toHaveBeenCalled();
    expect(api.windows.requestBoard).toHaveBeenCalledWith({ kind: 'agent', sessionId: 'builder', action: 'open-review' });
  });

  it('says what failed', async () => {
    const { api, actions, report } = parts();
    api.agents.pause.mockRejectedValueOnce(new Error('gone'));
    await actions.pauseAgent('coder');
    expect(report).toHaveBeenCalledWith('pause the agent');
  });
});

describe('doBoardAgentAction', () => {
  it("does each request with the board's own action", () => {
    const actions = { ...NO_TILE_ACTIONS, deleteAgent: vi.fn(), wakeAgent: vi.fn(async () => {}), saveAsPrefab: vi.fn(), openReview: vi.fn() };
    doBoardAgentAction(actions, agent, 'delete');
    doBoardAgentAction(actions, agent, 'wake');
    doBoardAgentAction(actions, agent, 'save-prefab');
    doBoardAgentAction(actions, agent, 'open-review');
    expect(actions.deleteAgent).toHaveBeenCalledWith('coder');
    expect(actions.wakeAgent).toHaveBeenCalledWith(agent);
    expect(actions.saveAsPrefab).toHaveBeenCalledWith(agent);
    expect(actions.openReview).toHaveBeenCalledWith('coder');
  });
});
