import { describe, expect, it } from 'vitest';
import type { Agent, BoardItem } from '@agent-board/daemon/protocol';
import { itemNode } from './items/items';
import { AGENT_NODE_PREFIX } from './tiles';
import { BRIEF_EDGE_TYPE, briefEdges, issueCardFor } from './brief-edges';

const card = (id: string, data: Partial<BoardItem['data']> = {}): BoardItem => ({
  id,
  kind: 'issue',
  zoneId: null,
  x: 0,
  y: 0,
  width: 240,
  height: 110,
  z: 1,
  data: { provider: 'linear', id: 'ACME-58', title: 'Movable sessions', url: 'https://linear.app/x/ACME-58', state: 'Todo', ...data },
  createdAt: '',
  updatedAt: '',
});

const agent = (sessionId: string, issue: Agent['issue']) => ({ sessionId, issue }) as Agent;
const tile = (sessionId: string) => ({ id: `${AGENT_NODE_PREFIX}${sessionId}`, position: { x: 0, y: 0 }, data: {} });

describe('briefEdges', () => {
  it("joins each issue card to the agents linked to its issue, from the card's right to the tile's left", () => {
    const nodes = [itemNode(card('c1')), itemNode(card('c2', { id: 'ACME-1' })), tile('a1'), tile('a2'), tile('a3')];
    const agents = [
      agent('a1', { provider: 'linear', id: 'ACME-58', title: '', url: '' }),
      agent('a2', null),
      agent('a3', { provider: 'github', id: 'ACME-58', title: '', url: '' }),
    ];

    expect(briefEdges(nodes, agents)).toEqual([
      expect.objectContaining({
        type: BRIEF_EDGE_TYPE,
        source: 'item:c1',
        sourceHandle: 'right',
        target: `${AGENT_NODE_PREFIX}a1`,
        targetHandle: 'left',
        selectable: false,
        deletable: false,
      }),
    ]);
  });

  it('leaves out an agent whose tile is not on the board', () => {
    const nodes = [itemNode(card('c1'))];
    expect(briefEdges(nodes, [agent('a1', { provider: 'linear', id: 'ACME-58', title: '', url: '' })])).toEqual([]);
  });
});

describe('issueCardFor', () => {
  it('finds a card of the issue in the zone, if there is one', () => {
    const nodes = [itemNode({ ...card('c1'), zoneId: 'z1' }), itemNode(card('c2'))];
    expect(issueCardFor(nodes, { provider: 'linear', id: 'ACME-58' }, 'z1')?.id).toBe('item:c1');
    expect(issueCardFor(nodes, { provider: 'linear', id: 'ACME-58' }, null)?.id).toBe('item:c2');
    expect(issueCardFor(nodes, { provider: 'linear', id: 'ACME-9' }, 'z1')).toBeUndefined();
  });
});
