import { describe, expect, it } from 'vitest';
import { zoneGrid } from '@agent-board/daemon/board-layout';
import { QUEUE_LATER, type Agent, type BoardItem, type QueueJob, type Zone } from '@agent-board/daemon/protocol';
import { layOutStageBoard } from '@agent-board/daemon/stage-board';
import { itemNode, type ItemNodeType } from './items/items';
import { laidOutTile } from './shelves';
import { doneShown, isLater, laterByZone, laterJobs, needYouLabel, sameLater, newStageBoardPlace, stageBoardDropPlace, stageBoardDrops, stageBoardResizes, stagedTile, stageQueues, withStageBoards } from './stage-boards';
import type { TileNodeType } from './tile';
import type { BoardNode } from './tiles';
import { zoneNode, type ZoneNodeType } from './ZoneNode';

const T0 = '2026-01-05T09:00:00.000Z';

const zone = (id: string, layoutMode: Zone['layoutMode'] = 'free'): Zone =>
  ({ id, kind: 'unbound', name: id, x: 0, y: 0, width: 720, height: 480, spacing: 'normal', layoutMode, repoRoot: null }) as Zone;

function agent(sessionId: string, fields: Partial<Agent> = {}): Agent {
  return {
    sessionId,
    name: sessionId,
    zoneId: 'z',
    branch: `${sessionId}-a1b2c3`,
    reviews: null,
    reviewOf: null,
    role: null,
    roleName: null,
    master: false,
    spawnedBy: 'lead',
    orphanedFrom: null,
    ticket: null,
    ticketChat: false,
    issue: null,
    state: 'idle',
    endedAt: null,
    exitCode: null,
    shellSessionId: null,
    shellHarness: null,
    permissions: [],
    ask: null,
    plan: null,
    flag: null,
    ledBy: null,
    seen: false,
    pullRequests: [],
    finishedAt: null,
    lastMessage: null,
    createdAt: T0,
    ...fields,
  } as Agent;
}

const tile = (id: string, x: number, y: number, parentId = 'z'): TileNodeType => ({ id, type: 'tile', parentId, position: { x, y }, width: 256, height: 136, draggable: true, data: { label: id, harness: null } });
const stages = (zoneId = 'z', data: Record<string, unknown> = { joined: [], left: [] }): BoardNode =>
  itemNode({ id: 'sb', kind: 'stages', zoneId, x: 300, y: 40, width: 100, height: 100, rotation: 0, z: 1, data } as unknown as BoardItem) as BoardNode;

const agents = [
  agent('lead', { roleName: 'orchestrator', spawnedBy: null, state: 'running' }),
  agent('doing', { state: 'running' }),
  agent('todo'),
  agent('mine', { spawnedBy: null, state: 'running' }),
];
const board = (): BoardNode[] => [
  zoneNode(zone('z')),
  tile('agent:lead', 40, 64),
  tile('agent:doing', 40, 400),
  tile('agent:todo', 600, 400),
  tile('agent:mine', 900, 900),
  stages(),
];
const byId = (nodes: readonly BoardNode[], id: string) => nodes.find((node) => node.id === id)!;
const draw = (nodes: readonly BoardNode[], who: readonly Agent[] = agents) => withStageBoards(nodes, { agents: who, links: [], shows: 'explicit' });

