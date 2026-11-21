import type { DatabaseSync } from 'node:sqlite';
import type { AfterRestart, Agent, Shell } from './protocol.ts';

/** What the start brought back when there was nothing to bring back. */
export const NOTHING_AFTER_RESTART: AfterRestart = { agents: [], cutOff: [], panes: 0, notResumed: [] };

/** What bringing back the sessions a restart stopped needs of the daemon. */
export interface ResumeAfterRestartOptions {
  db: DatabaseSync;
  agents: {
    get(sessionId: string): Agent | undefined;
    resume(sessionId: string, why: string, force: boolean, fresh: undefined, quiet: true): Promise<Agent>;
    broughtBack(sessionId: string): void;
    comingBack(sessionIds: readonly string[]): void;
    restartPassDone(): void;
  };
  shells: {
    list(): Shell[];
    resumePane(shellId: string, sessionId: string): Promise<unknown>;
  };
  /** The agents of clock runs the restart stopped: their clock closes or keeps them, so they stay as they are. */
  leftToClocks: ReadonlySet<string>;
  /** True once the daemon is shutting down: the pass resumes nothing more, and leaves the untried their marks. */
  stopping?(): boolean;
  log(line: string): void;
}

/**
 * Brings back, at the daemon's start, every session the restart before it stopped (`sessions.resume_at_start`), as
 * it was (ADR-0002, "A restart brings back what it stopped"): each agent still stopped by restart is resumed in its
 * conversation and types nothing, so one cut off mid-turn comes back at its prompt, still `cutOffMidTurn`, for the
 * user's Carry on; each shell pane is reopened. One at a time, after the socket listens. A paused or exited agent was
 * never marked, and one stopped by an earlier restart has lost its mark: each stays as it is. Each session is tried
 * once, its mark cleared whether it came back or not: what didn't waits on the board, stopped by restart.
 */
export async function resumeAfterRestart(options: ResumeAfterRestartOptions): Promise<AfterRestart> {
  const { db, agents, shells, log } = options;
  const marked = (db.prepare('SELECT id FROM sessions WHERE resume_at_start = 1 ORDER BY rowid').all() as { id: string }[]).map(
    (row) => row.id,
  );
  if (marked.length === 0) return NOTHING_AFTER_RESTART;
  // Its changes tell whether the mark was still there: a relaunch meanwhile (the user's Wake, a clock, an edge's
  // hand-off) has cleared it.
  const unmark = db.prepare('UPDATE sessions SET resume_at_start = 0 WHERE id = ? AND resume_at_start = 1');
  const result: AfterRestart = { agents: [], cutOff: [], panes: 0, notResumed: [] };
  const back = (agent: Agent) => {
    agents.broughtBack(agent.sessionId);
    result.agents.push(agent.name);
    // One cut off on a permission prompt is left out, as the banner leaves it out of its Carry on.
    if (agent.cutOffMidTurn === true && agent.cutOffAsking !== true) result.cutOff.push(agent.name);
  };
  // As they were as the daemon started: one woken since, by the user's Wake or its clock, came back all the same.
  const stopped = marked
    .map((sessionId) => agents.get(sessionId))
    .filter((agent) => agent?.state === 'stopped-by-restart' && !options.leftToClocks.has(agent.sessionId)) as Agent[];
  // Until the panes are back too: the banner waits for the whole pass, so its Wake all doesn't race it.
  agents.comingBack(stopped.map((agent) => agent.sessionId));
  try {
    for (const agent of stopped) {
      if (options.stopping?.() === true) break;
      // Tried once: one that fails, or takes the daemon down with it, isn't tried at every start after.
      const stillMarked = Number(unmark.run(agent.sessionId).changes) > 0;
      const now = agents.get(agent.sessionId);
      if (now === undefined) continue;
      if (now.endedAt === null) {
        back(now);
        continue;
      }
      // Woken meanwhile, then paused, or ended as done or exited: it stays as it was left. So does one whose relaunch
      // meanwhile failed, leaving it stopped by restart with its mark cleared: never launched twice, it waits for its Wake.
      if (!stillMarked || now.state !== 'stopped-by-restart') continue;
      try {
        back(await agents.resume(agent.sessionId, "the daemon's start after a restart", false, undefined, true));
      } catch (error) {
        const meanwhile = agents.get(agent.sessionId);
        if (meanwhile?.endedAt === null) back(meanwhile);
        else result.notResumed.push({ name: agent.name, message: (error as Error).message });
      }
    }
    const waiting = new Set(marked);
    for (const shell of shells.list()) {
      for (const sessionId of shell.stoppedPanes.filter((pane) => waiting.has(pane))) {
        if (options.stopping?.() === true) break;
        unmark.run(sessionId);
        try {
          await shells.resumePane(shell.id, sessionId);
          result.panes += 1;
        } catch (error) {
          // Reopened meanwhile, by the user's Wake all on a shell alone: it is back all the same.
          const meanwhile = shells.list().find((each) => each.id === shell.id);
          if (meanwhile !== undefined && !meanwhile.endedPanes.includes(sessionId)) result.panes += 1;
          else result.notResumed.push({ name: `a pane of ${shell.name}`, message: (error as Error).message });
        }
      }
    }
  } finally {
    agents.restartPassDone();
  }
  // Shut down partway: the next start brings back what this one didn't get to.
  if (options.stopping?.() === true) return result;
  // Neither an agent nor a pane (the shell an ended agent's pane dropped into): nothing to bring back.
  for (const sessionId of marked) unmark.run(sessionId);
  log(
    `after the restart, brought back ${result.agents.length} agents (${result.cutOff.length} cut off mid-turn) and ${result.panes} shell panes` +
      (result.notResumed.length === 0 ? '' : `; ${result.notResumed.length} stayed stopped: ${result.notResumed.map((each) => `${each.name}: ${each.message}`).join('; ')}`),
  );
  return result;
}
