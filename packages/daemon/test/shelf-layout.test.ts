import { describe, expect, it } from 'vitest';
import { CHIP_SIZE, tileSizeKey } from '../src/board-layout.ts';
import type { Agent } from '../src/protocol.ts';
import { CARD_GAP, cardHeight, CLUSTER_PADDING, doingColumns, layoutClusters, layoutShelves, MIN_SHELF_WIDTHS, needsUser, SHELF_GAP, shelfRows, stageOf, WAITING_ROW_HEIGHT, type ShelfInput } from '../src/shelf-layout.ts';

const T0 = '2026-01-05T09:00:00.000Z';
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

/** An agent in zone `z`, idle and never started, with what a test says. */
function agent(sessionId: string, fields: Partial<Agent> = {}): Agent {
  return {
    sessionId,
    name: sessionId,
    zoneId: 'z',
    repoRoot: '/repo',
    branch: `${sessionId}-a1b2c3`,
    reviews: null,
    reviewOf: null,
    role: null,
    roleName: null,
    master: false,
    spawnedBy: null,
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

const pr = (state: 'open' | 'draft' | 'merged' | 'closed') => ({ number: 7, title: 'Fix it', url: 'https://example.com/pr/7', state, checks: 'none' as const });
const closed = { endedAt: at(30), exitCode: 0, state: 'done' as const };

describe('stageOf', () => {
  it('puts work that runs, needs the user or failed on Doing', () => {
    expect(stageOf([agent('a', { state: 'running' })], 'explicit')).toBe('doing');
    expect(stageOf([agent('a', { state: 'rate-limited' })], 'explicit')).toBe('doing');
    expect(stageOf([agent('a', { state: 'needs-permission' })], 'explicit')).toBe('doing');
    expect(stageOf([agent('a', { ask: { question: 'Redis?' } as Agent['ask'] })], 'explicit')).toBe('doing');
    expect(stageOf([agent('a', { state: 'failed', endedAt: at(5), exitCode: 1 })], 'explicit')).toBe('doing');
    expect(stageOf([agent('a', { state: 'stopped-by-restart', endedAt: at(5), finishedAt: at(3) })], 'explicit')).toBe('doing');
    // Even with its pull request open: a needs-you never waits on a shelf.
    expect(stageOf([agent('a', { state: 'needs-permission', pullRequests: [pr('open')] })], 'explicit')).toBe('doing');
  });

  it('counts what needs the user as the Needs-you pill does: not a question asked in words at the prompt', () => {
    const asking = agent('a', { state: 'waiting', finishedAt: at(3), lastMessage: 'Redis or in-memory: which do you want?' });
    expect(needsUser(asking, 'explicit')).toBe(false);
    expect(needsUser(asking, 'turns')).toBe(true);
    expect(needsUser(agent('b', { state: 'needs-permission' }), 'explicit')).toBe(true);
  });

  it('counts a turn ended at the prompt as needing the user only when the inbox shows turns', () => {
    const done = agent('a', { state: 'waiting', finishedAt: at(3) });
    expect(stageOf([done], 'turns')).toBe('doing');
    // Started, so not To do, and nothing open: still Doing, quietly.
    expect(stageOf([done], 'explicit')).toBe('doing');
  });

  it('puts work whose pull request is open on Waiting: someone else has it', () => {
    expect(stageOf([agent('a', { finishedAt: at(3), pullRequests: [pr('open')] })], 'explicit')).toBe('waiting');
    expect(stageOf([agent('a', { pullRequests: [pr('draft')] }), agent('b')], 'explicit')).toBe('waiting');
    // Closed before its pull request merged, it still waits on review: never folded into Done.
    expect(stageOf([agent('a', { ...closed, pullRequests: [pr('open')] }), agent('b', closed)], 'explicit')).toBe('waiting');
  });

  it('puts work merged, or with every agent closed, on Done', () => {
    expect(stageOf([agent('a', { pullRequests: [pr('merged')] })], 'explicit')).toBe('done');
    expect(stageOf([agent('a', closed), agent('b', closed)], 'explicit')).toBe('done');
    // Stopped by the user, its harness exiting on the signal: done, as its tile says, not a failure.
    expect(stageOf([agent('a', { endedAt: at(30), exitCode: 143, state: 'done' })], 'explicit')).toBe('done');
    // A failure merged past is done with.
    expect(stageOf([agent('a', { state: 'failed', endedAt: at(5), exitCode: 1, pullRequests: [pr('merged')] })], 'explicit')).toBe('done');
    // One still at work pulls it back.
    expect(stageOf([agent('a', closed), agent('b', { state: 'running' })], 'explicit')).toBe('doing');
  });

  it('puts work not started and waiting on no one on To do', () => {
    expect(stageOf([agent('a')], 'explicit')).toBe('todo');
    expect(stageOf([agent('a', { state: 'scheduled' })], 'explicit')).toBe('todo');
    expect(stageOf([agent('a', { state: 'hibernated', hibernated: { at: at(1), by: null, byId: null } })], 'explicit')).toBe('todo');
    // Paused after a turn has ended, its work has started: quiet on Doing.
    expect(stageOf([agent('a', { state: 'hibernated', hibernated: { at: at(9), by: null, byId: null }, finishedAt: at(5) })], 'explicit')).toBe('doing');
    // A pull request closed unmerged leaves it where its agents put it.
    expect(stageOf([agent('a', { pullRequests: [pr('closed')] })], 'explicit')).toBe('todo');
  });
});

/** A shelved zone's input over `agents`, every tile the default size and no card with a footer. */
function input(agents: Agent[], fields: Partial<ShelfInput> = {}): ShelfInput {
  return {
    agents,
    zoneId: 'z',
    spacing: 'normal',
    width: 1600,
    pinned: new Set(),
    heads: [],
    links: [],
    shows: 'explicit',
    sizeOf: (key) => (key.startsWith('agent:closed') ? CHIP_SIZE : { width: 256, height: 136 }),
    footOf: () => false,
    doneShown: false,
    ...fields,
  };
}

const crew = () => [
  agent('lead', { orchestrate: 'zone', state: 'running' }),
  agent('impl-1', { role: 'implementer', issue: { id: 'ACME-1', title: 'Login redirect' } as Agent['issue'], state: 'running', createdAt: at(1) }),
  agent('rev-1', { role: 'reviewer', reviewOf: 'impl-1', state: 'idle', createdAt: at(2) }),
  agent('impl-2', { role: 'implementer', issue: { id: 'ACME-2', title: 'Export CSV' } as Agent['issue'], state: 'needs-permission', createdAt: at(3) }),
  agent('impl-3', { role: 'implementer', finishedAt: at(9), pullRequests: [pr('open')], createdAt: at(4) }),
  agent('impl-4', { role: 'implementer', state: 'scheduled', createdAt: at(5) }),
  agent('closed-5', { role: 'implementer', ...closed, createdAt: at(6) }),
  agent('elsewhere', { zoneId: 'other', state: 'running' }),
];

describe('layoutShelves', () => {
  it('stacks each unit of work once, a reviewer with what it reviews, on the shelf its agents put it on', () => {
    const layout = layoutShelves(input(crew(), { pinned: new Set(['lead']) }));
    expect(layout.stacks.map(({ key, ticket, title, stage, members }) => ({ key, ticket, title, stage, members }))).toEqual([
      { key: 'agent:impl-4', ticket: null, title: 'impl-4', stage: 'todo', members: ['impl-4'] },
      // What needs the user goes first on its shelf, whenever its work started.
      { key: 'issue:ACME-2', ticket: 'ACME-2', title: 'Export CSV', stage: 'doing', members: ['impl-2'] },
      { key: 'issue:ACME-1', ticket: 'ACME-1', title: 'Login redirect', stage: 'doing', members: ['impl-1', 'rev-1'] },
      { key: 'agent:impl-3', ticket: null, title: 'impl-3', stage: 'waiting', members: ['impl-3'] },
      { key: 'agent:closed-5', ticket: null, title: 'closed-5', stage: 'done', members: ['closed-5'] },
    ]);
    expect(layout.stacks.find((stack) => stack.key === 'issue:ACME-2')?.needsYou).toBe(true);
    expect(layout.shelves.map((shelf) => [shelf.stage, shelf.count])).toEqual([
      ['todo', 1],
      ['doing', 2],
      ['waiting', 1],
      ['done', 1],
    ]);
  });

  it('stacks the agents an implementer started with it, but never a lead\'s crew with the lead', () => {
    const agents = [
      ...crew().map((each) => (each.role === 'implementer' && each.sessionId !== 'impl-4' ? { ...each, spawnedBy: 'lead' } : each)),
      agent('helper-4', { role: 'implementer', spawnedBy: 'impl-4', state: 'running', createdAt: at(7) }),
      agent('rev-4', { role: 'reviewer', spawnedBy: 'impl-4', createdAt: at(8) }),
    ];
    const members = (pinned: Set<string>) => layoutShelves(input(agents, { pinned })).stacks.map((stack) => stack.members);
    expect(members(new Set(['lead']))).toContainEqual(['impl-4', 'helper-4', 'rev-4']);
    // Freed from the head row, the lead is a stack of its own: its crew stays in theirs.
    expect(members(new Set())).toContainEqual(['lead']);
    expect(members(new Set())).toContainEqual(['impl-1', 'rev-1']);
  });

  it('pins the zone\'s leads top-left in the head row, then its shells; a lead freed is a stack like any other', () => {
    const pinned = layoutShelves(input(crew(), { pinned: new Set(['lead']), heads: ['shell:s1'] }));
    expect(pinned.head).toEqual([
      { key: 'agent:lead', x: 20, y: 44 },
      { key: 'shell:s1', x: 20 + 256 + 16, y: 44 },
    ]);
    expect(pinned.stacks.some((stack) => stack.members.includes('lead'))).toBe(false);
    // The shelves start below the head row.
    expect(pinned.shelves[0]!.y).toBe(44 + 136 + 40);

    const freed = layoutShelves(input(crew()));
    expect(freed.head).toEqual([]);
    expect(freed.stacks.find((stack) => stack.members.includes('lead'))?.stage).toBe('doing');
    expect(freed.shelves[0]!.y).toBe(20);
  });

  it('lays the shelves out left to right across the zone, Doing twice as wide, Waiting as rows, Done as one line until shown', () => {
    const layout = layoutShelves(input(crew(), { pinned: new Set(['lead']) }));
    const [todo, doing, waiting, done] = layout.shelves;
    const widths = shelfRows(1600, 20)[0]!.map((shelf) => shelf.width);
    expect(layout.shelves.map((shelf) => shelf.width)).toEqual(widths);
    expect(Math.abs(doing!.width - 2 * todo!.width)).toBeLessThanOrEqual(1);
    expect([todo!.x, doing!.x, waiting!.x, done!.x]).toEqual([20, 20 + widths[0]! + SHELF_GAP, doing!.x + widths[1]! + SHELF_GAP, waiting!.x + widths[2]! + SHELF_GAP]);
    expect(done!.x + done!.width + 20).toBeLessThanOrEqual(1600);
    const { columns, card } = doingColumns(doing!.width);
    expect(columns).toBeGreaterThanOrEqual(2);
    const [needs, redirect] = layout.stacks.filter((stack) => stack.stage === 'doing');
    expect(needs).toMatchObject({ x: doing!.x, width: card, placed: true });
    expect(redirect).toMatchObject({ x: doing!.x + card + CARD_GAP, y: needs!.y });
    // A row is as tall as its tallest card: two members.
    expect(needs!.height).toBe(cardHeight(2, false));
    expect(layout.stacks.find((stack) => stack.stage === 'waiting')).toMatchObject({ x: waiting!.x, width: waiting!.width, height: WAITING_ROW_HEIGHT });
    expect(layout.doneLine).toMatchObject({ x: done!.x, count: 1, shown: false });
    expect(layout.stacks.find((stack) => stack.stage === 'done')?.placed).toBe(false);

    const shown = layoutShelves(input(crew(), { pinned: new Set(['lead']), doneShown: true }));
    expect(shown.stacks.find((stack) => stack.stage === 'done')).toMatchObject({ x: done!.x, y: shown.doneLine!.y + shown.doneLine!.height + 12, width: done!.width, placed: true });
    expect(shown.size.height).toBeGreaterThanOrEqual(layout.size.height);
  });

  it('keeps to a narrower zone: To do and Doing above Waiting and Done in two columns, the zone no wider', () => {
    const layout = layoutShelves(input(crew(), { pinned: new Set(['lead']), width: 840 }));
    const [todo, doing, waiting, done] = layout.shelves;
    expect(waiting!.x).toBe(todo!.x);
    expect(done!.x).toBe(doing!.x);
    expect(waiting!.y).toBeGreaterThan(Math.max(todo!.y + todo!.height, doing!.y + doing!.height));
    expect(doingColumns(doing!.width).columns).toBe(2);
    // Within the zone, but for rounding a pixel or two.
    expect(layout.size.width).toBeLessThanOrEqual(840);
    expect(layout.size.width).toBeGreaterThan(836);
    // Narrower still, each shelf at its least width: the zone is drawn as wide as that, never narrower.
    const narrow = layoutShelves(input(crew(), { width: 300 }));
    expect(narrow.size.width).toBe(20 + MIN_SHELF_WIDTHS.waiting + SHELF_GAP + MIN_SHELF_WIDTHS.doing + 20);
    expect(doingColumns(MIN_SHELF_WIDTHS.doing)).toEqual({ columns: 1, card: MIN_SHELF_WIDTHS.doing });
  });

  it('fans an open stack\'s tiles out below the shelves, over no card, moving nothing else', () => {
    const shut = layoutShelves(input(crew(), { pinned: new Set(['lead']) }));
    const open = layoutShelves(input(crew(), { pinned: new Set(['lead']), open: 'issue:ACME-1' }));
    const card = open.stacks.find((stack) => stack.key === 'issue:ACME-1')!;
    // Below every shelf, in the free space there: over no card.
    const below = Math.max(...open.shelves.map((shelf) => shelf.y + shelf.height)) + 12 + 24;
    expect(open.fanTop).toBe(below);
    expect(open.fan).toEqual([
      { key: tileSizeKey('agent', 'impl-1'), x: card.x, y: below },
      { key: tileSizeKey('agent', 'rev-1'), x: card.x + 256 + 16, y: below },
    ]);
    for (const stack of open.stacks.filter((each) => each.placed)) expect(stack.y + stack.height).toBeLessThan(below);
    expect(open.stacks).toEqual(shut.stacks);
    expect(open.size).toEqual(shut.size);
    // A stack folded away (Done, not shown) opens nothing.
    expect(layoutShelves(input(crew(), { open: 'agent:closed-5' })).fan).toEqual([]);
  });

  it('sizes the zone to hold its shelves and head row, with its padding', () => {
    const layout = layoutShelves(input(crew(), { pinned: new Set(['lead']) }));
    const done = layout.shelves.at(-1)!;
    expect(layout.size.width).toBe(done.x + done.width + 20);
    expect(layout.size.width).toBeLessThanOrEqual(1600);
    expect(layout.size.height).toBe(Math.max(...layout.shelves.map((shelf) => shelf.y + shelf.height)) + 20);
  });

  it('lays out the same board the same way, whatever order it is listed in', () => {
    const agents = crew();
    const once = layoutShelves(input(agents, { pinned: new Set(['lead']) }));
    expect(layoutShelves(input(agents.toReversed(), { pinned: new Set(['lead']) }))).toEqual(once);
    expect(layoutShelves(input([agents[3]!, ...agents.slice(0, 3), ...agents.slice(4)], { pinned: new Set(['lead']) }))).toEqual(once);
  });

  it('adds a new unit of work last on its shelf, leaving every card before it where it was', () => {
    const before = layoutShelves(input(crew(), { pinned: new Set(['lead']) }));
    const after = layoutShelves(input([...crew(), agent('impl-9', { state: 'running', createdAt: at(20) })], { pinned: new Set(['lead']) }));
    for (const stack of before.stacks) expect(after.stacks.find((each) => each.key === stack.key)).toEqual(stack);
    const added = after.stacks.find((stack) => stack.key === 'agent:impl-9')!;
    expect(added.stage).toBe('doing');
    // Last on Doing: after every card before it, in reading order.
    const doing = after.stacks.filter((stack) => stack.stage === 'doing');
    expect(doing.at(-1)).toEqual(added);
    for (const stack of doing.slice(0, -1)) expect(stack.y < added.y || (stack.y === added.y && stack.x < added.x)).toBe(true);
  });

  it('lists a card past four members as four lines and "+N more"', () => {
    expect(cardHeight(6, false)).toBe(cardHeight(4, false) + 22);
    expect(cardHeight(1, true)).toBe(cardHeight(1, false) + 20);
  });
});

describe('layoutClusters', () => {
  // Clusters take no footer or open stack, which only shelves draw: what a shelf's input has besides is ignored.
  const clusterInput = (agents: Agent[], fields: Partial<ShelfInput> = {}) => input(agents, fields);

  it("draws each unit of work's tiles together, what needs the user first, then Doing, Waiting and To do, the lead pinned top-left", () => {
    const layout = layoutClusters(clusterInput(crew(), { pinned: new Set(['lead']) }));
    expect(layout.head).toEqual([{ key: 'agent:lead', x: 20, y: 44 }]);
    expect(layout.clusters.filter((cluster) => cluster.placed).map((cluster) => cluster.key)).toEqual(['issue:ACME-2', 'issue:ACME-1', 'agent:impl-3', 'agent:impl-4']);
    const redirect = layout.clusters.find((cluster) => cluster.key === 'issue:ACME-1')!;
    // Its implementer and reviewer side by side inside its outline, close, under its label's row and the room for what
    // perches on them, room between them for the chip on the edge joining them.
    expect(redirect.solo).toBe(false);
    expect(redirect.tiles).toEqual([
      { key: 'agent:impl-1', x: redirect.x + CLUSTER_PADDING, y: redirect.y + CLUSTER_PADDING + 16 + 24 },
      { key: 'agent:rev-1', x: redirect.x + CLUSTER_PADDING + 256 + 24, y: redirect.y + CLUSTER_PADDING + 16 + 24 },
    ]);
    expect(redirect.width).toBe(2 * CLUSTER_PADDING + 2 * 256 + 24);
    // A lone tile is its own group: no outline round it, nor label over it.
    const alone = layout.clusters.find((cluster) => cluster.key === 'agent:impl-3')!;
    expect(alone.solo).toBe(true);
    expect(alone.tiles).toEqual([{ key: 'agent:impl-3', x: alone.x, y: alone.y + 24 }]);
    expect(alone).toMatchObject({ width: 256, height: 24 + 136 });
    // Under the head row.
    expect(Math.min(...layout.clusters.filter((cluster) => cluster.placed).map((cluster) => cluster.y))).toBe(44 + 136 + 40);
  });

  it('packs clusters in rows within the zone, never one over another, well apart, and grows the zone only downwards', () => {
    const layout = layoutClusters(clusterInput(crew(), { pinned: new Set(['lead']), width: 900 }));
    const placed = layout.clusters.filter((cluster) => cluster.placed);
    // Clusters stand further apart than a cluster's tiles do: 40 at the least.
    const [first, second] = placed;
    if (first!.y === second!.y) expect(second!.x - (first!.x + first!.width)).toBe(40);
    else expect(second!.y - (first!.y + first!.height)).toBeGreaterThanOrEqual(40);
    for (const cluster of placed) expect(cluster.x + cluster.width).toBeLessThanOrEqual(900 - 20);
    for (const [at, a] of placed.entries()) {
      for (const b of placed.slice(at + 1)) expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    }
    expect(layout.size.width).toBeLessThanOrEqual(900);
    expect(layout.size.height).toBe(Math.max(...placed.map((cluster) => cluster.y + cluster.height), layout.doneLine!.y + layout.doneLine!.height) + 20);
  });

  it("folds Done's clusters behind one line until shown, then lays them out after it", () => {
    const folded = layoutClusters(clusterInput(crew()));
    expect(folded.doneLine).toMatchObject({ count: 1, shown: false });
    expect(folded.clusters.find((cluster) => cluster.stage === 'done')?.placed).toBe(false);
    const shown = layoutClusters(clusterInput(crew(), { doneShown: true }));
    const done = shown.clusters.find((cluster) => cluster.stage === 'done')!;
    expect(done.placed).toBe(true);
    expect(done.y).toBeGreaterThan(shown.doneLine!.y);
    expect(done.tiles).toEqual([{ key: 'agent:closed-5', x: 20, y: done.y + 24 }]);
  });

  it('wraps the tiles of a cluster wider than the zone into rows of their own, so the zone keeps its width', () => {
    // A ticket with an implementer, two reviewers and a follow-up: four tiles across is 1088 wide, in a 720 zone.
    const ticket = { id: 'ACME-9', title: 'Rate limits' } as Agent['issue'];
    const agents = [
      agent('impl-9', { issue: ticket, state: 'running', createdAt: at(1) }),
      agent('rev-9a', { reviewOf: 'impl-9', state: 'running', createdAt: at(2) }),
      agent('rev-9b', { reviewOf: 'impl-9', state: 'running', createdAt: at(3) }),
      agent('fix-9', { issue: ticket, state: 'running', createdAt: at(4) }),
    ];
    const layout = layoutClusters(clusterInput(agents, { width: 720 }));
    const [cluster] = layout.clusters;
    expect(layout.clusters).toHaveLength(1);
    expect(cluster!.x + cluster!.width).toBeLessThanOrEqual(720 - 20);
    expect(layout.size.width).toBeLessThanOrEqual(720);
    // Two across (2 × 256 + 24 fits in 720 less the padding; three don't), in two rows under the label's, each with room
    // for its perch.
    const rows = [...new Set(cluster!.tiles.map((tile) => tile.y))];
    expect(rows).toEqual([cluster!.y + CLUSTER_PADDING + 16 + 24, cluster!.y + CLUSTER_PADDING + 16 + 24 + 136 + 24 + 24]);
    expect(cluster!.height).toBe(2 * CLUSTER_PADDING + 16 + 2 * (24 + 136) + 24);
    for (const tile of cluster!.tiles) expect(tile.x + 256).toBeLessThanOrEqual(cluster!.x + cluster!.width - CLUSTER_PADDING);
    for (const [at, a] of cluster!.tiles.entries()) {
      for (const b of cluster!.tiles.slice(at + 1)) expect(a.x + 256 <= b.x || b.x + 256 <= a.x || a.y + 136 <= b.y || b.y + 136 <= a.y).toBe(true);
    }
  });

  it("lists Done newest first, as its shelf does, and keeps each Done cluster's place while folded, so a jump knows where it goes", () => {
    // Six finished tickets, closed one after another: three rows deep in a narrow zone.
    const agents = [1, 2, 3, 4, 5, 6].map((n) => agent(`closed-${n}`, { ...closed, endedAt: at(30 + n), createdAt: at(n) }));
    const folded = layoutClusters(clusterInput(agents, { width: 500 }));
    const shown = layoutClusters(clusterInput(agents, { width: 500, doneShown: true }));
    expect(shown.clusters.map((cluster) => cluster.key)).toEqual(['agent:closed-6', 'agent:closed-5', 'agent:closed-4', 'agent:closed-3', 'agent:closed-2', 'agent:closed-1']);
    expect(new Set(shown.clusters.map((cluster) => cluster.y)).size).toBe(3);
    expect(folded.clusters.every((cluster) => !cluster.placed)).toBe(true);
    expect(folded.clusters.map(({ x, y, width, height, tiles }) => ({ x, y, width, height, tiles }))).toEqual(shown.clusters.map(({ x, y, width, height, tiles }) => ({ x, y, width, height, tiles })));
    // Folded, they take no room: the zone ends at Done's line.
    expect(folded.size.height).toBe(folded.doneLine!.y + folded.doneLine!.height + 20);
  });

  it('lays out the same board the same way, whatever order it is listed in', () => {
    const agents = crew();
    expect(layoutClusters(clusterInput(agents.toReversed(), { pinned: new Set(['lead']) }))).toEqual(layoutClusters(clusterInput(agents, { pinned: new Set(['lead']) })));
  });
});
