import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { fakeHarnessEnv, McpClient } from '@agent-board/fake-harness';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import { AGENT_TILE_SIZE, clearOf, CREW_GAP, GRID_COLUMN as COLUMN, GRID_ORIGIN as FIRST, gridPoint, RAIL_GAP, ROW_STEP, sizedFootprint, TILE_GAP, tileSlot, type Rect } from '../src/board-layout.ts';
import type { DaemonClient } from '../src/client.ts';
import { daemonPaths } from '../src/paths.ts';
import { AGENT_NOTE_SIZE, BOARD_ERROR, STICKY_SIZE, type Agent, type AgentUpdatedEvent, type BoardItem, type DaemonEvent, type Zone } from '../src/protocol.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, TEST_CLI_LAUNCHER, tempDataDir, tempRepo } from './helpers.ts';

// Orchestrators laying out their zone: move, arrange, groups and notes, each checked against the orchestrator's scope,
// placed clear of what is there by the board's rules, and logged.

const SIZE = { cols: 120, rows: 40 };

/** A daemon with two zones of different repos, which let no agent orchestrate unless a test does. */
async function layoutDaemon({ gh }: { gh?: string } = {}) {
  const dataDir = tempDataDir();
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }),
    ...(gh === undefined ? {} : { gh, pullRequestPollMs: 100 }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  const repo = tempRepo();
  // On GitHub, where a fake gh finds its agents' pull requests.
  if (gh !== undefined) git(repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
  const zone = await client.call('zone.add', { path: repo, x: 0, y: 0, width: 1200, height: 600, name: 'web' });
  const other = await client.call('zone.add', { path: tempRepo('other'), x: 3000, y: 0, name: 'other' });
  for (const { id } of [zone, other]) await client.call('zone.configure', { id, agentsOrchestrate: false });
  return { daemon, client, recorder, zone, other, repo, dataDir };
}

/** Marks item `id` as made by the agent `sessionId`, as the daemon marks what an orchestrator makes. */
function markMadeBy(setup: Setup, id: string, sessionId: string) {
  const db = new DatabaseSync(daemonPaths(setup.dataDir).database);
  db.prepare('UPDATE board_items SET made_by = ? WHERE id = ?').run(sessionId, id);
  db.close();
}

type Setup = Awaited<ReturnType<typeof layoutDaemon>>;

/** An agent in `zoneId` the user let orchestrate at `scope`, connected as itself: its board token presented. */
async function lead(setup: Setup, zoneId: string, scope: 'zone' | 'repo' | 'board' = 'zone') {
  const { daemon, client, recorder } = setup;
  const agent = await client.call('agent.spawn', { zoneId, name: 'lead', prompt: 'Print your board identity', orchestrate: scope, ...SIZE });
  await client.call('session.attach', { sessionId: agent.sessionId });
  await recorder.waitForText(agent.sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(recorder.screenText(agent.sessionId))![1]!;
  const connection = await connectTestClient(daemon);
  await connection.call('board.identify', { token });
  return { agent, token, connection };
}

const userAgent = (client: DaemonClient, zoneId: string, name: string) => client.call('agent.spawn', { zoneId, name, ...SIZE });

/** Every tile and item in `zoneId` as the daemon has them now, by name (a note by its text). */
async function rectsIn(client: DaemonClient, zoneId: string): Promise<Map<string, Rect>> {
  const [agents, items] = await Promise.all([client.call('agent.list'), client.call('item.list')]);
  const rects = new Map<string, Rect>();
  for (const agent of agents) if (agent.zoneId === zoneId && agent.position !== null) rects.set(agent.name, { x: agent.position.x, y: agent.position.y, ...AGENT_TILE_SIZE });
  for (const item of items) {
    if (item.zoneId === zoneId) rects.set(`item:${String(item.data.text ?? item.data.url)}`, { x: item.x, y: item.y, width: item.width, height: item.height });
  }
  return rects;
}

/** Asserts no two of `rects` (tiles with the room above them for their characters, and items) come within a gap of each other. */
function expectNoOverlap(rects: Map<string, Rect>) {
  const all = [...rects].map(([name, rect]) => [name, name.startsWith('item:') ? rect : sizedFootprint(rect, rect)] as const);
  const touching = all.flatMap(([name, rect], index) => all.slice(index + 1).filter(([, other]) => !clearOf(rect, [other])).map(([other]) => `${name} / ${other}`));
  expect(touching).toEqual([]);
}

async function lastLine(client: DaemonClient) {
  const [line] = await client.call('orchestrator.activity', { limit: 1 });
  return line!;
}

describe('orchestrator.move', () => {
  it('puts a worker beside it, clear of what is there, and logs it', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    await setup.client.call('agent.move', { sessionId: me.agent.sessionId, zoneId: setup.zone.id, ...tileSlot(0, 1200) });
    const worker = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker' });
    const blocker = await userAgent(setup.client, setup.zone.id, 'blocker');
    const below = { x: tileSlot(0, 1200).x, y: tileSlot(0, 1200).y + AGENT_TILE_SIZE.height + TILE_GAP + 24 };
    await setup.client.call('agent.move', { sessionId: blocker.sessionId, zoneId: setup.zone.id, ...below });

    const moved = await me.connection.call('orchestrator.move', {
      token: me.token,
      target: { kind: 'agent', id: worker.sessionId },
      near: { kind: 'agent', id: me.agent.sessionId },
      side: 'below',
    });
    expect(moved.zoneId).toBe(setup.zone.id);
    const rects = await rectsIn(setup.client, setup.zone.id);
    expect(rects.get('worker')).toMatchObject({ x: moved.x, y: moved.y });
    expectNoOverlap(rects);
    expect(await lastLine(setup.client)).toMatchObject({ orchestratorId: me.agent.sessionId, action: 'move', targetName: 'worker', outcome: 'done' });
  });

  it("works out where the board slots tiles it never saved, as a crew member's spot beside its lead", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const worker = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker' });
    // Neither has a place of its own: the board draws the lead in the first slot, its worker beside it.
    const shell = await setup.client.call('shell.create', { zoneId: setup.zone.id, position: { x: 900, y: 400 } });
    const moved = await me.connection.call('orchestrator.move', {
      token: me.token,
      target: { kind: 'shell', id: shell.id },
      near: { kind: 'agent', id: worker.sessionId },
      side: 'right',
    });
    const slot = tileSlot(0, 1200);
    expect(moved).toMatchObject({ x: slot.x + 2 * AGENT_TILE_SIZE.width + CREW_GAP + TILE_GAP, y: slot.y });
  });

  it('moves a note, and grows the zone to hold what it moves there', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const note = await setup.client.call('item.create', { kind: 'sticky', zoneId: setup.zone.id, x: 40, y: 40, ...STICKY_SIZE, data: { text: 'mine', color: '#fff3a3' } });
    const moved = await me.connection.call('orchestrator.move', { token: me.token, target: { kind: 'item', id: note.id }, at: { x: 1300, y: 700 } });
    // On the grid cell nearest the wish.
    expect(moved).toMatchObject(gridPoint(5, 4));
    const zone = (await setup.client.call('zone.list')).find((each) => each.id === setup.zone.id)!;
    expect(zone.width).toBeGreaterThanOrEqual(moved.x + STICKY_SIZE.width);
    expect(zone.height).toBeGreaterThanOrEqual(moved.y + STICKY_SIZE.height);
  });

  it('lands exactly on the grid cell nearest the wish, moving what is there aside, never itself', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const spawn = (name: string) => me.connection.call('orchestrator.spawn', { token: me.token, name });
    const [a, b, c] = [await spawn('a'), await spawn('b'), await spawn('c')];
    const place = (agent: Agent, column: number, row: number) => setup.client.call('agent.move', { sessionId: agent.sessionId, zoneId: setup.zone.id, ...gridPoint(column, row) });
    await place(me.agent, 0, 0);
    await place(a, 1, 1);
    await place(b, 2, 1);
    await place(c, 0, 2);
    const moved = await me.connection.call('orchestrator.move', { token: me.token, target: { kind: 'agent', id: c.sessionId }, at: { x: gridPoint(1, 1).x + 30, y: gridPoint(1, 1).y - 20 } });
    expect(moved).toMatchObject(gridPoint(1, 1));
    const rects = await rectsIn(setup.client, setup.zone.id);
    expect(rects.get('c')).toMatchObject(gridPoint(1, 1));
    expect(rects.get('a')).toMatchObject(gridPoint(2, 1));
    expect(rects.get('b')).toMatchObject(gridPoint(3, 1));
    expect(rects.get('lead')).toMatchObject(gridPoint(0, 0));
    expectNoOverlap(rects);
  });

  it("never moves the user's notes aside: a spot one fills is refused", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const worker = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker' });
    const users = await setup.client.call('item.create', { kind: 'sticky', zoneId: setup.zone.id, ...gridPoint(2, 1), ...STICKY_SIZE, data: { text: 'mine', color: '#fff3a3' } });
    await expect(me.connection.call('orchestrator.move', { token: me.token, target: { kind: 'agent', id: worker.sessionId }, at: gridPoint(2, 1) })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/you didn't make it/),
    });
    expect((await setup.client.call('item.list')).find((item) => item.id === users.id)).toMatchObject(gridPoint(2, 1));
  });

  it('refuses a tile or a zone outside its scope, and loose on the board short of board scope, logging each', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const elsewhere = await userAgent(setup.client, setup.other.id, 'elsewhere');
    const mine = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker' });
    const refusals = [
      me.connection.call('orchestrator.move', { token: me.token, target: { kind: 'agent', id: elsewhere.sessionId }, zoneId: setup.zone.id }),
      me.connection.call('orchestrator.move', { token: me.token, target: { kind: 'agent', id: mine.sessionId }, zoneId: setup.other.id }),
      me.connection.call('orchestrator.move', { token: me.token, target: { kind: 'agent', id: mine.sessionId }, zoneId: null, at: { x: 0, y: 2000 } }),
    ];
    for (const refused of refusals) await expect(refused).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    expect(await lastLine(setup.client)).toMatchObject({ action: 'move', outcome: 'refused', reason: expect.stringMatching(/whole board/) });
  });

  it('is refused to an agent that may not orchestrate', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    await setup.client.call('agent.setOrchestrate', { sessionId: me.agent.sessionId, scope: null });
    await expect(
      me.connection.call('orchestrator.move', { token: me.token, target: { kind: 'agent', id: me.agent.sessionId }, at: { x: 40, y: 60 } }),
    ).rejects.toMatchObject({ code: BOARD_ERROR.notAllowed });
  });

  it("never moves an agent into a zone that would let it orchestrate, but the user's side may", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id, 'board');
    // The user's group lets agents orchestrate, as a new zone does.
    const users = await setup.client.call('zone.addUnbound', { name: 'review', x: 0, y: 2000 });
    expect(users.agentsOrchestrate).toBe(true);
    const worker = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker' });
    await expect(
      me.connection.call('orchestrator.move', { token: me.token, target: { kind: 'agent', id: worker.sessionId }, zoneId: users.id }),
    ).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope, message: expect.stringMatching(/would let it orchestrate/) });

    await setup.client.call('orchestrator.move', { target: { kind: 'agent', id: worker.sessionId }, zoneId: users.id });
    const moved = (await setup.client.call('agent.list')).find((agent) => agent.sessionId === worker.sessionId)!;
    expect(moved.zoneId).toBe(users.id);
  });

  it('never moves a zone-scoped orchestrator out of its zone, its scope, but within it as it likes', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const group = await me.connection.call('orchestrator.addZone', { token: me.token, name: 'review' });
    const self = { kind: 'agent' as const, id: me.agent.sessionId };
    await expect(me.connection.call('orchestrator.move', { token: me.token, target: self, zoneId: group.id })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/your zone is your scope/),
    });
    await me.connection.call('orchestrator.move', { token: me.token, target: self, at: { x: 600, y: 300 } });
    // Still in its zone: it arranges it.
    expect(await me.connection.call('orchestrator.arrange', { token: me.token })).toMatchObject({ zoneId: setup.zone.id });
  });

  it("puts a far-off wish at its zone's reach, and never grows the zone over another", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const note = await me.connection.call('orchestrator.addNote', { token: me.token, text: 'far', at: { x: 40, y: 40 } });
    const far = await me.connection.call('orchestrator.move', { token: me.token, target: { kind: 'item', id: note.id }, at: { x: 40, y: 1e9 } });
    expect(far.y).toBeLessThanOrEqual(600 + 1000);
    // `other` sits 1800 px right of web's edge: a wish that far right would grow web over it.
    await setup.client.call('zone.update', { id: setup.other.id, x: 1300, y: 0, width: 720, height: 480 });
    await expect(me.connection.call('orchestrator.move', { token: me.token, target: { kind: 'item', id: note.id }, at: { x: 1500, y: 100 } })).rejects.toMatchObject({
      message: expect.stringMatching(/over other: zones never overlap/),
    });
    await expect(me.connection.call('orchestrator.addNote', { token: me.token, text: 'there', at: { x: 1500, y: 100 } })).rejects.toMatchObject({
      message: expect.stringMatching(/over other/),
    });
    const web = (await setup.client.call('zone.list')).find((zone) => zone.id === setup.zone.id)!;
    expect(web.x + web.width).toBeLessThanOrEqual(1300);
  });
});

