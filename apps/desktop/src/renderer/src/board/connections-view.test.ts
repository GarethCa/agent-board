import { describe, expect, it } from 'vitest';
import type { Edge } from '@xyflow/react';
import { connectionsViewFrom, edgeCounts, nextConnectionsView, shownEdges } from './connections-view';

const edge = (id: string, source: string, target: string): Edge => ({ id, source, target });
const connector = edge('connector:c1', 'a', 'b');
const brief = edge('brief:card:a', 'card', 'a');
const flow = edge('flow:f1', 'a', 'b');
const far = edge('flow:f2', 'c', 'd');
const all = [connector, brief, flow, far];
const none = new Set<string>();

describe('connectionsViewFrom', () => {
  it('reads a saved mode, and shows all otherwise', () => {
    expect(connectionsViewFrom('none')).toBe('none');
    expect(connectionsViewFrom('handoffs')).toBe('handoffs');
    expect(connectionsViewFrom('all')).toBe('all');
    expect(connectionsViewFrom(undefined)).toBe('all');
    expect(connectionsViewFrom('bogus')).toBe('all');
  });
});

describe('nextConnectionsView', () => {
  it('cycles all, hand-offs only, none', () => {
    expect(nextConnectionsView('all')).toBe('handoffs');
    expect(nextConnectionsView('handoffs')).toBe('none');
    expect(nextConnectionsView('none')).toBe('all');
  });
});

describe('shownEdges', () => {
  it('shows every edge with all', () => {
    expect(shownEdges(all, 'all', none)).toEqual(all);
  });

  it('keeps only flow edges with hand-offs only', () => {
    expect(shownEdges(all, 'handoffs', none)).toEqual([flow, far]);
  });

  it('shows nothing with none', () => {
    expect(shownEdges(all, 'none', none)).toEqual([]);
  });

  it('shows a selected edge, whatever the mode', () => {
    const picked = { ...connector, selected: true };
    expect(shownEdges([picked, flow], 'none', none)).toEqual([picked]);
    expect(shownEdges([picked, flow], 'handoffs', none)).toEqual([picked, flow]);
  });

  it('shows the edges of a revealed tile, whatever the mode', () => {
    expect(shownEdges(all, 'none', new Set(['b']))).toEqual([connector, flow]);
    expect(shownEdges(all, 'handoffs', new Set(['a']))).toEqual([connector, brief, flow, far]);
  });
});

describe('edgeCounts', () => {
  it('counts the edges at each end, from both sides', () => {
    expect(edgeCounts([connector, flow, far])).toEqual(
      new Map([
        ['a', 2],
        ['b', 2],
        ['c', 1],
        ['d', 1],
      ]),
    );
  });
});