describe('withStageBoards', () => {
  it('draws a Doing ticket’s tiles on the block, and hides a quiet ticket’s, behind its card', () => {
    const drawn = draw(board());
    const laid = (byId(drawn, 'item:sb') as ItemNodeType).data.stages!;
    const band = laid.tickets.find((ticket) => ticket.members.includes('doing'))!;
    const tileAt = laid.tiles.get('agent:doing')!;
    expect(band.stage).toBe('doing');
    expect(byId(drawn, 'agent:doing')).toMatchObject({ position: { x: 300 + tileAt.x, y: 40 + tileAt.y }, draggable: true });
    expect(byId(drawn, 'agent:todo').hidden).toBe(true);
  });

  it('draws a Doing worker’s note in its band, inside the block, and hides a quiet one’s', () => {
    const note = (id: string, about: string): BoardNode =>
      itemNode({ id, kind: 'agent-note', zoneId: 'z', x: 900, y: 40, width: 240, height: 96, rotation: 0, z: null, data: { text: 'hi', agent: { sessionId: 'lead', name: 'lead' }, about } } as unknown as BoardItem) as BoardNode;
    const drawn = draw([...board(), note('n1', 'doing'), note('n2', 'todo')]);
    const block = byId(drawn, 'item:sb') as ItemNodeType;
    const at = block.data.stages!.tiles.get('item:n1')!;
    expect(byId(drawn, 'item:n1').position).toEqual({ x: 300 + at.x, y: 40 + at.y });
    expect(at.y + 96).toBeLessThanOrEqual(block.height!);
    // It goes with its agent's tile: dragged on its own, it would save a place it is never drawn at.
    expect(byId(drawn, 'item:n1').draggable).toBe(false);
    expect(byId(drawn, 'item:n2').hidden).toBe(true);
  });

  it('leaves the lead and an agent the user started where they are', () => {
    const drawn = draw(board());
    expect(byId(drawn, 'agent:lead')).toEqual(byId(board(), 'agent:lead'));
    expect(byId(drawn, 'agent:mine')).toEqual(byId(board(), 'agent:mine'));
  });

  it('draws the block at the size its stages take, and its zone big enough to hold it', () => {
    const drawn = draw(board());
    const expected = layOutStageBoard({ agents, zoneId: 'z', data: { joined: [], left: [], showDone: false }, links: [], shows: 'explicit', spacing: 'normal', sizeOf: () => ({ width: 256, height: 136 }), footOf: () => false });
    expect(byId(drawn, 'item:sb')).toMatchObject(expected.size);
    expect((byId(drawn, 'z') as ZoneNodeType).width).toBe(300 + expected.size.width + zoneGrid('normal').gaps.padding);
    expect((byId(drawn, 'z') as ZoneNodeType).data.stageBoard).toBe(true);
  });

  it('takes in an agent the user dragged in, and lets go of one dragged out', () => {
    const drawn = draw([...board().slice(0, -1), stages('z', { joined: ['mine'], left: ['doing'] })]);
    expect(byId(drawn, 'agent:mine')).toMatchObject({ position: { x: 300 + (byId(drawn, 'item:sb') as ItemNodeType).data.stages!.tiles.get('agent:mine')!.x }, draggable: true });
    expect(byId(drawn, 'agent:doing')).toEqual(byId(board(), 'agent:doing'));
  });

  it('hides a stage board in a zone laid out by status, whose shelves say the same', () => {
    const nodes = [zoneNode(zone('z', 'shelves')), tile('agent:doing', 40, 400), stages()];
    const drawn = draw(nodes);
    expect(byId(drawn, 'item:sb').hidden).toBe(true);
    expect(byId(drawn, 'agent:doing')).toEqual(byId(nodes, 'agent:doing'));
  });

  it('leaves a Doing tile being dragged where the drag has it, so it can be dragged off the block', () => {
    const dragged = board().map((node) => (node.id === 'agent:doing' ? { ...node, position: { x: 700, y: 20 }, dragging: true } : node));
    expect(byId(draw(dragged), 'agent:doing').position).toEqual({ x: 700, y: 20 });
    // Still the block's, until it is dropped.
    expect((byId(draw(dragged), 'item:sb') as ItemNodeType).data.stages!.tiles.has('agent:doing')).toBe(true);
  });

  it('folds Done behind its line, its agents’ tiles hidden, until shown', () => {
    const merged = agent('merged', { pullRequests: [{ number: 7, title: 'Fix it', url: 'https://example.com/pr/7', state: 'merged', checks: 'none' }], finishedAt: T0 });
    const nodes = [...board(), tile('agent:merged', 40, 700)];
    const folded = draw(nodes, [...agents, merged]);
    expect((byId(folded, 'item:sb') as ItemNodeType).data.stages!.fold).toMatchObject({ count: 1, shown: false });
    expect(byId(folded, 'agent:merged').hidden).toBe(true);
    const shown = draw(
      nodes.map((node) => (node.id === 'item:sb' ? stages('z', { joined: [], left: [], showDone: true }) : node)),
      [...agents, merged],
    );
    const view = (byId(shown, 'item:sb') as ItemNodeType).data.stages!;
    expect(view.fold).toMatchObject({ count: 1, shown: true });
    expect(view.tickets.find((ticket) => ticket.members.includes('merged'))!.folded).toBe(false);
  });

  it('draws what its zone has put off for later at the foot of To do, and nothing of another zone’s', () => {
    const later = new Map([
      ['z', [{ id: 'j1', text: 'Tray icon is blurry' }]],
      ['y', [{ id: 'j2', text: 'Elsewhere' }]],
    ]);
    const view = (byId(withStageBoards(board(), { agents, links: [], shows: 'explicit', later }), 'item:sb') as ItemNodeType).data.stages!;
    expect(view.later.map((card) => card.text)).toEqual(['Tray icon is blurry']);
    expect(view.columns[0]!.later).toBe(1);
  });

  it('marks the tiles it draws as laid out, so nothing saves a place from where they are drawn', () => {
    const drawn = draw(board());
    expect(stagedTile(byId(drawn, 'agent:doing'), drawn)).toBe(true);
    expect(laidOutTile(byId(drawn, 'agent:doing'), drawn)).toBe(true);
    expect(laidOutTile(byId(drawn, 'agent:mine'), drawn)).toBe(false);
  });

  it('changes nothing on a board without one', () => {
    const nodes = board().slice(0, -1);
    expect(draw(nodes)).toEqual(nodes);
  });
});

