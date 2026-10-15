import { describe, expect, it } from 'vitest';
import type { PaneLayout } from '@agent-board/daemon/pane-layout';
import type { Shell, ShellOwner } from '@agent-board/daemon/protocol';
import { dropMove, foreignFolder, placeOf, surfaceMoveChanges, tabMoveChanges, tilesFirst, type TabDrag } from './shell-moves';

const agentA: ShellOwner = { kind: 'agent', id: 'agent-a' };
const agentB: ShellOwner = { kind: 'agent', id: 'agent-b' };
const tile: ShellOwner = { kind: 'shell', id: 'tile' };
const board = { tile: { zoneId: 'zone', x: 10, y: 20, toFront: true } };

const pane = (sessionId: string): PaneLayout => ({ type: 'pane', sessionId });
const shell = (id: string, fields: Partial<Shell> = {}): Shell =>
  ({ id, name: id, layout: pane(`${id}-pane`), owner: agentA, zoneId: null, position: null, tabOrder: 1, paneFolders: {}, ...fields }) as Shell;

describe('dropMove', () => {
  const tab: TabDrag = { kind: 'tab', shellId: 'sh', from: agentA };
  const split: TabDrag = { kind: 'pane', shellId: 'sh', sessionId: 'p2', from: agentA };

  it("moves a tab to another owner's tabs or onto the board", () => {
    expect(dropMove(tab, { owner: agentB })).toEqual({ kind: 'tab', shellId: 'sh', to: { owner: agentB } });
    expect(dropMove(tab, board)).toEqual({ kind: 'tab', shellId: 'sh', to: board });
  });

  it('leaves a tab dropped back on its own window be, and a shell tile dropped on itself', () => {
    expect(dropMove(tab, { owner: agentA })).toBeUndefined();
    expect(dropMove({ kind: 'tab', shellId: 'tile', from: tile }, { owner: tile })).toBeUndefined();
  });

  it('moves a pane out of its split anywhere, its own window too, where it becomes a tab of its own', () => {
    expect(dropMove(split, { owner: agentA })).toEqual({ kind: 'pane', shellId: 'sh', sessionId: 'p2', to: { owner: agentA } });
    expect(dropMove(split, board)).toEqual({ kind: 'pane', shellId: 'sh', sessionId: 'p2', to: board });
    expect(dropMove(split, { owner: agentA }, 'p1')).toEqual({ kind: 'pane', shellId: 'sh', sessionId: 'p2', to: { owner: agentA } });
  });

  it('leaves a pane let go over itself be, as a drag given up', () => {
    expect(dropMove(split, { owner: agentA }, 'p2')).toBeUndefined();
  });
});

describe('surfaceMoveChanges', () => {
  const pr = { kind: 'pr', repo: 'acme/app', number: 7 } as const;
  const tabs = { kind: 'tabs', id: 'popped' } as const;

  it('records which window a tab was in and where, and where it went, each with the window it leaves when put back', () => {
    expect(surfaceMoveChanges({ kind: 'surface', surface: pr, from: agentA, to: { owner: agentB, placement: { pane: 'p', edge: 'left' } } }, { pane: 'main', index: 2 })).toEqual([
      [
        'surface:pr:acme/app#7',
        { type: 'surfacePlace', surface: pr, in: { owner: agentA, placement: { pane: 'main', index: 2 } }, from: agentB },
        { type: 'surfacePlace', surface: pr, in: { owner: agentB, placement: { pane: 'p', edge: 'left' } }, from: agentA },
      ],
    ]);
  });

  it('records a tab popped out into a tab window of its own, or out of every window', () => {
    expect(surfaceMoveChanges({ kind: 'surface', surface: pr, from: agentA, to: { owner: tabs } }, { pane: 'main', index: 1 })[0]![2]).toEqual({
      type: 'surfacePlace',
      surface: pr,
      in: { owner: tabs },
      from: agentA,
    });
    expect(surfaceMoveChanges({ kind: 'surface', surface: pr, from: agentA, to: null }, { pane: 'main', index: 1 })[0]!.slice(1)).toEqual([
      { type: 'surfacePlace', surface: pr, in: { owner: agentA, placement: { pane: 'main', index: 1 } }, from: null },
      { type: 'surfacePlace', surface: pr, in: null, from: agentA },
    ]);
  });
});

