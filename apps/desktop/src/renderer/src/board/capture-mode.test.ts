import { describe, expect, it } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import { edgesAmong, nodesInZone, QUIET_FRAMES, quietCounter } from './capture-mode';
import { QUESTION_CARD_TYPE, questionNodeId } from './question-cards';
import { tileNodeId } from './tiles';

const node = (id: string, parentId?: string): Node => ({ id, position: { x: 0, y: 0 }, data: {}, ...(parentId === undefined ? {} : { parentId }) });
const edge = (source: string, target: string): Edge => ({ id: `${source}-${target}`, source, target });

describe("a capture window's canvas", () => {
  const nodes = [node('web'), node('lead', 'web'), node('note', 'web'), node('api'), node('other', 'api'), node('loose')];

  it('draws the zone and what is in it: nothing of another zone, and nothing loose', () => {
    expect(nodesInZone(nodes, 'web').map((each) => each.id)).toEqual(['web', 'lead', 'note']);
  });

  it("draws a question card of an agent in the zone, and its tether, though the card is loose on the board", () => {
    const asking = (sessionId: string): Node => ({ ...node(questionNodeId(sessionId)), type: QUESTION_CARD_TYPE, data: { sessionId } });
    const all = [node('web'), node(tileNodeId('agent', 's1'), 'web'), node(tileNodeId('agent', 's2'), 'api'), asking('s1'), asking('s2')];
    const kept = nodesInZone(all, 'web');
    expect(kept.map((each) => each.id)).toEqual(['web', tileNodeId('agent', 's1'), questionNodeId('s1')]);
    expect(edgesAmong([edge(questionNodeId('s1'), tileNodeId('agent', 's1'))], kept)).toHaveLength(1);
  });

  it('draws nothing as selected', () => {
    expect(nodesInZone([node('web'), { ...node('lead', 'web'), selected: true }], 'web').map((each) => each.selected ?? false)).toEqual([false, false]);
  });

  it('draws only the edges between what it draws', () => {
    const kept = nodesInZone(nodes, 'web');
    expect(edgesAmong([edge('lead', 'note'), edge('lead', 'other'), edge('loose', 'note')], kept).map((each) => each.id)).toEqual(['lead-note']);
  });
});

describe('quietCounter', () => {
  it(`settles once ${QUIET_FRAMES} frames pass with no change, counting again from any change`, () => {
    const counter = quietCounter(3);
    expect([counter.frame(), counter.frame()]).toEqual([false, false]);
    counter.changed();
    expect([counter.frame(), counter.frame(), counter.frame()]).toEqual([false, false, true]);
  });
});
