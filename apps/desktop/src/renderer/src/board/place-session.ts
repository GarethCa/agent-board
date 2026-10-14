// Placing a new agent or shell with the Agent and Shell tools (AG2), and what a dropped agent needs next.
import type { IssueCardData, Zone, ZoneLayout } from '@agent-board/daemon/protocol';
import { placeOnBoard } from './items/items';
import { AGENT_TILE_SIZE } from './layout';
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
 * What starting an agent in `zone` (or on bare board, undefined) needs: it starts at once with the zone's repo or a
 * group's default repo (AG2, AJ2), asks for a repo with the picker (AH1), or can't start while the zone clones.
 */
export type AgentStart = { kind: 'start' } | { kind: 'pick' } | { kind: 'refuse'; reason: string };

export function agentStartIn(zone: Pick<Zone, 'repoRoot' | 'clone' | 'defaultRepo'> | undefined): AgentStart {
  if (zone === undefined) return { kind: 'pick' };
  if (zone.clone !== null) return { kind: 'refuse', reason: whyNoAgents(zone)! };
  return zone.repoRoot !== null || zone.defaultRepo !== null ? { kind: 'start' } : { kind: 'pick' };
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
 * How an agent starts from an issue card in `zone` (undefined for a card loose on the board): the New agent dialog
 * where the zone gives a repo; else the repo picker, the issue taken from the zone that tracks it; or not at
 * all while the zone clones, or when no zone on the board tracks the issue.
 */
export type IssueStart =
  | { kind: 'dialog'; zone: Zone }
  | { kind: 'pick'; zone: Zone | undefined; issueZoneId: string }
  | { kind: 'refuse'; reason: string };

export function issueStartIn(issue: Pick<IssueCardData, 'provider' | 'id'>, zone: Zone | undefined, zones: readonly Zone[]): IssueStart {
  if (zone?.clone != null) return { kind: 'refuse', reason: whyNoAgents(zone)! };
  if (zone !== undefined && (zone.repoRoot !== null || zone.defaultRepo !== null)) return { kind: 'dialog', zone };
  const from = trackerZoneFor(issue, zones, zone);
  if (from === undefined) return { kind: 'refuse', reason: `No zone on the board takes issues from ${issueScope(issue)}` };
  return { kind: 'pick', zone, issueZoneId: from.id };
}