describe('stageBoardDrops', () => {
  // The zone is at the board's origin, so the block's drawn rect starts at (300, 40).
  const onBlock = { x: 320, y: 60 };
  const offBlock = { x: 100, y: 300 };

  it('takes in an agent the user started, dropped on the block, and keeps the place it had', () => {
    expect(stageBoardDrops('mine', onBlock, draw(board()), agents)).toEqual({ changes: [{ id: 'sb', data: { joined: ['mine'], left: [], showDone: false } }], kept: true });
  });

  it('lets go of a tile dragged off the block, to land where it was dropped', () => {
    expect(stageBoardDrops('doing', offBlock, draw(board()), agents)).toEqual({ changes: [{ id: 'sb', data: { joined: [], left: ['doing'], showDone: false } }], kept: false });
  });

  it('puts a tile dropped back on its block back on its band, saving nothing', () => {
    expect(stageBoardDrops('doing', onBlock, draw(board()), agents)).toEqual({ changes: [], kept: true });
  });

  it('changes nothing for a tile moved about off the block', () => {
    expect(stageBoardDrops('mine', offBlock, draw(board()), agents)).toEqual({ changes: [], kept: false });
  });

  it('puts the lead dropped on its block back where it was, as it never goes on', () => {
    expect(stageBoardDrops('lead', onBlock, draw(board()), agents)).toEqual({ changes: [], kept: true });
  });

  it('forgets a tile dragged off the block into another zone, rather than keep it off for when it comes back', () => {
    const nodes = [...board(), zoneNode({ ...zone('y'), x: 2000 })];
    const inOther = { x: 2100, y: 100 };
    expect(stageBoardDrops('doing', inOther, draw(nodes), agents)).toEqual({ changes: [], kept: false });
    const joined = nodes.map((node) => (node.id === 'item:sb' ? stages('z', { joined: ['mine'], left: ['todo'] }) : node));
    expect(stageBoardDrops('mine', inOther, draw(joined), agents)).toEqual({ changes: [{ id: 'sb', data: { joined: [], left: ['todo'], showDone: false } }], kept: false });
    expect(stageBoardDrops('todo', inOther, draw(joined), agents)).toEqual({ changes: [{ id: 'sb', data: { joined: ['mine'], left: [], showDone: false } }], kept: false });
  });

  it('takes in one from another zone, which moves to the block’s zone where it was dropped', () => {
    const other = agent('away', { zoneId: 'y', spawnedBy: null });
    const nodes = [...board(), zoneNode({ ...zone('y'), x: 2000 }), tile('agent:away', 40, 40, 'y')];
    expect(stageBoardDrops('away', onBlock, draw(nodes, [...agents, other]), [...agents, other])).toEqual({ changes: [{ id: 'sb', data: { joined: ['away'], left: [], showDone: false } }], kept: false });
  });

  it('changes nothing on a hidden block, in a zone laid out by status', () => {
    const nodes = [zoneNode(zone('z', 'shelves')), tile('agent:mine', 40, 400), stages()];
    expect(stageBoardDrops('mine', onBlock, draw(nodes), agents)).toEqual({ changes: [], kept: false });
  });
});

