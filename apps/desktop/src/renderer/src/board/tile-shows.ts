// What an agent's tile shows at rest. The quiet tile says what the agent is doing and since when, and little else: the
// rest is on hover, in its hover card, or in its menu. Warnings always stay on the tile. Pure, so the rules are
// unit-tested; HybridTile and CalmTile draw them.
import type { Agent, AgentState } from '@agent-board/daemon/protocol';
import { branchLine } from './AgentSetup';
import { whenLabel } from './schedule';

/** The parts of an agent's tile that can be shown at rest, or left to its hover card. */
export interface TileShows {
  /** How long it has been in its state, on its pill ("running · 3m"). */
  stateTime: boolean;
  /** How far through it says it is, as a hairline on the tile's bottom edge. */
  progress: boolean;
  /** Its next scheduled run as a time to go ("in 2 h 10 m"), not a clock time. */
  wakeInWords: boolean;
  /** Its model and reasoning effort as two tags, not one. */
  setupApart: boolean;
  /** Its corner actions (Expand, Pop out, ⋯) always, not only on hover. */
  cornerAlways: boolean;
  /** Its branch row always, not only when it says more than its issue does. */
  branchAlways: boolean;
  /** Who set its status line ("set by ◎ lead"), under the line, not in the hover card. */
  setBy: boolean;
  /** That its zone's setting answered its trust screen, on the tile, not in the hover card. */
  trusted: boolean;
  /** Its muted bell in the footer, not beside its name. */
  mutedInFooter: boolean;
}

/** The quiet tile, as the board draws it by default. */
export const QUIET_TILE: TileShows = {
  stateTime: true,
  progress: true,
  wakeInWords: true,
  setupApart: false,
  cornerAlways: false,
  branchAlways: false,
  setBy: false,
  trusted: false,
  mutedInFooter: false,
};

/** Every part on the tile, as it was before the quiet tile: none of the quiet tile's additions. */
export const FULL_TILE: TileShows = {
  stateTime: false,
  progress: false,
  wakeInWords: false,
  setupApart: true,
  cornerAlways: true,
  branchAlways: true,
  setBy: true,
  trusted: true,
  mutedInFooter: true,
};

/**
 * The parts the quiet tile leaves to hover or its hover card, or draws in a quieter form, each with the words of the switch
 * that puts it back: in the order the tile draws them, top to bottom, so the list reads down the tile.
 */
export const PARTS_TO_TURN_ON: readonly { part: keyof TileShows; label: string }[] = [
  { part: 'cornerAlways', label: 'Expand, Pop out and ⋯, without hovering' },
  { part: 'branchAlways', label: 'Branch row, even when it repeats the issue' },
  { part: 'trusted', label: 'The “trusted by this zone’s setting” line' },
  { part: 'setBy', label: 'Who set its status line' },
  { part: 'setupApart', label: 'Model and reasoning as two tags' },
  { part: 'mutedInFooter', label: 'A muted bell in the footer, not by the name' },
];

/** `look` with one part turned on or off and the rest as they were. */
export function tileShowsWith(look: TileShows, part: keyof TileShows, on: boolean): TileShows {
  return tileShowsFrom({ ...look, [part]: on });
}

/**
 * The tile look as saved in Settings › Board › Agent tiles: the quiet tile, with each part saved as a yes or no read over
 * it. Anything else saved is left out, and a look the same as the quiet tile is the quiet tile itself.
 */
export function tileShowsFrom(saved: unknown): TileShows {
  if (typeof saved !== 'object' || saved === null || Array.isArray(saved)) return QUIET_TILE;
  const look: TileShows = { ...QUIET_TILE };
  for (const part of Object.keys(QUIET_TILE) as (keyof TileShows)[]) {
    const value = (saved as Record<string, unknown>)[part];
    if (typeof value === 'boolean') look[part] = value;
  }
  return sameLook(look, QUIET_TILE) ? QUIET_TILE : look;
}

/** Whether two looks show the same parts. */
export function sameLook(a: TileShows, b: TileShows): boolean {
  return (Object.keys(a) as (keyof TileShows)[]).every((part) => a[part] === b[part]);
}

/**
 * How long ago `since` was, short enough for a pill: "3m", "2h", "4d"; in `words`, "3 min", "2 h", "4 d". Nothing
 * under a minute, as a fresh state needs no clock, nor for a time that doesn't parse.
 */
