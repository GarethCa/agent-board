import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import { fakeHarnessEnv, McpClient } from '@agent-board/fake-harness';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import { agentNoteSize } from '../src/agent-notes.ts';
import { BOARD_ARRANGE_GAP } from '../src/arrange-board.ts';
import { CLUSTER_LABEL_SIZE } from '../src/board-arrange.ts';
import { AGENT_TILE_SIZE, clearOf, overlaps as rectsOverlap, CREW_GAP, GRID_COLUMN as COLUMN, GRID_ORIGIN as FIRST, gridPoint, PERCH_ROOM, RAIL_GAP, ROW_STEP, sizedFootprint, SPACING_GAPS, TILE_GAP, tileSlot, ZONE_PADDING, type Rect } from '../src/board-layout.ts';
import type { DaemonClient } from '../src/client.ts';
import { daemonPaths } from '../src/paths.ts';
import { AGENT_NOTE_SIZE, BOARD_ERROR, measuredText, RPC_ERROR, STICKY_SIZE, type Agent, type AgentUpdatedEvent, type ArrangeLayout, type BoardItem, type DaemonEvent, type ExpandedBox, type MeasuredBox, type Zone } from '../src/protocol.ts';
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
  // At normal spacing, the gaps these tests are written in; a test of another spacing sets its zone's.
  await client.call('settings.set', { arrangeSpacing: 'normal' });
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

  it('slots the crew of an expanded lead beside it, right of its expanded edge, then down that side, never under it', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    await setup.client.call('agent.move', { sessionId: me.agent.sessionId, zoneId: setup.zone.id, x: 40, y: 80 });
    const open = { width: 960, height: 600 };
    await setup.client.call('view.set', { key: 'expandedTiles', value: [{ id: `agent:${me.agent.sessionId}`, ...open }] });
    const crew = [];
    for (const name of ['one', 'two', 'three', 'four']) crew.push(await me.connection.call('orchestrator.spawn', { token: me.token, name }));
    const { things } = await me.connection.call('orchestrator.map', { token: me.token });
    const at = (agent: Agent) => things.find((thing) => thing.key === `agent:${agent.sessionId}`)!;
    const right = 40 + open.width + CREW_GAP;
    // Three to a row, as beside a compact lead.
    expect(crew.map((agent) => [at(agent).x, at(agent).y])).toEqual([
      [right, 80],
      [right + COLUMN, 80],
      [right + 2 * COLUMN, 80],
      [right, 80 + ROW_STEP],
    ]);
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

  it('lands in the row of a lane laid out in px off the grid rows, when that is nearer the wish than a grid row', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const spawn = (name: string) => me.connection.call('orchestrator.spawn', { token: me.token, name });
    const [a, b] = [await spawn('a'), await spawn('b')];
    await setup.client.call('agent.move', { sessionId: me.agent.sessionId, zoneId: setup.zone.id, ...gridPoint(0, 0) });
    // A lane below a 140 px note: 400 px down, where no grid row is.
    await setup.client.call('agent.move', { sessionId: a.sessionId, zoneId: setup.zone.id, x: gridPoint(1, 0).x, y: 400 });
    const moved = await me.connection.call('orchestrator.move', { token: me.token, target: { kind: 'agent', id: b.sessionId }, at: { x: gridPoint(2, 0).x + 10, y: 405 } });
    expect(moved).toMatchObject({ x: gridPoint(2, 0).x, y: 400 });
    // Nearer a grid row than any tile's, it takes the grid row.
    const away = await me.connection.call('orchestrator.move', { token: me.token, target: { kind: 'agent', id: b.sessionId }, at: { x: gridPoint(2, 0).x, y: gridPoint(0, 4).y + 10 } });
    expect(away).toMatchObject(gridPoint(2, 4));
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
    // The edge joining them is drawn as a rail: its token and label fit between them, exactly a rail's room apart.
    expect(review.x - (impl.x + AGENT_TILE_SIZE.width)).toBe(RAIL_GAP);
    expect(leadAt.y).toBeLessThan(impl.y);
    expect(third.y).toBeGreaterThan(impl.y);
    // The user's note stays where it was.
    expect(rects.get('item:user note')).toMatchObject({ x: note.x, y: note.y });
    expect(await lastLine(setup.client)).toMatchObject({ action: 'arrange', targetName: 'web', outcome: 'done', detail: '4 tiles by issue, in rows' });
  });

  it("never lays a tile over the user's text or shapes, a rotated one by the room it takes turned", async () => {
    const setup = await layoutDaemon();
    const { me } = await messyCrew(setup);
    const style = { size: 'body', fontSize: 14, minHeight: 0, bold: false, italic: false, align: 'left', color: '#2b2a27', wrap: false };
    const shape = { shape: 'rectangle', fill: '#d3f9d8', stroke: '#2f9e44', strokeWidth: 2, dashed: false, textSize: 'body', fontSize: 14, bold: false, align: 'left', mono: false, attributes: '', methods: '', textColor: '#2b2a27' };
    const zoneId = setup.zone.id;
    await setup.client.call('item.create', { kind: 'text', zoneId, x: 320, y: 50, width: 200, height: 40, data: { ...style, text: 'Sprint goals' } });
    await setup.client.call('item.create', { kind: 'shape', zoneId, x: 40, y: 420, width: 240, height: 140, data: { ...shape, text: 'box' } });
    // A bar 600 by 40 turned upright: it takes 40 by 600 about its centre, not the box it was drawn in.
    const bar = await setup.client.call('item.create', { kind: 'shape', zoneId, x: 240, y: 600, width: 600, height: 40, data: { ...shape, text: 'bar' } });
    await setup.client.call('item.update', { id: bar.id, rotation: 90 });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const rects = await rectsIn(setup.client, zoneId);
    expect(rects.get('item:Sprint goals')).toMatchObject({ x: 320, y: 50 });
    expect(rects.get('item:box')).toMatchObject({ x: 40, y: 420 });
    rects.set('item:bar', { x: 520, y: 320, width: 40, height: 600 });
    expectNoOverlap(rects);
    expect((await me.connection.call('orchestrator.map', { token: me.token })).overlaps).toEqual([]);
  });

  it('lays out a tile expanded in place at its expanded size, so nothing is under it', async () => {
    const setup = await layoutDaemon();
    const { me, impl } = await messyCrew(setup);
    const open = { width: 960, height: 600 };
    await setup.client.call('view.set', { key: 'expandedTiles', value: [{ id: `agent:${impl.sessionId}`, ...open }] });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const rects = await rectsIn(setup.client, setup.zone.id);
    rects.set('impl', { ...rects.get('impl')!, ...open });
    expectNoOverlap(rects);
    // Its lane is as tall as it, and its column as wide: its reviewer past it on its row, the next lane below it.
    const [at, review, third] = ['impl', 'review', 'third'].map((name) => rects.get(name)!) as [Rect, Rect, Rect];
    expect(review.y).toBe(at.y);
    expect(review.x).toBeGreaterThan(at.x + open.width);
    expect(third.y).toBeGreaterThan(at.y + open.height);
    expect(third.x).toBe(at.x);
  });

  it('places a new crew member and moves a tile clear of a tile expanded in place, at its expanded size', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    await setup.client.call('agent.move', { sessionId: me.agent.sessionId, zoneId: setup.zone.id, x: 40, y: 80 });
    const open = { width: 960, height: 600 };
    await setup.client.call('view.set', { key: 'expandedTiles', value: [{ id: `agent:${me.agent.sessionId}`, ...open }] });
    const crew = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'crew' });
    await me.connection.call('orchestrator.move', { token: me.token, target: { kind: 'agent', id: crew.sessionId }, at: { x: 100, y: 200 } });
    const rects = await rectsIn(setup.client, setup.zone.id);
    rects.set('lead', { ...rects.get('lead')!, ...open });
    expectNoOverlap(rects);
  });

  it('fits the zone to what it holds: a huge zone shrinks, yet keeps what it may not move', async () => {
    const setup = await layoutDaemon();
    const { me, note } = await messyCrew(setup);
    await setup.client.call('zone.update', { id: setup.zone.id, x: 0, y: 0, width: 2800, height: 2400 });
    const result = await me.connection.call('orchestrator.arrange', { token: me.token });
    const rects = [...(await rectsIn(setup.client, setup.zone.id)).values()];
    const right = Math.max(...rects.map((rect) => rect.x + rect.width));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
    expect(result.width).toBe(right + ZONE_PADDING);
    expect(result.height).toBeLessThanOrEqual(bottom + TILE_GAP + ZONE_PADDING);
    expect(result.height).toBeGreaterThanOrEqual(bottom + ZONE_PADDING);
    expect(result.width).toBeLessThan(2800);
    const zone = (await setup.client.call('zone.list')).find((each) => each.id === setup.zone.id)!;
    expect([zone.width, zone.height]).toEqual([result.width, result.height]);
    // The user's note, which it may not move, is still inside.
    expect(note.x + note.width).toBeLessThanOrEqual(zone.width);
    expect(note.y + note.height).toBeLessThanOrEqual(zone.height);
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
    // In its lane's note column: on its row, right of its tiles.
    const placed = await rectsIn(setup.client, setup.zone.id);
    expect(sticky.y).toBe(placed.get('impl')!.y);
    expect(sticky.x).toBeGreaterThan(placed.get('review')!.x + placed.get('review')!.width);
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

  it("puts every tile on the grid across, or packed past another, and every note on its implementer's row, past its lane's tiles", async () => {
    const setup = await layoutDaemon();
    const { me } = await messyCrew(setup);
    for (const by of ['issue', 'role', 'state'] as const) {
      for (const layout of ['rows', 'grid'] as const) {
        await me.connection.call('orchestrator.arrange', { token: me.token, by, layout });
        const agents = (await setup.client.call('agent.list')).filter((agent) => agent.zoneId === setup.zone.id);
        const placed = [...(await rectsIn(setup.client, setup.zone.id)).values()];
        const packed = (x: number) => placed.some((rect) => [TILE_GAP, RAIL_GAP].includes(x - (rect.x + rect.width)));
        const off = agents.filter(({ position }) => !Number.isInteger((position!.x - FIRST.x) / COLUMN) && !packed(position!.x));
        expect(off.map((agent) => [by, layout, agent.name, agent.position])).toEqual([]);
        expectNoOverlap(await rectsIn(setup.client, setup.zone.id));
      }
    }
    // Asked for again: a bare arrange arranges as the last one was asked to.
    await me.connection.call('orchestrator.arrange', { token: me.token, by: 'issue', layout: 'rows' });
    const rects = await rectsIn(setup.client, setup.zone.id);
    const sticky = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note' && String(item.data.text).includes('**impl**'))!;
    expect(sticky.y).toBe(rects.get('impl')!.y);
    expect(sticky.x).toBe(rects.get('review')!.x + COLUMN);
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

  it("says its latest STATUS line when an agent has set no status and its turn has ended", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const worker = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker', prompt: 'Write the handover' });
    await setup.recorder.waitFor((event: DaemonEvent): event is AgentUpdatedEvent => event.type === 'agent.updated' && event.agent.sessionId === worker.sessionId && /STATUS: /.test(event.agent.lastMessage ?? ''));
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const note = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note')!;
    expect(note.data.text).toMatch(/^- \*\*worker\*\*: done$/);
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
    // Its note made as short as a note may be: the reviewer's line makes it grow.
    const lane = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note' && Array.isArray(item.data.members) && item.data.members.includes(impl.sessionId))!;
    await setup.client.call('item.update', { id: lane.id, height: 96 });
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
    expect(sticky.height).toBe(agentNoteSize(String(sticky.data.text), sticky.width, 0).height);
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
    // Room in web to lay the crew out round what stays, as an arrange leaves it only as big as its crew needs.
    const arranged = (await setup.client.call('zone.list')).find((zone) => zone.id === setup.zone.id)!;
    await setup.client.call('zone.update', { id: arranged.id, x: arranged.x, y: arranged.y, width: arranged.width, height: arranged.height + 600 });
    const web = { ...arranged, height: arranged.height + 600 };
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
  it("lays out the same whichever way its clocks start: its crew's clocks in the top row, the lanes below", async () => {
    /** Where everything in the zone is after an arrange from clocks put at `starts`, the lead expanded. */
    async function arrangedFrom(starts: readonly { x: number; y: number }[], layouts: readonly ArrangeLayout[] = ['rows']) {
      const setup = await layoutDaemon();
      const me = await lead(setup, setup.zone.id);
      const impl = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'impl' });
      await me.connection.call('orchestrator.spawn', { token: me.token, name: 'review', role: 'reviewer', baseBranch: impl.branch });
      await setup.client.call('view.set', { key: 'expandedTiles', value: [{ id: `agent:${me.agent.sessionId}`, width: 960, height: 600 }] });
      for (const [index, at] of starts.entries()) {
        const clock = await me.connection.call('orchestrator.addClock', { token: me.token, data: { cron: '@daily', does: 'fresh', prompt: `sweep ${index}` } });
        await setup.client.call('item.update', { id: clock.id, ...at });
      }
      for (const layout of layouts) await me.connection.call('orchestrator.arrange', { token: me.token, layout });
      const zone = (await setup.client.call('zone.list')).find((each) => each.id === setup.zone.id)!;
      const rects = await rectsIn(setup.client, setup.zone.id);
      const labels = (await setup.client.call('item.list')).filter((item) => item.kind === 'text').map((item) => ({ text: item.data.text, x: item.x, y: item.y }));
      const clocks = (await setup.client.call('item.list')).filter((item) => item.kind === 'clock').map((item) => ({ x: item.x, y: item.y }));
      return { size: { width: zone.width, height: zone.height }, rects: Object.fromEntries([...rects].filter(([name]) => !name.startsWith('item:'))), clocks, labels, map: await me.connection.call('orchestrator.map', { token: me.token }) };
    }
    // Stair-stepped, as clocks added beside a tile that moved between them are; and in a row.
    // Arranged as cards first, then rows, from the stairs; and only as rows from the row.
    const stairs = await arrangedFrom([{ x: 24, y: 24 }, { x: 300, y: 140 }], ['cards', 'rows']);
    const row = await arrangedFrom([{ x: 24, y: 24 }, { x: 296, y: 24 }]);
    expect(stairs.rects).toEqual(row.rects);
    expect(stairs.clocks).toEqual(row.clocks);
    expect(stairs.labels).toEqual(row.labels);
    expect(stairs.size).toEqual(row.size);
    // Level with each other, and nothing amiss.
    expect(new Set(row.clocks.map((clock) => clock.y)).size).toBe(1);
    expect({ overlaps: row.map.overlaps, offGrid: row.map.offGrid }).toEqual({ overlaps: [], offGrid: [] });
  });

  it("maps its crew's clocks stair-stepped above its tile as off where they go, and a zone mostly empty as such", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    await me.connection.call('orchestrator.spawn', { token: me.token, name: 'impl' });
    await setup.client.call('view.set', { key: 'expandedTiles', value: [{ id: `agent:${me.agent.sessionId}`, width: 960, height: 600 }] });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const clocks = [];
    for (const [index, at] of [{ x: 24, y: 24 }, { x: 300, y: 140 }].entries()) {
      const clock = await me.connection.call('orchestrator.addClock', { token: me.token, data: { cron: '@daily', does: 'fresh', prompt: `sweep ${index}` } });
      clocks.push(await setup.client.call('item.update', { id: clock.id, ...at }));
    }
    expect((await me.connection.call('orchestrator.map', { token: me.token })).offGrid).toEqual(expect.arrayContaining(clocks.map((clock) => `item:${clock.id}`)));
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const tidy = await me.connection.call('orchestrator.map', { token: me.token });
    expect({ offGrid: tidy.offGrid, emptyBands: tidy.emptyBands }).toEqual({ offGrid: [], emptyBands: { columns: 0, rows: 0 } });

    // Its tile moved to the far right of a zone grown wide: a band of empty columns across it.
    await setup.client.call('zone.update', { id: setup.other.id, x: 9000, y: 0, width: 600, height: 400 });
    await setup.client.call('zone.update', { id: setup.zone.id, x: 0, y: 0, width: 3923, height: 1810 });
    await setup.client.call('agent.move', { sessionId: me.agent.sessionId, zoneId: setup.zone.id, x: 3923 - 960 - 20, y: 44 });
    const empty = await me.connection.call('orchestrator.map', { token: me.token });
    expect(empty.emptyBands.columns).toBeGreaterThan(2);
  });

  it("never moves the user's own clocks, whoever arranges: only the clocks an orchestrator or its crew made", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    await me.connection.call('orchestrator.spawn', { token: me.token, name: 'impl' });
    const theirs = await setup.client.call('clock.add', { place: { zoneId: setup.zone.id, x: 700, y: 400 }, data: { prompt: 'Mine' } });
    const mine = await me.connection.call('orchestrator.addClock', { token: me.token, data: { cron: '@daily', does: 'fresh', prompt: 'sweep' } });
    await setup.client.call('item.update', { id: mine.id, x: 300, y: 300 });
    const at = async (id: string) => {
      const item = (await setup.client.call('item.list')).find((each) => each.id === id)!;
      return { x: item.x, y: item.y };
    };
    await me.connection.call('orchestrator.arrange', { token: me.token });
    expect(await at(theirs.id)).toEqual({ x: 700, y: 400 });
    expect(await at(mine.id)).not.toEqual({ x: 300, y: 300 });
    // On the user's side too.
    await setup.client.call('orchestrator.arrange', { zoneId: setup.zone.id });
    expect(await at(theirs.id)).toEqual({ x: 700, y: 400 });
  });

  it('leaves a zone outside its scope alone', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    await expect(me.connection.call('orchestrator.arrange', { token: me.token, zoneId: setup.other.id })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    expect(await lastLine(setup.client)).toMatchObject({ action: 'arrange', outcome: 'refused' });
    // What a refused arrange asked for is not kept.
    await expect(me.connection.call('orchestrator.arrange', { token: me.token, zoneId: setup.other.id, auto: true })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    expect((await me.connection.call('orchestrator.map', { token: me.token })).arrange.auto).toBe(false);
  });
});

