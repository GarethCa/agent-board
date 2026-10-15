import { describe, expect, it } from 'vitest';
import type { Surface } from '@agent-board/daemon/window-layout';
import { boardDrop, draggedWithin, givesUp, surfaceDrag, surfaceMoveInto } from './window-drags';

const agent = { kind: 'agent', id: 'a' } as const;
const tile = { kind: 'shell', id: 't' } as const;
const shell: Surface = { kind: 'shell', shellId: 'x' };
const known = new Map<string, Surface>([
  ['own', { kind: 'own' }],
  ['shell:x', shell],
  ['session:agent:b', { kind: 'session', target: { kind: 'agent', id: 'b' } }],
  ['pr:acme/app#41', { kind: 'pr', repo: 'acme/app', number: 41 }],
  ['web:w1', { kind: 'web', id: 'w1', url: 'http://localhost:5173/' }],
]);

describe("what a window's tab drags as", () => {
  it('is a shell tab as its shell, which can leave the window; the own tab and another session as surfaces, which stay in it', () => {
    expect(surfaceDrag(shell, agent, { alone: false, canMove: true })).toEqual({ kind: 'tab', shellId: 'x', from: agent });
    expect(surfaceDrag({ kind: 'own' }, agent, { alone: true, canMove: true })).toEqual({ kind: 'surface', surface: { kind: 'own' }, from: agent });
    expect(surfaceDrag(known.get('session:agent:b')!, agent, { alone: false, canMove: true })).toEqual({ kind: 'surface', surface: known.get('session:agent:b')!, from: agent });
  });

  it("is a PR tab as a surface, which moves and splits among the window's panes", () => {
    const drag = surfaceDrag(known.get('pr:acme/app#41')!, agent, { alone: false, canMove: true });
    expect(drag).toEqual({ kind: 'surface', surface: known.get('pr:acme/app#41')!, from: agent });
    expect(draggedWithin(drag, agent, (key) => known.get(key))).toEqual({ kind: 'pr', repo: 'acme/app', number: 41 });
    expect(draggedWithin(drag, { kind: 'agent', id: 'other' }, (key) => known.get(key))).toBeUndefined();
  });

  it("is a web tab as a surface, which moves and splits among the window's panes", () => {
    const drag = surfaceDrag(known.get('web:w1')!, agent, { alone: false, canMove: true });
    expect(drag).toEqual({ kind: 'surface', surface: known.get('web:w1')!, from: agent });
    expect(draggedWithin(drag, agent, (key) => known.get(key))).toEqual({ kind: 'web', id: 'w1', url: 'http://localhost:5173/' });
    expect(draggedWithin(drag, { kind: 'agent', id: 'other' }, (key) => known.get(key))).toBeUndefined();
  });

  it("is a shell tile alone in its window as the tile, to become another's tab, where the board can move it", () => {
    expect(surfaceDrag({ kind: 'own' }, tile, { alone: true, canMove: true })).toEqual({ kind: 'tab', shellId: 't', from: tile });
    expect(surfaceDrag({ kind: 'own' }, tile, { alone: false, canMove: true })).toEqual({ kind: 'surface', surface: { kind: 'own' }, from: tile });
    expect(surfaceDrag({ kind: 'own' }, tile, { alone: true, canMove: false })).toEqual({ kind: 'surface', surface: { kind: 'own' }, from: tile });
  });
});

describe('a tab dropped in another window', () => {
  const tabs = { kind: 'tabs', id: 'popped' } as const;
  const none = () => false;
  const pr = known.get('pr:acme/app#41')!;
  const web = known.get('web:w1')!;
  const session = known.get('session:agent:b')!;

  it('moves a pull request, web or session tab there, where it was dropped, into a session window or a tab window', () => {
    const at = { pane: 'p2', index: 1 };
    expect(surfaceMoveInto({ kind: 'surface', surface: pr, from: agent }, tile, none, at)).toEqual({ kind: 'surface', surface: pr, from: agent, to: { owner: tile, placement: at } });
    expect(surfaceMoveInto({ kind: 'surface', surface: web, from: tabs }, agent, none, at)).toEqual({ kind: 'surface', surface: web, from: tabs, to: { owner: agent, placement: at } });
    expect(surfaceMoveInto({ kind: 'surface', surface: session, from: agent }, tabs, none, at)).toEqual({ kind: 'surface', surface: session, from: agent, to: { owner: tabs, placement: at } });
  });

  it("leaves be a window's own tab, one already shown there, a session dropped on its own window, one back in its own window, and shells", () => {
    const at = { pane: 'main' };
    expect(surfaceMoveInto({ kind: 'surface', surface: pr, from: agent }, tile, none)).toEqual({ kind: 'surface', surface: pr, from: agent, to: { owner: tile } });
    expect(surfaceMoveInto({ kind: 'surface', surface: { kind: 'own' }, from: agent }, tile, none, at)).toBeUndefined();
    expect(surfaceMoveInto({ kind: 'surface', surface: pr, from: agent }, tile, (key) => key === 'pr:acme/app#41', at)).toBeUndefined();
    expect(surfaceMoveInto({ kind: 'surface', surface: session, from: tile }, { kind: 'agent', id: 'b' }, none, at)).toBeUndefined();
    expect(surfaceMoveInto({ kind: 'surface', surface: pr, from: agent }, agent, none, at)).toBeUndefined();
    expect(surfaceMoveInto({ kind: 'tab', shellId: 'x', from: agent }, tabs, none, at)).toBeUndefined();
  });
});

describe('a tab dropped on the board', () => {
  const pr = known.get('pr:acme/app#41')!;
  const session = known.get('session:agent:b')!;
  const tabs = { kind: 'tabs', id: 'popped' } as const;

  it("joins the window of the tile or window it is dropped on, as in a window", () => {
    expect(boardDrop({ kind: 'surface', surface: pr, from: agent }, tile, false)).toEqual({ kind: 'move', move: { kind: 'surface', surface: pr, from: agent, to: { owner: tile } } });
    expect(boardDrop({ kind: 'surface', surface: { kind: 'own' }, from: agent }, tile, false)).toBeUndefined();
  });

  it('on bare board: a session leaves its window, being a tile already, and a popped-out window\'s own tab pops it back in', () => {
    expect(boardDrop({ kind: 'surface', surface: session, from: tabs }, undefined, true)).toEqual({ kind: 'move', move: { kind: 'surface', surface: session, from: tabs, to: null } });
    expect(boardDrop({ kind: 'surface', surface: { kind: 'own' }, from: agent }, undefined, true)).toEqual({ kind: 'popIn', owner: agent });
    expect(boardDrop({ kind: 'surface', surface: { kind: 'own' }, from: agent }, undefined, false)).toBeUndefined();
  });

  it('leaves a pull request or web tab on bare board be: it has no tile to be', () => {
    expect(boardDrop({ kind: 'surface', surface: pr, from: agent }, undefined, true)).toBeUndefined();
    expect(boardDrop({ kind: 'surface', surface: known.get('web:w1')!, from: tabs }, undefined, true)).toBeUndefined();
  });

  it('leaves shells to the moves they have', () => {
    expect(boardDrop({ kind: 'tab', shellId: 'x', from: agent }, undefined, false)).toBeUndefined();
  });
});

describe('a drag that stays in its window', () => {
  it("moves the surface it names, the tile's own for the tile dragged as itself, and nothing from another window or for a pane", () => {
    const of = (key: string) => known.get(key);
    expect(draggedWithin({ kind: 'surface', surface: known.get('session:agent:b')!, from: agent }, agent, of)).toEqual(known.get('session:agent:b'));
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
