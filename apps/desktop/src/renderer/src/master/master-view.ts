// What the board master's panel and tile show (ADR-0019): which agent is the master, the zones' leads it watches, the
// rails to them, what needs the user, and its latest digest. Derived from the board's lists, never stored.
import type { Edge } from '@xyflow/react';
import { isOrchestratorRole, type Agent, type BoardItem, type NeedsYouKind, type Zone } from '@agent-board/daemon/protocol';
import { tileNodeId } from '../board/tiles';
import { agentNoteData } from '../board/items/agent-note';
import { TETHER_EDGE_TYPE } from '../board/items/agent-note-tethers';

const RAIL_EDGE_PREFIX = 'master-rail:';
/** Under the nodes, as a tether is: it leads to a tile, never across one. */
const RAIL_Z_INDEX = 0;

/** The board's master, live or ended; undefined until the user starts one. */
export const boardMaster = (agents: readonly Agent[]): Agent | undefined => agents.find((agent) => agent.master);

/**
 * The zones' leads the master watches: every live agent in a zone with the orchestrator role, and every live agent the
 * master started that orchestrates. Not the master itself.
 */
export function watchedOrchestrators(agents: readonly Agent[]): Agent[] {
  const master = boardMaster(agents);
  return agents.filter(
    (agent) =>
      !agent.master &&
      agent.endedAt === null &&
      agent.zoneId !== null &&
      (isOrchestratorRole(agent.roleName) || (master !== undefined && agent.spawnedBy === master.sessionId && agent.orchestrate !== null)),
  );
}

/** A zone in the panel's Watching list: its lead (the first watched there), and how many agents that lead started. */
export interface WatchRow {
  zone: Zone;
  lead: Agent | undefined;
  crew: number;
}

/** Each zone, in the board's order, with the lead the master watches there, if any. */
export function watchRows(zones: readonly Zone[], agents: readonly Agent[]): WatchRow[] {
  const leads = watchedOrchestrators(agents);
  return zones.map((zone) => {
    const lead = leads.find((agent) => agent.zoneId === zone.id);
    const crew = lead === undefined ? 0 : agents.filter((agent) => agent.spawnedBy === lead.sessionId).length;
    return { zone, lead, crew };
  });
}

/**
 * A dashed teal rail from the master's tile to each lead it watches, while both tiles are on the board. Drawn as a
 * tether is (with every connection shown, never counted as one hidden), from tile to tile.
 */
export function masterRails(nodeIds: ReadonlySet<string>, agents: readonly Agent[]): Edge[] {
  const master = boardMaster(agents);
  if (master === undefined) return [];
  const source = tileNodeId('agent', master.sessionId);
  if (!nodeIds.has(source)) return [];
  return watchedOrchestrators(agents).flatMap((lead) => {
    const target = tileNodeId('agent', lead.sessionId);
    if (!nodeIds.has(target)) return [];
    return [
      {
        id: `${RAIL_EDGE_PREFIX}${lead.sessionId}`,
        type: TETHER_EDGE_TYPE,
        source,
        sourceHandle: 'right',
        target,
        targetHandle: 'left',
        data: { tab: false, look: 'master' },
        selectable: false,
        deletable: false,
        focusable: false,
        zIndex: RAIL_Z_INDEX,
      },
    ];
  });
}

/** The master's digest: the agent note it wrote last, if any. */
export interface Digest {
  id: string;
  text: string;
  writtenAt: string;
}

/** The newest agent note the master wrote, by when it last wrote it. */
export function latestDigest(items: readonly BoardItem[], masterId: string): Digest | undefined {
  let latest: Digest | undefined;
  for (const item of items) {
    if (item.kind !== 'agent-note') continue;
    const note = agentNoteData(item.data);
    if (note.agent.sessionId !== masterId) continue;
    if (latest === undefined || note.writtenAt > latest.writtenAt) latest = { id: item.id, text: note.text, writtenAt: note.writtenAt };
  }
  return latest;
}

/** What a row of For you says the agent asks, in a line. */
export function askLine(agent: Agent, kind: NeedsYouKind): string {
  switch (kind) {
    case 'flagged':
      return agent.flag?.reason ?? '';
    case 'asks':
      return agent.ask?.question ?? '';
    case 'plan':
      return agent.plan === null ? '' : `Plan to review: ${agent.plan.title}`;
    case 'permission': {
      const tool = agent.permissions[0]?.toolName;
      return tool === undefined ? 'Asking for permission in its terminal' : `Asks to use ${tool}`;
    }
    case 'turn':
      return 'Its turn ended';
  }
}
