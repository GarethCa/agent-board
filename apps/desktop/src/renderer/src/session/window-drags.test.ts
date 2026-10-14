import { describe, expect, it } from 'vitest';
import type { Surface } from '@agent-board/daemon/window-layout';
import { draggedWithin, givesUp, surfaceDrag } from './window-drags';

const agent = { kind: 'agent', id: 'a' } as const;
const tile = { kind: 'shell', id: 't' } as const;
const shell: Surface = { kind: 'shell', shellId: 'x' };
const known = new Map<string, Surface>([
  ['own', { kind: 'own' }],
  ['shell:x', shell],
  ['session:agent:b', { kind: 'session', target: { kind: 'agent', id: 'b' } }],
]);

describe("what a window's tab drags as", () => {
  it('is a shell tab as its shell, which can leave the window; the own tab and another session as surfaces, which stay in it', () => {
    expect(surfaceDrag(shell, agent, { alone: false, canMove: true })).toEqual({ kind: 'tab', shellId: 'x', from: agent });
    expect(surfaceDrag({ kind: 'own' }, agent, { alone: true, canMove: true })).toEqual({ kind: 'surface', key: 'own', from: agent });
    expect(surfaceDrag(known.get('session:agent:b')!, agent, { alone: false, canMove: true })).toEqual({ kind: 'surface', key: 'session:agent:b', from: agent });
  });

  it("is a shell tile alone in its window as the tile, to become another's tab, where the board can move it", () => {
    expect(surfaceDrag({ kind: 'own' }, tile, { alone: true, canMove: true })).toEqual({ kind: 'tab', shellId: 't', from: tile });
    expect(surfaceDrag({ kind: 'own' }, tile, { alone: false, canMove: true })).toEqual({ kind: 'surface', key: 'own', from: tile });
    expect(surfaceDrag({ kind: 'own' }, tile, { alone: true, canMove: false })).toEqual({ kind: 'surface', key: 'own', from: tile });
  });
});

describe('a drag that stays in its window', () => {
  it("moves the surface it names, the tile's own for the tile dragged as itself, and nothing from another window or for a pane", () => {
    const of = (key: string) => known.get(key);
    expect(draggedWithin({ kind: 'surface', key: 'session:agent:b', from: agent }, agent, of)).toEqual(known.get('session:agent:b'));
    expect(draggedWithin({ kind: 'tab', shellId: 'x', from: agent }, agent, of)).toEqual(shell);
    expect(draggedWithin({ kind: 'tab', shellId: 't', from: tile }, tile, of)).toEqual({ kind: 'own' });
    expect(draggedWithin({ kind: 'tab', shellId: 'x', from: tile }, agent, of)).toBeUndefined();
    expect(draggedWithin({ kind: 'pane', shellId: 'x', sessionId: 'p', from: agent }, agent, of)).toBeUndefined();
  });

  it('gives a pane up let go in the middle of the pane showing it, not at an edge or elsewhere', () => {
    const pane = { kind: 'pane', shellId: 'x', sessionId: 'p', from: agent } as const;
    expect(givesUp(pane, { pane: 'main' }, ['p', 'q'])).toBe(true);
    expect(givesUp(pane, { pane: 'main', edge: 'left' }, ['p', 'q'])).toBe(false);
    expect(givesUp(pane, { pane: 'other' }, ['r'])).toBe(false);
    expect(givesUp({ kind: 'tab', shellId: 'x', from: agent }, { pane: 'main' }, ['p'])).toBe(false);
  });
});