describe('orchestrator.arrange', () => {
  /** A lead and its crew scattered about its zone: an implementer and its reviewer joined by an edge, and a third. */
  async function messyCrew(setup: Setup) {
    const me = await lead(setup, setup.zone.id);
    const spawn = (name: string) => me.connection.call('orchestrator.spawn', { token: me.token, name });
    const [impl, review, third] = [await spawn('impl'), await spawn('review'), await spawn('third')];
    await me.connection.call('orchestrator.addEdge', { token: me.token, from: impl.sessionId, to: review.sessionId });
    const scatter: [Agent, number, number][] = [
      [me.agent, 700, 300],
      [impl, 40, 400],
      [review, 900, 60],
      [third, 400, 220],
    ];
    for (const [agent, x, y] of scatter) await setup.client.call('agent.move', { sessionId: agent.sessionId, zoneId: setup.zone.id, x, y });
    const note = await setup.client.call('item.create', { kind: 'sticky', zoneId: setup.zone.id, x: 300, y: 250, ...STICKY_SIZE, data: { text: 'user note', color: '#fff3a3' } });
    return { me, impl, review, third, note };
  }

  it('lays its crew out a row each, the reviewer a rail apart from its implementer, clear of the notes, and logs it', async () => {
    const setup = await layoutDaemon();
    const { me, note } = await messyCrew(setup);
    const result = await me.connection.call('orchestrator.arrange', { token: me.token });
    expect(result.zoneId).toBe(setup.zone.id);
    const rects = await rectsIn(setup.client, setup.zone.id);
    expectNoOverlap(rects);
    const [leadAt, impl, review, third] = ['lead', 'impl', 'review', 'third'].map((name) => rects.get(name)!) as [Rect, Rect, Rect, Rect];
    expect(review.y).toBe(impl.y);
    // The edge joining them is drawn as a rail: its token and label fit between them, a grid column apart.
    expect(review.x).toBe(impl.x + 2 * COLUMN);
    expect(review.x - (impl.x + AGENT_TILE_SIZE.width)).toBeGreaterThanOrEqual(RAIL_GAP);
    expect(leadAt.y).toBeLessThan(impl.y);
    expect(third.y).toBeGreaterThan(impl.y);
    // The user's note stays where it was.
    expect(rects.get('item:user note')).toMatchObject({ x: note.x, y: note.y });
    expect(await lastLine(setup.client)).toMatchObject({ action: 'arrange', targetName: 'web', outcome: 'done', detail: '4 tiles by issue, in rows' });
  });

  it('starts each unit of work with a label and an agent note, edited in place on the next arrange, never stacked', async () => {
    const setup = await layoutDaemon();
    const { me } = await messyCrew(setup);
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const notes = async () => (await setup.client.call('item.list')).filter((item) => typeof item.data.arrange === 'string');
    const first = await notes();
    // impl and review are one unit (joined by an edge), third another: a label and a sticky each.
    expect(first.map((item) => [item.kind, item.data.arrange]).sort()).toEqual([
      ['agent-note', expect.stringMatching(/#note$/)],
      ['agent-note', expect.stringMatching(/#note$/)],
      ['text', expect.stringMatching(/#label$/)],
      ['text', expect.stringMatching(/#label$/)],
    ]);
    // An agent note by the lead, saying where each agent stands.
    const sticky = first.find((item) => item.kind === 'agent-note' && String(item.data.text).includes('**impl**'))!;
    expect(sticky.data).toMatchObject({ text: expect.stringMatching(/^- \*\*impl\*\*: .+\n- \*\*review\*\*: .+$/), agent: { name: 'lead' }, editedByUser: false });
    const impl = (await rectsIn(setup.client, setup.zone.id)).get('impl')!;
    expect(sticky.x + sticky.width).toBeLessThan(impl.x);
    expectNoOverlap(await rectsIn(setup.client, setup.zone.id));

    await me.connection.call('orchestrator.arrange', { token: me.token });
    expect((await notes()).map((item) => item.id).sort()).toEqual(first.map((item) => item.id).sort());
  });

  it("keeps a sticky's text once it is edited, on every arrange after", async () => {
    const setup = await layoutDaemon();
    const { me } = await messyCrew(setup);
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const stickyOf = async () => (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note' && String(item.data.text).includes('**impl**'))!;
    const sticky = await stickyOf();
    await me.connection.call('orchestrator.editNote', { token: me.token, id: sticky.id, text: '**impl**: fixing the 🤖 menu\nreview: waiting' });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    expect((await stickyOf()).data.text).toBe('**impl**: fixing the 🤖 menu\nreview: waiting');
    // The user's edit too.
    await setup.client.call('item.update', { id: sticky.id, data: { text: 'mine now' } });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    expect((await setup.client.call('item.list')).find((item) => item.id === sticky.id)!.data.text).toBe('mine now');
  });

  it('puts every tile on the grid and every sticky within a cell of its implementer', async () => {
    const setup = await layoutDaemon();
    const { me } = await messyCrew(setup);
    for (const by of ['issue', 'role', 'state'] as const) {
      for (const layout of ['rows', 'grid'] as const) {
        await me.connection.call('orchestrator.arrange', { token: me.token, by, layout });
        const agents = (await setup.client.call('agent.list')).filter((agent) => agent.zoneId === setup.zone.id);
        const off = agents.filter(({ position }) => !Number.isInteger((position!.x - FIRST.x) / COLUMN) || !Number.isInteger((position!.y - FIRST.y) / ROW_STEP));
        expect(off.map((agent) => [by, layout, agent.name, agent.position])).toEqual([]);
        expectNoOverlap(await rectsIn(setup.client, setup.zone.id));
      }
    }
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const rects = await rectsIn(setup.client, setup.zone.id);
    const sticky = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note' && String(item.data.text).includes('**impl**'))!;
    expect(Math.abs(sticky.x + COLUMN - rects.get('impl')!.x)).toBeLessThanOrEqual(0);
    expect(Math.abs(sticky.y - rects.get('impl')!.y)).toBeLessThan(ROW_STEP);
  });

  it('keeps what an arrange by issue made when arranging another way, lined up beside the crew, and the orchestrator may remove only its own link cards', async () => {
    const setup = await layoutDaemon();
    const { me } = await messyCrew(setup);
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const parts = async () => (await setup.client.call('item.list')).filter((item) => typeof item.data.arrange === 'string');
    const before = (await parts()).map((item) => item.id).sort();
    await me.connection.call('orchestrator.arrange', { token: me.token, by: 'role' });
    expect((await parts()).map((item) => item.id).sort()).toEqual(before);
    expectNoOverlap(await rectsIn(setup.client, setup.zone.id));
    // Back by issue, each in its slot again.
    await me.connection.call('orchestrator.arrange', { token: me.token });
    expect((await parts()).map((item) => item.id).sort()).toEqual(before);
    const card = await setup.client.call('item.create', { kind: 'link', zoneId: setup.zone.id, x: 900, y: 500, width: 240, height: 96, data: { url: 'https://github.com/o/r/pull/9' } });
    await expect(me.connection.call('orchestrator.removeNote', { token: me.token, id: card.id })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
  });

  it('arranges a zone once at a time, so two at once make one label and sticky a unit; and clears stacked ones', async () => {
    const setup = await layoutDaemon();
    const { me } = await messyCrew(setup);
    await Promise.all([me.connection.call('orchestrator.arrange', { token: me.token }), me.connection.call('orchestrator.arrange', { token: me.token })]);
    const parts = async () => (await setup.client.call('item.list')).filter((item) => typeof item.data.arrange === 'string');
    expect(await parts()).toHaveLength(4);
    // Stacked parts (from a daemon before arranges were one at a time) go at the next arrange.
    const [sticky] = (await parts()).filter((item) => item.kind === 'agent-note');
    await setup.client.call('item.create', { kind: 'agent-note', zoneId: setup.zone.id, x: sticky!.x, y: sticky!.y, width: 180, height: 136, data: { ...sticky!.data } });
    expect(await parts()).toHaveLength(5);
    // The user's side arranges as the maker of every part, so it clears them all.
    await setup.client.call('orchestrator.arrange', { zoneId: setup.zone.id });
    const keys = (await parts()).map((item) => item.data.arrange);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("makes an agent note per cluster that says where its agents stand, never the prompt they were given; keeps a hand-placed one; is a no-op the second time", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const prompt = 'Print your board identity';
    const worker = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker', prompt });
    await setup.client.call('session.attach', { sessionId: worker.sessionId });
    await setup.recorder.waitForText(worker.sessionId, ':end\r\n');
    const token = /identity:(.*):end\r\n/.exec(setup.recorder.screenText(worker.sessionId))![1]!;
    const own = await connectTestClient(setup.daemon);
    await own.call('board.identify', { token });
    await own.call('board.setStatus', { token, summary: 'Reading the menu code', progress: 40 });
    const idle = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'idler' });
    // A note the lead put by idler's tile by hand, before any arrange.
    const hand = await me.connection.call('orchestrator.addNote', { token: me.token, text: 'Waiting on design', near: { kind: 'agent', id: idle.sessionId } });
    expect(hand.kind).toBe('agent-note');

    await me.connection.call('orchestrator.arrange', { token: me.token });
    const items = await setup.client.call('item.list');
    const notes = items.filter((item) => typeof item.data.arrange === 'string' && item.kind !== 'text');
    expect(notes.every((item) => item.kind === 'agent-note' && (item.data as { agent: { name: string } }).agent.name === 'lead')).toBe(true);
    const text = notes.map((item) => String(item.data.text)).join('\n');
    expect(text).toContain('- **worker**: Reading the menu code')
    expect(text).not.toContain('40%');
    expect(text).not.toContain(prompt);
    // The hand-placed note is idler's cluster's note: kept as written, not duplicated.
    const handNow = items.find((item) => item.id === hand.id)!;
    expect(handNow.data).toMatchObject({ text: 'Waiting on design', members: [idle.sessionId], arrange: expect.stringMatching(/#note$/) });
    expect(notes.filter((item) => (item.data.members as string[]).includes(idle.sessionId))).toHaveLength(1);

    // About the crew member each is for (its cluster's implementer, or the tile it was put beside), never the lead: the
    // board tethers a note to that agent, so none joins a note to the orchestrator.
    expect(notes.map((item) => [item.data.members, (item.data as { about?: string }).about])).toEqual(
      expect.arrayContaining([
        [[worker.sessionId], worker.sessionId],
        [[idle.sessionId], idle.sessionId],
      ]),
    );
    expect(notes.every((item) => (item.data as { about?: string }).about !== me.agent.sessionId)).toBe(true);
    expect(hand.data).toMatchObject({ about: idle.sessionId });
    const edges = await setup.client.call('flowEdge.list');
    expect(edges.filter((edge) => [edge.from, edge.to].some((end) => notes.some((item) => item.id === end)))).toEqual([]);

    const before = await setup.client.call('item.list');
    const again = await me.connection.call('orchestrator.arrange', { token: me.token });
    expect(again.moved).toEqual([]);
    expect(await setup.client.call('item.list')).toEqual(before);
  });

  it('adopts only a note about the cluster, left in its slot, and keeps every other note clear of the arranged tiles, tethered to no one', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const impl = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'impl' });
    const review = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'review' });
    const third = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'third' });
    await me.connection.call('orchestrator.addEdge', { token: me.token, from: impl.sessionId, to: review.sessionId });
    const near = (agent: Agent, extra: object = {}) => me.connection.call('orchestrator.addNote', { token: me.token, text: `about ${agent.name}`, near: { kind: 'agent', id: agent.sessionId }, ...extra });
    // In the slot before impl; a second one in the same cluster, before review; by the lead's own tile; beside third, below it; and free.
    const slot = await near(impl);
    const second = await near(review);
    const mine = await near(me.agent);
    const below = await near(third, { side: 'below' });
    const free = await me.connection.call('orchestrator.addNote', { token: me.token, text: 'free' });

    await me.connection.call('orchestrator.arrange', { token: me.token });
    const items = await setup.client.call('item.list');
    const now = (id: string) => items.find((item) => item.id === id)!;
    // Only the first note in the cluster's slot is its note; the rest keep their places and stay unkeyed.
    expect(now(slot.id).data).toMatchObject({ arrange: expect.stringMatching(/#note$/), members: [impl.sessionId, review.sessionId], about: impl.sessionId });
    for (const each of [second, mine, below, free]) expect(now(each.id).data.arrange).toBeUndefined();
    expect(now(mine.id).data.about).toBe(me.agent.sessionId);
    // Nothing is laid on top of anything.
    expectNoOverlap(await rectsIn(setup.client, setup.zone.id));
    // A free note is about no agent, so nothing tethers it to the lead.
    expect(now(free.id).data.about).toBeUndefined();
    await me.connection.call('orchestrator.arrange', { token: me.token });
    expectNoOverlap(await rectsIn(setup.client, setup.zone.id));
  });

  it("says what an agent's last message began with when it has set no status and its turn has ended", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const worker = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker', prompt: 'Write the handover' });
    await setup.recorder.waitFor((event: DaemonEvent): event is AgentUpdatedEvent => event.type === 'agent.updated' && event.agent.sessionId === worker.sessionId && /STATUS: /.test(event.agent.lastMessage ?? ''));
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const note = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note')!;
    expect(note.data.text).toMatch(/^- \*\*worker\*\*: Handover written\.$/);
  });

  it('arranges the same way again, moving nothing the second time', async () => {
    const setup = await layoutDaemon();
    const { me } = await messyCrew(setup);
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const first = await rectsIn(setup.client, setup.zone.id);
    const parts = await setup.client.call('item.list');
    const again = await me.connection.call('orchestrator.arrange', { token: me.token });
    expect(again.moved).toEqual([]);
    expect(await rectsIn(setup.client, setup.zone.id)).toEqual(first);
    // Nor are its labels and stickies written again, nor re-signed.
    expect(await setup.client.call('item.list')).toEqual(parts);
  });

  it("puts a reviewer started on an arranged implementer's branch straight into its cluster, after it, and on its sticky", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const impl = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'impl', role: 'custom' });
    await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other' });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const before = await rectsIn(setup.client, setup.zone.id);
    const review = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'review', role: 'reviewer', baseBranch: impl.branch });
    const rects = await rectsIn(setup.client, setup.zone.id);
    expect(rects.get('review')).toMatchObject({ x: before.get('impl')!.x + COLUMN, y: before.get('impl')!.y });
    expect(review.position).toMatchObject({ x: before.get('impl')!.x + COLUMN, y: before.get('impl')!.y });
    expect(rects.get('other')).toMatchObject({ x: before.get('other')!.x, y: before.get('other')!.y });
    expectNoOverlap(rects);
    const sticky = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note' && Array.isArray(item.data.members) && item.data.members.includes(impl.sessionId))!;
    expect(sticky.data.members).toEqual([impl.sessionId, review.sessionId]);
    expect(sticky.data.text).toMatch(/^- \*\*impl\*\*: .+\n- \*\*review\*\*: .+$/);
    expect(sticky.data.text).not.toContain('Reviews');
    // It is joined to its implementer by edges as it starts, so the next arrange leaves a rail's room between them
    // (the first column past it), and from then on it stays put.
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const arranged = await rectsIn(setup.client, setup.zone.id);
    expect(arranged.get('review')!.y).toBe(rects.get('review')!.y);
    expect(arranged.get('review')!.x).toBeGreaterThan(rects.get('review')!.x);
    expectNoOverlap(arranged);
    const again = await me.connection.call('orchestrator.arrange', { token: me.token });
    expect(again.moved).toEqual([]);
  });

  it("re-anchors an edited sticky when its cluster's key changes, never deleting it", async () => {
    const setup = await layoutDaemon();
    const { me, impl, review } = await messyCrew(setup);
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const stickyOf = async () => (await setup.client.call('item.list')).filter((item) => item.kind === 'agent-note' && Array.isArray(item.data.members) && item.data.members.includes(impl.sessionId));
    const [sticky] = await stickyOf();
    await setup.client.call('item.update', { id: sticky!.id, data: { text: 'blocked on design review' } });
    // An edge into the implementer: the new agent now starts the unit, so its cluster is keyed by it.
    const first = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'first' });
    await me.connection.call('orchestrator.addEdge', { token: me.token, from: first.sessionId, to: impl.sessionId });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const after = await stickyOf();
    expect(after.map((item) => [item.id, item.data.text])).toEqual([[sticky!.id, 'blocked on design review']]);
    expect(after[0]!.data.members).toEqual([first.sessionId, impl.sessionId, review.sessionId]);
    expect(after[0]!.data.arrange).toBe(`agent:${first.sessionId}#note`);
    expectNoOverlap(await rectsIn(setup.client, setup.zone.id));
  });

  it("puts each of two reviewers started at once in its implementer's cluster, one after the other", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const impl = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'impl', role: 'implementer' });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const implAt = (await rectsIn(setup.client, setup.zone.id)).get('impl')!;
    const reviewer = (name: string) => me.connection.call('orchestrator.spawn', { token: me.token, name, role: 'reviewer', baseBranch: impl.branch });
    const started = await Promise.all([reviewer('one'), reviewer('two')]);
    const rects = await rectsIn(setup.client, setup.zone.id);
    expect([rects.get('one')!.x, rects.get('two')!.x].sort((a, b) => a - b)).toEqual([implAt.x + COLUMN, implAt.x + 2 * COLUMN]);
    expect([rects.get('one')!.y, rects.get('two')!.y]).toEqual([implAt.y, implAt.y]);
    expectNoOverlap(rects);
    const sticky = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note')!;
    expect([...(sticky.data.members as string[])].sort()).toEqual([impl.sessionId, ...started.map((agent) => agent.sessionId)].sort());
  });

  it("starts a reviewer all the same when the user's note fills its cluster slot, leaving it where the board slots it", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const impl = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'impl', role: 'implementer' });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const implAt = (await rectsIn(setup.client, setup.zone.id)).get('impl')!;
    await setup.client.call('item.create', { kind: 'sticky', zoneId: setup.zone.id, x: implAt.x + COLUMN, y: implAt.y, ...STICKY_SIZE, data: { text: 'mine', color: '#fff3a3' } });
    const review = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'review', role: 'reviewer', baseBranch: impl.branch });
    expect(review.position).toBeNull();
    const sticky = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note' && item.data.arrange !== undefined)!;
    expect(sticky.data.members).toEqual([impl.sessionId]);
  });

  it('parks the parts of an arrange by issue below the crew when beside it would grow the zone over another', async () => {
    const setup = await layoutDaemon();
    const { me } = await messyCrew(setup);
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const parts = async () => (await setup.client.call('item.list')).filter((item) => typeof item.data.arrange === 'string');
    const before = (await parts()).map((item) => item.id).sort();
    const web = (await setup.client.call('zone.list')).find((zone) => zone.id === setup.zone.id)!;
    // Web just wide enough for the crew by role (three columns and the rail's between impl and review), and another zone
    // just right of it: nothing fits beside.
    await setup.client.call('zone.update', { id: web.id, x: web.x, y: web.y, width: 1120, height: web.height });
    await setup.client.call('zone.update', { id: setup.other.id, x: web.x + 1130, y: 0, width: 720, height: 480 });
    await me.connection.call('orchestrator.arrange', { token: me.token, by: 'role' });
    expect((await parts()).map((item) => item.id).sort()).toEqual(before);
    const rects = await rectsIn(setup.client, setup.zone.id);
    expectNoOverlap(rects);
    const lowest = Math.max(...['lead', 'impl', 'review', 'third'].map((name) => rects.get(name)!.y));
    for (const item of await parts()) expect(item.y).toBeGreaterThan(lowest);
  });

  it('keeps a note added to a sticky while a reviewer joins its cluster at the same time', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const impl = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'impl', role: 'implementer' });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    await Promise.all([
      me.connection.call('orchestrator.spawn', { token: me.token, name: 'review', role: 'reviewer', baseBranch: impl.branch }),
      me.connection.call('orchestrator.addNote', { token: me.token, text: 'blocked on X', near: { kind: 'agent', id: impl.sessionId } }),
    ]);
    const sticky = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note')!;
    expect(sticky.data.text).toMatch(/blocked on X/);
    expect(sticky.data.members).toHaveLength(2);
  });

  it('starts a reviewer all the same when writing its cluster’s sticky fails after it has moved', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const impl = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'impl', role: 'implementer' });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const sticky = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note')!;
    // Its data just under the limit: adding the reviewer to it goes over, so the join's last write is refused.
    const room = 64 * 1024 - Buffer.byteLength(JSON.stringify(sticky.data)) - 40;
    await setup.client.call('item.update', { id: sticky.id, data: { pad: 'x'.repeat(room) } });
    const review = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'review', role: 'reviewer', baseBranch: impl.branch });
    expect(review.name).toBe('review');
    expect((await setup.client.call('agent.list')).some((agent) => agent.sessionId === review.sessionId)).toBe(true);
  });

  it('lays the crew out round the parts it can park nowhere, never on top of them', async () => {
    const setup = await layoutDaemon();
    const { me } = await messyCrew(setup);
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const parts = async () => (await setup.client.call('item.list')).filter((item) => typeof item.data.arrange === 'string');
    const before = (await parts()).map((item) => item.id).sort();
    const web = (await setup.client.call('zone.list')).find((zone) => zone.id === setup.zone.id)!;
    // Zones hard against web to its right and below it: it can grow neither way.
    await setup.client.call('zone.update', { id: setup.other.id, x: web.x + web.width + 10, y: 0, width: 720, height: 480 });
    await setup.client.call('zone.addUnbound', { name: 'below', x: 0, y: web.y + web.height + 10, width: web.width, height: 400 });
    await me.connection.call('orchestrator.arrange', { token: me.token, by: 'role' });
    expect((await parts()).map((item) => item.id).sort()).toEqual(before);
    expectNoOverlap(await rectsIn(setup.client, setup.zone.id));
  });

  it("replaces a sticky an earlier arrange wrote and no one edited with an agent note, or clears it, but keeps one someone edited", async () => {
    const setup = await layoutDaemon();
    const { impl, me } = await messyCrew(setup);
    const old = async (text: string, key: string) => {
      const item = await setup.client.call('item.create', { kind: 'sticky', zoneId: setup.zone.id, x: 900, y: 400, width: 180, height: 136, data: { text, color: '#fff3a3', arrange: key } });
      markMadeBy(setup, item.id, me.agent.sessionId);
      return item;
    };
    // As arranges before this one wrote them: no members, no record of what they wrote.
    const adopted = await old('impl: idle\nreview: thinking\n\n🤖 lead · 23:15', `agent:${impl.sessionId}#note`);
    const generated = await old('third: idle\n\n🤖 lead · 23:15', 'agent:gone#note');
    const written = await old('impl: waiting on design\n\n🤖 lead · 23:20', 'agent:gone-too#note');
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const items = await setup.client.call('item.list');
    // Still its cluster's, but now an agent note saying where its agents stand.
    expect(items.some((item) => item.id === adopted.id)).toBe(false);
    expect(items.find((item) => item.data.arrange === `agent:${impl.sessionId}#note`)).toMatchObject({
      kind: 'agent-note',
      data: { text: expect.stringMatching(/^- \*\*impl\*\*: /), members: expect.any(Array) },
    });
    // Its cluster gone: it goes, as no one wrote on it.
    expect(items.some((item) => item.id === generated.id)).toBe(false);
    expect(items.find((item) => item.id === written.id)?.data.text).toBe('impl: waiting on design\n\n🤖 lead · 23:20');
    expectNoOverlap(await rectsIn(setup.client, setup.zone.id));
  });

  it("removes an earlier arrange's PR card when it arranges another way, too", async () => {
    const setup = await layoutDaemon();
    const { me } = await messyCrew(setup);
    const old = await setup.client.call('item.create', {
      kind: 'link',
      zoneId: setup.zone.id,
      x: 900,
      y: 400,
      width: 240,
      height: 96,
      data: { url: 'https://github.com/acme/app/pull/9', arrange: 'agent:gone#pr' },
    });
    markMadeBy(setup, old.id, me.agent.sessionId);
    await me.connection.call('orchestrator.arrange', { token: me.token, by: 'state' });
    expect((await setup.client.call('item.list')).some((item) => item.id === old.id)).toBe(false);
  });
  it('leaves a zone outside its scope alone', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    await expect(me.connection.call('orchestrator.arrange', { token: me.token, zoneId: setup.other.id })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    expect(await lastLine(setup.client)).toMatchObject({ action: 'arrange', outcome: 'refused' });
  });
});

