import { needsYouKind, permissionPrompt, planPending, questionPrompt, type Agent, type DaemonSettings, type NeedsYouKind } from '@agent-board/daemon/protocol';
import { askAnsweredElsewhere, stepsLeftWords, stepsWaitKey, toolSummary } from '../shared/needs-you';
import { appStateOf, type AppStatus } from './app-state';

/** An OS notification about one agent. Clicking it opens that agent. */
export interface AgentNotification {
  sessionId: string;
  /** Why the agent is in the needs-you inbox. */
  kind: NeedsYouKind;
  /** The agent's name. */
  name: string;
  title: string;
  body: string;
  /** For a question, which it is and the answers it offers, so a banner can list them. */
  ask?: { askId: string; question: string; options: string[] };
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
  /**
   * Whether the Simplified design is on. It has no switch for notifications, leaving on and off to the OS, so a switch
   * left off under Classic raises none there no longer.
   */
  simplified?(): boolean;
}

/**
 * Follows every agent's state, as the daemon reports it, and tells the user when one needs them: an OS notification
 * for each new request in the needs-you inbox (`needsYouKind`: a permission prompt, a question, a remove ask, a plan, a flag, or with
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
 * its permission prompts (one request however many), a question, a remove ask, a plan version, a flag to the user, or (with
 * `turns`, and nothing else asked) its turn ended. Each new one notifies once.
 */
function requestsOf(agent: Agent, settings: AlertSettings): { kind: NeedsYouKind; key: string }[] {
  if (agent.endedAt !== null) return [];
  const requests: { kind: NeedsYouKind; key: string }[] = [];
  if (agent.state === 'needs-permission' || permissionPrompt(agent) !== undefined) requests.push({ kind: 'permission', key: 'permission' });
  if (agent.ask !== null) requests.push({ kind: 'asks', key: `asks:${agent.ask.id}` });
  // An orchestrator's ask to remove tiles: only the inbox row answers it, never the banner.
  if (agent.removeAsk != null) requests.push({ kind: 'asks', key: `remove:${agent.removeAsk.id}` });
  // Claude's question tool asks in its own dialog: a request of its own, which the banner never answers.
  const questions = questionPrompt(agent);
  if (questions !== undefined) requests.push({ kind: 'asks', key: `questions:${questions.id}` });
  // By its wait, which a version the user edits keeps: their own edit is no new request.
  if (planPending(agent)) requests.push({ kind: 'plan', key: `plan:${agent.plan.expiresAt ?? agent.plan.id}` });
  // A steps card it waits on: by the step that matters, so a new one is news and an answer to the last isn't.
  if (agent.stepsWait !== null) requests.push({ kind: agent.stepsWait.kind, key: stepsWaitKey(agent.stepsWait) });
  if (agent.flag?.to === 'user') requests.push({ kind: 'flagged', key: `flagged:${agent.flag.id}` });
  if (requests.length === 0 && needsYouKind(agent, settings.needsYouShows) === 'turn') requests.push({ kind: 'turn', key: 'turn' });
  return requests;
}

/** How many tiles a remove ask's banner names before "and N more". */
const REMOVE_NAMES_SHOWN = 3;

/** A remove ask's banner: how many tiles, the first few by name, and no Allow, which only the inbox row has. */
function removeNotification(agent: Agent): AgentNotification {
  const { sessionId, name } = agent;
  const tiles = agent.removeAsk!.tiles;
  const shown = tiles.slice(0, REMOVE_NAMES_SHOWN).map((tile) => tile.name);
  const more = tiles.length - shown.length;
  const names = more === 0 ? shown.join(', ') : `${shown.join(', ')} and ${more} more`;
  const count = `${tiles.length} tile${tiles.length === 1 ? '' : 's'}`;
  return { sessionId, kind: 'asks', name, title: `${name} asks to remove ${count}`, body: `${names}. Open it to allow or deny.` };
}

function notificationFor(agent: Agent, { kind, key }: { kind: NeedsYouKind; key: string }): AgentNotification {
  const { sessionId, name } = agent;
  if (key.startsWith('remove:') && agent.removeAsk != null) return removeNotification(agent);
  switch (kind) {
    case 'turn':
      return { sessionId, kind, name, title: `${name} is waiting for you`, body: agent.lastMessage ?? 'It is waiting for your answer.' };
    case 'asks': {
      if (agent.ask === null) {
        const prompt = questionPrompt(agent);
        return { sessionId, kind, name, title: `${name} asks you`, body: prompt === undefined ? 'Open it to answer.' : toolSummary(prompt) };
      }
      const asked = agent.ask;
      const { id, question, options } = asked;
      // Put on the board, or of several questions, its banner only says so: its options don't answer it.
      const elsewhere = askAnsweredElsewhere(asked);
      if (elsewhere !== undefined) return { sessionId, kind, name, title: `${name} asks you`, body: `${question}\n${elsewhere}` };
      return { sessionId, kind, name, title: `${name} asks you`, body: options.length === 0 ? question : `${question} (${options.join(' · ')})`, ask: { askId: id, question, options } };
    }
    case 'plan':
      return { sessionId, kind, name, title: `${name} has a plan to review`, body: `${agent.plan!.title} · v${agent.plan!.version}` };
    case 'steps': {
      const wait = agent.stepsWait!;
      return { sessionId, kind, name, title: `${name} asks you`, body: `${wait.title}: ${stepsLeftWords(wait)}` };
    }
    case 'todo':
      return { sessionId, kind, name, title: `${name} waits on your to-do`, body: `${agent.stepsWait!.text} (${agent.stepsWait!.title})` };
    case 'flagged': {
      const { reason, via } = agent.flag!;
      return { sessionId, kind, name, title: `${name} needs you`, body: via === null ? reason : `${reason} (via ${via})` };
    }
    case 'permission': {
      const prompt = permissionPrompt(agent);
      if (prompt === undefined) return { sessionId, kind, name, title: `${name} needs your permission`, body: 'It is asking in its terminal.' };
      const summary = toolSummary(prompt);
      const asked = summary === '' ? prompt.toolName : `${prompt.toolName}: ${summary}`;
      const body = prompt.subagent === null ? asked : `Its ${prompt.subagent.type} subagent: ${asked}`;
      return { sessionId, kind, name, title: `${name} needs your permission`, body };
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
    if ((!settings.notifications && options.simplified?.() !== true) || (!settings.notifyInFront && options.inFront?.() === true)) return;
    options.notify(notificationFor(agent, fresh));
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
