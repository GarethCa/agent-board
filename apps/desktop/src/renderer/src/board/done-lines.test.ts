import { describe, expect, it } from 'vitest';
import type { Agent, BoardItem, Zone } from '@agent-board/daemon/protocol';
import { itemNode } from './items/items';
import type { TileNodeType } from './tile';
import type { BoardNode } from './tiles';
import { zoneNode } from './ZoneNode';
import { FINISHED_IN_BAND, toDone, undoCleanUp, withDoneLines } from './done-lines';
import { historyKey } from './editing/use-history';

const zone = (id: string, layoutRule: Zone['layoutRule'], handPlaced: string[] = []) =>
  zoneNode({ id, x: 0, y: 0, width: 800, height: 300, repoRoot: null, folder: '', name: id, color: '#4c6ef5', spacing: 'normal', layoutMode: 'free', layoutRule, handPlaced } as Zone);

const issue = (id: string) => ({ provider: 'linear' as const, id, title: id, url: '' });
const agent = (sessionId: string, fields: Partial<Agent> = {}): Agent =>
  ({ sessionId, name: sessionId, state: 'running', endedAt: null, ticket: null, issue: null, pullRequests: [], spawnedBy: 'lead', orphanedFrom: null, ...fields }) as Agent;
const ended = (sessionId: string, fields: Partial<Agent> = {}) => agent(sessionId, { state: 'done', endedAt: '2026-11-15T10:00:00.000Z', ...fields });

const tile = (subject: Agent, parentId = 'z'): TileNodeType =>
  ({ id: `agent:${subject.sessionId}`, type: 'tile', parentId, position: { x: 0, y: 0 }, data: { label: subject.name, harness: 'claude', agent: subject } }) as TileNodeType;

const item = (id: string, kind: BoardItem['kind'], data: Record<string, unknown> = {}) =>
  itemNode({ id, kind, zoneId: 'z', ticket: null, x: 0, y: 0, width: 240, height: 40, z: 1, rotation: 0, data, createdAt: '', updatedAt: '' });

const doneLine = (members: string[], notes: string[]) =>
  item('line', 'done-line', { tickets: [{ key: 'issue:ACME-1', issue: issue('ACME-1'), title: 'ACME-1', pr: null, members, notes, doneAt: '' }] });

const byId = (nodes: BoardNode[], id: string) => nodes.find((node) => node.id === id)!;

describe('withDoneLines', () => {
  it("hides the tiles and notes a Done line holds, and keeps the line where its zone put it", () => {
    const nodes = withDoneLines([zone('z', 'spine'), tile(ended('a')), tile(agent('b')), item('n1', 'agent-note'), item('n2', 'agent-note'), doneLine(['agent:a'], ['n1'])]);
    expect(byId(nodes, 'agent:a').hidden).toBe(true);
    expect(byId(nodes, 'item:n1').hidden).toBe(true);
    expect(byId(nodes, 'agent:b').hidden).toBeUndefined();
    expect(byId(nodes, 'item:n2').hidden).toBeUndefined();
    expect(byId(nodes, 'item:line').draggable).toBe(false);
  });

  it('never hides a ticket that is no longer finished: one of its agents running again, or busy past a merge', () => {
    const resumed = withDoneLines([zone('z', 'spine'), tile(agent('a', { state: 'idle' })), item('n1', 'agent-note'), doneLine(['agent:a'], ['n1'])]);
    expect(byId(resumed, 'agent:a').hidden).toBeUndefined();
    expect(byId(resumed, 'item:n1').hidden).toBeUndefined();
    const merged = [{ number: 4, title: 'pr', url: '', state: 'merged' as const, checks: 'none' as const }];
    const busy = withDoneLines([zone('z', 'spine'), tile(ended('a', { pullRequests: merged })), tile(agent('b')), doneLine(['agent:a', 'agent:b'], [])]);
    expect(byId(busy, 'agent:a').hidden).toBeUndefined();
    expect(byId(busy, 'agent:b').hidden).toBeUndefined();
    // At rest past its merge, it stays folded.
    const resting = withDoneLines([zone('z', 'spine'), tile(ended('a', { pullRequests: merged })), tile(agent('b', { state: 'idle' })), doneLine(['agent:a', 'agent:b'], [])]);
    expect(byId(resting, 'agent:b').hidden).toBe(true);
  });

  it('dims an agent that finished while the rest of its ticket goes on', () => {
    const nodes = withDoneLines([
      zone('z', 'spine'),
      tile(ended('reviewer', { issue: issue('ACME-2') })),
      tile(agent('builder', { issue: issue('ACME-2') })),
      tile(ended('alone', { issue: issue('ACME-3') })),
    ]);
    expect(byId(nodes, 'agent:reviewer').className).toBe(FINISHED_IN_BAND);
    expect(byId(nodes, 'agent:builder').className).toBeUndefined();
    // A ticket all of whose agents ended waits for Clean up to fold it: nothing to dim it against.
    expect(byId(nodes, 'agent:alone').className).toBeUndefined();
  });

  it("dims a helper that finished while its ticket's chat goes on, and only in a Spine zone", () => {
    const helper = ended('helper', { ticket: 'chat' });
    const chat = agent('chat');
    expect(byId(withDoneLines([zone('z', 'spine'), tile(chat), tile(helper)]), 'agent:helper').className).toBe(FINISHED_IN_BAND);
    expect(byId(withDoneLines([zone('z', 'off'), tile(chat), tile(helper)]), 'agent:helper').className).toBeUndefined();
  });
});

