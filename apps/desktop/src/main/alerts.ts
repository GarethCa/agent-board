import { planPending, type Agent } from '@agent-board/daemon/protocol';
import { toolSummary } from '../shared/needs-you';
import { appStateOf, type AppStatus } from './app-state';

/** An OS notification about one agent. Clicking it opens that agent. */
export interface AgentNotification {
  sessionId: string;
  title: string;
  body: string;
}

export interface AgentAlertsOptions {
  /** Raises the OS notification. */
  notify(notification: AgentNotification): void;
  /** Shows the app's state, and how many agents wait, on the dock icon, its badge and the menu bar. */
  showState(state: AppStatus): void;
}

/**
 * Follows every agent's state, as the daemon reports it, and tells the user when one needs them or stops: an OS
 * notification each time an agent starts waiting, asks a question or presents a plan, needs permission, fails or is done, and the app's state (needs,
 * working or quiet) with the needs-you inbox's size, for the dock and menu bar.
 */
export interface AgentAlerts {
  /**
   * Takes a full listing of the agents. Agents heard of before are compared with what they were, as for `updated`;
   * agents new to it are taken as they are, without a notification.
   */
  reset(agents: readonly Agent[]): void;
  /** Notifies if the agent has just entered a state worth one, unless it is muted. Agents new to it never notify. */
  updated(agent: Agent): void;
  /** Forgets a deleted agent. */
  removed(sessionId: string): void;
}

/** What the user is told about: the states of an agent a notification is raised for. */
type Alert = 'waiting' | 'asks' | 'plan' | 'needs-permission' | 'failed' | 'done';

/** What the agent is in that the user is told about, or null. A pending permission prompt counts whatever its state. */
function alertOf(agent: Agent): Alert | null {
  if (agent.state === 'failed' || agent.state === 'done') return agent.state;
  if (agent.endedAt !== null) return null;
  if (agent.permissions.length > 0 || agent.state === 'needs-permission') return 'needs-permission';
  if (agent.ask !== null) return 'asks';
  if (planPending(agent)) return 'plan';
  return agent.state === 'waiting' ? 'waiting' : null;
}

function notificationFor(agent: Agent, alert: Alert): AgentNotification {
  const { sessionId, name } = agent;
  switch (alert) {
    case 'waiting':
      return { sessionId, title: `${name} is waiting for you`, body: agent.lastMessage ?? 'It is waiting for your answer.' };
    case 'asks': {
      const { question, options } = agent.ask!;
      return { sessionId, title: `${name} asks you`, body: options.length === 0 ? question : `${question} (${options.join(' · ')})` };
    }
    case 'plan':
      return { sessionId, title: `${name} has a plan to review`, body: `${agent.plan!.title} · v${agent.plan!.version}` };
    case 'needs-permission': {
      const [prompt] = agent.permissions;
      if (prompt === undefined) return { sessionId, title: `${name} needs your permission`, body: 'It is asking in its terminal.' };
      const summary = toolSummary(prompt);
      const asked = summary === '' ? prompt.toolName : `${prompt.toolName}: ${summary}`;
      const body = prompt.subagent === null ? asked : `Its ${prompt.subagent.type} subagent: ${asked}`;
      return { sessionId, title: `${name} needs your permission`, body };
    }
    case 'failed':
      return { sessionId, title: `${name} failed`, body: agent.notice ?? 'Open it to see what went wrong.' };
    case 'done':
      return { sessionId, title: `${name} is done`, body: agent.lastMessage ?? 'Its session has ended.' };
  }
}

export function createAgentAlerts(options: AgentAlertsOptions): AgentAlerts {
  const agents = new Map<string, Agent>();
  let shown: AppStatus | undefined;

  const showState = () => {
    const next = appStateOf([...agents.values()]);
    if (next.state !== shown?.state || next.waiting !== shown.waiting) options.showState(next);
    shown = next;
  };

  /** Records the agent, notifying if it entered a state the user is told about. */
  const track = (agent: Agent) => {
    const before = agents.get(agent.sessionId);
    agents.set(agent.sessionId, agent);
    if (before === undefined || agent.muted) return;
    const alert = alertOf(agent);
    if (alert !== null && alert !== alertOf(before)) options.notify(notificationFor(agent, alert));
  };

  return {
    reset(listed) {
      const known = new Map(agents);
      agents.clear();
      for (const agent of listed) {
        const before = known.get(agent.sessionId);
        if (before !== undefined) agents.set(agent.sessionId, before);
        track(agent);
      }
      showState();
    },
    updated(agent) {
      track(agent);
      showState();
    },
    removed(sessionId) {
      agents.delete(sessionId);
      showState();
    },
  };
}
