import { describe, expect, it } from 'vitest';
import type { Agent, BoardItem, Zone } from '@agent-board/daemon/protocol';
import { tileNodeId } from '../board/tiles';
import { askLine, boardMaster, latestDigest, masterRails, watchedOrchestrators, watchRows } from './master-view';

const agent = (sessionId: string, fields: Partial<Agent> = {}): Agent =>
  ({
    sessionId,
    zoneId: 'z1',
    name: sessionId,
    state: 'idle',
    endedAt: null,
    master: false,
    role: null,
    roleName: null,
    orchestrate: null,
    spawnedBy: null,
    permissions: [],
    ask: null,
    plan: null,
    flag: null,
    ...fields,
  }) as Agent;

const zone = (id: string, name = id): Zone => ({ id, name }) as Zone;

const master = agent('m', { master: true, zoneId: null, orchestrate: 'board' });
const lead = agent('lead', { role: 'custom', roleName: 'Orchestrator', orchestrate: 'zone' });

describe('the Captain', () => {
  it('is the agent marked as it, if there is one', () => {
    expect(boardMaster([lead, master])).toBe(master);
    expect(boardMaster([lead])).toBeUndefined();
  });

  it('watches the live zone leads: orchestrator-role agents, and agents it started that orchestrate', () => {
    const started = agent('started', { zoneId: 'z2', spawnedBy: 'm', orchestrate: 'zone' });
    const member = agent('member', { spawnedBy: 'm', orchestrate: null });
    const ended = agent('ended', { roleName: 'orchestrator', endedAt: '2026-10-23T10:00:00.000Z' });
    const loose = agent('loose', { roleName: 'orchestrator', zoneId: null });

    expect(watchedOrchestrators([master, lead, started, member, ended, loose]).map((each) => each.sessionId)).toEqual(['lead', 'started']);
  });

  it('lists every zone with its lead and that lead’s crew, or none', () => {
    const crew = [agent('a', { spawnedBy: 'lead' }), agent('b', { spawnedBy: 'lead' })];

    const rows = watchRows([zone('z1', 'web'), zone('z2', 'docs')], [master, lead, ...crew]);

    expect(rows.map((row) => [row.zone.name, row.lead?.sessionId, row.crew])).toEqual([
      ['web', 'lead', 2],
      ['docs', undefined, 0],
    ]);
  });

  it('draws a rail from its tile to each lead whose tile is on the board', () => {
    const away = agent('away', { roleName: 'orchestrator', zoneId: 'z3' });
    const onBoard = new Set([tileNodeId('agent', 'm'), tileNodeId('agent', 'lead')]);

    const rails = masterRails(onBoard, [master, lead, away]);

    expect(rails).toMatchObject([{ source: tileNodeId('agent', 'm'), target: tileNodeId('agent', 'lead'), data: { look: 'master' } }]);
    expect(masterRails(new Set([tileNodeId('agent', 'lead')]), [master, lead])).toEqual([]);
    expect(masterRails(onBoard, [lead])).toEqual([]);
  });

  it('takes as its digest the agent note it wrote last', () => {
    const note = (id: string, sessionId: string, writtenAt: string, text: string) =>
      ({ id, kind: 'agent-note', data: { text, writtenAt, agent: { sessionId, name: sessionId, harness: 'claude', role: 'orchestrator' } } }) as unknown as BoardItem;
    const items = [
      note('n1', 'm', '2026-10-23T10:00:00.000Z', 'old'),
      note('n2', 'm', '2026-10-23T11:00:00.000Z', 'new'),
      note('n3', 'lead', '2026-10-23T12:00:00.000Z', 'not the master’s'),
      { id: 's1', kind: 'sticky', data: {} } as unknown as BoardItem,
    ];

    expect(latestDigest(items, 'm')).toEqual({ id: 'n2', text: 'new', writtenAt: '2026-10-23T11:00:00.000Z' });
    expect(latestDigest(items, 'nobody')).toBeUndefined();
  });

  it('says in a line what each request asks', () => {
    expect(askLine(agent('f', { flag: { reason: 'Ready for review' } as Agent['flag'] }), 'flagged')).toBe('Ready for review');
    expect(askLine(agent('q', { ask: { question: 'Which base?' } as Agent['ask'] }), 'asks')).toBe('Which base?');
    expect(askLine(agent('p', { permissions: [{ toolName: 'Bash' }] as Agent['permissions'] }), 'permission')).toBe('Asks to use Bash');
    expect(askLine(agent('p'), 'permission')).toBe('Asking for permission in its terminal');
  });
});
