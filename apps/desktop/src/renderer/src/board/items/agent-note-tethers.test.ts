import { describe, expect, it } from 'vitest';
import type { BoardItem } from '@agent-board/daemon/protocol';
import { AGENT_NODE_PREFIX } from '../tiles';
import { itemNode } from './items';
import { agentNoteTethers, isTether, TETHER_EDGE_TYPE } from './agent-note-tethers';

const note = (id: string, sessionId: string, kind: BoardItem['kind'] = 'agent-note'): BoardItem => ({
  id,
  kind,
  zoneId: null,
  x: 0,
  y: 0,
  width: 272,
  height: 120,
  z: 1,
  rotation: 0,
  data: { text: 'x', agent: { sessionId, name: 'lead', harness: 'claude', role: 'orchestrator' }, writtenAt: '', editedByUser: false },
  createdAt: '',
  updatedAt: '',
});
const answer = (id: string, sessionId: string): BoardItem => ({ ...note(id, sessionId), data: { ...note(id, sessionId).data, asked: 'why?' } });
const tile = (sessionId: string) => ({ id: `${AGENT_NODE_PREFIX}${sessionId}`, position: { x: 0, y: 0 }, data: {} });

describe('agentNoteTethers', () => {
  it("ties each answer to its agent's tile while the tile is on the board, and nothing else", () => {
    const nodes = [itemNode(answer('n1', 'a1')), itemNode(answer('n2', 'gone')), itemNode(note('s1', 'a1', 'sticky')), tile('a1')];

    const tethers = agentNoteTethers(nodes);

    expect(tethers).toEqual([
      expect.objectContaining({ id: 'tether:item:n1', type: TETHER_EDGE_TYPE, source: 'item:n1', target: `${AGENT_NODE_PREFIX}a1`, selectable: false, deletable: false }),
    ]);
    expect(isTether(tethers[0]!)).toBe(true);
  });

  it('ties a note about no agent to none, so no connector leads to the orchestrator that wrote it', () => {
    expect(agentNoteTethers([itemNode(note('n1', 'lead')), tile('lead')])).toEqual([]);
  });

  it("ties a note about another agent to that agent's tile, never to its author's, and to none once that tile is gone", () => {
    const about = (id: string, subject: string): BoardItem => ({ ...note(id, 'lead'), data: { ...note(id, 'lead').data, about: subject } });
    const nodes = [itemNode(about('n1', 'worker')), itemNode(about('n2', 'gone')), tile('lead'), tile('worker')];

    expect(agentNoteTethers(nodes).map((edge) => [edge.source, edge.target])).toEqual([['item:n1', `${AGENT_NODE_PREFIX}worker`]]);
  });

  it("ties a plan card to its agent's tile", () => {
    const card: BoardItem = { ...note('p1', 'a1'), kind: 'plan', data: { agent: { sessionId: 'a1', name: 'a', harness: 'claude', role: null }, title: 'Plan' } };
    expect(agentNoteTethers([itemNode(card), tile('a1')]).map((edge) => [edge.source, edge.target])).toEqual([['item:p1', `${AGENT_NODE_PREFIX}a1`]]);
  });
});
