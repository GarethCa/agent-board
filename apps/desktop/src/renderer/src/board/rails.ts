// Linked sessions as one rail (CD4): the edges between two agents are drawn as one line with no arrowheads,
// and the latest document rides it as a token, at the end of whoever has it. The edges stay apart in the data (their
// rules, conditions and payloads); only the drawing merges them.
import type { ConnectorSide, FlowEdge, FlowEdgeShape, UpdateFlowEdgeParams } from '@agent-board/daemon/protocol';
import type { Rect } from '../geometry';
import { autoSides } from './connectors/endpoints';
import { deliveredLabel, heldLabel, waitsFor } from './flow-edges';

/**
 * The edges between two agents, drawn as one: from the `from` end of the edge made first to its `to` end. With edges
 * both ways it is a pair's rail; with one way only, it has an arrow at the receiving end.
 */
export interface Rail {
  /** The drawn edge's id: its first edge's, so it stays the same as another edge joins it. */
  id: string;
  from: string;
  to: string;
  /** Oldest first. */
  edges: FlowEdge[];
}

/** One rail for each two agents with an edge between them, either way, in the order their first edges were made. */
export function railsOf(edges: readonly FlowEdge[]): Rail[] {
  const pairs = new Map<string, FlowEdge[]>();
  for (const edge of [...edges].sort(byMade)) {
    const key = [edge.from, edge.to].sort().join('\n');
    pairs.set(key, [...(pairs.get(key) ?? []), edge]);
  }
  return [...pairs.values()].map((joined) => ({ id: joined[0]!.id, from: joined[0]!.from, to: joined[0]!.to, edges: joined }));
}

/** The rail `edge` is on, among `edges`. */
export function railOf(edges: readonly FlowEdge[], edge: FlowEdge): Rail {
  return railsOf(edges.filter((other) => (other.from === edge.from && other.to === edge.to) || (other.from === edge.to && other.to === edge.from)))[0]!;
}

const byMade = (a: FlowEdge, b: FlowEdge) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** Whether a rail's agents hand work both ways: its token then says which round it is on. */
export const isLinkedPair = (rail: Pick<Rail, 'edges' | 'from'>): boolean => rail.edges.some((edge) => edge.from !== rail.from);

/**
 * What a rail's token shows of its edge: a hand-off on its way (`sending`), `held`
 * by a condition, `queued` for the receiver's turn, `waiting` for Send, its last delivery `delivered` or `failed`, or,
 * before its first, what comes `next`.
 */
export type TokenState = 'sending' | 'held' | 'queued' | 'waiting' | 'delivered' | 'failed' | 'next';

export interface RailToken {
  /** The edge whose document it is. */
  edge: FlowEdge;
  state: TokenState;
  /** Whose end of the rail it sits at: the sender's, until it is delivered. */
  end: 'from' | 'to';
  /** A linked pair's round: how many times its edge has delivered, counting one on its way or waiting to go. */
  round?: number;
  /** The line under it: when it was delivered, what holds it, what comes next. */
  note?: string;
  /** A held one's conditions, as how many pass of how many (`1/2`). */
  passing?: string;
}

/**
 * What the board knows that a rail's edges don't: the edges a hand-off is going along, and the agents done with their
 * turn, each with when its last turn ended (`Agent.finishedAt`; null before its first).
 */
export interface RailContext {
  live: ReadonlySet<string>;
  ready: ReadonlyMap<string, string | null>;
  now: Date;
}

/**
 * The latest document on `rail`: a hand-off on its way first; then the newest of those waiting at their sender (held,
 * queued or waiting for Send); then the last delivered (or skipped); else what comes next on the edge made first.
 *
 * A manual edge is waiting for Send while its agent is done with its turn (`ready`) and that turn ended after the edge
 * last delivered, or the edge has never delivered: its agent has something it hasn't sent. A one-off edge never waits:
 * its agent hands off along it mid-turn, and Send would only replay what it already carried.
 */
