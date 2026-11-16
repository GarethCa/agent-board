// What a Spine zone's Clean up leaves for the board to draw: the tiles and notes its Done line holds are hidden (the
// line's chips stand for them) while their ticket is finished, and an agent that finished in a ticket still going is
// dimmed in its band.
import { startedByHand, type Agent, type Zone } from '@agent-board/daemon/protocol';
import { doneLineData, hasEnded, isFinished } from '@agent-board/daemon/zone-clean-up';
import { historyKey, type BoardHistory } from './editing/use-history';
import { ITEM_NODE_PREFIX, isItemNode } from './items/items';
import { isSessionTile, isZone, type BoardNode } from './tiles';

/** The class a finished agent's tile has while the rest of its ticket goes on. */
export const FINISHED_IN_BAND = 'finished-in-band';

/** Which ticket an agent works on, as its band is: its issue, or else the chat it helps (or its own session). */
const ticketOf = (agent: Agent): string => (agent.issue === null ? `agent:${agent.ticket ?? agent.sessionId}` : `issue:${agent.issue.id}`);

/** Every ticket of a Spine zone with an agent still going, as `<zone node id> <ticket>`. */
function goingTickets(nodes: readonly BoardNode[]): Set<string> {
  const spine = new Set(nodes.filter((node) => isZone(node) && node.data.zone.layoutRule === 'spine').map((node) => node.id));
  const going = new Set<string>();
  for (const node of nodes) {
    const agent = isSessionTile(node) ? node.data.agent : undefined;
    if (agent !== undefined && node.parentId !== undefined && spine.has(node.parentId) && !hasEnded(agent)) going.add(`${node.parentId} ${ticketOf(agent)}`);
  }
  return going;
}

/**
 * The Spine zone and session an agent's Move to Done folds, for the tile `nodeId`: only an ended agent in a band (not
 * placed by hand, nor started by the user and not among the tiles that `joined` the bands) whose whole ticket is
 * finished (not one dimmed in its band while the rest goes on). Undefined for any other tile.
 */
export function toDone(nodes: readonly BoardNode[], nodeId: string, joined: ReadonlySet<string> = new Set()): { zone: Zone; sessionId: string } | undefined {
  const node = nodes.find((each) => each.id === nodeId);
  const agent = node !== undefined && isSessionTile(node) ? node.data.agent : undefined;
  const zone = nodes.filter(isZone).find((each) => each.id === node?.parentId)?.data.zone;
  if (agent === undefined || zone?.layoutRule !== 'spine' || !hasEnded(agent)) return undefined;
  if (zone.handPlaced.includes(nodeId) || (startedByHand(agent) && !joined.has(nodeId))) return undefined;
  return goingTickets(nodes).has(`${node!.parentId} ${ticketOf(agent)}`) ? undefined : { zone, sessionId: agent.sessionId };
}

/**
 * `nodes` with every tile and item a Done line holds hidden while its ticket is finished, the Done line itself fixed where its zone put it, and each
 * ended agent of a Spine zone dimmed while another agent in its ticket is still going. The same nodes, unchanged, when
 * there is nothing to hide or dim.
 */
export function withDoneLines(nodes: readonly BoardNode[]): BoardNode[] {
  const agents = new Map(nodes.flatMap((node) => (isSessionTile(node) && node.data.agent !== undefined ? [[node.id, node.data.agent] as const] : [])));
  const hidden = new Set<string>();
  for (const node of nodes) {
    if (!isItemNode(node) || node.data.item.kind !== 'done-line') continue;
    for (const ticket of doneLineData(node.data.item.data).tickets) {
      // One no longer finished (resumed, or busy past a merge) shows: its zone puts it back on the board.
      const present = ticket.members.map((member) => agents.get(member)).filter((each) => each !== undefined);
      if (present.length > 0 && !isFinished(present)) continue;
      for (const member of ticket.members) hidden.add(member);
      for (const note of ticket.notes) hidden.add(`${ITEM_NODE_PREFIX}${note}`);
    }
  }
  const going = goingTickets(nodes);
  return nodes.map((node): BoardNode => {
    if (hidden.has(node.id)) return { ...node, hidden: true };
    if (isItemNode(node) && node.data.item.kind === 'done-line') return { ...node, draggable: false };
    const agent = isSessionTile(node) ? node.data.agent : undefined;
    if (agent === undefined || node.parentId === undefined || !hasEnded(agent) || !going.has(`${node.parentId} ${ticketOf(agent)}`)) return node;
    return { ...node, className: [node.className, FINISHED_IN_BAND].filter(Boolean).join(' ') };
  });
}

/**
 * Undoes the Clean up (or Move to Done) of the zone `zoneId`, as its toast's Undo does, only while it is still the step
 * ⌘Z would undo: false, undoing nothing, once another step came after it.
 */
export const undoCleanUp = (history: Pick<BoardHistory, 'undo' | 'undoKeys'>, zoneId: string): boolean =>
  history.undoKeys().has(historyKey.cleanUp(zoneId)) && history.undo();