describe('toDone', () => {
  it("offers Move to Done only for an ended agent of a Spine zone whose whole ticket is finished", () => {
    const nodes = [
      zone('z', 'spine'),
      zone('free', 'off'),
      tile(ended('reviewer', { issue: issue('ACME-2') })),
      tile(agent('builder', { issue: issue('ACME-2') })),
      tile(ended('alone', { issue: issue('ACME-3') })),
      tile(ended('elsewhere'), 'free'),
    ];
    expect(toDone(nodes, 'agent:alone')).toMatchObject({ zone: { id: 'z' }, sessionId: 'alone' });
    // Its ticket still going, a finished agent has nothing to fold yet; nor has a running one, nor one outside Spine.
    expect(toDone(nodes, 'agent:reviewer')).toBeUndefined();
    expect(toDone(nodes, 'agent:builder')).toBeUndefined();
    expect(toDone(nodes, 'agent:elsewhere')).toBeUndefined();
    expect(toDone(nodes, 'agent:gone')).toBeUndefined();
  });

  it('never offers it for a tile the rule leaves be: placed by hand, or started by the user and not joined to a band', () => {
    const mine = ended('mine', { spawnedBy: null });
    const nodes = [zone('z', 'spine', ['agent:dragged']), tile(ended('dragged')), tile(mine)];
    expect(toDone(nodes, 'agent:dragged')).toBeUndefined();
    expect(toDone(nodes, 'agent:mine')).toBeUndefined();
    expect(toDone(nodes, 'agent:mine', new Set(['agent:mine']))).toMatchObject({ sessionId: 'mine' });
  });
});

describe('undoCleanUp', () => {
  const history = (keys: string[]) => {
    const undone: string[] = [];
    return { undone, undoKeys: () => new Set(keys), undo: () => (undone.push('undo'), true) };
  };

  it("undoes a zone's Clean up while it is the step ⌘Z would undo, and nothing once another step came after it", () => {
    const last = history([historyKey.cleanUp('z')]);
    expect(undoCleanUp(last, 'z')).toBe(true);
    expect(last.undone).toEqual(['undo']);
    // A tile dragged since, or another zone cleaned up: its toast's Undo leaves that be.
    for (const other of [history(['tile:agent:a']), history([historyKey.cleanUp('other')]), history([])]) {
      expect(undoCleanUp(other, 'z')).toBe(false);
      expect(other.undone).toEqual([]);
    }
  });
});