export function railToken(rail: Rail, context: RailContext): RailToken {
  const linked = isLinkedPair(rail);
  const states = rail.edges.map((edge) => stateOf(edge, context));
  const [rank, since] = [(state: EdgeState) => RANKS[state.state], (state: EdgeState) => state.since ?? ''];
  const latest = states.reduce((best, state) => {
    if (rank(state) !== rank(best)) return rank(state) < rank(best) ? state : best;
    return since(state) > since(best) ? state : best;
  });
  return tokenOf(latest, linked, context.now);
}

/** Which states a rail's token shows first: one on its way, then one waiting to go, then the last that went. */
const RANKS: Record<TokenState, number> = { sending: 0, held: 1, queued: 1, waiting: 1, delivered: 2, failed: 2, next: 3 };

interface EdgeState {
  edge: FlowEdge;
  state: TokenState;
  /** Since when it has been in it, to pick the newest of the same rank. */
  since?: string;
}

function stateOf(edge: FlowEdge, { live, ready }: RailContext): EdgeState {
  if (live.has(edge.id)) return { edge, state: 'sending' };
  if (edge.held !== null) return { edge, state: 'held', since: edge.held.since };
  if (edge.queued !== null) return { edge, state: 'queued', since: edge.queued.since };
  const sent = edge.lastDelivery?.delivered === true ? edge.lastDelivery.at : undefined;
  const finished = ready.get(edge.from) ?? null;
  if (edge.trigger === 'manual' && !edge.oneOff && !edge.paused && ready.has(edge.from) && (sent === undefined || (finished !== null && finished > sent))) {
    return { edge, state: 'waiting', since: finished ?? edge.createdAt };
  }
  if (edge.lastDelivery !== null) return { edge, state: edge.lastDelivery.delivered ? 'delivered' : 'failed', since: edge.lastDelivery.at };
  // Of those yet to carry anything, the edge made first leads: the first of a rank is kept on a tie.
  return { edge, state: 'next' };
}

function tokenOf({ edge, state }: EdgeState, linked: boolean, now: Date): RailToken {
  const end = state === 'sending' || state === 'delivered' ? 'to' : 'from';
  // On its way or waiting to go, it is the round after the last it delivered; a hand-off just delivered is still shown
  // going, and has been counted.
  const going = state === 'held' || state === 'queued' || state === 'waiting' || (state === 'sending' && edge.delivering);
  const round = !linked || state === 'next' ? undefined : edge.deliveries + (going ? 1 : 0);
  const token: RailToken = { edge, state, end, ...(round !== undefined && round > 0 && { round }) };
  const note = noteOf(edge, state, now);
  if (note !== undefined) token.note = note;
  if (state === 'held' && edge.conditions.length > 0) {
    token.passing = `${edge.checks.filter((check) => check?.passed === true).length}/${edge.conditions.length}`;
  }
  return token;
}

function noteOf(edge: FlowEdge, state: TokenState, now: Date): string | undefined {
  switch (state) {
    case 'sending':
      return 'sending…';
    case 'held':
      return edge.paused ? `paused · ${heldLabel(edge)}` : heldLabel(edge);
    case 'queued':
      return edge.paused ? 'paused · queued' : 'queued';
    case 'waiting':
      return undefined;
    case 'failed':
      return edge.paused ? 'paused' : 'skipped';
    case 'delivered':
      return edge.paused ? 'paused' : deliveredLabel(edge, now);
    case 'next':
      if (edge.paused) return 'paused';
      if (edge.conditions[0] !== undefined) return `on ${waitsFor(edge.conditions[0])}`;
      return edge.trigger === 'manual' ? 'on send' : 'when done';
  }
}

/**
 * The edges selected once a rail of `ids` is: picked, the one of its edges already selected stays (the direction its
 * Edge rules show), else its token's (`lead`); unpicked, none of them.
 */
export function withRailSelected(current: ReadonlySet<string>, ids: readonly string[], selected: boolean, lead: string): Set<string> {
  if (!selected) return new Set([...current].filter((id) => !ids.includes(id)));
  return ids.some((id) => current.has(id)) ? new Set(current) : new Set([...current, lead]);
}

/**
 * The changes that move `rail`'s `which` end onto agent `agent` (BT1): each of its edges takes `agent` in place of the
 * one it left, and its edge made first, whose shape it is drawn in, takes `shape` too.
 */
