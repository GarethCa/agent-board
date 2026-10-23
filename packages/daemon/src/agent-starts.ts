// Agents being started, before they are agents (`AgentStart`): kept in memory, and told to every client as they go.
import { invalidParams } from './params.ts';
import type { AgentStart, DaemonEvent, StartStep, StartStepKind } from './protocol.ts';

/** What a start's tile was asked for with, less what its steps fill in. */
export type NewStart = Omit<AgentStart, 'steps' | 'error' | 'confirm'>;

/** A start's own handle on its record, for the steps that run it. */
export interface StartProgress {
  readonly sessionId: string;
  /** Marks a step under way, done (with what it made) or failed; a step already shown is updated in place. */
  step(kind: StartStepKind, state: StartStep['state'], detail?: string): void;
  rename(name: string): void;
  /** It failed: the tile keeps `error` for Retry or Delete. */
  fail(error: string, confirm: boolean): void;
  /** Its session runs: the start is over. */
  end(): void;
  /** Whether it was dismissed while it ran: it must stop before its session would start. */
  readonly dismissed: boolean;
  /** Its record as it is now: moved or renamed since it began, maybe. */
  readonly start: AgentStart;
}

/** What the user changed of a start's tile while it starts: its name, or where it is. */
export interface StartChange {
  name?: string;
  move?: { zoneId: string | null; x: number; y: number };
}

/** What a start's owner runs: it again, after a failure; and once it is dismissed, its cleanup. */
export interface StartHooks {
  retry(progress: StartProgress, allowProjectCodexConfig: boolean): void;
  dismissed(): void;
}

interface Entry {
  start: AgentStart;
  dismissed: boolean;
  hooks: StartHooks;
}

export interface AgentStarts {
  /** Puts a new start on the board, and returns its progress. */
  open(start: NewStart, hooks: StartHooks): StartProgress;
  list(): AgentStart[];
  has(sessionId: string): boolean;
  /** Starts a failed start again; refuses one that is still going. */
  retry(sessionId: string, allowProjectCodexConfig: boolean): void;
  /** Renames or moves a start's tile; its agent takes the name and the place it has when its session runs. */
  update(sessionId: string, change: StartChange): AgentStart;
  /**
   * Takes a start off the board: one still going stops at its next step. One the daemon doesn't know (it restarted
   * since, or the start is over) is told as over all the same, so no client keeps its tile.
   */
  dismiss(sessionId: string): void;
  /** Dismisses every start whose tile is in the zone, as the zone goes. */
  dismissIn(zoneId: string): void;
}

export function createAgentStarts(broadcast: (event: DaemonEvent) => void): AgentStarts {
  const entries = new Map<string, Entry>();
  const tell = (entry: Entry) => broadcast({ type: 'agent.starting', start: structuredClone(entry.start) });
  const over = (sessionId: string) => {
    if (entries.delete(sessionId)) broadcast({ type: 'agent.startEnded', sessionId });
  };

  const progressOf = (entry: Entry): StartProgress => ({
    sessionId: entry.start.sessionId,
    step(kind, state, detail) {
      if (entry.dismissed) return;
      const steps = entry.start.steps;
      const shown = steps.find((step) => step.kind === kind);
      const next = { kind, state, detail: detail ?? null };
      if (shown === undefined) steps.push(next);
      else Object.assign(shown, next);
      tell(entry);
    },
    rename(name) {
      if (entry.dismissed || entry.start.name === name) return;
      entry.start.name = name;
      tell(entry);
    },
    fail(error, confirm) {
      if (entry.dismissed) return;
      for (const step of entry.start.steps) if (step.state === 'now') step.state = 'failed';
      entry.start.error = error;
      entry.start.confirm = confirm;
      tell(entry);
    },
    end: () => over(entry.start.sessionId),
    get dismissed() {
      return entry.dismissed;
    },
    get start() {
      return entry.start;
    },
  });

  const open: AgentStarts['open'] = (start, hooks) => {
    const entry: Entry = { start: { ...start, steps: [], error: null, confirm: false }, dismissed: false, hooks };
    entries.set(start.sessionId, entry);
    tell(entry);
    return progressOf(entry);
  };

  const entryOf = (sessionId: string): Entry => {
    const entry = entries.get(sessionId);
    if (entry === undefined) throw invalidParams(`no agent being started as ${sessionId}`);
    return entry;
  };

  const dismiss = (sessionId: string) => {
    const entry = entries.get(sessionId);
    if (entry === undefined) return broadcast({ type: 'agent.startEnded', sessionId });
    entry.dismissed = true;
    over(sessionId);
    entry.hooks.dismissed();
  };

  return {
    open,
    list: () => [...entries.values()].map((entry) => structuredClone(entry.start)),
    has: (sessionId) => entries.has(sessionId),
    retry(sessionId, allowProjectCodexConfig) {
      const entry = entryOf(sessionId);
      if (entry.start.error === null) throw invalidParams(`${entry.start.name} is still starting`);
      entry.start.steps = [];
      entry.start.error = null;
      entry.start.confirm = false;
      tell(entry);
      entry.hooks.retry(progressOf(entry), allowProjectCodexConfig);
    },
    update(sessionId, change) {
      const entry = entryOf(sessionId);
      if (change.name !== undefined) {
        const name = change.name.trim();
        if (name === '') throw invalidParams('name must not be blank');
        entry.start.name = name;
      }
      if (change.move !== undefined) {
        entry.start.zoneId = change.move.zoneId;
        entry.start.position = { x: change.move.x, y: change.move.y };
      }
      tell(entry);
      return structuredClone(entry.start);
    },
    dismiss,
    dismissIn(zoneId) {
      for (const entry of [...entries.values()]) if (entry.start.zoneId === zoneId) dismiss(entry.start.sessionId);
    },
  };
}
