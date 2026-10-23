// Placing a new agent or shell with the Agent and Shell tools, and what a dropped agent needs next.
import type { IssueCardData, Zone, ZoneLayout } from '@agent-board/daemon/protocol';
import { placeOnBoard } from './items/items';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { whyNoAgents } from './ZoneNode';

/** The grid a dropped tile's corner snaps to, px. */
const DROP_GRID = 20;

/**
 * Where a new session tile dropped with its centre at board point `at` goes: in the zone it is over (relative to it)
 * or loose on the board, its top-left corner on the `DROP_GRID`.
 */
export function dropPlace(
  at: { x: number; y: number },
  zones: readonly (ZoneLayout & { id: string })[],
): { zoneId: string | null; x: number; y: number } {
  const snap = (value: number) => Math.round(value / DROP_GRID) * DROP_GRID;
  const corner = { x: snap(at.x - AGENT_TILE_SIZE.width / 2), y: snap(at.y - AGENT_TILE_SIZE.height / 2) };
  return placeOnBoard(corner, AGENT_TILE_SIZE, zones);
}

/**
 * What starting an agent in `zone` (or on bare board, undefined) needs: it starts at once in a repo zone, asks in the
 * New agent dialog (with its Repo field) in a group or on bare board, or can't start while the zone clones.
 */
export type AgentStart = { kind: 'start' } | { kind: 'dialog' } | { kind: 'refuse'; reason: string };

export function agentStartIn(zone: Pick<Zone, 'repoRoot' | 'clone' | 'defaultRepo'> | undefined): AgentStart {
  if (zone === undefined) return { kind: 'dialog' };
  if (zone.clone !== null) return { kind: 'refuse', reason: whyNoAgents(zone)! };
  return zone.repoRoot !== null ? { kind: 'start' } : { kind: 'dialog' };
}

/** The tracker scope an issue is in, from its ID: a Linear team's key (`ACME-12` → `ACME`), a GitHub repo (`o/r#3` → `o/r`). */
export function issueScope(issue: Pick<IssueCardData, 'provider' | 'id'>): string {
  return issue.provider === 'github' ? issue.id.slice(0, issue.id.lastIndexOf('#')) : issue.id.slice(0, issue.id.lastIndexOf('-'));
}

type TrackedZone = Pick<Zone, 'id' | 'tracker'>;

/** The zone whose tracker the issue is in: `preferred` (its card's zone) if that is it, else the first zone that is. */
export function trackerZoneFor<Z extends TrackedZone>(issue: Pick<IssueCardData, 'provider' | 'id'>, zones: readonly Z[], preferred?: Z): Z | undefined {
  const scope = issueScope(issue);
  const tracks = (zone: Z) => zone.tracker?.provider === issue.provider && zone.tracker.scope.toLowerCase() === scope.toLowerCase();
  return preferred !== undefined && tracks(preferred) ? preferred : zones.find(tracks);
}

/**
 * How an agent starts from an issue card in `zone` (undefined for a card loose on the board): in the New agent dialog,
 * the issue taken from `issueZoneId`, the zone that tracks it (the card's own first); with a Repo field where the zone
 * gives no repo. Or not at all while the zone clones, or when no zone on the board tracks the issue.
 */
export type IssueStart = { kind: 'dialog'; zone: Zone | undefined; issueZoneId: string } | { kind: 'refuse'; reason: string };

export function issueStartIn(issue: Pick<IssueCardData, 'provider' | 'id'>, zone: Zone | undefined, zones: readonly Zone[]): IssueStart {
  if (zone?.clone != null) return { kind: 'refuse', reason: whyNoAgents(zone)! };
  const from = trackerZoneFor(issue, zones, zone);
  if (from === undefined) return { kind: 'refuse', reason: `No zone on the board takes issues from ${issueScope(issue)}` };
  return { kind: 'dialog', zone, issueZoneId: from.id };
}