describe('stageBoardResizes', () => {
  it('asks to save a drawn block’s size its item does not have yet, and nothing once it does', () => {
    const drawn = draw(board());
    const { width, height } = byId(drawn, 'item:sb') as ItemNodeType;
    expect(stageBoardResizes(drawn)).toEqual([{ id: 'sb', width, height }]);
    const saved = itemNode({ ...(byId(board(), 'item:sb') as ItemNodeType).data.item, width: width!, height: height! }) as BoardNode;
    expect(stageBoardResizes(draw([...board().slice(0, -1), saved]))).toEqual([]);
  });

  it('saves nothing for a hidden block', () => {
    expect(stageBoardResizes(draw([zoneNode(zone('z', 'shelves')), stages()]))).toEqual([]);
  });
});

describe('newStageBoardPlace', () => {
  const { padding, lane } = zoneGrid('normal').gaps;

  it('puts a new one under what stays outside it, at the zone’s padding', () => {
    const nodes = board().slice(0, -1);
    // The lead and the agent the user started stay out; the others go on the block.
    expect(newStageBoardPlace('z', nodes, agents)).toEqual({ x: padding, y: 900 + 136 + lane });
    const withoutMine = nodes.filter((node) => node.id !== 'agent:mine');
    expect(newStageBoardPlace('z', withoutMine, agents)).toEqual({ x: padding, y: 64 + 136 + lane });
  });

  it('puts one at the top of an empty zone', () => {
    expect(newStageBoardPlace('z', [zoneNode(zone('z'))], [])).toEqual({ x: padding, y: padding });
  });
});

describe('stageBoardDropPlace', () => {
  const zone = { id: 'zone:z', x: 1000, y: 500, width: 2000, height: 1200 };
  const size = { width: 900, height: 600 };
  const padding = 28;

  it('keeps a block dropped inside its zone where it was dropped', () => {
    expect(stageBoardDropPlace({ x: 1300, y: 700 }, size, zone, padding)).toEqual({ zoneId: 'zone:z', x: 300, y: 200 });
  });

  it('keeps a block dragged past its zone’s edge in it, at its padding', () => {
    expect(stageBoardDropPlace({ x: 200, y: 100 }, size, zone, padding)).toEqual({ zoneId: 'zone:z', x: padding, y: padding });
    expect(stageBoardDropPlace({ x: 5000, y: 4000 }, size, zone, padding)).toEqual({ zoneId: 'zone:z', x: 2000 - 900 - padding, y: 1200 - 600 - padding });
  });

  it('puts a block wider than its zone at the zone’s padding', () => {
    expect(stageBoardDropPlace({ x: 1500, y: 600 }, { width: 2500, height: 600 }, zone, padding)).toEqual({ zoneId: 'zone:z', x: padding, y: 100 });
  });
});

describe('doneShown', () => {
  it('shows or folds Done, keeping what else the block holds', () => {
    const block = stages('z', { joined: ['mine'], left: ['todo'] }) as ItemNodeType;
    expect(doneShown(block.data.item, true)).toEqual({ id: 'sb', data: { joined: ['mine'], left: ['todo'], showDone: true } });
    expect(doneShown(block.data.item, false).data.showDone).toBe(false);
  });
});

describe('needYouLabel', () => {
  it('says how many of a stage’s tickets need you, in the singular for one', () => {
    expect(needYouLabel(1)).toBe('1 needs you');
    expect(needYouLabel(2)).toBe('2 need you');
  });
});

describe('stageQueues', () => {
  const queue = (id: string, zoneId: string) =>
    itemNode({ id, kind: 'queue', zoneId, x: 0, y: 0, width: 200, height: 200, rotation: 0, z: 1, updatedAt: T0, data: {} } as unknown as BoardItem) as BoardNode;

  it('lists the queues of the zones with a stage board, with when each last changed', () => {
    const nodes = [zoneNode(zone('z')), zoneNode(zone('y')), stages('z'), queue('q1', 'z'), queue('q2', 'y')];
    expect(stageQueues(nodes)).toEqual([{ id: 'q1', zoneId: 'z', updatedAt: T0 }]);
  });

  it('lists none without a stage board', () => {
    expect(stageQueues([zoneNode(zone('z')), queue('q1', 'z')])).toEqual([]);
  });
});