describe('groups an orchestrator makes', () => {
  it('makes one beside its zone, never on another, marked as its own: it renames, resizes and removes only its own', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const group = await me.connection.call('orchestrator.addZone', { token: me.token, name: 'review', x: 100, y: 100 });
    expect(group).toMatchObject({ kind: 'unbound', name: 'review' });
    const zones = await setup.client.call('zone.list');
    for (const zone of zones.filter((each) => each.id !== group.id)) expect(overlapping(zone, group)).toBe(false);
    expect(await lastLine(setup.client)).toMatchObject({ action: 'add-zone', targetName: 'review', outcome: 'done' });

    const renamed = await me.connection.call('orchestrator.changeZone', { token: me.token, id: group.id, name: 'reviews', width: 800, height: 400 });
    expect(renamed).toMatchObject({ name: 'reviews', width: 800, height: 400 });
    expect(await lastLine(setup.client)).toMatchObject({ action: 'change-zone', outcome: 'done' });

    const users = await setup.client.call('zone.addUnbound', { name: 'the user’s', x: 0, y: 3000 });
    for (const refused of [
      me.connection.call('orchestrator.changeZone', { token: me.token, id: users.id, name: 'mine now' }),
      me.connection.call('orchestrator.removeZone', { token: me.token, id: users.id }),
    ]) {
      await expect(refused).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    }
    await expect(me.connection.call('orchestrator.changeZone', { token: me.token, id: setup.zone.id, name: 'x' })).rejects.toMatchObject({
      message: expect.stringMatching(/only groups/),
    });

    await me.connection.call('orchestrator.removeZone', { token: me.token, id: group.id });
    expect((await setup.client.call('zone.list')).some((zone) => zone.id === group.id)).toBe(false);
    expect(await lastLine(setup.client)).toMatchObject({ action: 'remove-zone', targetName: 'reviews', outcome: 'done' });
  });

  it('shrinks a group past its tiles only as the board does, moving the cut ones, and never onto another zone', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const group = await me.connection.call('orchestrator.addZone', { token: me.token, name: 'review', x: 0, y: 1000, width: 1000, height: 400 });
    const worker = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker' });
    await me.connection.call('orchestrator.move', { token: me.token, target: { kind: 'agent', id: worker.sessionId }, zoneId: group.id, at: { x: 700, y: 44 } });
    await me.connection.call('orchestrator.changeZone', { token: me.token, id: group.id, width: 600 });
    const moved = (await setup.client.call('agent.list')).find((agent) => agent.sessionId === worker.sessionId)!;
    expect(moved.position!.x + AGENT_TILE_SIZE.width).toBeLessThanOrEqual(600);
    await expect(me.connection.call('orchestrator.changeZone', { token: me.token, id: group.id, width: 260, height: 160 })).rejects.toMatchObject({
      message: expect.stringMatching(/nowhere to go/),
    });
    await expect(me.connection.call('orchestrator.changeZone', { token: me.token, id: group.id, y: 0 })).rejects.toMatchObject({
      message: expect.stringMatching(/would cover web/),
    });
  });

  it('makes a group that lets no agent orchestrate: an agent started in it does not', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id, 'board');
    const group = await me.connection.call('orchestrator.addZone', { token: me.token, name: 'review' });
    expect(group.agentsOrchestrate).toBe(false);
    await setup.client.call('zone.setDefaultRepo', { id: group.id, path: setup.zone.repoRoot! });
    const worker = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker', zoneId: group.id });
    expect(worker.orchestrate).toBeNull();
  });

  it("caps a group's name and size, and refuses control characters in it", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    for (const [fields, message] of [
      [{ name: 'x'.repeat(81) }, /at most 80 characters/],
      [{ name: 'evil\u001b[2J' }, /control character/],
      [{ name: 'nul\u0000' }, /control character/],
      [{ name: 'huge', width: 1e9 }, /at most 8000 px/],
    ] as const) {
      await expect(me.connection.call('orchestrator.addZone', { token: me.token, ...fields })).rejects.toMatchObject({ message: expect.stringMatching(message) });
    }
    const group = await me.connection.call('orchestrator.addZone', { token: me.token, name: 'ok', x: 1e12, y: -1e12 });
    expect(Math.abs(group.x)).toBeLessThanOrEqual(100_000 + 2000);
    await expect(me.connection.call('orchestrator.changeZone', { token: me.token, id: group.id, name: 'bell\u0007' })).rejects.toMatchObject({
      message: expect.stringMatching(/control character/),
    });
  });

  it("lets the user's side make and change any group, logged as you", async () => {
    const setup = await layoutDaemon();
    const users = await setup.client.call('orchestrator.addZone', { name: 'the user’s' });
    expect(await setup.client.call('orchestrator.changeZone', { id: users.id, name: 'still the user’s' })).toMatchObject({ name: 'still the user’s' });
    expect(await lastLine(setup.client)).toMatchObject({ orchestratorName: 'you', action: 'change-zone' });
  });
});

