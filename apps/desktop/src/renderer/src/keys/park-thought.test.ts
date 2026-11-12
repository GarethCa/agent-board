import { describe, expect, it, vi } from 'vitest';
import type { Agent, BoardItem, QueueChange, QueueJob, QueueView, Shell, Zone } from '@agent-board/daemon/protocol';
import { parkLine, parkQueue, parkThought, unpark, type ParkApi } from './park-thought';

const item = (id: string, kind: BoardItem['kind'], data: Record<string, unknown>, at: Partial<BoardItem> = {}): BoardItem =>
  ({ id, kind, zoneId: null, x: 0, y: 0, width: 340, height: 244, z: 0, rotation: 0, data, ...at }) as BoardItem;

const userQueue = (id: string, at: Partial<BoardItem> = {}) => item(id, 'queue', { title: 'To look at', audience: 'user' }, at);
const agentQueue = (id: string) => item(id, 'queue', { title: 'Jobs', audience: 'agents' });

describe('the line to park', () => {
  it('is what was typed, trimmed; nothing for an empty or blank line', () => {
    expect(parkLine('  check the docs  ')).toBe('check the docs');
    expect(parkLine('')).toBeNull();
    expect(parkLine('   \t ')).toBeNull();
  });
});

describe('the queue a thought is parked in', () => {
  it('is the user’s loose queue first, then the first of theirs in a zone; never an agents’ queue', () => {
    expect(parkQueue([agentQueue('a'), userQueue('z', { zoneId: 'zone-1' }), userQueue('loose')])?.id).toBe('loose');
    expect(parkQueue([agentQueue('a'), userQueue('z1', { zoneId: 'zone-1' }), userQueue('z2', { zoneId: 'zone-2' })])?.id).toBe('z1');
    expect(parkQueue([agentQueue('a'), item('n', 'sticky', {})])).toBeUndefined();
  });
});

function fakeApi(items: BoardItem[], { zones = [], agents = [], shells = [], jobs = [] }: { zones?: Partial<Zone>[]; agents?: Partial<Agent>[]; shells?: Partial<Shell>[]; jobs?: string[] } = {}) {
  const changes: { id: string; change: QueueChange }[] = [];
  const api: ParkApi = {
    items: {
      list: vi.fn(async () => items),
      create: vi.fn(async (params) => ({ ...item('made', params.kind, params.data), ...params, id: 'made' }) as BoardItem),
      changeQueue: vi.fn(async (id: string, change: QueueChange) => {
        changes.push({ id, change });
        return { item: items[0]!, job: change.action === 'add' ? ({ id: 'job-1', text: change.text } as QueueJob) : null };
      }),
      delete: vi.fn(async () => {}),
      readQueue: vi.fn(async () => ({ item: items[0]!, jobs: jobs.map((id) => ({ id }) as QueueJob) }) as QueueView),
    },
    zones: { list: vi.fn(async () => zones as Zone[]) },
    agents: { list: vi.fn(async () => agents as Agent[]) },
    shells: { list: vi.fn(async () => shells as Shell[]) },
  };
  return { api, changes };
}

describe('parking a thought', () => {
  it('adds the line at the back of the user’s queue, as a job of theirs to look at', async () => {
    const { api, changes } = fakeApi([agentQueue('a'), userQueue('mine')]);
    await expect(parkThought(api, 'check the docs')).resolves.toEqual({ queueId: 'mine', made: false, jobId: 'job-1' });
    expect(changes).toEqual([{ id: 'mine', change: { action: 'add', kind: 'backlog', text: 'check the docs' } }]);
    expect(api.items.create).not.toHaveBeenCalled();
  });

  it('makes the user a loose "To look at" queue right of every zone, loose item and loose tile when they have none', async () => {
    const { api, changes } = fakeApi([item('n', 'sticky', {}, { x: 100, width: 200 }), item('far', 'sticky', {}, { zoneId: 'z', x: 5000, width: 200 })], {
      zones: [{ id: 'z', x: -50, y: 40, width: 900, height: 400 }],
      agents: [{ zoneId: null, position: { x: 1000, y: 0, z: null } }, { zoneId: 'z', position: { x: 9000, y: 0, z: null } }, { zoneId: null, position: null }],
      shells: [{ zoneId: null, owner: null, position: { x: 600, y: 0, z: null } }],
    });
    await expect(parkThought(api, 'idea')).resolves.toEqual({ queueId: 'made', made: true, jobId: 'job-1' });
    expect(api.items.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'queue', zoneId: null, x: 1000 + 256 + 80, y: 0, data: expect.objectContaining({ title: 'To look at', audience: 'user', madeBy: { kind: 'user' } }) }),
    );
    expect(changes).toEqual([{ id: 'made', change: { action: 'add', kind: 'backlog', text: 'idea' } }]);
  });
});

describe('taking a parked line back', () => {
  it('removes the line from its queue', async () => {
    const { api, changes } = fakeApi([userQueue('mine')]);
    await unpark(api, { queueId: 'mine', made: false, jobId: 'job-1' });
    expect(changes).toEqual([{ id: 'mine', change: { action: 'remove', job: 'job-1' } }]);
    expect(api.items.delete).not.toHaveBeenCalled();
  });

  it('deletes the queue it made for the line, while the line is all it holds', async () => {
    const { api, changes } = fakeApi([], { jobs: ['job-1'] });
    await unpark(api, { queueId: 'made', made: true, jobId: 'job-1' });
    expect(api.items.delete).toHaveBeenCalledWith('made');
    expect(changes).toEqual([]);
  });

  it('keeps the queue it made once other lines are in it, and removes only the parked one', async () => {
    const { api, changes } = fakeApi([], { jobs: ['job-1', 'typed-since'] });
    await unpark(api, { queueId: 'made', made: true, jobId: 'job-1' });
    expect(api.items.delete).not.toHaveBeenCalled();
    expect(changes).toEqual([{ id: 'made', change: { action: 'remove', job: 'job-1' } }]);
  });
});
