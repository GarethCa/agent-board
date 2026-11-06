// The scope of a board item agents read and write through its own methods (a steps card): where it sits. In a zone it
// is that zone's agents' and the orchestrators' whose scope reaches the zone; loose, every agent's; and always the
// agents it is about.
import type { Agent, BoardItem } from './protocol.ts';

/** Whether the agent's orchestrator scope reaches the zone `zoneId`. */
export type ReachesZone = (agent: Agent, zoneId: string) => boolean;

/** Whether `agent` reads `item`: loose, in its zone or one its scope reaches, or one it is part of (`involved`). */
export function readsItem(agent: Agent, item: Pick<BoardItem, 'zoneId'>, involved: boolean, reachesZone: ReachesZone): boolean {
  return item.zoneId === null || item.zoneId === agent.zoneId || involved || reachesZone(agent, item.zoneId);
}
