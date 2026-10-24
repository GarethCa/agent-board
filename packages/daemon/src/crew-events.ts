// Crew events: what happened to each agent, once each, derived from the daemon's agent updates, so an
// orchestrator hears its crew through `orchestrator.wait` instead of polling states and collapsing their flips itself.
import { randomBytes } from 'node:crypto';
import { CREW_CURSOR as CURSOR, MAX_CREW_EVENTS, planPending, waitsOnUser, type Agent, type AgentState, type CrewEvent, type CrewEventKind, type PullRequest } from './protocol.ts';
import { oneLine } from './terminal-input.ts';

/** States a turn is under way in: a turn ends when an agent goes from one of these to its prompt. */
const TURN_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['running', 'thinking', 'needs-permission', 'handing-off']);

/** States of an agent at its prompt, between turns. */
const AT_PROMPT: ReadonlySet<AgentState> = new Set<AgentState>(['idle', 'waiting', 'scheduled', 'on-command']);

/** Longest detail an event keeps: one line of what it asks, cut short. */
const MAX_DETAIL_LENGTH = 200;

/** Most events one answer carries; the rest follow from its cursor. */
const MAX_EVENTS_PER_ANSWER = 100;

/** A logged event, with the agents above its agent in their crew as it happened, so it reaches them once it is gone. */
export interface LoggedEvent extends CrewEvent {
  /** Its agent's `spawnedBy`, then theirs, as it happened. */
  leads: readonly string[];
}

export interface CrewEventLogOptions {
  /** The agents as they are as the daemon starts. */
  seed: readonly Agent[];
  /** Whether only its idle prompt left the agent waiting (`AgentHost.idlePrompted`). */
  idlePrompted(sessionId: string): boolean;
  /** The agent as it is now, if it is. */
  agent(sessionId: string): Agent | undefined;
  /** The agents above the agent in its crew: its `spawnedBy`, then theirs. */
  leads(agent: Agent): string[];
  /** This run's name in cursors: a cursor of another run is from before a restart. */
  run?: string;
  now?: () => Date;
}

export interface CrewEventLog {
  /** Hears the agent as it is now, logging what changed since it was last heard. */
  observe(agent: Agent): void;
  /** The agent was deleted: an end it hasn't had yet is logged, so a watcher between waits still hears it. */
  forget(sessionId: string): void;
  /**
   * The agent's own pull requests were read (`PullRequestWatcherOptions.onRead`): an open one new since its first read
   * this run is news. What its first read finds was there before, so a restart announces nothing.
   */
  pullRequestsRead(sessionId: string, own: readonly PullRequest[], first: boolean): void;
  /**
   * The events after `since` (a cursor, `now` or `all`), oldest first, at most `MAX_EVENTS_PER_ANSWER` of those `keep`
   * takes; the cursor to go on from; and whether some were lost: dropped already, or `since` is from another run.
   * Throws for a cursor that isn't one.
   */
  after(since: string, keep: (event: LoggedEvent) => boolean): { events: LoggedEvent[]; cursor: string; missed: boolean };
  /** The cursor of the newest event. */
  cursor(): string;
  /** The state a wait takes the agent in: idle while its idle prompt alone left it waiting, else its own. */
  waitState(agent: Agent): AgentState;
}