describe('laterJobs', () => {
  const job = (id: string, fields: Partial<QueueJob> = {}): QueueJob => ({ id, queueId: 'q1', kind: 'task', text: `${id}\n\nmore`, state: 'queued', hiddenUntil: null, ...fields }) as QueueJob;
  const now = Date.parse('2026-01-05T10:00:00.000Z');

  it('keeps the open jobs put off until later, by their headline', () => {
    const jobs = [
      job('soon', { hiddenUntil: '2026-01-06T09:00:00.000Z' }),
      job('now'),
      job('back', { hiddenUntil: '2026-01-05T09:59:00.000Z' }),
      job('finished', { hiddenUntil: '2026-01-06T09:00:00.000Z', state: 'done' }),
    ];
    expect(laterJobs(jobs, now)).toEqual({ later: [{ id: 'soon', text: 'soon' }], until: Date.parse('2026-01-06T09:00:00.000Z') });
  });

  it('takes a job as for later while it is open and put off until a time still ahead', () => {
    expect(isLater(job('soon', { hiddenUntil: '2026-01-06T09:00:00.000Z' }), now)).toBe(true);
    expect(isLater(job('now'), now)).toBe(false);
    expect(isLater(job('back', { hiddenUntil: '2026-01-05T09:59:00.000Z' }), now)).toBe(false);
    expect(isLater(job('finished', { hiddenUntil: '2026-01-06T09:00:00.000Z', state: 'done' }), now)).toBe(false);
  });

  it('says when nothing is put off', () => {
    expect(laterJobs([job('now')], now)).toEqual({ later: [], until: null });
  });

  it('keeps a job marked Later, with no time to read the queue again for', () => {
    expect(isLater(job('marked', { hiddenUntil: QUEUE_LATER }), now)).toBe(true);
    expect(laterJobs([job('marked', { hiddenUntil: QUEUE_LATER })], now)).toEqual({ later: [{ id: 'marked', text: 'marked' }], until: null });
    expect(laterJobs([job('marked', { hiddenUntil: QUEUE_LATER }), job('soon', { hiddenUntil: '2026-01-06T09:00:00.000Z' })], now).until).toBe(Date.parse('2026-01-06T09:00:00.000Z'));
  });
});

describe('laterByZone', () => {
  const job = (id: string, hiddenUntil: string | null): QueueJob => ({ id, queueId: 'q', kind: 'task', text: id, state: 'queued', hiddenUntil }) as QueueJob;
  const now = Date.parse('2026-01-05T10:00:00.000Z');
  const inAnHour = '2026-01-05T11:00:00.000Z';

  it("gathers each zone's put-off jobs from all its queues, and reads again just after the soonest comes back", () => {
    const { byZone, wait } = laterByZone(
      [
        { zoneId: 'a', jobs: [job('one', inAnHour), job('now', null)] },
        { zoneId: 'a', jobs: [job('two', '2026-01-05T12:00:00.000Z')] },
        { zoneId: 'b', jobs: [job('none', null)] },
      ],
      now,
    );
    expect([...byZone]).toEqual([['a', [{ id: 'one', text: 'one' }, { id: 'two', text: 'two' }]]]);
    expect(wait).toBe(60 * 60 * 1000 + 50);
  });

  it("skips a queue that couldn't be read, and reads again only on a write when nothing is put off", () => {
    expect(laterByZone([null, { zoneId: 'a', jobs: [job('now', null)] }], now)).toEqual({ byZone: new Map(), wait: null });
  });

  it('reads again at most a day off, as a longer timer fires at once', () => {
    expect(laterByZone([{ zoneId: 'a', jobs: [job('far', '2026-03-05T10:00:00.000Z')] }], now).wait).toBe(24 * 60 * 60 * 1000);
  });
});

describe('sameLater', () => {
  it('tells two reads apart only by what they draw', () => {
    const one = new Map([['a', [{ id: 'j', text: 'Write it' }]]]);
    expect(sameLater(one, new Map([['a', [{ id: 'j', text: 'Write it' }]]]))).toBe(true);
    expect(sameLater(one, new Map([['a', [{ id: 'j', text: 'Write it again' }]]]))).toBe(false);
    expect(sameLater(one, new Map())).toBe(false);
  });
});