export function railMoved(
  rail: Rail,
  which: 'from' | 'to',
  agent: string,
  shape: Pick<FlowEdgeShape, 'fromSide' | 'toSide' | 'points'>,
): [string, Omit<UpdateFlowEdgeParams, 'id'>][] {
  const left = which === 'from' ? rail.from : rail.to;
  return rail.edges.map((edge, index) => [
    edge.id,
    { ...(edge.from === left ? { from: agent } : { to: agent }), ...(index === 0 && shape) },
  ]);
}

/**
 * Why `rail`'s `which` end can't move onto agent `agent`, among all the board's `edges`, or undefined if it can: as
 * the daemon would refuse it, onto the agent at its other end, onto a pair already joined the same way by an edge not
 * on it (which would leave a linked pair split across two rails), or closing a loop of auto edges. Checked whole, before
 * any of its edges is sent, so a rail never half moves.
 */
export function railMoveRefused(rail: Rail, which: 'from' | 'to', agent: string, edges: readonly FlowEdge[]): string | undefined {
  const left = which === 'from' ? rail.from : rail.to;
  const onRail = new Set(rail.edges.map((edge) => edge.id));
  const moved = edges.map((edge) =>
    !onRail.has(edge.id) ? edge : { ...edge, from: edge.from === left ? agent : edge.from, to: edge.to === left ? agent : edge.to },
  );
  for (const edge of moved.filter((each) => onRail.has(each.id))) {
    if (edge.from === edge.to) return 'an edge can not join an agent to itself';
    if (moved.some((other) => other.id !== edge.id && other.from === edge.from && other.to === edge.to)) return 'an edge already joins those agents that way';
  }
  if (closesAutoLoop(moved)) return 'its auto edges would close a loop';
  return undefined;
}

/** Whether `edges`' auto edges make a loop: agents that would answer each other for ever. */
function closesAutoLoop(edges: readonly FlowEdge[]): boolean {
  const next = new Map<string, string[]>();
  for (const { from, to, trigger } of edges) if (trigger === 'auto') next.set(from, [...(next.get(from) ?? []), to]);
  const done = new Set<string>();
  const visiting = new Set<string>();
  const loops = (agent: string): boolean => {
    if (visiting.has(agent)) return true;
    if (done.has(agent)) return false;
    visiting.add(agent);
    const found = (next.get(agent) ?? []).some(loops);
    visiting.delete(agent);
    done.add(agent);
    return found;
  };
  return [...next.keys()].some(loops);
}

/** A token's place among those off the same side of the same tile: which of how many, so none lies on another. */
export interface TokenSlot {
  index: number;
  count: number;
}

/**
 * Each rail's token's slot among the tokens off the same side of the same tile (an orchestrator fanning out to its
 * workers, a merger with several edges in), by rail id. The side is the one its rail ends on there, as it is drawn
 * (`autoSides`, from the tiles' `rectOf` on the board); they are ordered as the tiles at the rails' other ends lie
 * along that side, so they fan out as the rails do.
 */
export function tokenSlots(rails: readonly { rail: Rail; token: RailToken }[], rectOf: (sessionId: string) => Rect | undefined): Map<string, TokenSlot> {
  const sides = new Map<string, { id: string; along: number }[]>();
  for (const { rail, token } of rails) {
    const [first] = rail.edges;
    const at = token.end === 'from' ? token.edge.from : token.edge.to;
    const other = at === rail.from ? rail.to : rail.from;
    const ends = autoSides(first!.fromSide, first!.toSide, rectOf(rail.from), rectOf(rail.to));
    const side: ConnectorSide = at === rail.from ? ends.fromSide : ends.toSide;
    const far = rectOf(other);
    const along = far === undefined ? 0 : side === 'left' || side === 'right' ? far.y + far.height / 2 : far.x + far.width / 2;
    const key = `${at}\n${side}`;
    sides.set(key, [...(sides.get(key) ?? []), { id: rail.id, along }]);
  }
  const slots = new Map<string, TokenSlot>();
  for (const shared of sides.values()) {
    shared.sort((a, b) => a.along - b.along || a.id.localeCompare(b.id));
    shared.forEach(({ id }, index) => slots.set(id, { index, count: shared.length }));
  }
  return slots;
}
