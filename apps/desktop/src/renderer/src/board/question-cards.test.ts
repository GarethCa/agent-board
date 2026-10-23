import { describe, expect, it } from 'vitest';
import type { Agent, AgentAsk, BoardItem, Zone } from '@agent-board/daemon/protocol';
import { AGENT_TILE_SIZE } from '@agent-board/daemon/board-layout';
import { itemNode } from './items/items';
import { zoneNode } from './ZoneNode';
import { askedAgo, CARD_GAP, QUESTION_CARD_WIDTH, questionCardNodes, questionCardSize, questionTethers, questionNodeId } from './question-cards';
import { tileNodeId, type BoardNode } from './tiles';
import { TETHER_EDGE_TYPE } from './items/agent-note-tethers';

const ask = (fields: Partial<AgentAsk> = {}): AgentAsk => ({
  id: 'q1',
  question: 'Which database should I use for the job cache?',
  options: ['SQLite', 'Postgres'],
  freeText: true,
  askedAt: '2026-10-23T09:00:00.000Z',
  expiresAt: '2026-10-23T09:30:00.000Z',
  onBoard: true,
  at: null,
  ...fields,
});
const agent = (sessionId: string, asked: AgentAsk | null, fields: Partial<Agent> = {}) =>
  ({ sessionId, name: 'Pick a cache', endedAt: null, ask: asked, ...fields }) as Agent;
const tile = (sessionId: string, x: number, y: number, parentId?: string) =>
  ({ id: tileNodeId('agent', sessionId), type: 'tile', position: { x, y }, width: AGENT_TILE_SIZE.width, height: AGENT_TILE_SIZE.height, parentId, data: {} }) as unknown as BoardNode;
const sticky = (x: number, y: number, width = 200, height = 200) =>
  itemNode({ id: `s${x}:${y}`, kind: 'sticky', zoneId: null, x, y, width, height, z: 1, rotation: 0, data: { text: '' }, createdAt: '', updatedAt: '' } as BoardItem);