describe('placeOf', () => {
  it("is a tab's owner, or a tile's place on the board", () => {
    expect(placeOf(shell('sh'))).toEqual({ owner: agentA });
    expect(placeOf(shell('t', { owner: null, zoneId: 'z', position: { x: 1, y: 2, z: 3 } }))).toEqual({ tile: { zoneId: 'z', x: 1, y: 2, z: 3 } });
    expect(placeOf(shell('t', { owner: null, zoneId: null, position: { x: 1, y: 2, z: null } }))).toEqual({ tile: { zoneId: null, x: 1, y: 2 } });
  });

  it('is unknown for a tile not placed yet', () => {
    expect(placeOf(shell('t', { owner: null, position: null }))).toBeUndefined();
  });
});

describe('tabMoveChanges', () => {
  it('records where each moved shell was and went, with its order', () => {
    const before = [shell('t', { owner: null, position: { x: 1, y: 2, z: 3 }, tabOrder: null }), shell('tab', { owner: tile, tabOrder: 4 })];
    const after = [shell('t', { owner: agentA, tabOrder: 7 }), shell('tab', { owner: agentA, tabOrder: 8 })];

    expect(tabMoveChanges(before, after)).toEqual([
      ['shell:t', { type: 'shellPlace', to: { tile: { zoneId: null, x: 1, y: 2, z: 3 } }, order: null }, { type: 'shellPlace', to: { owner: agentA }, order: 7 }],
      ['shell:tab', { type: 'shellPlace', to: { owner: tile }, order: 4 }, { type: 'shellPlace', to: { owner: agentA }, order: 8 }],
    ]);
  });

  it('leaves out a shell it knew no place for', () => {
    expect(tabMoveChanges([shell('t', { owner: null, position: null })], [shell('t')])).toEqual([]);
  });
});

describe('tilesFirst', () => {
  it('puts shells going onto the board before shells going into tabs, so a tile is back before its tabs return to it', () => {
    const intoTabs = { to: { owner: tile } };
    const onBoard = { to: board };
    expect(tilesFirst([intoTabs, onBoard])).toEqual([onBoard, intoTabs]);
  });
});

describe('foreignFolder', () => {
  const worktrees = [
    { name: 'impl-auth', worktree: '/w/impl-auth' },
    { name: 'review-auth', worktree: '/w/review-auth' },
  ];
  const tab = shell('dev', { name: 'pnpm dev', layout: pane('p1'), paneFolders: { p1: '/w/impl-auth/apps/web' } });

  it("names the agent whose worktree a shell runs in, outside its own agent's", () => {
    expect(foreignFolder([tab], 'agent-b', '/w/review-auth', worktrees)).toBe("pnpm dev runs in impl-auth's worktree");
  });

  it("says a shell runs outside the worktree when it is in no agent's", () => {
    const astray = shell('sh', { name: 'sh', layout: pane('p1'), paneFolders: { p1: '/tmp' } });
    expect(foreignFolder([astray], 'agent-b', '/w/review-auth', worktrees)).toBe('sh runs outside this worktree');
  });

  it("says nothing of a shell in its agent's worktree, or of the agent's own pane", () => {
    const home = shell('sh', { layout: pane('p1'), paneFolders: { p1: '/w/review-auth/src' } });
    const own = shell('own', { layout: pane('agent-b'), paneFolders: { 'agent-b': '/elsewhere' } });
    expect(foreignFolder([home, own], 'agent-b', '/w/review-auth', worktrees)).toBeUndefined();
  });

  it('names a labelled pane by its label', () => {
    const labelled = shell('sh', { name: 'sh', layout: { type: 'pane', sessionId: 'p1', name: 'server' }, paneFolders: { p1: '/w/impl-auth' } });
    expect(foreignFolder([labelled], 'agent-b', '/w/review-auth', worktrees)).toBe("server runs in impl-auth's worktree");
  });
});