describe('the zone map and arranging by itself', () => {
  async function crewWithLanes(setup: Setup) {
    const me = await lead(setup, setup.zone.id);
    const impl = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'impl' });
    const review = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'review', role: 'reviewer', baseBranch: impl.branch });
    return { me, impl, review };
  }
  const key = (agent: Agent) => `agent:${agent.sessionId}`;

  it('maps a zone as its lanes after an arrange, with nothing amiss, and a tile dragged out of its row as off the grid', async () => {
    const setup = await layoutDaemon();
    const { me, impl, review } = await crewWithLanes(setup);
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const map = await me.connection.call('orchestrator.map', { token: me.token });
    expect(map).toMatchObject({ zoneId: setup.zone.id, name: 'web', arrange: { by: 'issue', layout: 'rows', auto: false }, overlaps: [], offGrid: [] });
    expect(map.top).toEqual([key(me.agent)]);
    expect(map.lanes).toHaveLength(1);
    expect(map.lanes[0]!.slots).toEqual({ implementer: [key(impl)], reviewer: [key(review)], 'follow-up': [] });
    expect(map.lanes[0]!.note).toMatch(/^item:/);
    expect(map.lanes[0]!.labelItem).toMatch(/^item:/);

    const at = (await setup.client.call('agent.list')).find((agent) => agent.sessionId === review.sessionId)!.position!;
    await setup.client.call('agent.move', { sessionId: review.sessionId, zoneId: setup.zone.id, x: at.x, y: at.y + 300 });
    expect((await me.connection.call('orchestrator.map', { token: me.token })).offGrid).toEqual([key(review)]);
    // Read only: nothing is logged.
    expect(await lastLine(setup.client)).toMatchObject({ action: 'arrange' });
  });

  it("lays its crew out at its zone's spacing, and maps it at that spacing with nothing amiss", async () => {
    const setup = await layoutDaemon();
    await setup.client.call('zone.configure', { id: setup.zone.id, spacing: 'roomy' });
    const { me, impl, review } = await crewWithLanes(setup);
    const result = await me.connection.call('orchestrator.arrange', { token: me.token });
    const roomy = SPACING_GAPS.roomy;
    const at = new Map((await setup.client.call('agent.list')).map((agent) => [agent.sessionId, agent.position!]));
    const [lead, implAt, reviewAt] = [me.agent, impl, review].map((agent) => at.get(agent.sessionId)!);
    expect(lead).toMatchObject({ x: roomy.padding, y: roomy.padding + PERCH_ROOM });
    expect(implAt!.y - (lead!.y + AGENT_TILE_SIZE.height)).toBe(roomy.lane);
    expect(reviewAt!.x - (implAt!.x + AGENT_TILE_SIZE.width)).toBe(roomy.rail);
    const rects = [...(await rectsIn(setup.client, setup.zone.id)).values()];
    expect(result.width).toBe(Math.max(...rects.map((rect) => rect.x + rect.width)) + roomy.padding);

    const map = await me.connection.call('orchestrator.map', { token: me.token });
    expect(map).toMatchObject({ spacing: 'roomy', overlaps: [], offGrid: [], laneGap: 0, labelGap: 0 });
    // The same tiles read at normal spacing are where no normal arrange puts them.
    await setup.client.call('zone.configure', { id: setup.zone.id, spacing: 'normal' });
    expect((await me.connection.call('orchestrator.map', { token: me.token })).offGrid.length).toBeGreaterThan(0);
  });

  it("slots a tile no arrange placed on its zone's grid, so the map finds nothing off it", async () => {
    const setup = await layoutDaemon();
    await setup.client.call('zone.configure', { id: setup.zone.id, spacing: 'roomy' });
    const me = await lead(setup, setup.zone.id);
    await userAgent(setup.client, setup.zone.id, 'mine');
    await setup.client.call('shell.create', { zoneId: setup.zone.id });
    const map = await me.connection.call('orchestrator.map', { token: me.token });
    expect(map.things.filter((thing) => thing.itemKind === null)).toHaveLength(3);
    expect(map).toMatchObject({ spacing: 'roomy', overlaps: [], offGrid: [] });
    // The first slot is the zone's, its padding and perch in from its corner.
    expect(Math.min(...map.things.map((thing) => thing.x))).toBe(SPACING_GAPS.roomy.padding);
  });

  it('keeps what an arrange was asked for as the orchestrator’s settings, for a bare arrange after', async () => {
    const setup = await layoutDaemon();
    const { me } = await crewWithLanes(setup);
    await me.connection.call('orchestrator.arrange', { token: me.token, by: 'role' });
    expect((await me.connection.call('orchestrator.map', { token: me.token })).arrange).toEqual({ by: 'role', layout: 'rows', auto: false });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    expect((await lastLine(setup.client)).detail).toMatch(/by role, in rows$/);
  });

  it('with auto on, arranges by itself as it starts an agent, adds a note and closes one, and logs it', async () => {
    const setup = await layoutDaemon();
    const { me, impl } = await crewWithLanes(setup);
    await me.connection.call('orchestrator.arrange', { token: me.token, auto: true });
    // Left too big, the zone shrinks again with the arrange the next agent brings.
    await setup.client.call('zone.update', { id: setup.zone.id, x: 0, y: 0, width: 2800, height: 2400 });
    // Started where the board slots it, then put in its lane at once: a lane of its own, below impl's.
    const other = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other' });
    expect(await lastLine(setup.client)).toMatchObject({ action: 'arrange', detail: expect.stringMatching(/, by itself$/) });
    const fitted = (await setup.client.call('zone.list')).find((zone) => zone.id === setup.zone.id)!;
    expect(fitted.width).toBeLessThan(2800);
    expect(fitted.height).toBeLessThan(2400);
    let map = await me.connection.call('orchestrator.map', { token: me.token });
    expect(map.lanes.map((lane) => lane.slots.implementer)).toEqual([[key(impl)], [key(other)]]);
    expect([map.overlaps, map.offGrid]).toEqual([[], []]);
    expect(other.position).toEqual((await setup.client.call('agent.list')).find((agent) => agent.sessionId === other.sessionId)!.position);

    // A note beside an agent of a lane becomes that lane's note, in its slot.
    const note = await me.connection.call('orchestrator.addNote', { token: me.token, text: 'Waiting on design', near: { kind: 'agent', id: other.sessionId } });
    map = await me.connection.call('orchestrator.map', { token: me.token });
    expect(map.lanes[1]!.note).toBe(`item:${note.id}`);
    expect([map.overlaps, map.offGrid]).toEqual([[], []]);

    // Closed, its zone is arranged again: a closed agent folded to a chip is laid out at a chip's size.
    await me.connection.call('orchestrator.close', { token: me.token, sessionId: other.sessionId });
    expect(await lastLine(setup.client)).toMatchObject({ action: 'arrange', detail: expect.stringMatching(/, by itself$/) });
    map = await me.connection.call('orchestrator.map', { token: me.token });
    expect([map.overlaps, map.offGrid]).toEqual([[], []]);
  });

  it('with its own tile expanded and auto on, starts each agent below or right of it, the map clean', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const open = { width: 960, height: 600 };
    await setup.client.call('view.set', { key: 'expandedTiles', value: [{ id: key(me.agent), ...open }] });
    await me.connection.call('orchestrator.arrange', { token: me.token, auto: true });
    const crew = [];
    for (const name of ['one', 'two', 'three']) crew.push(await me.connection.call('orchestrator.spawn', { token: me.token, name }));
    const rects = await rectsIn(setup.client, setup.zone.id);
    const at = { ...rects.get('lead')!, ...open };
    rects.set('lead', at);
    expectNoOverlap(rects);
    for (const agent of crew) {
      const tile = rects.get(agent.name)!;
      expect(tile.y >= at.y + at.height || tile.x >= at.x + at.width).toBe(true);
    }
    const map = await me.connection.call('orchestrator.map', { token: me.token });
    expect(map.lanes.map((lane) => lane.slots.implementer)).toEqual(crew.map((agent) => [key(agent)]));
    // Each lane's tiles beside its label, not out past the expanded tile's width.
    expect({ overlaps: map.overlaps, offGrid: map.offGrid, widestGap: map.widestGap }).toEqual({ overlaps: [], offGrid: [], widestGap: 0 });
  });

  it("in rows, keeps each lane's tiles and note side by side when another lane's tile is expanded", async () => {
    const setup = await layoutDaemon();
    const { me, impl } = await crewWithLanes(setup);
    await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other' });
    await setup.client.call('view.set', { key: 'expandedTiles', value: [{ id: key(impl), width: 1340, height: 600 }] });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const map = await me.connection.call('orchestrator.map', { token: me.token });
    expect(map.lanes).toHaveLength(2);
    // The one slot is the rail's room between the implementer and its reviewer, kept in every lane: not the expanded width.
    expect({ overlaps: map.overlaps, offGrid: map.offGrid, widestGap: map.widestGap }).toEqual({ overlaps: [], offGrid: [], widestGap: 1 });
  });

  it('with auto off, maps a tile expanded after the arrange as the board draws it: what it grew over pushed aside, no overlap', async () => {
    const setup = await layoutDaemon();
    const { me, impl } = await crewWithLanes(setup);
    await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other' });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    await setup.client.call('view.set', { key: 'expandedTiles', value: [{ id: key(impl), width: 960, height: 600 }] });
    const map = await me.connection.call('orchestrator.map', { token: me.token });
    expect(map.arrange.auto).toBe(false);
    // Laid out at its expanded size, it is.
    expect(map.things.find((thing) => thing.key === key(impl))).toMatchObject({ width: 960, height: 600 });
    expect(map.overlaps).toEqual([]);
  });

  it('lays lanes out as columns or cards, its note under its label as tall as its text needs, and back as rows', async () => {
    const setup = await layoutDaemon();
    const { me, impl, review } = await crewWithLanes(setup);
    const noteOf = async () => (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note')!;
    for (const layout of ['columns', 'cards'] as const) {
      await me.connection.call('orchestrator.arrange', { token: me.token, layout });
      const map = await me.connection.call('orchestrator.map', { token: me.token });
      expect([map.overlaps, map.offGrid], layout).toEqual([[], []]);
      const label = map.things.find((thing) => thing.key === map.lanes[0]!.labelItem)!;
      const note = await noteOf();
      expect(note.x).toBe(label.x);
      expect(note.y).toBe(label.y + CLUSTER_LABEL_SIZE.height + TILE_GAP);
      expect(note.height).toBe(Math.max(AGENT_TILE_SIZE.height - CLUSTER_LABEL_SIZE.height - TILE_GAP, agentNoteSize(String(note.data.text), note.width, 0).height));
    }
    const agents = await setup.client.call('agent.list');
    const [implAt, reviewAt] = [impl, review].map((agent) => agents.find((each) => each.sessionId === agent.sessionId)!.position!);
    expect(reviewAt!.y).toBe(implAt!.y);
    await me.connection.call('orchestrator.arrange', { token: me.token, layout: 'rows' });
    const note = await noteOf();
    expect(note).toMatchObject({ width: AGENT_TILE_SIZE.width, height: Math.max(AGENT_TILE_SIZE.height, agentNoteSize(String(note.data.text), note.width, 0).height) });
    const map = await me.connection.call('orchestrator.map', { token: me.token });
    expect([map.overlaps, map.offGrid]).toEqual([[], []]);
  });

  it('keeps a lane’s note at a height it was grown or resized to while its text stays, and makes room for it', async () => {
    const setup = await layoutDaemon();
    const { me, impl, review } = await crewWithLanes(setup);
    const other = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other' });
    const otherReview = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other review', role: 'reviewer', baseBranch: other.branch });
    // Each with a line of its own, so a lane's note says the same while its agents start and end their turns.
    for (const { sessionId } of [impl, review, other, otherReview]) await me.connection.call('orchestrator.setStatus', { token: me.token, sessionId, summary: 'Working' });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const first = (await me.connection.call('orchestrator.map', { token: me.token })).lanes[0]!.note!;
    const noteOf = async () => (await setup.client.call('item.list')).find((item) => `item:${item.id}` === first)!;
    const arranged = await noteOf();
    // As the board grows it to fit its text, or the user drags it taller.
    await setup.client.call('item.update', { id: arranged.id, height: 400 });
    for (const layout of ['rows', 'columns', 'rows'] as const) {
      await me.connection.call('orchestrator.arrange', { token: me.token, layout });
      expect((await noteOf()).height, layout).toBe(400);
      const map = await me.connection.call('orchestrator.map', { token: me.token });
      expect([map.overlaps, map.offGrid], layout).toEqual([[], []]);
    }
    // Written anew by an arrange, once its implementer stands elsewhere, it is sized for its new text.
    await me.connection.call('orchestrator.setStatus', { token: me.token, sessionId: impl.sessionId, summary: 'Fixing' });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const rewritten = await noteOf();
    expect(rewritten.data.text).not.toBe(arranged.data.text);
    expect(rewritten.height).toBe(arranged.height);
  });

  it('keeps the width and height a user gave a lane’s note, even as its text changes, and lays the lanes out round it', async () => {
    const setup = await layoutDaemon();
    const { me, impl } = await crewWithLanes(setup);
    const other = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other' });
    await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other review', role: 'reviewer', baseBranch: other.branch });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const first = (await me.connection.call('orchestrator.map', { token: me.token })).lanes[0]!.note!;
    const noteOf = async () => (await setup.client.call('item.list')).find((item) => `item:${item.id}` === first)!;
    // Dragged wider, and shorter than its slot, as the board saves it.
    await setup.client.call('item.update', { id: (await noteOf()).id, width: 420, height: 100, data: { userSized: true } });
    for (const layout of ['rows', 'columns', 'cards', 'rows'] as const) {
      await me.connection.call('orchestrator.arrange', { token: me.token, layout });
      expect(await noteOf(), layout).toMatchObject({ width: 420, height: 100 });
      const map = await me.connection.call('orchestrator.map', { token: me.token });
      expect([map.overlaps, map.offGrid], layout).toEqual([[], []]);
    }
    // Written anew by an arrange, or by its agent, it keeps the size.
    await me.connection.call('orchestrator.setStatus', { token: me.token, sessionId: impl.sessionId, summary: 'Fixing' });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const long = Array.from({ length: 14 }, (_, index) => `- step ${index + 1} of the review is done`).join('\n');
    expect(await noteOf()).toMatchObject({ width: 420, height: 100 });
    await me.connection.call('orchestrator.editNote', { token: me.token, id: (await noteOf()).id, text: long });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    expect(await noteOf()).toMatchObject({ width: 420, height: 100, data: { text: long } });
  });

  it('arranges a zone that arranges itself again when a note is given a bigger size, so nothing overlaps', async () => {
    const setup = await layoutDaemon();
    const { me } = await crewWithLanes(setup);
    const other = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other' });
    await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other review', role: 'reviewer', baseBranch: other.branch });
    await me.connection.call('orchestrator.arrange', { token: me.token, auto: true });
    const first = (await me.connection.call('orchestrator.map', { token: me.token })).lanes[0]!.note!;
    const note = (await setup.client.call('item.list')).find((item) => `item:${item.id}` === first)!;
    await me.connection.call('orchestrator.editNote', { token: me.token, id: note.id, width: 900, height: 700 });
    const map = await me.connection.call('orchestrator.map', { token: me.token });
    expect([map.overlaps, map.offGrid]).toEqual([[], []]);
    expect((await setup.client.call('item.list')).find((item) => item.id === note.id)).toMatchObject({ width: 900, height: 700 });
  });

  it('refuses a size above the most a note can be, which would leave its zone unarrangeable', async () => {
    const setup = await layoutDaemon();
    const { me } = await crewWithLanes(setup);
    const added = await me.connection.call('orchestrator.addNote', { token: me.token, text: 'Digest' });
    await expect(me.connection.call('orchestrator.editNote', { token: me.token, id: added.id, width: 1e9, height: 1e9 })).rejects.toThrow(/at most 1200x1440/);
    await expect(me.connection.call('orchestrator.editNote', { token: me.token, id: added.id, width: 1200, height: 1441 })).rejects.toThrow(/at most 1200x1440/);
    expect(await me.connection.call('orchestrator.editNote', { token: me.token, id: added.id, width: 1200, height: 1440 })).toMatchObject({ width: 1200, height: 1440 });
  });

  it('sizes an agent note it made when asked, and refuses a size below the least', async () => {
    const setup = await layoutDaemon();
    const { me } = await crewWithLanes(setup);
    const added = await me.connection.call('orchestrator.addNote', { token: me.token, text: 'Digest' });
    const edited = await me.connection.call('orchestrator.editNote', { token: me.token, id: added.id, width: 380, height: 260 });
    expect(edited).toMatchObject({ width: 380, height: 260, data: { text: 'Digest', userSized: true } });
    await expect(me.connection.call('orchestrator.editNote', { token: me.token, id: added.id, width: 380 })).rejects.toThrow(/width and the height together/);
    await expect(me.connection.call('orchestrator.editNote', { token: me.token, id: added.id, width: 100, height: 50 })).rejects.toThrow(/at least 200x96/);
    // Its text rewritten, the size stays: it does not grow to its text.
    const long = Array.from({ length: 30 }, (_, index) => `- line ${index + 1}`).join('\n');
    expect(await me.connection.call('orchestrator.editNote', { token: me.token, id: added.id, text: long })).toMatchObject({ width: 380, height: 260 });
  });

  it('shrinks a lane’s note it kept taller once its text is written shorter, by its agent or by the user', async () => {
    const setup = await layoutDaemon();
    const { me } = await crewWithLanes(setup);
    const other = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other' });
    await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other review', role: 'reviewer', baseBranch: other.branch });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const first = (await me.connection.call('orchestrator.map', { token: me.token })).lanes[0]!.note!;
    const noteOf = async () => (await setup.client.call('item.list')).find((item) => `item:${item.id}` === first)!;
    const slot = (await noteOf()).height;
    const long = Array.from({ length: 14 }, (_, index) => `- step ${index + 1} of the review is done`).join('\n');
    const settled = async () => {
      await me.connection.call('orchestrator.arrange', { token: me.token });
      const map = await me.connection.call('orchestrator.map', { token: me.token });
      expect([map.overlaps, map.offGrid]).toEqual([[], []]);
      return (await noteOf()).height;
    };

    // Its agent writes it long, then short.
    await me.connection.call('orchestrator.editNote', { token: me.token, id: (await noteOf()).id, text: long });
    expect(await settled()).toBeGreaterThan(slot);
    await me.connection.call('orchestrator.editNote', { token: me.token, id: (await noteOf()).id, text: 'Done' });
    expect(await settled()).toBe(slot);

    // The user writes it long and the board grows it past what an arrange gives it, which the next arrange keeps; then
    // they write it short.
    await setup.client.call('item.update', { id: (await noteOf()).id, data: { text: long, editedByUser: true } });
    const arranged = await settled();
    await setup.client.call('item.update', { id: (await noteOf()).id, height: arranged + 40 });
    expect(await settled()).toBe(arranged + 40);
    await setup.client.call('item.update', { id: (await noteOf()).id, data: { text: 'Done', editedByUser: true } });
    expect(await settled()).toBe(slot);
  });

  it('arranging by itself, makes room for a lane’s note written longer, so nothing overlaps it', async () => {
    const setup = await layoutDaemon();
    const { me } = await crewWithLanes(setup);
    // A second lane like the first, so its note is under the first one's.
    const other = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other' });
    await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other review', role: 'reviewer', baseBranch: other.branch });
    await me.connection.call('orchestrator.arrange', { token: me.token, auto: true });
    const first = (await me.connection.call('orchestrator.map', { token: me.token })).lanes[0]!.note!;
    const note = (await setup.client.call('item.list')).find((item) => `item:${item.id}` === first)!;
    const longer = Array.from({ length: 10 }, (_, index) => `- step ${index + 1} of the review is done`).join('\n');
    const edited = await me.connection.call('orchestrator.editNote', { token: me.token, id: note.id, text: longer });
    expect(edited.height).toBe(agentNoteSize(longer, note.width, 0).height);
    expect(edited.height).toBeGreaterThan(AGENT_TILE_SIZE.height);
    const map = await me.connection.call('orchestrator.map', { token: me.token });
    expect([map.overlaps, map.offGrid]).toEqual([[], []]);
  });

  it('with auto off, arranges nothing by itself: not for a new agent, a note or a close', async () => {
    const setup = await layoutDaemon();
    const { me } = await crewWithLanes(setup);
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const other = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other' });
    expect(await lastLine(setup.client)).toMatchObject({ action: 'spawn' });
    await me.connection.call('orchestrator.addNote', { token: me.token, text: 'Waiting on design', near: { kind: 'agent', id: other.sessionId } });
    expect(await lastLine(setup.client)).toMatchObject({ action: 'add-note' });
    await me.connection.call('orchestrator.close', { token: me.token, sessionId: other.sessionId });
    expect(await lastLine(setup.client)).toMatchObject({ action: 'close' });
  });

  it('keeps nothing an arrange asked for when it is refused for growing its zone over another', async () => {
    const setup = await layoutDaemon();
    const { me } = await crewWithLanes(setup);
    await setup.client.call('zone.update', { id: setup.zone.id, x: 0, y: 0, width: 600, height: 600 });
    await setup.client.call('zone.update', { id: setup.other.id, x: 610, y: 0, width: 720, height: 480 });
    await expect(me.connection.call('orchestrator.arrange', { token: me.token, layout: 'cards', auto: true })).rejects.toThrow(/over other/);
    expect(await lastLine(setup.client)).toMatchObject({ action: 'arrange', outcome: 'refused' });
    expect((await me.connection.call('orchestrator.map', { token: me.token })).arrange).toEqual({ by: 'issue', layout: 'rows', auto: false });
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
    // Written longer, it grows to show all its text; written shorter again, it keeps its size.
    const longer = Array.from({ length: 8 }, (_, index) => `- step ${index + 1} of the review is done`).join('\n');
    const grown = await me.connection.call('orchestrator.editNote', { token: me.token, id: note.id, text: longer });
    expect(grown.height).toBe(agentNoteSize(longer, grown.width).height);
    expect(grown.height).toBeGreaterThan(note.height);
    expect((await me.connection.call('orchestrator.editNote', { token: me.token, id: note.id, text: 'Reviewed' })).height).toBe(grown.height);
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

  describe.each([{ auto: false }, { auto: true }])('a note near an agent, auto-arrange $auto', ({ auto }) => {
    const OPEN = { width: 960, height: 600 };

    /** A crew of the lead with the first worker expanded in place (or not), then the zone's map: what a note near it leaves. */
    async function noteNear(expanded: boolean, near: 'worker' | 'me', extra: object = {}) {
      const setup = await layoutDaemon();
      const me = await lead(setup, setup.zone.id);
      const worker = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker' });
      await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other' });
      const target = near === 'worker' ? worker : me.agent;
      // Expanded before the zone is laid out, so everything starts clear of it; the note is the only thing that could land on it.
      if (expanded) await setup.client.call('view.set', { key: 'expandedTiles', value: [{ id: `agent:${target.sessionId}`, ...OPEN }] });
      await me.connection.call('orchestrator.arrange', { token: me.token, ...(auto ? { auto: true } : {}) });
      const note = await me.connection.call('orchestrator.addNote', { token: me.token, text: 'Waiting on review', near: { kind: 'agent', id: target.sessionId }, ...extra });
      const rects = await rectsIn(setup.client, setup.zone.id);
      if (expanded) rects.set(target.name, { ...rects.get(target.name)!, ...OPEN });
      return { setup, me, note, rects, map: await me.connection.call('orchestrator.map', { token: me.token }) };
    }

    it.each([
      ['a compact tile', false, 'worker'],
      ['an expanded tile', true, 'worker'],
      ['the orchestrator\'s own expanded tile', true, 'me'],
    ] as const)('leaves the map clean beside %s, expanded before the arrange (coverage; the regressions are below)', async (_name, expanded, near) => {
      const { rects, map } = await noteNear(expanded, near);
      expectNoOverlap(rects);
      expect(map.overlaps).toEqual([]);
    });

    it.each(['worker', 'user'] as const)("keeps it off %s's tile, expanded after the zone was arranged, whatever the note's slot held", async (who) => {
      const setup = await layoutDaemon();
      const me = await lead(setup, setup.zone.id);
      const worker = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker' });
      const user = await userAgent(setup.client, setup.zone.id, 'user');
      await me.connection.call('orchestrator.arrange', { token: me.token, ...(auto ? { auto: true } : {}) });
      const target = who === 'user' ? user : worker;
      await setup.client.call('view.set', { key: 'expandedTiles', value: [{ id: `agent:${target.sessionId}`, ...OPEN }] });
      const note = await me.connection.call('orchestrator.addNote', { token: me.token, text: 'Waiting on review', near: { kind: 'agent', id: target.sessionId } });
      const rects = await rectsIn(setup.client, setup.zone.id);
      rects.set(target.name, { ...rects.get(target.name)!, ...OPEN });
      const tile = rects.get(target.name)!;
      const placed = (await setup.client.call('item.list')).find((item) => item.id === note.id)!;
      // The expansion itself is drawn pushing its neighbours aside; what the note did is not to sit under it.
      expect(clearOf(sizedFootprint(tile, tile), [{ x: placed.x, y: placed.y, width: placed.width, height: placed.height }])).toBe(true);
      if (auto) expectNoOverlap(rects);
    });

    it("keeps an appended cluster note where it is when no tile is in its way, even as it grows", async () => {
      const setup = await layoutDaemon();
      const me = await lead(setup, setup.zone.id);
      const worker = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker' });
      await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other' });
      await me.connection.call('orchestrator.arrange', { token: me.token, ...(auto ? { auto: true } : {}) });
      const sticky = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note' && item.data.members !== undefined && String(item.data.text).includes('worker'))!;
      const near = { kind: 'agent' as const, id: worker.sessionId };
      for (let line = 0; line < 12; line++) await me.connection.call('orchestrator.addNote', { token: me.token, text: `line ${line} of what the worker is doing`, near });
      const now = (await setup.client.call('item.list')).find((item) => item.id === sticky.id)!;
      expect([now.x, now.y]).toEqual([sticky.x, sticky.y]);
    });

    it('appends the text, with the note below everything, when beside the tile would grow the zone over another', async () => {
      const setup = await layoutDaemon();
      const me = await lead(setup, setup.zone.id);
      const worker = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker' });
      await me.connection.call('orchestrator.arrange', { token: me.token });
      const web = (await setup.client.call('zone.list')).find((zone) => zone.id === setup.zone.id)!;
      await setup.client.call('zone.update', { id: setup.other.id, x: web.x + web.width + 20, y: web.y, width: 600, height: 400 });
      await setup.client.call('view.set', { key: 'expandedTiles', value: [{ id: `agent:${worker.sessionId}`, ...OPEN }] });
      const note = await me.connection.call('orchestrator.addNote', { token: me.token, text: 'Waiting on review', near: { kind: 'agent', id: worker.sessionId } });
      expect(note.data.text).toContain('Waiting on review');
      const tile = { ...(await rectsIn(setup.client, setup.zone.id)).get('worker')!, ...OPEN };
      expect(clearOf(sizedFootprint(tile, tile), [{ x: note.x, y: note.y, width: note.width, height: note.height }])).toBe(true);
    });

    it('puts it beside an expanded tile on the side asked, never on it', async () => {
      const { note, rects, map } = await noteNear(true, 'worker', { side: 'right' });
      const tile = rects.get('worker')!;
      expect(note.x).toBeGreaterThanOrEqual(tile.x + tile.width);
      expectNoOverlap(rects);
      expect(map.overlaps).toEqual([]);
    });
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
    // Any theme colour by name, stored as its light colour, which the board draws as the theme's.
    const teal = await me.connection.call('orchestrator.addNote', { token: me.token, text: 'Teal', kind: 'text', color: 'Teal' });
    expect(teal.data).toMatchObject({ color: '#087f5b', colorSlot: 'teal' });
    // A colour set writes over the slot the user picked: by name, the slot; as #rrggbb, fixed, though it is a slot's.
    await setup.client.call('item.update', { id: teal.id, data: { color: '#3b5bdb', colorSlot: 'blue' } });
    expect((await me.connection.call('orchestrator.editNote', { token: me.token, id: teal.id, color: 'red' })).data).toMatchObject({ color: '#c92a2a', colorSlot: 'red' });
    expect((await me.connection.call('orchestrator.editNote', { token: me.token, id: teal.id, color: '#3B5BDB' })).data).toMatchObject({ color: '#3b5bdb', colorSlot: null });
    expect((await me.connection.call('orchestrator.addNote', { token: me.token, text: 'Ink', kind: 'text' })).data).toMatchObject({ colorSlot: 'ink' });
  });
});

describe('the layout tools and commands', () => {
  it('draws a class diagram with the shape and connector tools, and reads it back with board', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const env = { ...process.env, AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: me.token };
    const mcp = new McpClient({ command: TEST_CLI_LAUNCHER.command, args: [...TEST_CLI_LAUNCHER.args, 'mcp'], env }, tempDataDir());
    await mcp.initialize();

    const order = await mcp.callTool('add_shape', { shape: 'class', text: 'Order', attributes: ['+ id: UUID'], methods: ['+ total(): Money'] });
    expect(order).toMatchObject({ text: expect.stringMatching(/^Added item:\S+ {2}shape class {2}"Order" {2}\(1 attribute, 1 method\)/), isError: false });
    const orderRef = /item:\w+/.exec(order.text)![0];
    const line = await mcp.callTool('add_shape', { shape: 'class', text: 'LineItem', methods: '+ subtotal(): Money\n+ qty(): int', near: orderRef, side: 'right' });
    expect(line).toMatchObject({ text: expect.stringContaining('(0 attributes, 2 methods)'), isError: false });
    const lineRef = /item:\w+/.exec(line.text)![0];
    expect(await mcp.callTool('add_shape', { shape: 'class', text: 'X', methods: [1] })).toMatchObject({ text: expect.stringContaining('methods must be an array of strings'), isError: true });

    const joined = await mcp.callTool('connect', { from: orderRef, to: lineRef, relation: 'composition', to_label: '1..*' });
    expect(joined).toMatchObject({ text: expect.stringMatching(/^Connected connector:\w+ {2}item:\w+ "Order" → item:\w+ "LineItem" {2}composition {2}\(to "1\.\.\*"\)/), isError: false });
    const connectorRef = /connector:\w+/.exec(joined.text)![0];
    expect(await mcp.callTool('edit_connector', { connector: connectorRef, from_label: '1' })).toMatchObject({ text: expect.stringContaining('(from "1", to "1..*")'), isError: false });
    expect((await mcp.callTool('board', {})).text).toContain(`${connectorRef}  ${orderRef} "Order" → ${lineRef} "LineItem"  composition`);
    // Its hints name the tools, not the commands.
    const summary = (await mcp.callTool('map', {})).text;
    expect(summary).toMatch(/\ndiagram {2}\(2 shapes, 1 connector; members with sections: true\)/);
    expect(summary.slice(summary.indexOf('\ndiagram'))).not.toContain('agent-board');
    // MCP has no `show`: the map is the diagram's whole read, a class's members and all.
    expect((await mcp.callTool('map', { sections: true })).text).toMatch(/\ndiagram {2}\(2 shapes.*"LineItem".*\n {4}── methods\n {4}\+ subtotal\(\): Money\n {4}\+ qty\(\): int\n/s);
    expect(await mcp.callTool('edit_shape', { item: lineRef, text: 'Line' })).toMatchObject({ text: expect.stringContaining('"Line"'), isError: false });
    expect(await mcp.callTool('remove_connector', { connector: connectorRef })).toMatchObject({ isError: false });
  });

  it('moves, arranges and makes notes over the MCP tools, and groups over the CLI, as the orchestrator', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker' });
    const env = { ...process.env, AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: me.token };
    const mcp = new McpClient({ command: TEST_CLI_LAUNCHER.command, args: [...TEST_CLI_LAUNCHER.args, 'mcp'], env }, tempDataDir());
    await mcp.initialize();

    expect(await mcp.callTool('arrange', {})).toMatchObject({ isError: false, text: expect.stringMatching(/^Arranged zone:\S+ web/) });
    // auto as a model may send it: "true" turns it on, an unknown word is refused, never read as off.
    expect(await mcp.callTool('arrange', { auto: 'true' })).toMatchObject({ isError: false, text: expect.stringContaining('auto-arrange on') });
    expect(await mcp.callTool('arrange', { auto: 'maybe' })).toMatchObject({ isError: true, text: expect.stringContaining('auto must be true or false') });
    expect(await mcp.callTool('map', {})).toMatchObject({ isError: false, text: expect.stringContaining('auto-arrange on') });
    expect(await mcp.callTool('arrange', { auto: false })).toMatchObject({ isError: false, text: expect.stringContaining('auto-arrange off') });
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
    // Sized as `note edit --size` does: kept by the daemon as the user's size; a malformed, too small or too big one is refused.
    expect(await mcp.callTool('edit_note', { note: `item:${note.id}`, size: '400x300' })).toMatchObject({ isError: false });
    expect((await setup.client.call('item.list')).find((item) => item.id === note.id)).toMatchObject({ width: 400, height: 300, data: { text: 'Shipped', userSized: true } });
    expect(await mcp.callTool('edit_note', { note: `item:${note.id}`, size: 'big' })).toMatchObject({ isError: true, text: expect.stringContaining('--size is <width>x<height>') });
    expect(await mcp.callTool('edit_note', { note: `item:${note.id}`, size: '100x50' })).toMatchObject({ isError: true, text: expect.stringContaining('at least 200x96') });
    expect(await mcp.callTool('edit_note', { note: `item:${note.id}`, size: '9000x9000' })).toMatchObject({ isError: true, text: expect.stringContaining('at most 1200x1440') });
    expect((await setup.client.call('item.list')).find((item) => item.id === note.id)).toMatchObject({ width: 400, height: 300 });
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

describe('orchestrator.addClock and removeClock', () => {
  it('puts a clock in its scope, marked as its own: messaging a worker beside its tile, or starting fresh agents in its zone; another zone is refused, and logged', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const worker = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker' });
    const elsewhere = await userAgent(setup.client, setup.other.id, 'elsewhere');

    const messaging = await me.connection.call('orchestrator.addClock', { token: me.token, data: { cron: '@hourly', agent: worker.sessionId, prompt: 'Report in' } });
    expect(messaging).toMatchObject({ kind: 'clock', zoneId: setup.zone.id, data: { does: 'message', agent: worker.sessionId } });
    expect(await lastLine(setup.client)).toMatchObject({ action: 'add-clock', outcome: 'done', targetName: 'clock Every hour', detail: 'Every hour, messaging worker' });
    const fresh = await me.connection.call('orchestrator.addClock', { token: me.token, data: { cron: '@daily', does: 'fresh', prompt: 'Sweep' } });
    expect(fresh).toMatchObject({ zoneId: setup.zone.id, data: { does: 'fresh', agent: null } });

    await expect(me.connection.call('orchestrator.addClock', { token: me.token, data: { cron: '@daily', agent: elsewhere.sessionId, prompt: 'Go' } })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    await expect(me.connection.call('orchestrator.addClock', { token: me.token, zoneId: setup.other.id, data: { cron: '@daily', does: 'fresh', prompt: 'Go' } })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
    });
    expect(await lastLine(setup.client)).toMatchObject({ action: 'add-clock', outcome: 'refused' });

    // Its own goes; the user's stays.
    const users = await setup.client.call('clock.add', { place: { zoneId: setup.zone.id, x: 0, y: 900 }, data: { prompt: 'Mine' } });
    await expect(me.connection.call('orchestrator.removeClock', { token: me.token, id: users.id })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    await me.connection.call('orchestrator.removeClock', { token: me.token, id: fresh.id });
    expect((await setup.client.call('item.list')).filter((item) => item.kind === 'clock').map((item) => item.id).sort()).toEqual([messaging.id, users.id].sort());
  });
});

describe('orchestrators drawing a diagram', () => {
  it('draws a class sized for its sections, marked as its own, and changes only the shapes its crew drew', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const order = await me.connection.call('orchestrator.addShape', {
      token: me.token,
      shape: 'class',
      text: 'Order',
      attributes: '+ id: UUID\n+ placedAt: Date',
      methods: '+ total(): Money',
      fill: 'blue',
    });
    expect(order).toMatchObject({ kind: 'shape', zoneId: setup.zone.id, data: { shape: 'class', text: 'Order', methods: '+ total(): Money', fill: '#d0ebff', fillSlot: 'blue', mono: true } });
    expect(order.height).toBeGreaterThan(160);
    expect(await lastLine(setup.client)).toMatchObject({ orchestratorId: me.agent.sessionId, action: 'add-shape', targetName: 'shape “Order”', outcome: 'done' });
    expectNoOverlap(await rectsIn(setup.client, setup.zone.id));

    const edited = await me.connection.call('orchestrator.editShape', { token: me.token, id: order.id, methods: '+ total(): Money\n+ cancel(): void' });
    expect(edited.data).toMatchObject({ text: 'Order', methods: '+ total(): Money\n+ cancel(): void' });
    const users = await setup.client.call('orchestrator.addShape', { shape: 'rectangle', text: 'Theirs', zoneId: setup.zone.id });
    await expect(me.connection.call('orchestrator.editShape', { token: me.token, id: users.id, text: 'Mine' })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/that shape was not made by you/),
    });
    await expect(me.connection.call('orchestrator.editShape', { token: me.token, id: order.id, shape: 'blob' as never })).rejects.toMatchObject({ message: expect.stringMatching(/shape must be one of/) });
    await expect(me.connection.call('orchestrator.addShape', { token: me.token, shape: 'rectangle', text: 'Cart', methods: 'x' })).rejects.toMatchObject({
      message: expect.stringMatching(/a rectangle has no methods/),
    });
    await expect(me.connection.call('orchestrator.addShape', { token: me.token, shape: 'class', text: 'X', fill: 'tartan' })).rejects.toMatchObject({ message: expect.stringMatching(/fill is none, #rrggbb/) });
    await expect(me.connection.call('orchestrator.addShape', { token: me.token, shape: 'class', text: 'Far', zoneId: setup.other.id })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    // Made a class, a rectangle takes a class's mono.
    const plain = await me.connection.call('orchestrator.addShape', { token: me.token, shape: 'rectangle', text: 'Cart' });
    expect(plain.data).toMatchObject({ mono: false, fill: '#ffffff', fillSlot: 'tile', strokeSlot: 'accent' });
    expect((await me.connection.call('orchestrator.editShape', { token: me.token, id: plain.id, fill: '#d0ebff' })).data).toMatchObject({ fill: '#d0ebff', fillSlot: null });
    expect((await me.connection.call('orchestrator.editShape', { token: me.token, id: plain.id, fill: 'none' })).data).toMatchObject({ fill: null, fillSlot: null });
    expect((await me.connection.call('orchestrator.editShape', { token: me.token, id: plain.id, shape: 'class', attributes: 'items: Item[]' })).data).toMatchObject({ shape: 'class', mono: true });
    // Removed only its own, as shapes, never by the note commands.
    await expect(me.connection.call('orchestrator.removeShape', { token: me.token, id: users.id })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    await expect(me.connection.call('orchestrator.removeNote', { token: me.token, id: order.id })).rejects.toMatchObject({ message: expect.stringMatching(/the note commands change only notes/) });
    await me.connection.call('orchestrator.removeShape', { token: me.token, id: order.id });
    expect(await lastLine(setup.client)).toMatchObject({ action: 'remove-shape', targetName: 'shape “Order”', outcome: 'done' });
  });

  it('draws a Mermaid diagram as one block of its own shapes and connectors, and exports it as Mermaid again', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const env = { ...process.env, AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: me.token };
    const mcp = new McpClient({ command: TEST_CLI_LAUNCHER.command, args: [...TEST_CLI_LAUNCHER.args, 'mcp'], env }, tempDataDir());
    await mcp.initialize();
    const mermaid = ['classDiagram', '  class Order {', '    +UUID id', '    +total() Money', '  }', '  Order "1" *-- "1..*" Line : holds', '  Base <|-- Order', '  note for Order "kept"'].join('\n');

    const drawn = await mcp.callTool('add_diagram', { mermaid });
    expect(drawn).toMatchObject({ isError: false, text: expect.stringMatching(/^Drew 3 shapes and 2 connectors \(in zone:\w+ web\):\n/) });
    expect(drawn.text).toMatch(/connector:\w+ {2}item:\w+ "Order" → item:\w+ "Line" {2}composition {2}\(label "holds", from "1", to "1\.\.\*"\)/);
    expect(drawn.text).toMatch(/item:\w+ "Order" → item:\w+ "Base" {2}inheritance/);
    expect(drawn.text).toMatch(/Passed over 1 line it does not draw:\n {2}note for Order "kept"$/);
    const items = (await setup.client.call('item.list')).filter((item) => item.kind === 'shape');
    expect(items.map((item) => [item.zoneId, item.data.text, item.data.attributes])).toEqual([
      [setup.zone.id, 'Order', '+UUID id'],
      [setup.zone.id, 'Line', ''],
      [setup.zone.id, 'Base', ''],
    ]);
    // Laid out as Mermaid draws it: the parent above, the parts below, none on another.
    const [order, line, base] = items;
    expect(base!.y + base!.height).toBeLessThan(order!.y);
    expect(order!.y + order!.height).toBeLessThan(line!.y);
    expect(await lastLine(setup.client)).toMatchObject({ action: 'add-diagram', targetName: 'a class diagram of 3 shapes', outcome: 'done' });
    // Its own, to change as any shape it drew.
    expect((await me.connection.call('orchestrator.editShape', { token: me.token, id: line!.id, text: 'LineItem' })).data.text).toBe('LineItem');

    const exported = await mcp.callTool('export_diagram', {});
    expect(exported).toMatchObject({ isError: false });
    expect(exported.text).toBe(
      ['classDiagram', '  class Order {', '    +UUID id', '    +total() Money', '  }', '  class LineItem', '  class Base', '  Order "1" *-- "1..*" LineItem : holds', '  Order --|> Base'].join('\n'),
    );
    expect(await mcp.callTool('add_diagram', { mermaid: 'sequenceDiagram\n  A->>B: hi' })).toMatchObject({ isError: true, text: expect.stringContaining('not a Mermaid flowchart or class diagram') });
    expect(await mcp.callTool('add_diagram', { mermaid: 'flowchart TD\n  style A fill:#fff', to: setup.other.id })).toMatchObject({ isError: true, text: expect.stringContaining('no shapes') });
    // No control character but a tab or a line break, raw or as an entity, as shape add refuses.
    expect(await mcp.callTool('add_diagram', { mermaid: 'flowchart TD\n  A["\u001b[2J"] --> B' })).toMatchObject({ isError: true, text: expect.stringContaining('no other control character') });
    const shapes = async () => (await setup.client.call('item.list')).filter((item) => item.kind === 'shape');
    expect(await shapes()).toHaveLength(3);
    expect(await mcp.callTool('add_diagram', { mermaid: 'flowchart TD\n  A["#27;[2Jx"] --> B' })).toMatchObject({ isError: false });
    expect((await shapes()).map((item) => item.data.text)).toContain('[2Jx');
    // A class longer than a shape holds is cut to fit, its name and sections together, not refused half drawn.
    const members = (prefix: string) => Array.from({ length: 1200 }, (_, n) => `    ${prefix}${String(n).padStart(6, '0')}`);
    expect(await mcp.callTool('add_diagram', { mermaid: ['classDiagram', '  class Big {', ...members('+a'), ...members('+m()'), '  }', '  Big --> Small'].join('\n') })).toMatchObject({
      isError: false,
      text: expect.stringContaining('Drew 2 shapes and 1 connector'),
    });
  });

  it("changes the shapes and connectors an agent of its crew made, and removing its shape takes the user's connectors on it too", async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const worker = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'worker' });
    const crews = await setup.client.call('orchestrator.addShape', { shape: 'class', text: 'Crew', zoneId: setup.zone.id, at: { x: 40, y: 400 } });
    const users = await setup.client.call('orchestrator.addShape', { shape: 'class', text: 'User', zoneId: setup.zone.id, at: { x: 600, y: 400 } });
    const line = await setup.client.call('orchestrator.connect', { from: crews.id, to: users.id });
    markMadeBy(setup, crews.id, worker.sessionId);
    const db = new DatabaseSync(daemonPaths(setup.dataDir).database);
    db.prepare('UPDATE connectors SET made_by = ? WHERE id = ?').run(worker.sessionId, line.id);
    db.close();

    expect((await me.connection.call('orchestrator.editShape', { token: me.token, id: crews.id, text: 'Crew2' })).data.text).toBe('Crew2');
    expect(await me.connection.call('orchestrator.editConnector', { token: me.token, id: line.id, label: 'uses' })).toMatchObject({ label: 'uses' });
    // A connector the user drew onto the crew's shape: the agent can't remove it, but it goes with the shape, as with a note.
    const theirs = await setup.client.call('connector.create', { from: { type: 'item', id: users.id, side: 'top' }, to: { type: 'item', id: crews.id, side: 'top' } });
    await expect(me.connection.call('orchestrator.removeConnector', { token: me.token, id: theirs.id })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    await me.connection.call('orchestrator.removeShape', { token: me.token, id: crews.id });
    expect(await setup.client.call('connector.list')).toEqual([]);
  });

  it('connects loose items only at board scope', async () => {
    const setup = await layoutDaemon();
    const a = await setup.client.call('orchestrator.addShape', { shape: 'rectangle', text: 'A', zoneId: null, at: { x: 0, y: 2000 } });
    const b = await setup.client.call('orchestrator.addShape', { shape: 'rectangle', text: 'B', zoneId: null, at: { x: 600, y: 2000 } });
    const zoned = await lead(setup, setup.zone.id);
    await expect(zoned.connection.call('orchestrator.connect', { token: zoned.token, from: a.id, to: b.id })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/shape “A” is outside your scope/),
    });
    await setup.client.call('agent.setOrchestrate', { sessionId: zoned.agent.sessionId, scope: 'board' });
    expect(await zoned.connection.call('orchestrator.connect', { token: zoned.token, from: a.id, to: b.id })).toMatchObject({ from: { side: 'right' }, to: { side: 'left' } });
  });

  it('connects two items in its scope as a relation reads, sides facing, and changes only the connectors its crew made', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    const parent = await me.connection.call('orchestrator.addShape', { token: me.token, shape: 'class', text: 'Shape', at: { x: 400, y: 40 } });
    const users = await setup.client.call('orchestrator.addShape', { shape: 'class', text: 'Circle', zoneId: setup.zone.id, at: { x: 400, y: 400 } });
    const far = await setup.client.call('orchestrator.addShape', { shape: 'class', text: 'Far', zoneId: setup.other.id });

    // The child below its parent: joined top to bottom, a hollow triangle by the parent.
    const inherits = await me.connection.call('orchestrator.connect', { token: me.token, from: users.id, to: parent.id, relation: 'inheritance', startLabel: 'child' });
    expect(inherits).toMatchObject({ from: { type: 'item', id: users.id, side: 'top' }, to: { type: 'item', id: parent.id, side: 'bottom' }, endEnd: 'triangle', dashed: false, startLabel: 'child' });
    expect(await lastLine(setup.client)).toMatchObject({ orchestratorId: me.agent.sessionId, action: 'connect', targetName: 'shape “Circle” → shape “Shape”', outcome: 'done' });
    // Made with no relation, it is the board's own arrow.
    expect(await me.connection.call('orchestrator.connect', { token: me.token, from: parent.id, to: users.id })).toMatchObject({ startEnd: 'none', endEnd: 'arrow' });

    await expect(me.connection.call('orchestrator.connect', { token: me.token, from: parent.id, to: far.id })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    await expect(me.connection.call('orchestrator.connect', { token: me.token, from: parent.id, to: parent.id })).rejects.toMatchObject({ message: expect.stringMatching(/two different items/) });
    await expect(me.connection.call('orchestrator.connect', { token: me.token, from: parent.id, to: users.id, relation: 'friendship' as never })).rejects.toMatchObject({
      message: expect.stringMatching(/relation must be one of/),
    });
    await expect(me.connection.call('orchestrator.connect', { token: me.token, from: parent.id, to: users.id, label: 'ring\u0007' })).rejects.toMatchObject({
      message: expect.stringMatching(/no other control character/),
    });

    const edited = await me.connection.call('orchestrator.editConnector', { token: me.token, id: inherits.id, relation: 'realisation', label: 'implements' });
    expect(edited).toMatchObject({ endEnd: 'triangle', dashed: true, label: 'implements', startLabel: 'child' });
    await expect(me.connection.call('orchestrator.editConnector', { token: me.token, id: inherits.id })).rejects.toMatchObject({ message: expect.stringMatching(/give the relation/) });
    const theirs = await setup.client.call('connector.create', { from: { type: 'item', id: users.id, side: 'right' }, to: { type: 'item', id: parent.id, side: 'right' } });
    await expect(me.connection.call('orchestrator.editConnector', { token: me.token, id: theirs.id, label: 'x' })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    await expect(me.connection.call('orchestrator.removeConnector', { token: me.token, id: theirs.id })).rejects.toMatchObject({ code: BOARD_ERROR.outOfScope });
    await me.connection.call('orchestrator.removeConnector', { token: me.token, id: inherits.id });
    expect((await setup.client.call('connector.list')).map((each) => each.id)).not.toContain(inherits.id);
    expect(await lastLine(setup.client)).toMatchObject({ action: 'remove-connector', targetName: 'connector “implements”', outcome: 'done' });
  });
});

describe('orchestrator.arrangeBoard', () => {
  it('moves whole zones, with what is in them, and the loose tiles for an orchestrator of the whole board, never the user’s loose notes', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id, 'board');
    // In `other`, the zone that moves: they go with it, at the same place in it.
    const inOther = await setup.client.call('shell.create', { zoneId: setup.other.id, position: { x: 40, y: 60 } });
    const noteInOther = await setup.client.call('item.create', { kind: 'sticky', zoneId: setup.other.id, x: 320, y: 50, ...STICKY_SIZE, data: { text: 'inside', color: '#fff3a3' } });
    const loose = await setup.client.call('shell.create', { zoneId: null, position: { x: 5000, y: 3000 } });
    const sticky = await setup.client.call('item.create', { kind: 'sticky', zoneId: null, x: 9000, y: 9000, ...STICKY_SIZE, data: { text: 'mine', color: '#fff3a3' } });

    const result = await me.connection.call('orchestrator.arrangeBoard', { token: me.token });
    const zones = await setup.client.call('zone.list');
    const web = zones.find((zone) => zone.id === setup.zone.id)!;
    const other = zones.find((zone) => zone.id === setup.other.id)!;
    // web stays at the top-left; other comes in beside it, a gap to its right.
    expect({ x: web.x, y: web.y }).toEqual({ x: 0, y: 0 });
    expect({ x: other.x, y: other.y }).toEqual({ x: web.width + BOARD_ARRANGE_GAP, y: 0 });
    expect(result.zones).toEqual([{ zoneId: other.id, x: other.x, y: other.y }]);
    const shells = await setup.client.call('shell.list');
    expect(shells.find((each) => each.id === inOther.id)).toMatchObject({ zoneId: other.id, position: { x: 40, y: 60 } });
    expect((await setup.client.call('item.list')).find((item) => item.id === noteInOther.id)).toMatchObject({ zoneId: other.id, x: 320, y: 50 });
    // The loose shell goes below the zones, the only tile moved; the sticky stays where it is.
    const moved = shells.find((each) => each.id === loose.id)!;
    expect(moved.position!.y - PERCH_ROOM).toBe(Math.max(web.height, other.height) + BOARD_ARRANGE_GAP);
    expect(result.moved).toEqual([{ target: { kind: 'shell', id: loose.id }, zoneId: null, x: moved.position!.x, y: moved.position!.y }]);
    expect((await setup.client.call('item.list')).find((item) => item.id === sticky.id)).toMatchObject({ x: 9000, y: 9000 });
    expect(await lastLine(setup.client)).toMatchObject({ action: 'arrange-board', outcome: 'done', detail: '1 zone and 1 loose tile' });
  });

  it('keeps a zone a gap clear of a note loose on the board, which stays, and arranges over the MCP arrange tool', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id, 'board');
    // Where `other` would go, right of web.
    const note = await setup.client.call('item.create', { kind: 'sticky', zoneId: null, x: 1300, y: 100, ...STICKY_SIZE, data: { text: 'mine', color: '#fff3a3' } });
    const env = { ...process.env, AGENT_BOARD_SOCKET: setup.daemon.socketPath, AGENT_BOARD_IDENTITY: me.token };
    const mcp = new McpClient({ command: TEST_CLI_LAUNCHER.command, args: [...TEST_CLI_LAUNCHER.args, 'mcp'], env }, tempDataDir());
    await mcp.initialize();

    expect(await mcp.callTool('arrange', { zone: 'board' })).toMatchObject({ isError: false, text: expect.stringMatching(/^Arranged the board:\n {2}zone:\S+ other at /) });
    const other = (await setup.client.call('zone.list')).find((zone) => zone.id === setup.other.id)!;
    const kept = (await setup.client.call('item.list')).find((item) => item.id === note.id)!;
    expect(kept).toMatchObject({ x: 1300, y: 100 });
    const space = Math.max(kept.x - (other.x + other.width), other.x - (kept.x + kept.width), kept.y - (other.y + other.height), other.y - (kept.y + kept.height));
    expect(space).toBeGreaterThanOrEqual(BOARD_ARRANGE_GAP);
    expect(await mcp.callTool('arrange', { zone: 'board' })).toMatchObject({ isError: false, text: 'The board was arranged already: nothing moved.' });
    expect(await mcp.callTool('arrange', { zone: 'board', by: 'role' })).toMatchObject({ isError: true, text: expect.stringContaining('arrange board takes no --by') });
  });

  it('refuses an orchestrator of less than the whole board', async () => {
    const setup = await layoutDaemon();
    const me = await lead(setup, setup.zone.id);
    await expect(me.connection.call('orchestrator.arrangeBoard', { token: me.token })).rejects.toMatchObject({
      code: BOARD_ERROR.outOfScope,
      message: expect.stringMatching(/whole board/),
    });
    expect((await setup.client.call('zone.list')).find((zone) => zone.id === setup.other.id)).toMatchObject({ x: 3000, y: 0 });
  });
});

