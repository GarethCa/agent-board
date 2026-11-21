// What an agent's menu does in its popped-out window, which has no board of its own: what the window can do by itself
// it does (pause, mute, a gate run, a tab), and what asks first or opens a dialog it asks the board for, which comes forward.
import type { Agent } from '@agent-board/daemon/protocol';
import type { Surface } from '@agent-board/daemon/window-layout';
import type { AgentBoardApi, BoardAgentAction } from '../../../preload/api';
import type { TileActions } from '../board/tile';
import { documentSurfaceOf, gateSurfaceOf, planSurfaceOf, pullRequestSurfaceOf } from '../session/tabs';

/** The rows of an agent's menu a popped-out window leaves out: it is open already, out of the board. */
export const POP_OUT_DROPS = ['open', 'open-window', 'expand', 'pop-out', 'fold', 'pin-expanded'];

type Api = { agents: Pick<AgentBoardApi['agents'], 'interrupt' | 'pause' | 'resume' | 'continueOnCredits' | 'setMuted' | 'setEffort' | 'setRole'> } & {
  reviews: Pick<AgentBoardApi['reviews'], 'start'>;
  gates: Pick<AgentBoardApi['gates'], 'run'>;
  items: Pick<AgentBoardApi['items'], 'update'>;
  trackers: Pick<AgentBoardApi['trackers'], 'openLink'>;
  windows: Pick<AgentBoardApi['windows'], 'requestBoard' | 'popOut'>;
  orchestrators: Pick<AgentBoardApi['orchestrators'], 'setTicketChat'>;
};

/** What the popped-out window's own parts give it: its tabs and Review view to ask for, and a way to say what failed. */
export interface PopOutParts {
  api: Api;
  /** The agent the window is of. */
  sessionId: string;
  /** Opens a tab in this window on `surface`, or goes to it. */
  requestTab(sessionId: string, surface: Surface): void;
  /** Opens this window's Review view, or goes to it. */
  requestReviewTab(sessionId: string): void;
  /** Says what could not be done: `action` as "pause the agent". */
  report(action: string): (error: unknown) => void;
}

/** The tile actions of a popped-out agent's window, over `base` (what does nothing there). */
export function popOutActions(base: TileActions, { api, sessionId: own, requestTab, requestReviewTab, report }: PopOutParts): TileActions {
  const board = (sessionId: string, action: BoardAgentAction) => void api.windows.requestBoard({ kind: 'agent', sessionId, action });
  const ignore = () => {};
  return {
    ...base,
    interruptAgent: (sessionId) => void api.agents.interrupt(sessionId).catch(report('interrupt the agent')),
    pauseAgent: (sessionId) => api.agents.pause(sessionId).then(ignore, report('pause the agent')),
    resumeAgent: (sessionId) => api.agents.resume(sessionId).then(ignore, report('resume the agent')),
    continueOnCredits: (sessionId) => api.agents.continueOnCredits(sessionId).then(ignore, report('continue it on credits')),
    setMuted: (sessionId, muted) => void api.agents.setMuted(sessionId, muted).catch(report(muted ? "mute the agent's notifications" : "unmute the agent's notifications")),
    setEffort: (sessionId, effort) => void api.agents.setEffort(sessionId, effort).catch(report("change the agent's reasoning")),
    setRole: (sessionId, role, sendTemplate) => void api.agents.setRole(sessionId, role, sendTemplate).catch(report("change the agent's role")),
    turnClockOff: (agent) => {
      if (agent.schedule !== null) void api.items.update({ id: agent.schedule.clockId, data: { enabled: false } }).catch(report('turn its clock off'));
    },
    startReview: (agent) => void api.reviews.start(agent.sessionId).catch(report('start a review')),
    // A reviewer's Open review is of its implementer, which this window doesn't show: the board finds where it is.
    openReview: (implementer) => (implementer === own ? requestReviewTab(implementer) : board(implementer, 'open-review')),
    openGate(agent, run) {
      if (run) void api.gates.run(agent.sessionId).catch(report('run the gate'));
      requestTab(agent.sessionId, gateSurfaceOf(agent.sessionId));
    },
    openPlan: (agent) => requestTab(agent.sessionId, planSurfaceOf(agent.sessionId)),
    openDoc: (agent, document) => requestTab(agent.sessionId, documentSurfaceOf(document)),
    openPullRequest(agent, pr) {
      const surface = pullRequestSurfaceOf(pr);
      if (surface === undefined) void api.trackers.openLink(pr.url).catch(report('open the link'));
      else requestTab(agent.sessionId, surface);
    },
    // Another agent's window, from a tab's or the ticket board's: brought forward if it is out, else popped out.
    openAgent: (agent) => void api.windows.popOut({ kind: 'session', id: agent.sessionId, title: agent.name }).catch(report('open its window')),
    setTicketChat: (sessionId, kind) => void api.orchestrators.setTicketChat(sessionId, kind).catch(report('switch who builds the ticket')),
    openTicketBoard: (chat) => board(chat, 'ticket-board'),
    closeTicket: (chat) => board(chat, 'close-ticket'),
    openLink: (url) => void api.trackers.openLink(url).catch(report('open the link')),
    deleteAgent: (sessionId) => board(sessionId, 'delete'),
    stopAgent: (sessionId) => board(sessionId, 'stop'),
    restartAgent: (sessionId) => board(sessionId, 'restart'),
    wakeAgent: async (agent) => board(agent.sessionId, 'wake'),
    scheduleAgent: (agent) => board(agent.sessionId, 'schedule'),
    linkIssue: (agent) => board(agent.sessionId, 'link-issue'),
    saveAsPrefab: (agent) => board(agent.sessionId, 'save-prefab'),
  };
}

/** Does, on the board, what a popped-out agent's menu asked of it, as its tile's menu would. */
export function doBoardAgentAction(actions: TileActions, agent: Agent, action: BoardAgentAction): void {
  if (action === 'delete') actions.deleteAgent(agent.sessionId);
  else if (action === 'stop') actions.stopAgent(agent.sessionId);
  else if (action === 'restart') actions.restartAgent(agent.sessionId);
  else if (action === 'wake') void actions.wakeAgent(agent);
  else if (action === 'schedule') actions.scheduleAgent(agent);
  else if (action === 'link-issue') actions.linkIssue(agent);
  else if (action === 'open-review') actions.openReview(agent.sessionId);
  else if (action === 'ticket-board') actions.openTicketBoard(agent.sessionId);
  else if (action === 'close-ticket') actions.closeTicket(agent.sessionId);
  else actions.saveAsPrefab(agent);
}