describe('notes an orchestrator makes', () => {
  it('puts an agent note beside a tile, clear of the rest, edits and removes only its own, logging each', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const note = await me.connection.call('orchestrator.addNote', {
      token: me.token,
      text: 'Waiting on **review**',
      near: { kind: 'agent', id: me.agent.sessionId },
      side: 'right',
    });
    // An agent's note is an agent note: badged with who wrote it, so not signed.
    expect(note).toMatchObject({
      kind: 'agent-note',
      zoneId: setup.zone.id,
      width: AGENT_NOTE_SIZE.width,
      data: {
        text: 'Waiting on **review**',
        agent: { sessionId: me.agent.sessionId, name: 'lead', harness: me.agent.harness, role: 'orchestrator' },
        writtenAt: expect.any(String),
        editedByUser: false,
      },
    });
    expectNoOverlap(await rectsIn(setup.client, setup.zone.id));
    expect(await lastLine(setup.client)).toMatchObject({ action: 'add-note', targetName: 'note “Waiting on **review**”', outcome: 'done' });

    // The user's edit marks it; the agent writing it again clears the mark.
    await setup.client.call('item.update', { id: note.id, data: { text: 'Waiting on you', editedByUser: true } });
    const edited = await me.connection.call('orchestrator.editNote', { token: me.token, id: note.id, text: 'Reviewed' });
    expect(edited.data).toMatchObject({ text: 'Reviewed', editedByUser: false });
    // An agent note has no colour: one asked for is ignored, so a caller that gives one still works.
    expect((await me.connection.call('orchestrator.editNote', { token: me.token, id: note.id, color: 'blue' })).data).toEqual(edited.data);
    const users: BoardItem = await setup.client.call('item.create', { kind: 'sticky', zoneId: setup.zone.id, x: 600, y: 400, ...STICKY_SIZE, data: { text: 'mine', color: '#fff3a3' } });
    for (const refused of [
      me.connection.call('orchestrator.editNote', { token: me.token, id: users.id, text: 'gone' }),
      me.connection.call('orchestrator.removeNote', { token: me.token, id: users.id }),
    ]) {
      await expect(refused).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    }
    await me.connection.call('orchestrator.removeNote', { token: me.token, id: note.id });
    expect((await setup.client.call('item.list')).map((item) => item.id)).toEqual([users.id]);
    expect(await lastLine(setup.client)).toMatchObject({ action: 'remove-note', outcome: 'done' });
  });

  it("adds a note near a tile of an arranged cluster to that cluster's sticky, never in place of what it says", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const impl = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'impl' });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const stickies = async () => (await setup.client.call('item.list')).filter((item) => item.kind === 'agent-note');
    const [sticky] = await stickies();
    const near = { kind: 'agent' as const, id: impl.sessionId };
    const note = await me.connection.call('orchestrator.addNote', { token: me.token, text: 'Fixing the menu', near });
    expect(note).toMatchObject({ id: sticky!.id, x: sticky!.x, y: sticky!.y, data: { text: expect.stringMatching(/^- \*\*impl\*\*: .+\nFixing the menu$/) } });
    expect(await stickies()).toHaveLength(1);
    await me.connection.call('orchestrator.arrange', { token: me.token });
    expect((await stickies())[0]!.data.text).toMatch(/\nFixing the menu$/);
    // What the user wrote there stays, the note after it.
    await setup.client.call('item.update', { id: sticky!.id, data: { text: 'blocked on design review' } });
    await me.connection.call('orchestrator.addNote', { token: me.token, text: 'tests green', near });
    expect((await stickies())[0]!.data.text).toBe('blocked on design review\ntests green');
  });

  it("makes the user's text near an arranged agent its own item, never adding it to the cluster's note", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const impl = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'impl' });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const clusterNote = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note')!;
    const near = { kind: 'agent' as const, id: impl.sessionId };
    const text = await setup.client.call('orchestrator.addNote', { text: 'Mine', kind: 'text', near, zoneId: setup.zone.id });
    expect(text).toMatchObject({ kind: 'text' });
    expect(text.id).not.toBe(clusterNote.id);
    expect((await setup.client.call('item.list')).find((item) => item.id === clusterNote.id)!.data.text).toBe(clusterNote.data.text);
  });

  it("puts a note near a tile of no cluster in the slot before it, moving the tile and its row along", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const [a, b] = [await me.connection.call('orchestrator.spawn', { token: me.token, name: 'a' }), await me.connection.call('orchestrator.spawn', { token: me.token, name: 'b' })];
    const place = (agent: Agent, column: number, row: number) => setup.client.call('agent.move', { sessionId: agent.sessionId, zoneId: setup.zone.id, ...gridPoint(column, row) });
    await place(me.agent, 0, 0);
    await place(a, 0, 1);
    await place(b, 1, 1);
    const note = await me.connection.call('orchestrator.addNote', { token: me.token, text: 'Waiting on review', near: { kind: 'agent', id: a.sessionId } });
    expect(note).toMatchObject({ kind: 'agent-note', ...gridPoint(0, 1), width: AGENT_TILE_SIZE.width, height: AGENT_TILE_SIZE.height });
    const rects = await rectsIn(setup.client, setup.zone.id);
    expect(rects.get('a')).toMatchObject(gridPoint(1, 1));
    expect(rects.get('b')).toMatchObject(gridPoint(2, 1));
    expectNoOverlap(rects);
  });

  it('puts a note at the grid cell nearest --at, moving what is there aside', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    await setup.client.call('agent.move', { sessionId: me.agent.sessionId, zoneId: setup.zone.id, ...gridPoint(1, 0) });
    const note = await me.connection.call('orchestrator.addNote', { token: me.token, text: 'here', at: { x: gridPoint(1, 0).x - 50, y: gridPoint(1, 0).y + 30 } });
    expect(note).toMatchObject(gridPoint(1, 0));
    expect((await rectsIn(setup.client, setup.zone.id)).get('lead')!.x).toBeGreaterThan(note.x + note.width);
    expectNoOverlap(await rectsIn(setup.client, setup.zone.id));
  });

  it("makes an agent note when an agent gives no kind, a signed sticky when it asks for one, and a plain sticky on the user's side", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    expect(await me.connection.call('orchestrator.addNote', { token: me.token, text: 'mine' })).toMatchObject({ kind: 'agent-note' });
    expect(await me.connection.call('orchestrator.addNote', { token: me.token, text: 'mine', kind: 'sticky', color: 'green' })).toMatchObject({
      kind: 'sticky',
      data: { text: expect.stringMatching(/^mine\n\n🤖 lead · \d\d:\d\d$/), color: '#b2f2bb' },
    });
    const coloured = await me.connection.call('orchestrator.addNote', { token: me.token, text: 'x', color: 'green' });
    expect(coloured.kind).toBe('agent-note');
    expect(coloured.data).not.toHaveProperty('color');
    const users = await setup.client.call('orchestrator.addNote', { text: 'Yours', color: 'green', zoneId: setup.zone.id });
    expect(users).toMatchObject({ kind: 'sticky', data: { text: 'Yours', color: '#b2f2bb' } });
  });

  it('refuses control characters in a note but tabs and line breaks, and text over the limit', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    expect(await me.connection.call('orchestrator.addNote', { token: me.token, text: 'a\tb\nc' })).toMatchObject({ kind: 'agent-note' });
    await expect(me.connection.call('orchestrator.addNote', { token: me.token, text: 'ring\u0007' })).rejects.toMatchObject({ message: expect.stringMatching(/no other control character/) });
    await expect(me.connection.call('orchestrator.addNote', { token: me.token, text: 'x'.repeat(20_001) })).rejects.toMatchObject({
      message: expect.stringMatching(/at most 20000 characters/),
    });
    // The log keeps a short quote of what was asked, not the whole text.
    expect((await lastLine(setup.client)).detail.length).toBeLessThan(60);
  });

  it('makes text too, in its zone by default, and refuses a zone outside its scope', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const text = await me.connection.call('orchestrator.addNote', { token: me.token, text: 'Sprint 3', kind: 'text' });
    expect(text).toMatchObject({ kind: 'text', zoneId: setup.zone.id, data: { text: expect.stringMatching(/^Sprint 3\n\n🤖 lead/), wrap: true } });
    await expect(me.connection.call('orchestrator.addNote', { token: me.token, text: 'there', zoneId: setup.other.id })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    await expect(me.connection.call('orchestrator.addNote', { token: me.token, text: 'x', kind: 'text', color: 'plaid' })).rejects.toMatchObject({
      message: expect.stringMatching(/#rrggbb or one of/),
    });
  });
});