describe('sizes the app measured', () => {
  const key = (agent: Agent) => `agent:${agent.sessionId}`;

  async function measuredDaemon({ measureWaitMs }: { measureWaitMs?: number } = {}) {
    const dataDir = tempDataDir();
    const daemon = await startTestDaemon({
      dataDir,
      worktreesDir: tempDataDir(),
      agentEnv: fakeHarnessEnv({ scenario: 'orchestrate', home: tempDataDir(), idleNotifyMs: 200 }),
      ...(measureWaitMs === undefined ? {} : { measureWaitMs }),
    });
    const client = await connectTestClient(daemon);
    const recorder = recordEvents(client);
    await client.call('settings.set', { arrangeSpacing: 'normal' });
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, width: 1200, height: 600, name: 'web' });
    const other = await client.call('zone.add', { path: tempRepo('other'), x: 3000, y: 0, name: 'other' });
    for (const { id } of [zone, other]) await client.call('zone.configure', { id, agentsOrchestrate: false });
    return { daemon, client, recorder, zone, other, repo: '', dataDir };
  }

  /**
   * Connects as the app (the connection that serves captures) and its window: `report` says how it draws the board now,
   * round the tiles `expanded`, and, with `fits`, every agent note is measured again as it changes, at the height `fits`
   * gives its text, as the board measures a note it draws.
   */
  async function app(setup: Setup, fits?: (text: string) => number) {
    const client = await connectTestClient(setup.daemon);
    await client.call('capture.serve');
    let boxes: MeasuredBox[] = [];
    let expanded: ExpandedBox[] = [];
    let away = false;
    const notes = new Map<string, BoardItem>();
    const send = () => client.call('layout.measured', { boxes: [...boxes, ...[...notes.values()].map(noteBox)], expanded, away });
    const noteBox = (item: BoardItem): MeasuredBox => {
      const box = { x: item.x, y: item.y, width: item.width, height: item.height };
      return { key: `item:${item.id}`, saved: box, drawn: box, fits: { height: fits!(String(item.data.text)), text: measuredText(String(item.data.text)) } };
    };
    if (fits !== undefined) {
      for (const item of await client.call('item.list')) if (item.kind === 'agent-note') notes.set(item.id, item);
      client.onEvent((event: DaemonEvent) => {
        if (event.type === 'item.updated' && event.item.kind === 'agent-note') {
          notes.set(event.item.id, event.item);
          if (!away) void send();
        }
      });
    }
    await send();
    return {
      client,
      report: async (measured: MeasuredBox[], round: ExpandedBox[] = []) => {
        boxes = measured;
        expanded = round;
        await send();
      },
      /** Its window is no longer in front: it says so, and nothing more. */
      leave: async () => {
        away = true;
        await send();
      },
    };
  }

  /** A lead with an implementer and its reviewer, arranged. */
  async function arrangedCrew(setup: Setup) {
    const me = await lead(setup, setup.zone.id);
    const impl = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'impl' });
    const review = await me.connection.call('orchestrator.spawn', { token: me.token, name: 'review', role: 'reviewer', baseBranch: impl.branch });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    return { me, impl, review };
  }

  it('maps a zone as unmeasured with no app window, and measured while one reports', async () => {
    const setup = await measuredDaemon();
    const { me } = await arrangedCrew(setup);
    expect((await me.connection.call('orchestrator.map', { token: me.token })).unmeasured).toBe(true);
    const window = await app(setup);
    expect((await me.connection.call('orchestrator.map', { token: me.token })).unmeasured).toBe(false);
    window.client.close();
    await expect.poll(async () => (await me.connection.call('orchestrator.map', { token: me.token })).unmeasured).toBe(true);
  });

  it('maps a tile where the app draws it pushed aside by an expanded one, holding the lint to where it is saved', async () => {
    const setup = await measuredDaemon();
    const { me, impl, review } = await arrangedCrew(setup);
    await setup.client.call('view.set', { key: 'expandedTiles', value: [{ id: key(impl), width: 960, height: 600 }] });
    const before = await me.connection.call('orchestrator.map', { token: me.token });
    const [implAt, reviewAt] = [impl, review].map((agent) => before.things.find((thing) => thing.key === key(agent))!);
    const saved = { x: reviewAt!.x, y: reviewAt!.y, width: reviewAt!.width, height: reviewAt!.height };
    const window = await app(setup);

    // Pushed clear below the expanded tile, as the board draws what it grew over.
    const expanded = { x: implAt!.x, y: implAt!.y, width: 960, height: 600 };
    const under = before.things.filter((thing) => thing.key !== key(impl) && rectsOverlap(thing, expanded));
    const pushedAside = (thing: Rect) => ({ ...thing, y: thing.y + 600 + TILE_GAP + PERCH_ROOM });
    const others = under.filter((thing) => thing.key !== key(review)).map((thing) => {
      const box = { x: thing.x, y: thing.y, width: thing.width, height: thing.height };
      return { key: thing.key, saved: box, drawn: pushedAside(box) };
    });
    const clear = pushedAside(saved);
    const round = [{ key: key(impl), ...expanded }];
    await window.report([{ key: key(review), saved, drawn: clear }, ...others], round);
    const pushed = await me.connection.call('orchestrator.map', { token: me.token });
    expect(pushed.things.find((thing) => thing.key === key(review))).toMatchObject({ x: clear.x, y: clear.y, saved: { x: saved.x, y: saved.y } });
    // Held to where it is saved, nothing is further off the grid than it was before it was drawn aside.
    expect({ overlaps: pushed.overlaps, offGrid: pushed.offGrid, unmeasured: pushed.unmeasured }).toEqual({ overlaps: [], offGrid: before.offGrid, unmeasured: false });

    // Left under it, where the board found no room to push it: the lint says so.
    await window.report([{ key: key(review), saved, drawn: { ...saved, x: implAt!.x + 100 } }, ...others], round);
    expect((await me.connection.call('orchestrator.map', { token: me.token })).overlaps).toEqual([[key(impl), key(review)]]);

    // Measured where it was saved before, it no longer holds: it is mapped where it is saved now.
    await window.report([{ key: key(review), saved: { ...saved, x: saved.x + 8 }, drawn: clear }, ...others], round);
    const mappedAt = async () => (await me.connection.call('orchestrator.map', { token: me.token })).things.find((thing) => thing.key === key(review));
    expect(await mappedAt()).toMatchObject({ x: saved.x, y: saved.y });

    // Drawn round an expanded tile that has since closed, with no word from the window since, it is where it is saved.
    await window.report([{ key: key(review), saved, drawn: clear }, ...others], round);
    expect(await mappedAt()).toMatchObject({ x: clear.x, y: clear.y });
    await setup.client.call('view.set', { key: 'expandedTiles', value: [] });
    const collapsed = await me.connection.call('orchestrator.map', { token: me.token });
    expect(collapsed.things.find((thing) => thing.key === key(review))).toMatchObject({ x: saved.x, y: saved.y });
    expect(collapsed.things.find((thing) => thing.key === key(review))!.saved).toBeUndefined();
    // So too once it is expanded to another size.
    await setup.client.call('view.set', { key: 'expandedTiles', value: [{ id: key(impl), width: 1000, height: 600 }] });
    expect(await mappedAt()).toMatchObject({ x: saved.x, y: saved.y });
  });

  it("maps a text item at the size the app draws it, and arranges round that", async () => {
    const setup = await measuredDaemon();
    const { me } = await arrangedCrew(setup);
    const text = await setup.client.call('item.create', { kind: 'text', zoneId: setup.zone.id, x: 900, y: 40, width: 120, height: 24, data: { text: 'a long heading', size: 'body', align: 'left', bold: false, italic: false, wrap: true, minHeight: 0, color: '#000000' } });
    const saved = { x: text.x, y: text.y, width: text.width, height: text.height };
    const window = await app(setup);
    await window.report([{ key: `item:${text.id}`, saved, drawn: { ...saved, width: 260, height: 300 } }]);
    const map = await me.connection.call('orchestrator.map', { token: me.token });
    expect(map.things.find((thing) => thing.key === `item:${text.id}`)).toMatchObject({ width: 260, height: 300 });
    await me.connection.call('orchestrator.arrange', { token: me.token });
    const rects = await rectsIn(setup.client, setup.zone.id);
    rects.set('item:a long heading', { ...saved, width: 260, height: 300 });
    expectNoOverlap(rects);
  });

  it("sizes a lane's note to the height the app measures its text at, below a high estimate, and says it measured", async () => {
    const setup = await measuredDaemon();
    const { me } = await arrangedCrew(setup);
    const long = Array.from({ length: 14 }, (_, index) => `- step ${index + 1} of the review is done`).join('\n');
    const written = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note')!;
    await setup.client.call('item.update', { id: written.id, data: { text: long, editedByUser: true } });
    // The app draws this text shorter than the daemon's estimate.
    const measured = 200;
    await app(setup, (text) => (text.includes('step 14') ? measured : AGENT_TILE_SIZE.height - 40));
    const result = await me.connection.call('orchestrator.arrange', { token: me.token });
    expect(result.unmeasured).toBe(false);
    const note = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note')!;
    expect(note.data.text).toBe(long);
    expect(agentNoteSize(String(note.data.text), note.width, 0).height).toBeGreaterThan(measured);
    expect(note.height).toBe(measured);
    const map = await me.connection.call('orchestrator.map', { token: me.token });
    expect({ overlaps: map.overlaps, offGrid: map.offGrid, unmeasured: map.unmeasured }).toEqual({ overlaps: [], offGrid: [], unmeasured: false });
  });

  it("estimates a lane's note it couldn't have measured in time, and says so", async () => {
    const setup = await measuredDaemon({ measureWaitMs: 50 });
    const { me, impl } = await arrangedCrew(setup);
    await me.connection.call('orchestrator.setStatus', { token: me.token, sessionId: impl.sessionId, summary: 'Fixing the review' });
    // A window that reports, but never measures notes.
    await app(setup);
    const result = await me.connection.call('orchestrator.arrange', { token: me.token });
    expect(result.unmeasured).toBe(true);
    const note = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note')!;
    expect(note.height).toBe(Math.max(AGENT_TILE_SIZE.height, agentNoteSize(String(note.data.text), note.width, 0).height));
  });

  it('arranges from estimates with no app window, and says so', async () => {
    const setup = await measuredDaemon();
    const { me } = await arrangedCrew(setup);
    expect((await me.connection.call('orchestrator.arrange', { token: me.token })).unmeasured).toBe(true);
  });

  it("writes a lane's new text into its note first, then sizes the lane to the height the app measures it at", async () => {
    for (const measured of [150, 420]) {
      const setup = await measuredDaemon();
      const { me, impl } = await arrangedCrew(setup);
      const said = 'step 9 of the review is under way';
      // Measured as the app draws it: whatever the estimate, this text takes `measured` once it is in the note.
      await app(setup, (text) => (text.includes(said) ? measured : AGENT_TILE_SIZE.height - 40));
      await me.connection.call('orchestrator.setStatus', { token: me.token, sessionId: impl.sessionId, summary: said });
      const result = await me.connection.call('orchestrator.arrange', { token: me.token });
      expect(result.unmeasured, String(measured)).toBe(false);
      const note = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note')!;
      expect(note.data.text).toContain(said);
      expect(note.height, String(measured)).toBe(Math.max(AGENT_TILE_SIZE.height, measured));
      expect(agentNoteSize(String(note.data.text), note.width, 0).height).not.toBe(note.height);
      const map = await me.connection.call('orchestrator.map', { token: me.token });
      expect({ overlaps: map.overlaps, offGrid: map.offGrid }).toEqual({ overlaps: [], offGrid: [] });
    }
  });

  it("keeps a lane's note saying where its agents stand, arrange after measured arrange", async () => {
    const setup = await measuredDaemon();
    const { me, impl } = await arrangedCrew(setup);
    await app(setup, (text) => (text.includes('status') ? 300 : AGENT_TILE_SIZE.height - 40));
    const noteOf = async () => (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note')!;
    for (const [summary, height] of [
      ['first status ONE', 300],
      ['second status TWO', 300],
      ['all done', AGENT_TILE_SIZE.height],
    ] as const) {
      await me.connection.call('orchestrator.setStatus', { token: me.token, sessionId: impl.sessionId, summary });
      expect((await me.connection.call('orchestrator.arrange', { token: me.token })).unmeasured, summary).toBe(false);
      const note = await noteOf();
      expect(note.data.text, summary).toContain(summary);
      // Its own text, which the next arrange writes again: never taken for someone's edit.
      expect({ arrangeText: note.data.arrangeText, editedByUser: note.data.editedByUser }, summary).toEqual({ arrangeText: note.data.text, editedByUser: false });
      expect(note.height, summary).toBe(height);
    }
  });

  it('puts back the notes it wrote first when the arrange is refused, and writes no new lane before it goes ahead', async () => {
    const setup = await measuredDaemon();
    const { me, impl } = await arrangedCrew(setup);
    // Another zone right under this one: a lane grown taller would grow the zone over it.
    await setup.client.call('zone.update', { id: setup.other.id, x: 0, y: 610, width: 1200, height: 400 });
    await app(setup, (text) => (text.includes('long story') ? 480 : AGENT_TILE_SIZE.height - 40));
    await me.connection.call('orchestrator.setStatus', { token: me.token, sessionId: impl.sessionId, summary: 'a long story' });
    // A new lane, whose label and note an arrange that goes ahead would make.
    await me.connection.call('orchestrator.spawn', { token: me.token, name: 'other' });
    const items = async () => (await setup.client.call('item.list')).map(({ id, kind, x, y, width, height, data }) => ({ id, kind, x, y, width, height, text: data.text }));
    const before = await items();
    await expect(me.connection.call('orchestrator.arrange', { token: me.token })).rejects.toThrow(/over other/);
    expect(await items()).toEqual(before);
  });

  it('leaves a note the user edited while the arrange waited as they wrote it, when the arrange is refused', async () => {
    const setup = await measuredDaemon({ measureWaitMs: 300 });
    const { me, impl } = await arrangedCrew(setup);
    await setup.client.call('zone.update', { id: setup.other.id, x: 0, y: 610, width: 1200, height: 400 });
    // The app's window: once the arrange writes its new text into the note, the user edits it, long, and the window
    // measures what they wrote.
    const window = await connectTestClient(setup.daemon);
    await window.call('capture.serve');
    await window.call('layout.measured', { boxes: [], expanded: [] });
    const mine = 'mine now, and a long story of my own';
    let edited: Promise<unknown> | undefined;
    window.onEvent((event: DaemonEvent) => {
      if (edited !== undefined || event.type !== 'item.updated' || event.item.kind !== 'agent-note' || !String(event.item.data.text).includes('a long story')) return;
      edited = window.call('item.update', { id: event.item.id, data: { text: mine, editedByUser: true } }).then((item) => {
        const box = { x: item.x, y: item.y, width: item.width, height: item.height };
        return window.call('layout.measured', { boxes: [{ key: `item:${item.id}`, saved: box, drawn: box, fits: { height: 480, text: measuredText(mine) } }], expanded: [] });
      });
    });
    await me.connection.call('orchestrator.setStatus', { token: me.token, sessionId: impl.sessionId, summary: 'a long story' });
    await expect(me.connection.call('orchestrator.arrange', { token: me.token })).rejects.toThrow(/over other/);
    expect(edited).toBeDefined();
    const note = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note')!;
    expect(note.data).toMatchObject({ text: mine, editedByUser: true });
  });

  /**
   * An arrange that writes 'a long story' into a lane's note first, then is refused for growing its zone over another.
   * Once the note says it, the app's window gives it the height `resize` asks for (at the width the arrange measures it
   * at, so the measure holds) and measures its new text `FIT` tall. The note as it was, and as the refusal left it.
   */
  const FIT = 400;
  async function refusedWhileResized(resize: (height: number) => number) {
    const setup = await measuredDaemon({ measureWaitMs: 300 });
    const { me, impl } = await arrangedCrew(setup);
    await setup.client.call('zone.update', { id: setup.other.id, x: 0, y: 610, width: 1200, height: 400 });
    const noteOf = async () => (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note')!;
    const before = await noteOf();
    const window = await connectTestClient(setup.daemon);
    await window.call('capture.serve');
    await window.call('layout.measured', { boxes: [], expanded: [] });
    let resized: number | undefined;
    window.onEvent((event: DaemonEvent) => {
      if (resized !== undefined || event.type !== 'item.updated' || event.item.kind !== 'agent-note' || !String(event.item.data.text).includes('a long story')) return;
      const { id, height, data } = event.item;
      resized = resize(height);
      void window.call('item.update', { id, height: resized }).then((item) => {
        const box = { x: item.x, y: item.y, width: item.width, height: item.height };
        return window.call('layout.measured', { boxes: [{ key: `item:${item.id}`, saved: box, drawn: box, fits: { height: FIT, text: measuredText(String(data.text)) } }], expanded: [] });
      });
    });
    await me.connection.call('orchestrator.setStatus', { token: me.token, sessionId: impl.sessionId, summary: 'a long story' });
    await expect(me.connection.call('orchestrator.arrange', { token: me.token })).rejects.toThrow(/over other/);
    expect(resized).toBeDefined();
    return { before, after: await noteOf(), resized: resized! };
  }

  it('puts back what a note said, but keeps a height the user gave it while the arrange waited, when the arrange is refused', async () => {
    // Taller than its new text needs: the user's doing.
    const { before, after, resized } = await refusedWhileResized(() => FIT + 120);
    expect({ text: after.data.text, width: after.width, height: after.height }).toEqual({ text: before.data.text, width: before.width, height: resized });
  });

  it('keeps the size and the mark of a note the user dragged while the arrange waited, when the arrange is refused', async () => {
    const setup = await measuredDaemon({ measureWaitMs: 300 });
    const { me, impl } = await arrangedCrew(setup);
    await setup.client.call('zone.update', { id: setup.other.id, x: 0, y: 610, width: 1200, height: 400 });
    const noteOf = async () => (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note')!;
    const window = await connectTestClient(setup.daemon);
    await window.call('capture.serve');
    await window.call('layout.measured', { boxes: [], expanded: [] });
    let dragged = false;
    window.onEvent((event: DaemonEvent) => {
      if (dragged || event.type !== 'item.updated' || event.item.kind !== 'agent-note' || !String(event.item.data.text).includes('a long story')) return;
      dragged = true;
      // Dragged to just the height the window measures the text at, as the app saves it: it looks like the board's own growing.
      void window.call('item.update', { id: event.item.id, height: FIT, data: { userSized: true } }).then((item) => {
        const box = { x: item.x, y: item.y, width: item.width, height: item.height };
        return window.call('layout.measured', { boxes: [{ key: `item:${item.id}`, saved: box, drawn: box, fits: { height: FIT, text: measuredText(String(item.data.text)) } }], expanded: [] });
      });
    });
    await me.connection.call('orchestrator.setStatus', { token: me.token, sessionId: impl.sessionId, summary: 'a long story' });
    await expect(me.connection.call('orchestrator.arrange', { token: me.token })).rejects.toThrow(/over other/);
    expect(dragged).toBe(true);
    expect(await noteOf()).toMatchObject({ height: FIT, data: { userSized: true } });
  });

  it('puts back the size of a note the app grew to fit the text the arrange wrote, when the arrange is refused', async () => {
    // As the window in front grows a note to show its text whole: just as tall as it measures that text at.
    const { before, after } = await refusedWhileResized(() => FIT);
    expect({ text: after.data.text, width: after.width, height: after.height }).toEqual({ text: before.data.text, width: before.width, height: before.height });
  });

  it("doesn't wait for a window that says it is away, and says the arrange is unmeasured", async () => {
    const setup = await measuredDaemon({ measureWaitMs: 60_000 });
    const { me, impl } = await arrangedCrew(setup);
    const window = await app(setup, () => 200);
    await window.leave();
    await me.connection.call('orchestrator.setStatus', { token: me.token, sessionId: impl.sessionId, summary: 'Fixing the review' });
    const started = Date.now();
    const result = await me.connection.call('orchestrator.arrange', { token: me.token });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.unmeasured).toBe(true);
  });

  it('puts what is placed near an expanded tile beside it where the app draws it, not where it is saved', async () => {
    const setup = await measuredDaemon();
    const me = await lead(setup, setup.zone.id);
    await setup.client.call('zone.update', { id: setup.other.id, x: 6000, y: 0, width: 600, height: 400 });
    await setup.client.call('zone.update', { id: setup.zone.id, x: 0, y: 0, width: 2800, height: 1000 });
    const saved = { x: 100, y: 100, ...AGENT_TILE_SIZE };
    await setup.client.call('agent.move', { sessionId: me.agent.sessionId, zoneId: setup.zone.id, x: saved.x, y: saved.y });
    const open = { width: 960, height: 600 };
    await setup.client.call('view.set', { key: 'expandedTiles', value: [{ id: key(me.agent), ...open }] });
    // The board draws it at the zone's right, clear of something it may not cover: not where it is saved.
    const drawn = { x: 1600, y: 100, ...open };
    const window = await app(setup);
    await window.report([{ key: key(me.agent), saved: { ...saved, ...open }, drawn }], [{ key: key(me.agent), ...saved, ...open }]);

    const near = { kind: 'agent' as const, id: me.agent.sessionId };
    const diagram = await me.connection.call('orchestrator.addDiagram', { token: me.token, mermaid: 'flowchart LR\n  A --> B', near, side: 'right' });
    for (const shape of diagram.items) expect(shape.x).toBeGreaterThanOrEqual(drawn.x + drawn.width);
    const note = await me.connection.call('orchestrator.addNote', { token: me.token, text: 'beside it', near, side: 'below' });
    expect(note).toMatchObject({ x: drawn.x });
    expect(note.y).toBeGreaterThanOrEqual(drawn.y + drawn.height);
  });

  it("moves its cluster's note off an expanded tile beside where the app draws the tile, when a note is added near it", async () => {
    const setup = await measuredDaemon();
    await setup.client.call('zone.update', { id: setup.other.id, x: 6000, y: 0, width: 600, height: 400 });
    await setup.client.call('zone.update', { id: setup.zone.id, x: 0, y: 0, width: 2800, height: 1000 });
    const { me, impl } = await arrangedCrew(setup);
    const open = { width: 960, height: 600 };
    await setup.client.call('view.set', { key: 'expandedTiles', value: [{ id: key(impl), ...open }] });
    const implAt = (await me.connection.call('orchestrator.map', { token: me.token })).things.find((thing) => thing.key === key(impl))!;
    const saved = { x: implAt.x, y: implAt.y, ...open };
    // Drawn at the zone's right, its cluster's note under it there, clear of where it is saved.
    const drawn = { x: 1600, y: 100, ...open };
    const sticky = (await setup.client.call('item.list')).find((item) => item.kind === 'agent-note' && item.data.members !== undefined)!;
    await setup.client.call('item.update', { id: sticky.id, x: 1700, y: 200 });
    const window = await app(setup);
    await window.report([{ key: key(impl), saved, drawn }], [{ key: key(impl), ...saved }]);

    const note = await me.connection.call('orchestrator.addNote', { token: me.token, text: 'Waiting on review', near: { kind: 'agent', id: impl.sessionId } });
    expect(note.id).toBe(sticky.id);
    expect(note.x).toBeGreaterThanOrEqual(drawn.x + drawn.width);
  });

  it('takes boxes from the app only, and refuses a malformed one', async () => {
    const setup = await measuredDaemon();
    const { me } = await arrangedCrew(setup);
    await expect(me.connection.call('layout.measured', { boxes: [], expanded: [] })).rejects.toThrow(/not open to a session's board token/);
    // Only the app's connection, the one that serves captures, may say how the board is drawn.
    await expect(setup.client.call('layout.measured', { boxes: [], expanded: [] })).rejects.toThrow(/only the app's window/);
    expect((await me.connection.call('orchestrator.map', { token: me.token })).unmeasured).toBe(true);
    const { client } = await app(setup);
    const box = { x: 0, y: 0, width: 10, height: 10 };
    for (const params of [
      { boxes: [{ key: 'agent:x', saved: box }], expanded: [] },
      { boxes: [{ key: 'agent:x', saved: box, drawn: { ...box, width: Number.NaN } }], expanded: [] },
      { boxes: [{ key: 7, saved: box, drawn: box }], expanded: [] },
      { boxes: 'all', expanded: [] },
      { boxes: [], expanded: [{ key: 'agent:x', x: 0 }] },
      { boxes: [], expanded: [], away: 'yes' },
    ]) {
      await expect(client.call('layout.measured', params as never)).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    }
  });
});
