import { describe, expect, it } from 'vitest';
import type { Edge } from '@xyflow/react';
import { connectionsViewFrom, edgeCounts, nextConnectionsView, revealedBy, shownEdges, tethersShownFrom, typingInTile, withTethers } from './connections-view';

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

describe('tethers', () => {
  const tether = (id: string, source: string, target: string): Edge => ({ ...edge(id, source, target), type: 'tether' });
  const rail = tether('master-rail:lead', 'captain', 'lead');
  const clock = tether('clock-tether:k1', 'clock', 'a');
  const note = tether('tether:note', 'note', 'a');

  it('are off unless turned on', () => {
    expect(tethersShownFrom(true)).toBe(true);
    expect(tethersShownFrom(false)).toBe(false);
    expect(tethersShownFrom(undefined)).toBe(false);
    expect(tethersShownFrom('true')).toBe(false);
  });

  it("leave out the Captain's, the clocks' and the notes' tethers while off, and keep every other edge", () => {
    expect(withTethers([...all, rail, clock, note], false)).toEqual(all);
    expect(withTethers([...all, rail, clock, note], true)).toEqual([...all, rail, clock, note]);
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

describe('revealedBy', () => {
  it('reveals the hovered tile, but not one being typed in, and nothing for a selection', () => {
    expect([...revealedBy('a', undefined)]).toEqual(['a']);
    expect([...revealedBy('a', 'b')]).toEqual(['a']);
    expect(revealedBy('a', 'a').size).toBe(0);
    expect(revealedBy(undefined, 'a').size).toBe(0);
  });
});

describe('typingInTile', () => {
  /** An element with a tag, in the board node `nodeId` if one is given. */
  const element = (tagName: string, nodeId?: string, contentEditable = false) =>
    ({ tagName, isContentEditable: contentEditable, closest: (selector: string) => (selector === '.react-flow__node' && nodeId !== undefined ? { getAttribute: () => nodeId } : null) }) as unknown as Element;

  it("names the tile a field that has the keyboard is in: a terminal's textarea, an input, editable text, a web page", () => {
    expect(typingInTile(element('TEXTAREA', 'agent:a'))).toBe('agent:a');
    expect(typingInTile(element('INPUT', 'item:n'))).toBe('item:n');
    expect(typingInTile(element('DIV', 'item:n', true))).toBe('item:n');
    expect(typingInTile(element('WEBVIEW', 'agent:w'))).toBe('agent:w');
    expect(typingInTile(element('IFRAME', 'item:f'))).toBe('item:f');
  });

  it('names none for a tile that only has focus, a field off the board, or nothing', () => {
    expect(typingInTile(element('DIV', 'agent:a'))).toBeUndefined();
    expect(typingInTile(element('INPUT'))).toBeUndefined();
    expect(typingInTile(null)).toBeUndefined();
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
