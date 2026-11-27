// Pausing an agent (hibernating it) from its tile and window, and what a paused tile says. Pure, so the rules are
// unit-tested. Only the user or an orchestrator pauses an agent: nothing here suggests it.
import { pauseRefusal, type Agent, type NeedsYouShows } from '@agent-board/daemon/protocol';
import { humanStatus, standsOut, type HumanStatusFacts } from '@agent-board/daemon/human-status';
import { sinceText } from '../../../shared/needs-you';
import { upperFirst } from '../upper-first';
import { clockTime } from './items/agent-note';
import { whenLabel } from './schedule';

/** What Pause does, as its hint while it can. */
export const PAUSE_HINT = 'Hibernate it to free its memory: Wake, or a message, starts it again in its conversation';

/** What Wake does, as its hint. */
export const WAKE_HINT = 'Start it again, carrying on its conversation';

/**
 * Whether the agent is asleep: paused, or stopped by a restart. Either is frosted and has Wake, which starts it again in
 * its conversation; only the tile's line says which it was.
 */
export function asleep(agent: Pick<Agent, 'state'>): boolean {
  return agent.state === 'hibernated' || agent.state === 'stopped-by-restart';
}

/** The agents a restart can carry on: not a reviewer, whose round ends with it, nor one with a harness running in its shell. */
export const restartsInPlace = (agent: Pick<Agent, 'reviewOf' | 'shellHarness'>): boolean => agent.reviewOf === null && agent.shellHarness === null;

/**
 * Whether the agent ended on its own or was stopped (not by a restart, nor paused: both of those are asleep): Wake
 * restarts it in its worktree, carrying on its conversation. Not a reviewer, whose round ended with it.
 */
export const canRestart = (agent: Pick<Agent, 'endedAt' | 'state' | 'reviewOf' | 'shellHarness'>): boolean => agent.endedAt !== null && !asleep(agent) && restartsInPlace(agent);

/**
 * Whether its clock wakes the agent by itself at its next time: its clock is on and has one, and it waits at its prompt
 * for it, is paused (its clock hibernates it between runs), or has ended (a run starts it again). Such an agent draws as
 * Scheduled, with Wake now on hover. Not one a restart stopped, which asks to be woken.
 */
export function clockWakes(agent: Pick<Agent, 'endedAt' | 'state'> & Partial<Pick<Agent, 'schedule' | 'reviewOf' | 'shellHarness'>>): boolean {
  if (agent.schedule?.enabled !== true || agent.schedule.nextRunAt === null || agent.state === 'stopped-by-restart') return false;
  if (agent.state === 'scheduled' || agent.state === 'hibernated') return true;
  // Ended, as Wake would restart it: not a reviewer whose round ended, nor a harness in its shell.
  return agent.endedAt !== null && (agent.reviewOf ?? null) === null && (agent.shellHarness ?? null) === null;
}

/** How an ended agent that isn't asleep ended: exited on an error (the daemon's `failed`), else done. */
export type EndedAs = 'done' | 'exited';

/** How the agent ended, or undefined while it is live or asleep (paused, or stopped by a restart). */
export function endedAs(agent: Pick<Agent, 'endedAt' | 'state'>): EndedAs | undefined {
  if (agent.endedAt === null || asleep(agent)) return undefined;
  return agent.state === 'failed' ? 'exited' : 'done';
}

/** How an agent that exited on an error ended, and when: "Error (code 1) · 17:48", its code only when it isn't 0. */
export function exitedLine(agent: Pick<Agent, 'endedAt' | 'state' | 'exitCode'>): string | undefined {
  if (endedAs(agent) !== 'exited' || agent.endedAt === null) return undefined;
  const code = agent.exitCode === null || agent.exitCode === 0 ? '' : ` (code ${agent.exitCode})`;
  return `Error${code} · ${clockTime(agent.endedAt)}`;
}

/**
 * What Wake does for the agent: `resume` while it is asleep; `restart` once it is done or exited, which starts it again
 * in its worktree; `run-now` while its clock wakes it by itself (`clockWakes`), which runs its clock now and leaves
 * the clock's next time as it was. Each carries on its conversation. Undefined when nothing wakes it: it is at work, or
 * a reviewer whose round ended.
 */
export type WakeAct = 'resume' | 'restart' | 'run-now';

export function wakeAct(agent: Pick<Agent, 'endedAt' | 'state' | 'reviewOf' | 'shellHarness' | 'schedule'>): WakeAct | undefined {
  // Its clock first: one that wakes it anyway (between runs it hibernates it) runs it now, and keeps its next time.
  if (clockWakes(agent)) return 'run-now';
  if (asleep(agent)) return 'resume';
  if (canRestart(agent)) return 'restart';
  return undefined;
}

/** What Wake now does, as its hint: a scheduled agent runs at once, and its clock still fires when it would have. */
export const WAKE_NOW_HINT = 'Run it now: its clock keeps its next time';

/** Why Wake waits, its shell running something there (the daemon's `message`), and what waking does to it. */
export const wakeBusyText = (message: string): string => `${message}. Waking the agent ends it.`;

/** Where to wake it anyway, from a window: the banner over its pane, which asks first. */
export const WAKE_ANYWAY_WHERE = 'Wake on the banner over its pane asks to end it.';

/** What Wake does for a done or exited agent, as its hint. */
export const WAKE_ENDED_HINT = 'Start it again in its worktree, carrying on its conversation';