export function createCrewEventLog(options: CrewEventLogOptions): CrewEventLog {
  const run = options.run ?? `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const now = options.now ?? (() => new Date());
  const last = new Map<string, Agent>(options.seed.map((agent) => [agent.sessionId, agent]));
  /** Each agent's leads as last heard, for its end once it is gone. */
  const leadsOf = new Map<string, readonly string[]>(options.seed.map((agent) => [agent.sessionId, options.leads(agent)]));
  /** Each agent's pull requests known since their first read this run: any other is news. */
  const pullRequestsKnown = new Map<string, Set<number>>();
  const events: LoggedEvent[] = [];
  let seq = 0;

  const needsUser = (agent: Agent): boolean =>
    agent.state === 'needs-permission' ||
    agent.permissions.length > 0 ||
    waitsOnUser(agent) ||
    planPending(agent) ||
    // Waiting with no ask of the board's: Claude's own question (`agent_needs_input`), unless only its idle prompt.
    (agent.state === 'waiting' && agent.endedAt === null && !options.idlePrompted(agent.sessionId));

  const askedFor = (agent: Agent): string | null => {
    const [prompt] = agent.permissions;
    if (prompt !== undefined) return `permission for ${prompt.toolName}`;
    if (agent.ask !== null) return agent.ask.question;
    if (agent.plan !== null) return `plan: ${agent.plan.title}`;
    return agent.lastMessage;
  };

  /** How its session ended, in a few words. */
  const howEnded = (agent: Agent): string => {
    if (agent.state === 'done' && agent.exitCode === null) return 'closed';
    return agent.exitCode === null ? 'stopped by a signal' : `exited ${agent.exitCode}`;
  };

  /** What happened between two updates of a live agent, in order. */
  const changes = (before: Agent, after: Agent): { kind: CrewEventKind; detail: string | null }[] => {
    const found: { kind: CrewEventKind; detail: string | null }[] = [];
    if (before.workFinishedAt === null && after.workFinishedAt !== null) found.push({ kind: 'finished', detail: after.status?.summary ?? null });
    // A new flag (or a new reason): one an orchestrator passes on is the user's, not news to its own lead.
    if (after.flag !== null && after.flag.id !== before.flag?.id && after.flag.to === 'orchestrator') {
      found.push({ kind: 'flagged', detail: after.flag.reason });
    }
    const asking = after.endedAt === null && !needsUser(before) && needsUser(after);
    if (asking) found.push({ kind: 'needs-you', detail: askedFor(after) });
    if (after.endedAt === null && before.unsent === null && after.unsent !== null) found.push({ kind: 'not-sent', detail: after.unsent });
    // A turn that ends finished, or on asking the user, says so instead.
    if (!asking && after.workFinishedAt === null && TURN_STATES.has(before.state) && AT_PROMPT.has(after.state)) {
      found.push({ kind: 'turn-ended', detail: null });
    }
    for (const kind of ['failed', 'rate-limited'] as const) {
      if (before.state !== kind && after.state === kind) found.push({ kind, detail: null });
    }
    // A pause is no end: the agent wakes on its next message, so its orchestrator hears who paused it.
    if (after.endedAt !== null && after.hibernated !== null) found.push({ kind: 'paused', detail: `by ${after.hibernated.by ?? 'the user'}` });
    else if (after.endedAt !== null) found.push({ kind: 'ended', detail: howEnded(after) });
    return found;
  };

  const log = (agent: Pick<Agent, 'sessionId' | 'name'>, leads: readonly string[], kind: CrewEventKind, detail: string | null) => {
    seq += 1;
    // One line each, as `watch` prints them: a question or a final message may run to many.
    const line = detail === null ? null : oneLine(detail);
    const shown = line === null || line.length <= MAX_DETAIL_LENGTH ? line : `${line.slice(0, MAX_DETAIL_LENGTH - 1).trimEnd()}…`;
    events.push({ cursor: `${run}.${seq}`, at: now().toISOString(), sessionId: agent.sessionId, name: agent.name, kind, detail: shown, leads });
    if (events.length > MAX_CREW_EVENTS) events.splice(0, events.length - MAX_CREW_EVENTS);
  };

  /** The seq of a cursor of this run; -1 for another run's. */
  const seqOf = (cursor: string): number => {
    const match = CURSOR.exec(cursor);
    if (match === null) throw new Error(`${cursor} is not a cursor: give one a wait answered with, now or all`);
    return match[1] === run ? Number(match[2]) : -1;
  };

  return {
    observe(agent) {
      const before = last.get(agent.sessionId);
      const leads = options.leads(agent);
      last.set(agent.sessionId, agent);
      leadsOf.set(agent.sessionId, leads);
      // An ended agent's later updates (its `done`, a rename) are no news; a relaunch starts it over. A paused one that
      // is closed as it is has ended now.
      if (before !== undefined && before.endedAt === null) {
        for (const { kind, detail } of changes(before, agent)) log(agent, leads, kind, detail);
      } else if (before?.hibernated != null && agent.endedAt !== null && agent.hibernated === null) {
        log(agent, leads, 'ended', howEnded(agent));
      }
    },

    pullRequestsRead(sessionId, own, first) {
      const known = pullRequestsKnown.get(sessionId);
      // Its first read (or the first the log hears, as the daemon starts) finds what was there before.
      if (first || known === undefined) {
        pullRequestsKnown.set(sessionId, new Set(own.map((pr) => pr.number)));
        return;
      }
      const agent = last.get(sessionId) ?? options.agent(sessionId);
      for (const pr of own) {
        if (known.has(pr.number)) continue;
        known.add(pr.number);
        if (agent !== undefined && (pr.state === 'open' || pr.state === 'draft')) {
          log(agent, leadsOf.get(sessionId) ?? options.leads(agent), 'pr-opened', `#${pr.number} ${pr.url}`);
        }
      }
    },

    forget(sessionId) {
      const before = last.get(sessionId);
      if (before !== undefined && (before.endedAt === null || before.hibernated !== null)) log(before, leadsOf.get(sessionId) ?? [], 'ended', 'removed');
      last.delete(sessionId);
      leadsOf.delete(sessionId);
      pullRequestsKnown.delete(sessionId);
    },

    after(since, keep) {
      const from = since === 'now' ? seq : since === 'all' ? 0 : seqOf(since);
      if (from > seq) throw new Error(`${since} is past the newest event`);
      // A cursor of another run (from before a restart): every event of this one is news, and what came between is lost.
      const start = Math.max(from, 0);
      const oldest = events.length === 0 ? seq + 1 : Number(CURSOR.exec(events[0]!.cursor)![2]);
      const missed = from < 0 || oldest > start + 1;
      const kept: LoggedEvent[] = [];
      let cursor = seq;
      for (const event of events) {
        const at = Number(CURSOR.exec(event.cursor)![2]);
        if (at <= start || !keep(event)) continue;
        if (kept.length === MAX_EVENTS_PER_ANSWER) {
          cursor = at - 1;
          break;
        }
        kept.push(event);
      }
      return { events: kept, cursor: `${run}.${cursor}`, missed };
    },

    cursor: () => `${run}.${seq}`,

    waitState: (agent) => (agent.state === 'waiting' && options.idlePrompted(agent.sessionId) ? 'idle' : agent.state),
  };
}
