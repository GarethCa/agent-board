import { needsYouKind, planPending, type Agent, type DaemonSettings, type NeedsYouKind } from '@agent-board/daemon/protocol';
import { toolSummary } from '../shared/needs-you';
import { appStateOf, type AppStatus } from './app-state';

/** An OS notification about one agent. Clicking it opens that agent. */
export interface AgentNotification {
  sessionId: string;
  title: string;
  body: string;
}

/** The settings alerts follow: what Needs you lists, and whether and when it notifies. */
export type AlertSettings = Pick<DaemonSettings, 'needsYouShows' | 'notifications' | 'notifyInFront'>;

/** The settings until the daemon's are read: its defaults. */
export const DEFAULT_ALERT_SETTINGS: AlertSettings = { needsYouShows: 'explicit', notifications: true, notifyInFront: false };

export interface AgentAlertsOptions {
  /** Raises the OS notification. */
  notify(notification: AgentNotification): void;
  /** Shows the app's state, and how many agents wait, on the dock icon, its badge and the menu bar. */
  showState(state: AppStatus): void;
  /** Whether one of the app's windows is in front, so the user sees the board change: no notification then, unless asked. */
  inFront?(): boolean;
}

/**
 * Follows every agent's state, as the daemon reports it, and tells the user when one needs them: an OS notification
 * for each new request in the needs-you inbox (`needsYouKind`: a permission prompt, a question, a plan, a flag, or with
 * `turns` a finished turn), and the app's state (needs, working or quiet) with the inbox's size, for the dock and menu
 * bar. Notifications follow the settings: off altogether, or not while the app is in front.
 */
export interface AgentAlerts {
  /**
   * Takes a full listing of the agents, and the settings as they are. Agents heard of before are compared with what
   * they were, as for `updated`; agents new to it are taken as they are, without a notification.
   */
  reset(agents: readonly Agent[], settings?: AlertSettings): void;
  /** Notifies if the agent has just made a new request, unless it is muted. Agents new to it never notify. */
  updated(agent: Agent): void;
  /** Forgets a deleted agent. */
  removed(sessionId: string): void;
  /** Takes the settings as they are now. */
  settingsChanged(settings: AlertSettings): void;
}

/**
 * Every request of the agent's that the inbox lists it for, most pressing first, each by its kind and what names it:
 * its permission prompts (one request however many), a question, a plan version, a flag to the user, or (with
 * `turns`, and nothing else asked) its turn ended. Each new one notifies once.
 */
function requestsOf(agent: Agent, settings: AlertSettings): { kind: NeedsYouKind; key: string }[] {
  if (agent.endedAt !== null) return [];
  const requests: { kind: NeedsYouKind; key: string }[] = [];
  if (agent.state === 'needs-permission' || agent.permissions.length > 0) requests.push({ kind: 'permission', key: 'permission' });
  if (agent.ask !== null) requests.push({ kind: 'asks', key: `asks:${agent.ask.id}` });
  // By its wait, which a version the user edits keeps: their own edit is no new request.
  if (planPending(agent)) requests.push({ kind: 'plan', key: `plan:${agent.plan.expiresAt ?? agent.plan.id}` });
  if (agent.flag?.to === 'user') requests.push({ kind: 'flagged', key: `flagged:${agent.flag.id}` });
  if (requests.length === 0 && needsYouKind(agent, settings.needsYouShows) === 'turn') requests.push({ kind: 'turn', key: 'turn' });
  return requests;
}

function notificationFor(agent: Agent, kind: NeedsYouKind): AgentNotification {
  const { sessionId, name } = agent;
  switch (kind) {
    case 'turn':
      return { sessionId, title: `${name} is waiting for you`, body: agent.lastMessage ?? 'It is waiting for your answer.' };
    case 'asks': {
      const { question, options } = agent.ask!;
      return { sessionId, title: `${name} asks you`, body: options.length === 0 ? question : `${question} (${options.join(' · ')})` };
    }
    case 'plan':
      return { sessionId, title: `${name} has a plan to review`, body: `${agent.plan!.title} · v${agent.plan!.version}` };
    case 'flagged': {
      const { reason, via } = agent.flag!;
      return { sessionId, title: `${name} needs you`, body: via === null ? reason : `${reason} (via ${via})` };
    }
    case 'permission': {
      const [prompt] = agent.permissions;
      if (prompt === undefined) return { sessionId, title: `${name} needs your permission`, body: 'It is asking in its terminal.' };
      const summary = toolSummary(prompt);
      const asked = summary === '' ? prompt.toolName : `${prompt.toolName}: ${summary}`;
      const body = prompt.subagent === null ? asked : `Its ${prompt.subagent.type} subagent: ${asked}`;
      return { sessionId, title: `${name} needs your permission`, body };
    }
  }
}

export function createAgentAlerts(options: AgentAlertsOptions): AgentAlerts {
  const agents = new Map<string, Agent>();
  /** Per agent, the requests standing as it was last heard: each has been told of, or was there when first heard. */
  const notified = new Map<string, Set<string>>();
  let settings = DEFAULT_ALERT_SETTINGS;
  let shown: AppStatus | undefined;

  const showState = () => {
    const next = appStateOf([...agents.values()], settings.needsYouShows);
    if (next.state !== shown?.state || next.waiting !== shown.waiting) options.showState(next);
    shown = next;
  };

  /** Records the agent, notifying if it made a new request the user is told about. */
  const track = (agent: Agent) => {
    const before = agents.get(agent.sessionId);
    agents.set(agent.sessionId, agent);
    const requests = requestsOf(agent, settings);
    const told = notified.get(agent.sessionId);
    // Each request is told of once while it stands, muted or not; one that goes is forgotten, so its return is news.
    notified.set(agent.sessionId, new Set(requests.map((request) => request.key)));
    if (before === undefined || told === undefined || agent.muted) return;
    const fresh = requests.find((request) => !told.has(request.key));
    if (fresh === undefined) return;
    if (!settings.notifications || (!settings.notifyInFront && options.inFront?.() === true)) return;
    options.notify(notificationFor(agent, fresh.kind));
  };

  return {
    reset(listed, next) {
      if (next !== undefined) settings = next;
      const known = new Map(agents);
      agents.clear();
      for (const agent of listed) {
        const before = known.get(agent.sessionId);
        if (before !== undefined) agents.set(agent.sessionId, before);
        track(agent);
      }
      for (const sessionId of notified.keys()) if (!agents.has(sessionId)) notified.delete(sessionId);
      showState();
    },
    updated(agent) {
      track(agent);
      showState();
    },
    removed(sessionId) {
      agents.delete(sessionId);
      notified.delete(sessionId);
      showState();
    },
    settingsChanged(next) {
      settings = next;
      // What the change lists now was there before it: no news.
      for (const agent of agents.values()) notified.set(agent.sessionId, new Set(requestsOf(agent, settings).map((request) => request.key)));
      showState();
    },
  };
}