describe('the layout tools and commands', () => {
  it('moves, arranges and makes notes over the MCP tools, and groups over the CLI, as the orchestrator', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker' });
    const env = { ...process.env, AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: me.token };
    const mcp = new McpClient({ command: TEST_CLI_LAUNCHER.command, args: [...TEST_CLI_LAUNCHER.args, 'mcp'], env }, tempDataDir());
    await mcp.initialize();

    expect(await mcp.callTool('arrange', {})).toMatchObject({ isError: false, text: expect.stringMatching(/^Arranged zone:\S+ web/) });
    expect(await mcp.callTool('move', { tile: 'worker', near: 'me', side: 'right' })).toMatchObject({
      isError: false,
      text: expect.stringMatching(/^Moved agent:\S+ worker \(in zone:\S+ web\) at \d+,\d+\.$/),
    });
    const added = await mcp.callTool('add_note', { text: 'Ship it', near: 'worker' });
    // The worker is in a cluster since the arrange: the note is added to its sticky.
    expect(added).toMatchObject({ isError: false, text: expect.stringMatching(/agent-note {2}".*Ship it"/) });
    const sticky = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note')!;
    expect(await mcp.callTool('edit_note', { note: `item:${sticky.id}`, text: 'Shipping' })).toMatchObject({ isError: false });
    // Beside it, out of its cluster's slot, it is an agent note: a colour, which it hasn't, is ignored with a warning.
    const beside = await mcp.callTool('add_note', { text: 'Ship it', near: 'worker', side: 'below', color: 'green' });
    expect(beside).toMatchObject({ isError: false, text: expect.stringContaining('agent-note  "Ship it"  by ') });
    expect(beside.text).toContain('an agent note has no colour, so the colour was ignored');
    const note = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note')!;
    expect(await mcp.callTool('edit_note', { note: `item:${note.id}`, text: 'Shipped' })).toMatchObject({ isError: false });
    expect(await mcp.callTool('edit_note', { note: `item:${note.id}`, color: 'blue' })).toMatchObject({
      isError: false,
      text: expect.stringContaining('an agent note has no colour, so the colour was ignored'),
    });
    expect(await mcp.callTool('remove_note', { note: `item:${note.id}` })).toMatchObject({ isError: false, text: expect.stringMatching(/^Removed item:/) });
    expect(await mcp.callTool('move', { tile: 'worker', to: 'other' })).toMatchObject({ isError: true, text: expect.stringContaining('outside your scope') });
  });
});