export function stateAge(since: string, now: number, words = false): string | undefined {
  const minutes = Math.floor((now - Date.parse(since)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return undefined;
  const hours = Math.floor(minutes / 60);
  const [n, unit] = minutes < 60 ? [minutes, words ? ' min' : 'm'] : hours < 24 ? [hours, words ? ' h' : 'h'] : [Math.floor(hours / 24), words ? ' d' : 'd'];
  return `${n}${unit}`;
}

/**
 * The Simplified tile's times, in words, for the start of its grey line: how long it has been in its state ("12 min")
 * and, while its schedule is on, its next run ("next run in 2 h"), joined by " · ". Undefined when neither applies.
 */
export function calmTimes(agent: Pick<Agent, 'state' | 'stateSince' | 'schedule'>, now: number, shows: Pick<TileShows, 'stateTime' | 'wakeInWords'>): string | undefined {
  const parts: string[] = [];
  const age = shows.stateTime && pillShowsAge(agent.state) ? stateAge(agent.stateSince, now, true) : undefined;
  if (age !== undefined) parts.push(age);
  // An ended agent's schedule still runs: it relaunches it.
  const next = agent.schedule?.enabled === true ? agent.schedule.nextRunAt : null;
  if (shows.wakeInWords && next !== null) parts.push(`next run ${timeToGo(new Date(next), new Date(now))}`);
  return parts.length === 0 ? undefined : parts.join(' · ');
}

/**
 * Whether its pill carries the time in its state. Not while paused, as its paused line says since when, nor while it
 * starts or hands off, which take moments.
 */
export function pillShowsAge(state: AgentState): boolean {
  return state !== 'hibernated' && state !== 'starting' && state !== 'handing-off';
}

/**
 * A time to go until `date`, in words: "in 5 m", "in 2 h 10 m", "in 3 d"; "due now" once it is past. A week or more
 * away, its date reads better than a count of days ("12 Dec 09:00").
 */
export function timeToGo(date: Date, now: Date): string {
  const minutes = Math.ceil((date.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return 'due now';
  if (minutes < 60) return `in ${minutes} m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `in ${hours} h` : `in ${hours} h ${minutes % 60} m`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `in ${days} d` : whenLabel(date, now);
}

/**
 * How long until `timeToGo(at, …)` reads differently: it counts whole minutes rounded up, so it moves as each whole
 * minute before `at` passes, then once a minute after it.
 */
export function toGoChangesIn(at: string, now: number): number {
  const left = Date.parse(at) - now;
  if (!Number.isFinite(left) || left <= 0) return 60_000;
  return left % 60_000 || 60_000;
}

/** Its pill's tooltip time: "since 09:05" today, else with its day ("since Mon 09:05", "since 3 Nov 09:05"). */
export function sinceLabel(since: string, now: number): string {
  return `since ${whenLabel(new Date(since), new Date(now))}`;
}

/** The states in which an agent is at work, so its progress means something: its turn, or a command it runs. */
const AT_WORK: ReadonlySet<AgentState> = new Set<AgentState>(['running', 'thinking', 'on-command']);

/**
 * How far through it says it is, 0 to 100, for its progress hairline: only while it is at work, as a status left at
 * 100% on an idle or paused agent says nothing about now.
 */
export function tileProgress(agent: Pick<Agent, 'state' | 'status'>, shows: Pick<TileShows, 'progress'>): number | undefined {
  const progress = agent.status?.progress;
  if (!shows.progress || progress == null || !AT_WORK.has(agent.state)) return undefined;
  return Math.min(100, Math.max(0, progress));
}

/**
 * Whether its branch says more than its issue already does. A branch named for its issue ("abc-12-fix-login" for
 * ABC-12) says nothing new; nor does none. What a reviewer reviews always says something.
 */
export function branchSaysMore(agent: Pick<Agent, 'branch' | 'reviews' | 'issue'>): boolean {
  if (agent.reviews !== null) return true;
  if (agent.branch === '') return false;
  if (agent.issue === null) return true;
  const id = agent.issue.id.toLowerCase();
  const branch = agent.branch.toLowerCase().split('/').at(-1)!;
  return branch !== id && !branch.startsWith(`${id}-`);
}

/**
 * Its hover card's details, one line each: what it says it is for, which no tile shows, and what the quiet tile leaves
 * off. Empty when none applies.
 */
export function tileDetails(
  agent: Pick<Agent, 'branch' | 'reviews' | 'issue' | 'trustedByZone' | 'status' | 'purpose'>,
  shows: TileShows,
  branchShown: boolean,
): string[] {
  const lines: string[] = [];
  if (agent.purpose) lines.push(`For: ${agent.purpose}`);
  if (!branchShown && branchLine(agent) !== '') lines.push(`Branch: ${branchLine(agent)}`);
  if (!shows.setBy && agent.status?.setBy != null) lines.push(`Status set by ${agent.status.setBy}`);
  if (!shows.trusted && agent.trustedByZone) lines.push("Trusted by its zone's setting: Claude's trust screen was answered by that setting, not by you");
  return lines;
}