describe('questionCardNodes', () => {
  it('puts a card asked for the board beside its agent’s tile, on the right', () => {
    const [card] = questionCardNodes([agent('a1', ask())], [tile('a1', 100, 50)]);

    expect(card).toMatchObject({
      id: questionNodeId('a1'),
      position: { x: 100 + AGENT_TILE_SIZE.width + CARD_GAP, y: 50 },
      deletable: false,
      data: { sessionId: 'a1', ask: { id: 'q1' }, side: 'left' },
    });
    expect(card!.width).toBe(QUESTION_CARD_WIDTH);
  });

  it('shows no card for a question kept to the inbox, an ended agent, or an agent whose tile isn’t on the board', () => {
    const nodes = [tile('a1', 0, 0), tile('a2', 0, 400)];
    expect(questionCardNodes([agent('a1', ask({ onBoard: false })), agent('a2', ask(), { endedAt: '2026-10-23T09:05:00.000Z' }), agent('a3', ask()), agent('a4', null)], nodes)).toEqual([]);
  });

  it('measures a tile in a zone from the zone’s corner', () => {
    const zone = zoneNode({ id: 'z', x: 1000, y: 500, width: 900, height: 600, repoRoot: '/code', folder: '', name: 'z', color: '#4c6ef5' } as Zone);
    const [card] = questionCardNodes([agent('a1', ask())], [zone, tile('a1', 40, 60, 'z')]);
    expect(card!.position).toEqual({ x: 1040 + AGENT_TILE_SIZE.width + CARD_GAP, y: 560 });
  });

  it('finds a gap when something sits on the right: below the tile, else left, else above', () => {
    const right = sticky(100 + AGENT_TILE_SIZE.width + 30, 40);
    const below = sticky(100, 50 + AGENT_TILE_SIZE.height + 10, 300);
    const size = questionCardSize(ask());

    const [under] = questionCardNodes([agent('a1', ask())], [tile('a1', 100, 50), right]);
    expect(under).toMatchObject({ position: { x: 100, y: 50 + AGENT_TILE_SIZE.height + CARD_GAP }, data: { side: 'top' } });

    const [leftOf] = questionCardNodes([agent('a1', ask())], [tile('a1', 400, 50), sticky(400 + AGENT_TILE_SIZE.width + 30, 40), sticky(400, 50 + AGENT_TILE_SIZE.height + 10, 300)]);
    expect(leftOf).toMatchObject({ position: { x: 400 - CARD_GAP - size.width, y: 50 }, data: { side: 'right' } });

    // Nowhere free: on the right all the same, over what is there, as it floats above the board.
    const [crowded] = questionCardNodes([agent('a1', ask())], [tile('a1', 100, 50), right, below, sticky(-400, 0, 490, 400), sticky(0, -600, 600, 640)]);
    expect(crowded!.position).toEqual({ x: 100 + AGENT_TILE_SIZE.width + CARD_GAP, y: 50 });
  });

  it('keeps two cards asked at once clear of each other', () => {
    const [first, second] = questionCardNodes([agent('a1', ask()), agent('a2', ask({ id: 'q2' }))], [tile('a1', 0, 0), tile('a2', 0, AGENT_TILE_SIZE.height + 20)]);
    expect(first!.position).toEqual({ x: AGENT_TILE_SIZE.width + CARD_GAP, y: 0 });
    // Its right-hand place would overlap the first card, which reaches below the first tile: below its own tile instead.
    expect(second).toMatchObject({ position: { x: 0, y: 2 * AGENT_TILE_SIZE.height + 20 + CARD_GAP }, data: { side: 'top' } });
  });

  it('places a card by its size as drawn, once measured', () => {
    // Estimated, it fits beside the tile, over a note well below its top; drawn taller, it reaches the note.
    const note = sticky(AGENT_TILE_SIZE.width + 30, 400);
    const [estimated] = questionCardNodes([agent('a1', ask())], [tile('a1', 0, 0), note]);
    expect(estimated!.data.side).toBe('left');
    const [drawn] = questionCardNodes([agent('a1', ask())], [tile('a1', 0, 0), note], new Map([['q1', { width: QUESTION_CARD_WIDTH, height: 480 }]]));
    expect(drawn!.data.side).not.toBe('left');
  });

  it('keeps a card the user moved where they put it, with no tail', () => {
    const [card] = questionCardNodes([agent('a1', ask({ at: { x: -300, y: 900 } }))], [tile('a1', 100, 50)]);
    expect(card).toMatchObject({ position: { x: -300, y: 900 }, data: { side: null } });
  });

  it('grows with its options and reply field', () => {
    const plain = questionCardSize(ask({ options: [], freeText: true }));
    const many = questionCardSize(ask({ options: ['a', 'b', 'c', 'd'], freeText: false }));
    expect(plain.width).toBe(QUESTION_CARD_WIDTH);
    expect(many.height).toBeGreaterThan(plain.height);
  });
});

describe('questionTethers', () => {
  it('ties a card the user moved to its agent’s tile; one beside it points at it with its tail instead', () => {
    expect(questionTethers(questionCardNodes([agent('a1', ask())], [tile('a1', 0, 0)]))).toEqual([]);

    const cards = questionCardNodes([agent('a1', ask({ at: { x: 900, y: 0 } }))], [tile('a1', 0, 0)]);
    expect(questionTethers(cards)).toEqual([
      expect.objectContaining({ id: `tether:${questionNodeId('a1')}`, type: TETHER_EDGE_TYPE, source: questionNodeId('a1'), target: tileNodeId('agent', 'a1') }),
    ]);
  });
});

describe('askedAgo', () => {
  it('says how long the question has waited, in whole minutes, then hours', () => {
    const asked = '2026-10-23T09:00:00.000Z';
    const at = (minutes: number) => Date.parse(asked) + minutes * 60_000;
    expect([askedAgo(asked, at(0.5)), askedAgo(asked, at(4.9)), askedAgo(asked, at(59)), askedAgo(asked, at(125))]).toEqual(['now', '4 min', '59 min', '2 h']);
  });
});