describe('arranging a unit of work with a ticket and a pull request', () => {
  it('labels it by the ticket in its branch and makes no PR card, removing the one an earlier arrange made', async () => {
    const github = createFakeGitHub();
    onTestFinished(github.dispose);
    const setup = await layoutDaemon({ gh: github.gh });
    const me = await lead(setup, setup.zone.id);
    const impl = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'menu', role: 'custom', branch: 'acme-199-menu-scroll' });
    const review = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'review', role: 'reviewer', baseBranch: impl.branch });
    // Started on the implementer's branch, the reviewer is joined to it, both ways, already.
    const url = 'https://github.com/acme/app/pull/41';
    github.setState({
      ...FAKE_GITHUB_STATE,
      pullRequests: [{ repo: 'acme/app', number: 41, title: 'Menu scroll', headRefName: impl.branch, state: 'OPEN', isDraft: false, statusCheckRollup: [] }],
    });
    await setup.recorder.waitFor(
      (event: DaemonEvent): event is AgentUpdatedEvent => event.type === 'agent.updated' && event.agent.sessionId === impl.sessionId && event.agent.pullRequests.length > 0,
    );
    // As an arrange before they stopped made it: the cluster's PR card, made by the lead.
    const old = await setup.client.call('item.create', { kind: 'link', zoneId: setup.zone.id, x: 900, y: 400, width: 240, height: 96, data: { url, arrange: 'issue:ACME-199#pr' } });
    markMadeBy(setup, old.id, me.agent.sessionId);
    // And one the user made, which is theirs to keep.
    const users = await setup.client.call('item.create', { kind: 'link', zoneId: setup.zone.id, x: 900, y: 40, width: 240, height: 96, data: { url } });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const parts = async () => (await setup.client.call('item.list')).filter((item) => typeof item.data.arrange === 'string');
    const made = await parts();
    expect(made.map((item) => [item.kind, item.data.arrange]).sort()).toEqual([
      ['agent-note', 'issue:ACME-199#note'],
      ['text', 'issue:ACME-199#label'],
    ]);
    expect(made.find((item) => item.data.arrange === 'issue:ACME-199#label')?.data.text).toBe('ACME-199');
    expect(made.find((item) => item.kind === 'agent-note')?.data.text).toContain('PR #41 Menu scroll');
    expect((await setup.client.call('item.list')).map((item) => item.id)).toContain(users.id);
    const rects = await rectsIn(setup.client, setup.zone.id);
    const [implAt, reviewAt] = [rects.get('menu')!, rects.get('review')!];
    // Linked both ways, a rail's room between them, its token and label clear of both.
    expect(reviewAt.y).toBe(implAt.y);
    expect(reviewAt.x - (implAt.x + AGENT_TILE_SIZE.width)).toBeGreaterThanOrEqual(RAIL_GAP);
    expectNoOverlap(rects);
    expect(review.reviews?.branch).toBe(impl.branch);

    // Arranged again, any way, it makes none and leaves the label and sticky as they are.
    const ids = made.map((item) => item.id).sort();
    for (const by of ['role', 'issue'] as const) {
      await me.connection.call('orchestrator.arrange', { token: me.token, by });
      expect((await parts()).map((item) => item.id).sort()).toEqual(ids);
    }
    expect((await setup.client.call('item.list')).filter((item) => item.kind === 'link').map((item) => item.id)).toEqual([users.id]);
  });
});

function overlapping(a: Zone, b: Zone): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
