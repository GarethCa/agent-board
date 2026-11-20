// A Clean up of a Spine zone, as the board's zone menu runs it: whose each note or doc is, so it can stand at the tail of
// that agent's band; which tickets are finished, so they fold into the zone's Done line; and the Done line's data. Pure:
// the daemon's pass (`orchestrator-layout.ts`) reads the board, asks these, and moves what they say.
import { tileSizeKey } from './board-layout.ts';
import type { Agent, AgentState, BoardItem, BoardItemKind, DoneLineData, DoneTicket } from './protocol.ts';

/** The item kind a Done line is: one to a Spine zone, made by its first Clean up that finds a ticket finished. */
export const DONE_LINE_KIND = 'done-line';

/**
 * What a Clean up gathers to its agent: notes and docs an agent made. Never the user's own items, nor a memory, a queue
 * or a crew card, which are the zone's.
 */
const GATHERED: readonly BoardItemKind[] = ['agent-note', 'document', 'plan', 'steps', 'todo'];

/** Whether a Clean up gathers an item of `kind` to its agent: the board keeps such an item with its tile until it is dragged. */
export const isGatheredKind = (kind: BoardItemKind): boolean => GATHERED.includes(kind);

/**
 * The tile (`agent:<session id>`) the item `item` goes to on a Clean up, or null if it stays where it is: a note the
 * user edited or dragged, an item no agent made, or one of a kind that is never gathered. A note an agent wrote about
 * another agent (`about`) goes to that one. `maker` is the session that made it, if any.
 */
export function gatherTo(item: BoardItem, maker: string | null): string | null {
  if (!GATHERED.includes(item.kind) || item.data.placedByHand === true) return null;
  if (item.kind === 'agent-note') {
    if (item.data.editedByUser === true) return null;
    if (typeof item.data.about === 'string') return tileSizeKey('agent', item.data.about);
    const author = (item.data.agent as { sessionId?: unknown } | undefined)?.sessionId;
    return typeof author === 'string' ? tileSizeKey('agent', author) : null;
  }
  return maker === null ? null : tileSizeKey('agent', maker);
}

/** The tile an item was gathered to by a Clean up, while it stays there: until the user drags it. */
export const gatheredTo = (item: BoardItem): string | null =>
  typeof item.data.gatheredTo === 'string' && item.data.placedByHand !== true ? item.data.gatheredTo : null;

/** Where a Spine zone keeps its state between layouts: its bands' places, and the agents the user started that joined them. */
export const spineViewKey = (zoneId: string) => `spine:${zoneId}`;

/** The agents the user started that joined a Spine zone's bands, from its state (`spineViewKey`) as read. */
export function spineJoined(saved: unknown): string[] {
  const joined = typeof saved === 'object' && saved !== null ? (saved as { joined?: unknown }).joined : undefined;
  return Array.isArray(joined) ? joined.filter((key): key is string => typeof key === 'string') : [];
}

/**
 * Whether `agent`'s session ended for good: not stopped by a restart (it resumes) nor hibernated (it wakes). A shell left
 * on its tile doesn't count: the agent is done all the same.
 */
export const hasEnded = (agent: Agent): boolean => agent.endedAt !== null && agent.state !== 'stopped-by-restart' && agent.state !== 'hibernated';

/** The states of a live agent that is doing nothing and asks nothing: at its prompt, or paused. */
const RESTING: ReadonlySet<AgentState> = new Set(['idle', 'done', 'hibernated', 'stopped-by-restart']);

/** Whether `agent` is at rest: ended or live but not working, and not waiting on the user (no flag to them standing). */
export const atRest = (agent: Agent): boolean => agent.flag?.to !== 'user' && (hasEnded(agent) || RESTING.has(agent.state));

/**
 * Whether a ticket's band (its agents, `members`) is finished: none of them working or waiting on the user, and every one
 * of them ended or its pull request merged. A ticket on the Done line that stops being finished goes back on the board.
 */
export function isFinished(members: readonly Agent[]): boolean {
  if (members.length === 0 || !members.every(atRest)) return false;
  return members.every(hasEnded) || members.some((agent) => agent.pullRequests.some((pr) => pr.state === 'merged'));
}

/** The Done line's chip for the finished band `key` of `members` (its agents, in band order), with its notes. */
export function doneTicketOf(key: string, members: readonly Agent[], notes: readonly string[], doneAt: string): DoneTicket {
  const issue = members.find((agent) => agent.issue !== null)?.issue ?? null;
  const prs = members.flatMap((agent) => agent.pullRequests);
  const pr = prs.find((each) => each.state === 'merged') ?? prs[0];
  return {
    key,
    issue,
    title: issue?.title ?? members[0]?.name ?? key,
    pr: pr === undefined ? null : { number: pr.number, url: pr.url },
    members: members.map((agent) => tileSizeKey('agent', agent.sessionId)),
    notes: [...notes],
    doneAt,
  };
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((each) => typeof each === 'string');

const isDoneTicket = (value: unknown): value is DoneTicket => {
  if (typeof value !== 'object' || value === null) return false;
  const ticket = value as Record<string, unknown>;
  const pr = ticket.pr as Record<string, unknown> | null;
  const issue = ticket.issue as Record<string, unknown> | null;
  return (
    typeof ticket.key === 'string' &&
    typeof ticket.title === 'string' &&
    typeof ticket.doneAt === 'string' &&
    strings(ticket.members) &&
    strings(ticket.notes) &&
    (pr === null || (typeof pr === 'object' && Number.isInteger(pr.number) && typeof pr.url === 'string')) &&
    (issue === null || (typeof issue === 'object' && typeof issue.id === 'string' && typeof issue.title === 'string'))
  );
};

/** Why `data` is not a Done line's data, or null if it is. */
export function doneLineDataProblem(data: Record<string, unknown>): string | null {
  if (!Array.isArray(data.tickets) || !data.tickets.every(isDoneTicket)) {
    return "a Done line's tickets must be a list of { key, issue, title, pr, members, notes, doneAt }";
  }
  return null;
}

/** A Done line's data as `data` holds it: what doesn't read as a ticket is dropped. */
export const doneLineData = (data: Record<string, unknown>): DoneLineData => ({
  tickets: Array.isArray(data.tickets) ? data.tickets.filter(isDoneTicket) : [],
});