/** A shell's Wake, for its panes a restart stopped. */
export const SHELL_RESUME_HINT = 'Stopped by a restart: start its panes again where they were';

/** A shell's Wake, for a pane whose shell had ended. */
export const SHELL_RESTART_HINT = 'Its shell has ended: start a new one in this pane';

/** What a shell's Wake button says: Resume after a restart, Restart shell for one that ended. */
export function shellWakeLabel(act: 'resume' | 'restart'): { label: string; hint: string } {
  return act === 'resume' ? { label: 'Resume', hint: SHELL_RESUME_HINT } : { label: 'Restart shell', hint: SHELL_RESTART_HINT };
}

/** Wake's words and hint for the agent, by what it does: Wake now for one its clock wakes, else Wake. */
export function wakeLabel(act: WakeAct): { label: string; hint: string } {
  if (act === 'run-now') return { label: 'Wake now', hint: WAKE_NOW_HINT };
  return { label: 'Wake', hint: act === 'restart' ? WAKE_ENDED_HINT : WAKE_HINT };
}

/**
 * Pause or Wake for the agent's menu and window: Wake while it is asleep (paused, or stopped by a restart); Pause while it runs, disabled with why while
 * it is mid-turn or waiting on you. Neither for an ended agent, whose Wake restarts it (`wakeAct`).
 */
export function pauseControl(
  agent: Pick<Agent, 'endedAt' | 'state' | 'ask' | 'removeAsk' | 'plan' | 'permissions'>,
): { action: 'pause' | 'wake'; enabled: boolean; hint: string } | undefined {
  if (asleep(agent)) return { action: 'wake', enabled: true, hint: WAKE_HINT };
  if (agent.endedAt !== null) return undefined;
  const refusal = pauseRefusal(agent);
  return { action: 'pause', enabled: refusal === undefined, hint: refusal === undefined ? PAUSE_HINT : upperFirst(refusal) };
}

/**
 * A paused tile's line, in its two parts: who ("paused by Release lead", which gives way to a narrow tile first) and
 * when ("· 14 min ago", which always shows).
 */
export function pausedLine(hibernated: NonNullable<Agent['hibernated']>, now: number): { who: string; when: string } {
  return { who: `paused by ${hibernated.by ?? 'you'}`, when: ` · ${sinceText(hibernated.at, now)}` };
}

/**
 * How a frozen agent (one not at work) looks, each with a frost of its own: `paused` (paused, or stopped by a restart:
 * slate, a snowflake), `scheduled` (its clock wakes it by itself, whatever froze it: slate-blue, a clock), `done` (ended,
 * and not on an error: grey, a tick) or `exited` (ended in the daemon's `failed`, whatever its exit code: grey warmed
 * with clay, a warning). Undefined while it is live and not waiting on its clock.
 */
export type FrozenKind = 'paused' | 'scheduled' | 'done' | 'exited';

/** What the frost reads of an agent: its status (needs-you comes first), its start, its clock. */
export type FrostFacts = HumanStatusFacts & Partial<Pick<Agent, 'schedule' | 'reviewOf' | 'shellHarness' | 'startup'>>;

/**
 * Its frozen kind under `shows`. A done, exited or scheduled agent never while it needs you (its changes open, a flag,
 * a finished turn the inbox lists): that stays bright and raised. An asleep one keeps its frost even then, as the frost
 * says it. Nor a failed start, which is a problem with Try again, not a frozen agent.
 */
export function frozenKind(agent: FrostFacts, shows: NeedsYouShows): FrozenKind | undefined {
  if (agent.startup?.failed === true) return undefined;
  // A cue that asks the user to look keeps it bright, as a need does.
  const needsYou = standsOut(humanStatus(agent, shows));
  // Its clock first: an agent that comes back by itself reads so, however it was frozen.
  if (clockWakes(agent) && (!needsYou || asleep(agent))) return 'scheduled';
  if (asleep(agent)) return 'paused';
  if (needsYou) return undefined;
  return endedAs(agent);
}

/** The class that frosts a frozen agent's tile (expanded too), so it reads as frozen across the board, and its kind's. */
const FROSTED = 'tile-frosted';

/** Its tile's classes with the frost (and its kind's) added while it is frozen, and only then: waking it clears the frost at once. */
export function frostedClasses(base: string, agent: FrostFacts, shows: NeedsYouShows): string {
  const kind = frozenKind(agent, shows);
  return kind === undefined ? base : `${base} ${FROSTED} tile-frost-${kind}`;
}

/**
 * A frozen agent's chip in its expanded tile's and its window's head: its kind and the one time that matters, as of
 * `now` ("Scheduled · wakes 22:30", "Done · finished 18:02", "Exited · error 17:48"). Undefined while it is live.
 */
export function frozenChip(agent: FrostFacts, shows: NeedsYouShows, now: number = Date.now()): string | undefined {
  const at = agent.endedAt === null ? '' : clockTime(agent.endedAt);
  switch (frozenKind(agent, shows)) {
    case 'scheduled':
      return `Scheduled · wakes ${whenLabel(new Date(agent.schedule?.nextRunAt ?? now), new Date(now))}`;
    case 'paused':
      return agent.state === 'stopped-by-restart' ? 'Stopped by a restart' : 'Paused';
    case 'done':
      return at === '' ? 'Done' : `Done · finished ${at}`;
    case 'exited':
      return at === '' ? 'Exited' : `Exited · error ${at}`;
    case undefined:
      return undefined;
  }
}
