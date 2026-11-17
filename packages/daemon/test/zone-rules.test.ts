import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import type { DaemonClient } from '../src/client.ts';
import { agentNoteData } from '../src/agent-notes.ts';
import { AGENT_TILE_SIZE, SPACING_GAPS } from '../src/board-layout.ts';
import { migrate } from '../src/migrate.ts';
import { daemonPaths } from '../src/paths.ts';
import type { DaemonCall } from '../src/protocol.ts';
import { zoneSnapshot, type Agent, type BoardItem, type FlowEdge, type Shell, type Zone } from '../src/protocol.ts';
import { createZoneRules, RULE_SETTLE_MS, zonesChangedBy, type RuleInputs } from '../src/zone-rules.ts';
import { createZoneTable } from '../src/zones.ts';
import { createFakeClock } from './fake-clock.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

// A zone's layout rule, kept: what sets a zone off to be laid out again, the engine that does it, and the rule on a
// real daemon.

const zone = (fields: Partial<Zone> = {}) => ({ id: 'z1', name: 'web', layoutRule: 'lanes', layoutMode: 'free', spacing: 'normal', width: 1200, folded: false, handPlaced: [], free: [], ...fields }) as Zone;
const agent = (fields: Partial<Agent> = {}) =>
  ({ sessionId: 's1', name: 'impl', zoneId: 'z1', issue: null, role: null, reviewOf: null, reviews: null, spawnedBy: null, orphanedFrom: null, ticket: null, ticketChat: false, branch: '', endedAt: null, state: 'idle', shellSessionId: null, shellHarness: null, position: { x: 0, y: 0 }, ...fields }) as Agent;

describe('what sets a zone off to be laid out by its rule again', () => {
  it('is a tile coming, going or changing what its lane depends on, never its place or its state', () => {
    const inputs: RuleInputs = new Map();
    expect(zonesChangedBy({ type: 'agent.updated', agent: agent() }, inputs)).toEqual(['z1']);
    // Moved, or busy: nothing a rule lays out by.
    expect(zonesChangedBy({ type: 'agent.updated', agent: agent({ position: { x: 400, y: 300, z: 1 }, state: 'running' }) }, inputs)).toEqual([]);
    expect(zonesChangedBy({ type: 'agent.updated', agent: agent({ issue: { id: 'ENG-1' } as Agent['issue'] }) }, inputs)).toEqual(['z1']);
    // Moved to another zone: both are laid out again.
    expect(zonesChangedBy({ type: 'agent.updated', agent: agent({ issue: { id: 'ENG-1' } as Agent['issue'], zoneId: 'z2' }) }, inputs)).toEqual(['z1', 'z2']);
    // Closed, it takes a chip's room.
    expect(zonesChangedBy({ type: 'agent.updated', agent: agent({ issue: { id: 'ENG-1' } as Agent['issue'], zoneId: 'z2', endedAt: '2026-11-12T09:00:00Z', state: 'done' }) }, inputs)).toEqual(['z2']);
    expect(zonesChangedBy({ type: 'agent.removed', sessionId: 's1' }, inputs)).toEqual(['z2']);
    // One it never heard of may have been in any zone.
    expect(zonesChangedBy({ type: 'agent.removed', sessionId: 'gone' }, inputs)).toBe('all');
  });

  it("is, in a Spine zone, a move of an agent the user started (a drop may let it join), never of one an agent started", () => {
    const inputs: RuleInputs = new Map();
    const spines = new Set(['z1']);
    expect(zonesChangedBy({ type: 'agent.updated', agent: agent() }, inputs, spines)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'agent.updated', agent: agent({ position: { x: 400, y: 300, z: 1 } }) }, inputs, spines)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'agent.updated', agent: agent({ position: { x: 400, y: 300, z: 2 }, state: 'running' }) }, inputs, spines)).toEqual([]);
    const crew = agent({ sessionId: 's2', spawnedBy: 's1' });
    expect(zonesChangedBy({ type: 'agent.updated', agent: crew }, inputs, spines)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'agent.updated', agent: { ...crew, position: { x: 400, y: 300, z: 1 } } }, inputs, spines)).toEqual([]);
    // On a Done line, with its shell left on the tile: resumed, or busy again, it may have to come back.
    const folded = new Set(['agent:s2']);
    const shelled = { ...crew, position: { x: 400, y: 300, z: 1 }, shellSessionId: 'sh1', shellHarness: 'claude', endedAt: '2026-11-12T09:00:00Z', state: 'done' } as Agent;
    expect(zonesChangedBy({ type: 'agent.updated', agent: shelled }, inputs, spines)).toEqual([]);
    expect(zonesChangedBy({ type: 'agent.updated', agent: shelled }, inputs, spines, folded)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'agent.updated', agent: { ...shelled, endedAt: null, state: 'idle' } }, inputs, spines, folded)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'agent.updated', agent: { ...shelled, endedAt: null, state: 'running' } }, inputs, spines, folded)).toEqual(['z1']);
    // Back at its prompt, then flagging the user from there: it needs them, so it may have to come back too.
    expect(zonesChangedBy({ type: 'agent.updated', agent: { ...shelled, endedAt: null, state: 'idle' } }, inputs, spines, folded)).toEqual(['z1']);
    const flag = { id: 1, reason: 'read this', at: '2026-11-15T10:00:00.000Z', to: 'user' as const, via: null };
    expect(zonesChangedBy({ type: 'agent.updated', agent: { ...shelled, endedAt: null, state: 'idle', flag } }, inputs, spines, folded)).toEqual(['z1']);
    // Busy off the Done line: nothing.
    expect(zonesChangedBy({ type: 'agent.updated', agent: { ...shelled, endedAt: null, state: 'idle' } }, inputs, spines)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'agent.updated', agent: { ...shelled, endedAt: null, state: 'running' } }, inputs, spines)).toEqual([]);
    // Off Spine, the user's agent's move sets nothing off either.
    expect(zonesChangedBy({ type: 'agent.updated', agent: agent({ position: { x: 90, y: 90, z: 1 } }) }, inputs)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'agent.updated', agent: agent({ position: { x: 10, y: 10, z: 1 } }) }, inputs)).toEqual([]);
  });

  it('is a zone changing its rule, width, folding or tiles placed by hand, never its place or height', () => {
    const inputs: RuleInputs = new Map();
    expect(zonesChangedBy({ type: 'zone.updated', zone: zone() }, inputs)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'zone.updated', zone: zone({ x: 500, y: 90, height: 2000 }) }, inputs)).toEqual([]);
    expect(zonesChangedBy({ type: 'zone.updated', zone: zone({ folded: true }) }, inputs)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'zone.updated', zone: zone({ folded: true, handPlaced: ['agent:s1'] }) }, inputs)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'zone.updated', zone: zone({ folded: true, handPlaced: ['agent:s1'], width: 900 }) }, inputs)).toEqual(['z1']);
  });

  it('is a stage board coming, going, moving, resizing or changing who it holds; never another note', () => {
    const inputs: RuleInputs = new Map();
    const board = { id: 'b1', kind: 'stages', zoneId: 'z1', x: 0, y: 0, width: 600, height: 92, rotation: 0, data: { joined: [], left: [] } } as unknown as BoardItem;
    expect(zonesChangedBy({ type: 'item.updated', item: board }, inputs)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'item.updated', item: board }, inputs)).toEqual([]);
    expect(zonesChangedBy({ type: 'item.updated', item: { ...board, height: 300 } }, inputs)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'item.updated', item: { ...board, height: 300, x: 50 } }, inputs)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'item.updated', item: { ...board, height: 300, x: 50, data: { joined: ['s1'], left: [] } } }, inputs)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'item.removed', id: 'b1', ticket: null }, inputs)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'item.updated', item: { ...board, id: 'n1', kind: 'sticky' } as BoardItem }, inputs)).toEqual([]);
  });

  it("is an edge between agents joined or cut, a shell or clock coming or going; never a shell in an agent's tile or a note", () => {
    const inputs: RuleInputs = new Map();
    const edge = { id: 'e1', from: 's1', to: 's2' } as FlowEdge;
    expect(zonesChangedBy({ type: 'flowEdge.updated', edge }, inputs)).toBe('all');
    expect(zonesChangedBy({ type: 'flowEdge.updated', edge: { ...edge, checks: [] } }, inputs)).toEqual([]);
    expect(zonesChangedBy({ type: 'flowEdge.removed', id: 'e1' }, inputs)).toBe('all');
    expect(zonesChangedBy({ type: 'flowEdge.removed', id: 'e1' }, inputs)).toEqual([]);

    const shell = { id: 'sh1', name: 'tests', zoneId: 'z1', owner: null } as unknown as Shell;
    expect(zonesChangedBy({ type: 'shell.updated', shell }, inputs)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'shell.updated', shell: { ...shell, id: 'tab', owner: { kind: 'agent', id: 's1' } } as unknown as Shell }, inputs)).toEqual([]);
    expect(zonesChangedBy({ type: 'shell.removed', shellId: 'sh1' }, inputs)).toEqual(['z1']);

    const clock = { id: 'c1', kind: 'clock', zoneId: 'z1', width: 240, height: 120, rotation: 0, x: 0, y: 0 } as unknown as BoardItem;
    expect(zonesChangedBy({ type: 'item.updated', item: clock }, inputs)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'item.updated', item: { ...clock, x: 300 } }, inputs)).toEqual([]);
    expect(zonesChangedBy({ type: 'item.updated', item: { ...clock, id: 'n1', kind: 'sticky' } }, inputs)).toEqual([]);
    expect(zonesChangedBy({ type: 'item.removed', id: 'n1', ticket: null }, inputs)).toEqual([]);
    expect(zonesChangedBy({ type: 'item.removed', id: 'c1', ticket: null }, inputs)).toEqual(['z1']);
  });
});

describe('the rules engine', () => {
  function engine(zones: Zone[]) {
    const clock = createFakeClock(new Date('2026-11-12T09:00:00Z'));
    const followed: string[] = [];
    const call = (async (method: string, params: { id?: string }) => {
      if (method === 'zone.list') return zones;
      if (method === 'zone.followRule') {
        followed.push(params.id!);
        if (params.id === 'broken') throw new Error('no room');
        return zones.find((each) => each.id === params.id);
      }
      return [];
    }) as unknown as DaemonCall;
    const log = vi.fn();
    const zonesTable = { tileSeen: vi.fn() };
    return { rules: createZoneRules({ call, zones: zonesTable, clock, log }), clock, followed, log, zonesTable };
  }
  const settle = async (clock: ReturnType<typeof createFakeClock>) => {
    clock.advance(RULE_SETTLE_MS);
    await vi.waitFor(() => expect(clock.pending()).toBe(0));
    await new Promise((resolve) => setImmediate(resolve));
  };

  it('lays out each zone with a rule once on start, then a zone once after a burst of changes in it', async () => {
    const zones = [zone(), zone({ id: 'z2', layoutRule: 'off' }), zone({ id: 'z3', folded: true })];
    const { rules, clock, followed } = engine(zones);
    await rules.start();
    await settle(clock);
    // Off is laid out as its tiles are put; a folded zone waits to be unfolded.
    expect(followed).toEqual(['z1']);

    followed.length = 0;
    rules.onEvent({ type: 'agent.updated', agent: agent({ sessionId: 'new' }) });
    clock.advance(RULE_SETTLE_MS - 10);
    rules.onEvent({ type: 'agent.updated', agent: agent({ sessionId: 'other' }) });
    clock.advance(RULE_SETTLE_MS - 10);
    expect(followed).toEqual([]);
    await settle(clock);
    expect(followed).toEqual(['z1']);

    // Its own moves set nothing off.
    followed.length = 0;
    rules.onEvent({ type: 'agent.updated', agent: agent({ sessionId: 'new', position: { x: 300, y: 40, z: 1 } }) });
    await settle(clock);
    expect(followed).toEqual([]);
  });

  it('tells the zones where each tile is, however it got there, so a mark left in another zone goes', () => {
    const { rules, zonesTable } = engine([zone()]);
    // Before it starts too: a tile that leaves its zone loses its mark there whether or not the rules are laying out.
    rules.onEvent({ type: 'agent.updated', agent: agent({ sessionId: 'a', zoneId: 'z2' }) });
    rules.onEvent({ type: 'agent.removed', sessionId: 'b' });
    rules.onEvent({ type: 'shell.updated', shell: { id: 's', zoneId: null, owner: null } as unknown as Shell });
    rules.onEvent({ type: 'shell.updated', shell: { id: 't', zoneId: 'z1', owner: 'a' } as unknown as Shell });
    rules.onEvent({ type: 'shell.removed', shellId: 'u' });
    expect(zonesTable.tileSeen.mock.calls).toEqual([
      ['agent:a', 'z2'],
      ['agent:b', undefined],
      ['shell:s', null],
      ['shell:t', undefined],
      ['shell:u', undefined],
    ]);
  });

  it('lays out a folded zone once it is unfolded, and only logs a zone it could not', async () => {
    const zones = [zone({ folded: true }), zone({ id: 'broken', name: 'tight' })];
    const { rules, clock, followed, log } = engine(zones);
    await rules.start();
    await settle(clock);
    expect(followed).toEqual(['broken']);
    expect(log).toHaveBeenCalledWith('could not lay out tight by its rule: no room');

    followed.length = 0;
    zones[0] = zone({ folded: false });
    rules.onEvent({ type: 'zone.updated', zone: zones[0] });
    await settle(clock);
    expect(followed).toEqual(['z1']);
  });
});

describe('a zone with a rule, on the daemon', () => {
  const SIZE = { cols: 120, rows: 40 };
  async function ruleDaemon() {
    const dataDir = tempDataDir();
    const daemon = await startTestDaemon({ dataDir, worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'waiting', home: tempDataDir() }) });
    const client = await connectTestClient(daemon);
    await client.call('settings.set', { arrangeSpacing: 'normal' });
    const web = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, width: 1200, height: 600, name: 'web' });
    const startedByAnAgent = (sessionId: string) => {
      // As the daemon marks an agent an orchestrator started: the rule lays it out (it leaves the user's own where they are).
      const db = new DatabaseSync(daemonPaths(dataDir).database);
      db.prepare("UPDATE agents SET spawned_by = 'an-orchestrator' WHERE session_id = ?").run(sessionId);
      db.close();
    };
    return { client, web, startedByAnAgent };
  }
  const placeOf = async (client: DaemonClient, sessionId: string) => (await client.call('agent.list')).find((each) => each.sessionId === sessionId)?.position;
  const zoneOf = async (client: DaemonClient, id: string) => (await client.call('zone.list')).find((each) => each.id === id)!;

  it('keeps the rule apart from the views, and through a snapshot', async () => {
    const { client, web } = await ruleDaemon();
    expect(web).toMatchObject({ layoutRule: 'off', layoutMode: 'free', handPlaced: [], free: [] });
    await client.call('zone.configure', { id: web.id, layoutMode: 'shelves' });
    // A rule sets the zone free of its view; a view sets the rule off.
    expect(await client.call('zone.configure', { id: web.id, layoutRule: 'lanes' })).toMatchObject({ layoutRule: 'lanes', layoutMode: 'free' });
    expect(await client.call('zone.configure', { id: web.id, layoutMode: 'clusters' })).toMatchObject({ layoutRule: 'off', layoutMode: 'clusters' });
    await expect(client.call('zone.configure', { id: web.id, layoutRule: 'lanes', layoutMode: 'shelves' })).rejects.toThrow(/a layout rule or a shelves view, not both/);
    await expect(client.call('zone.configure', { id: web.id, layoutRule: 'status' as never })).rejects.toThrow(/layoutRule must be one of off, lanes, spine/);

    const ruled = await client.call('zone.configure', { id: web.id, layoutRule: 'lanes' });
    expect(zoneSnapshot(ruled)).toMatchObject({ layoutRule: 'lanes' });
    // The rule's own arrange may make its lanes' labels; the zone is removed and restored without them in the way.
    for (const item of await client.call('item.list')) await client.call('item.delete', { id: item.id });
    await client.call('zone.remove', { id: web.id });
    expect(await client.call('zone.restore', { ...zoneSnapshot(ruled), id: 'web-again' })).toMatchObject({ layoutRule: 'lanes', layoutMode: 'free' });
    // A snapshot from before zones kept a rule has none.
    const older: Partial<ReturnType<typeof zoneSnapshot>> = { ...zoneSnapshot(ruled), id: 'web-older' };
    delete older.layoutRule;
    expect(await client.call('zone.restore', older as ReturnType<typeof zoneSnapshot>)).toMatchObject({ layoutRule: 'off' });
  });

  it("lays a new agent out in its lane, leaves one dragged there, and puts it back under the rule when asked", async () => {
    const { client, web } = await ruleDaemon();
    const first = await client.call('agent.spawn', { zoneId: web.id, name: 'impl', ...SIZE });
    await client.call('agent.move', { sessionId: first.sessionId, zoneId: web.id, x: 900, y: 420 });
    await client.call('zone.configure', { id: web.id, layoutRule: 'lanes' });
    // Laid out by the rule: its place is the rule's, so laying it out again moves nothing.
    await vi.waitFor(async () => expect(await placeOf(client, first.sessionId)).not.toMatchObject({ x: 900, y: 420 }), { timeout: 5000 });
    const lane = await placeOf(client, first.sessionId);
    const second = await client.call('agent.spawn', { zoneId: web.id, name: 'docs', ...SIZE });
    await vi.waitFor(async () => {
      expect((await client.call('orchestrator.arrange', { zoneId: web.id })).moved).toEqual([]);
      expect(await placeOf(client, first.sessionId)).toEqual(lane);
    }, { timeout: 5000 });

    // Dragged, it stays where it was put, and the rule leaves it there.
    await client.call('agent.move', { sessionId: second.sessionId, zoneId: web.id, x: 700, y: 480, byHand: true });
    expect((await zoneOf(client, web.id)).handPlaced).toEqual([`agent:${second.sessionId}`]);
    await client.call('agent.spawn', { zoneId: web.id, name: 'tests', ...SIZE });
    await vi.waitFor(async () => expect((await client.call('orchestrator.arrange', { zoneId: web.id })).moved).toEqual([]), { timeout: 5000 });
    expect(await placeOf(client, second.sessionId)).toMatchObject({ x: 700, y: 480 });
    // A move that isn't the user's keeps it placed by hand; another zone, and it isn't.
    await client.call('agent.move', { sessionId: second.sessionId, zoneId: web.id, x: 720, y: 480 });
    expect((await zoneOf(client, web.id)).handPlaced).toEqual([`agent:${second.sessionId}`]);

    // Put back, it is laid out with the rest.
    const back = await client.call('zone.followRule', { id: web.id, tiles: [`agent:${second.sessionId}`] });
    expect(back.handPlaced).toEqual([]);
    expect(await placeOf(client, second.sessionId)).not.toMatchObject({ x: 720, y: 480 });

    // Another way to arrange it is refused while it keeps the rule; free, the rule and its marks go.
    await expect(client.call('orchestrator.arrange', { zoneId: web.id, layout: 'grid' })).rejects.toThrow(/web keeps the Lanes rule: set it free first \(zone layout free\) to arrange it another way/);
    await client.call('agent.move', { sessionId: second.sessionId, zoneId: web.id, x: 700, y: 480, byHand: true });
    const free = await client.call('orchestrator.zoneLayout', { zoneId: web.id, mode: 'free' });
    expect(free).toMatchObject({ layoutRule: 'off', layoutMode: 'free', handPlaced: [], free: [] });
    await expect(client.call('zone.followRule', { id: web.id, tiles: [] })).rejects.toThrow(/web keeps no layout rule/);
    // Off, a drag marks nothing.
    await client.call('agent.move', { sessionId: first.sessionId, zoneId: web.id, x: 40, y: 480, byHand: true });
    expect((await zoneOf(client, web.id)).handPlaced).toEqual([]);
  });

  /** The rule's lines in the activity log. */
  const ruleLines = async (client: DaemonClient) => (await client.call('orchestrator.activity', {})).filter((line) => line.orchestratorName === 'the rule');

  it('keeps the size the user gives a ruled zone, laying it out once for it, and logs only the passes that moved something', async () => {
    const { client, web } = await ruleDaemon();
    const first = await client.call('agent.spawn', { zoneId: web.id, name: 'impl', ...SIZE });
    await client.call('agent.move', { sessionId: first.sessionId, zoneId: web.id, x: 900, y: 420 });
    await client.call('zone.configure', { id: web.id, layoutRule: 'lanes' });
    await vi.waitFor(async () => expect(await placeOf(client, first.sessionId)).not.toMatchObject({ x: 900, y: 420 }), { timeout: 5000 });
    // Laid out, a pass more moves nothing, and writes no line.
    await vi.waitFor(async () => expect(await ruleLines(client)).toHaveLength(1), { timeout: 5000 });
    await client.call('zone.followRule', { id: web.id, tiles: [] });
    expect(await ruleLines(client)).toHaveLength(1);
    // The zone keeps the size it had: the rule grows a zone to fit, never shrinks one.
    expect(await zoneOf(client, web.id)).toMatchObject({ width: 1200, height: 600 });

    const events = recordEvents(client);
    const resized = { id: web.id, x: 0, y: 0, width: 3000, height: 1500 };
    await client.call('zone.update', resized);
    await new Promise((resolve) => setTimeout(resolve, RULE_SETTLE_MS * 4));
    expect(await zoneOf(client, web.id)).toMatchObject({ width: 3000, height: 1500 });
    // Only the user's resize changed the zone: the pass it set off moved nothing and resized nothing, so set off no other.
    const zoneChanges = events.events.filter((event) => event.type === 'zone.updated' && event.zone.id === web.id);
    expect(zoneChanges.map((event) => (event as { zone: Zone }).zone.width)).toEqual([3000]);
    expect(await ruleLines(client)).toHaveLength(1);
  });

  it('lays a Spine zone out as bands in a column, hugging them; keeps each band where it went until a Tidy', async () => {
    const { client, web, startedByAnAgent } = await ruleDaemon();
    const first = await client.call('agent.spawn', { zoneId: web.id, name: 'impl', ...SIZE });
    const second = await client.call('agent.spawn', { zoneId: web.id, name: 'docs', ...SIZE });
    for (const { sessionId } of [first, second]) startedByAnAgent(sessionId);
    await client.call('agent.move', { sessionId: first.sessionId, zoneId: web.id, x: 900, y: 420 });
    expect(await client.call('orchestrator.zoneLayout', { zoneId: web.id, mode: 'spine' })).toMatchObject({ layoutRule: 'spine', layoutMode: 'free' });
    // Each agent a band, the first started on top; the zone shrinks to hug them.
    await vi.waitFor(async () => expect((await zoneOf(client, web.id)).width).toBeLessThan(1200), { timeout: 5000 });
    const [one, two] = [await placeOf(client, first.sessionId), await placeOf(client, second.sessionId)];
    expect(two!.x).toBe(one!.x);
    expect(two!.y).toBeGreaterThan(one!.y);
    const saved = (await client.call('view.get', { key: `spine:${web.id}` })) as { places: Record<string, { line: number; rank: number }> };
    expect(Object.values(saved.places)).toEqual([
      { line: 0, rank: 0 },
      { line: 0, rank: 1 },
    ]);
    expect((await client.call('orchestrator.arrange', { zoneId: web.id })).moved).toEqual([]);
    await expect(client.call('orchestrator.arrange', { zoneId: web.id, layout: 'grid' })).rejects.toThrow(/web keeps the Spine rule/);

    // A band that goes moves the one under it up.
    await client.call('agent.delete', { sessionId: first.sessionId, force: true });
    await vi.waitFor(async () => expect(await placeOf(client, second.sessionId)).toMatchObject({ x: one!.x, y: one!.y }), { timeout: 5000 });

    // Dragged, a tile stays where it was put; put back, it is laid out with the rest.
    await client.call('agent.move', { sessionId: second.sessionId, zoneId: web.id, x: 300, y: 200, byHand: true });
    await new Promise((resolve) => setTimeout(resolve, RULE_SETTLE_MS * 2));
    expect(await placeOf(client, second.sessionId)).toMatchObject({ x: 300, y: 200 });
    await client.call('zone.followRule', { id: web.id, tiles: [`agent:${second.sessionId}`], reflow: true });
    expect(await placeOf(client, second.sessionId)).toMatchObject({ x: one!.x, y: one!.y });
  });

  it('cleans a Spine zone up: a note to the tail of its band, a finished ticket to the Done line; and puts it all back', async () => {
    const { client, web, startedByAnAgent } = await ruleDaemon();
    const impl = await client.call('agent.spawn', { zoneId: web.id, name: 'impl', ...SIZE });
    const docs = await client.call('agent.spawn', { zoneId: web.id, name: 'docs', ...SIZE });
    for (const { sessionId } of [impl, docs]) startedByAnAgent(sessionId);
    await client.call('orchestrator.zoneLayout', { zoneId: web.id, mode: 'spine' });
    const author = { sessionId: impl.sessionId, name: 'impl', harness: 'claude' as const, role: null };
    const note = await client.call('item.create', { kind: 'agent-note', zoneId: web.id, x: 900, y: 420, width: 240, height: 100, data: { ...agentNoteData(author, 'The plan') } });
    const sticky = await client.call('item.create', { kind: 'sticky', zoneId: web.id, x: 700, y: 40, width: 200, height: 200, data: { text: 'mine', color: '#fff3a3' } });
    await client.call('agent.stop', { sessionId: docs.sessionId });
    await vi.waitFor(async () => expect((await client.call('agent.list')).find((each) => each.sessionId === docs.sessionId)).toMatchObject({ state: 'done' }), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, RULE_SETTLE_MS * 2));
    const one = (await placeOf(client, impl.sessionId))!;
    const before = (await placeOf(client, docs.sessionId))!;

    const cleaned = await client.call('zone.cleanUp', { id: web.id });
    expect(cleaned).toMatchObject({ done: 1 });
    expect(cleaned.moved).toBeGreaterThan(0);
    const items = async () => new Map((await client.call('item.list')).map((item) => [item.id, item]));
    const after = await items();
    // The note stands at the tail of its agent's band, beside its tile; the sticky, the user's, stays where it was.
    expect(after.get(note.id)).toMatchObject({ x: one.x + AGENT_TILE_SIZE.width + SPACING_GAPS.normal.tile, y: one.y, data: { gatheredTo: `agent:${impl.sessionId}` } });
    expect(after.get(sticky.id)).toMatchObject({ x: 700, y: 40 });
    const line = [...after.values()].find((item) => item.kind === 'done-line')!;
    expect(line.data).toMatchObject({ tickets: [{ title: 'docs', members: [`agent:${docs.sessionId}`], notes: [] }] });
    // The finished agent waits behind the Done line, under the bands.
    expect(await placeOf(client, docs.sessionId)).toMatchObject({ x: line.x, y: line.y });
    expect(line.y).toBeGreaterThan(one.y);
    await expect(client.call('zone.cleanUp', { id: 'nope' })).rejects.toThrow(/no zone nope/);

    await client.call('zone.undoCleanUp', { id: web.id, undo: cleaned.undo });
    const undone = await items();
    expect(undone.get(note.id)).toMatchObject({ x: 900, y: 420, data: { gatheredTo: null } });
    expect([...undone.values()].some((item) => item.kind === 'done-line')).toBe(false);
    expect(await placeOf(client, docs.sessionId)).toMatchObject({ x: before.x, y: before.y });
  });

  it('puts a ticket on the Done line back by itself once one of its agents runs again', async () => {
    const { client, web, startedByAnAgent } = await ruleDaemon();
    const impl = await client.call('agent.spawn', { zoneId: web.id, name: 'impl', ...SIZE });
    const docs = await client.call('agent.spawn', { zoneId: web.id, name: 'docs', ...SIZE });
    for (const { sessionId } of [impl, docs]) startedByAnAgent(sessionId);
    await client.call('orchestrator.zoneLayout', { zoneId: web.id, mode: 'spine' });
    await client.call('agent.stop', { sessionId: docs.sessionId });
    await vi.waitFor(async () => expect((await client.call('agent.list')).find((each) => each.sessionId === docs.sessionId)).toMatchObject({ state: 'done' }), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, RULE_SETTLE_MS * 2));
    await client.call('zone.cleanUp', { id: web.id });
    const line = (await client.call('item.list')).find((item) => item.kind === 'done-line')!;
    expect(await placeOf(client, docs.sessionId)).toMatchObject({ x: line.x, y: line.y });

    await client.call('agent.resume', { sessionId: docs.sessionId });
    // Live again, it isn't hidden: off the Done line, which goes with nothing left on it, and laid out with the rest.
    await vi.waitFor(async () => expect((await client.call('item.list')).some((item) => item.kind === 'done-line')).toBe(false), { timeout: 5000 });
    const one = (await placeOf(client, impl.sessionId))!;
    await vi.waitFor(async () => expect((await placeOf(client, docs.sessionId))!.y).toBeGreaterThan(one.y), { timeout: 5000 });
    expect(await placeOf(client, docs.sessionId)).toMatchObject({ x: one.x });
  });

  it('refuses to clean up a zone not laid out by Spine', async () => {
    const { client, web } = await ruleDaemon();
    await expect(client.call('zone.cleanUp', { id: web.id })).rejects.toThrow(/web isn't laid out by Spine/);
  });

  it('puts a ticket on the Done line back on the board', async () => {
    const { client, web, startedByAnAgent } = await ruleDaemon();
    const impl = await client.call('agent.spawn', { zoneId: web.id, name: 'impl', ...SIZE });
    startedByAnAgent(impl.sessionId);
    await client.call('orchestrator.zoneLayout', { zoneId: web.id, mode: 'spine' });
    await client.call('agent.stop', { sessionId: impl.sessionId });
    await vi.waitFor(async () => expect((await client.call('agent.list')).find((each) => each.sessionId === impl.sessionId)).toMatchObject({ state: 'done' }), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, RULE_SETTLE_MS * 2));
    const laid = (await placeOf(client, impl.sessionId))!;
    await client.call('zone.cleanUp', { id: web.id });
    await client.call('zone.putBackDone', { id: web.id, key: `agent:${impl.sessionId}` });
    expect((await client.call('item.list')).some((item) => item.kind === 'done-line')).toBe(false);
    expect(await placeOf(client, impl.sessionId)).toMatchObject({ x: laid.x, y: laid.y });
    await expect(client.call('zone.putBackDone', { id: web.id, key: 'agent:gone' })).rejects.toThrow(/Done line has no agent:gone/);

    // Put back, it is kept out: the next Clean up leaves it on the board, until the user moves it to Done by hand.
    expect(await client.call('zone.cleanUp', { id: web.id })).toMatchObject({ done: 0 });
    expect((await client.call('item.list')).some((item) => item.kind === 'done-line')).toBe(false);
    const moved = await client.call('zone.moveToDone', { id: web.id, sessionId: impl.sessionId });
    expect(moved).toMatchObject({ done: 1 });
    const line = (await client.call('item.list')).find((item) => item.kind === 'done-line');
    expect(line?.data).toMatchObject({ tickets: [{ key: `agent:${impl.sessionId}`, members: [`agent:${impl.sessionId}`] }] });
    await expect(client.call('zone.moveToDone', { id: web.id, sessionId: impl.sessionId })).rejects.toThrow(/isn't in a band of web/);
  });

  it("puts a ticket back at the foot of the shortest column, as a new one goes, and won't move a running one to Done", async () => {
    const { client, web, startedByAnAgent } = await ruleDaemon();
    const impl = await client.call('agent.spawn', { zoneId: web.id, name: 'impl', ...SIZE });
    const docs = await client.call('agent.spawn', { zoneId: web.id, name: 'docs', ...SIZE });
    for (const { sessionId } of [impl, docs]) startedByAnAgent(sessionId);
    await client.call('orchestrator.zoneLayout', { zoneId: web.id, mode: 'spine' });
    await client.call('agent.stop', { sessionId: impl.sessionId });
    await vi.waitFor(async () => expect((await client.call('agent.list')).find((each) => each.sessionId === impl.sessionId)).toMatchObject({ state: 'done' }), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, RULE_SETTLE_MS * 2));
    const top = (await placeOf(client, impl.sessionId))!;
    await client.call('zone.cleanUp', { id: web.id });
    await vi.waitFor(async () => expect(await placeOf(client, docs.sessionId)).toMatchObject({ x: top.x, y: top.y }), { timeout: 5000 });
    await client.call('zone.putBackDone', { id: web.id, key: `agent:${impl.sessionId}` });
    // Not its old slot at the top: under docs, which took the top meanwhile.
    expect((await placeOf(client, impl.sessionId))!.y).toBeGreaterThan(top.y);
    await expect(client.call('zone.moveToDone', { id: web.id, sessionId: docs.sessionId })).rejects.toThrow(/docs's ticket isn't finished/);

    // Kept out of the next Clean up while its band is on the board; gone with the band, it is forgotten.
    const keptOut = async () => ((await client.call('view.get', { key: `spine:${web.id}` })) as { keptOut?: string[] }).keptOut;
    expect(await keptOut()).toEqual([`agent:${impl.sessionId}`]);
    await client.call('agent.delete', { sessionId: impl.sessionId, force: true });
    await vi.waitFor(async () => expect(await keptOut()).toBeUndefined(), { timeout: 5000 });
  });

  it('leaves the agents on a stage board out of the Spine, where the board draws them', async () => {
    const { client, web, startedByAnAgent } = await ruleDaemon();
    const held = await client.call('agent.spawn', { zoneId: web.id, name: 'impl', ...SIZE });
    startedByAnAgent(held.sessionId);
    await client.call('agent.move', { sessionId: held.sessionId, zoneId: web.id, x: 900, y: 420 });
    await client.call('item.create', { kind: 'stages', zoneId: web.id, x: 40, y: 40, width: 600, height: 92, data: { joined: [], left: [] } });
    await client.call('orchestrator.zoneLayout', { zoneId: web.id, mode: 'spine' });
    expect((await client.call('orchestrator.arrange', { zoneId: web.id })).moved).toEqual([]);
    expect(await placeOf(client, held.sessionId)).toMatchObject({ x: 900, y: 420 });
  });

  it('leaves the notes of the agents on a stage board out of the Spine’s way too', async () => {
    // Where the Spine puts an agent dragged off the board, with a note of a held agent there or not.
    const outPlace = async (noted: boolean) => {
      const { client, web, startedByAnAgent } = await ruleDaemon();
      const held = await client.call('agent.spawn', { zoneId: web.id, name: 'impl', ...SIZE });
      const out = await client.call('agent.spawn', { zoneId: web.id, name: 'out', ...SIZE });
      for (const each of [held, out]) startedByAnAgent(each.sessionId);
      await client.call('item.create', { kind: 'stages', zoneId: web.id, x: 40, y: 400, width: 600, height: 92, data: { joined: [], left: [out.sessionId] } });
      await client.call('orchestrator.zoneLayout', { zoneId: web.id, mode: 'spine' });
      await client.call('orchestrator.arrange', { zoneId: web.id });
      const first = (await placeOf(client, out.sessionId))!;
      if (!noted) return first;
      const agent = { sessionId: held.sessionId, name: 'impl', harness: 'claude', role: null };
      await client.call('item.create', { kind: 'agent-note', zoneId: web.id, x: first.x, y: first.y, width: 240, height: 96, data: { text: 'hi', agent, writtenAt: new Date().toISOString(), editedByUser: false, about: held.sessionId } });
      await client.call('zone.followRule', { id: web.id, tiles: [], reflow: true });
      return placeOf(client, out.sessionId);
    };
    expect(await outPlace(true)).toEqual(await outPlace(false));
  });

  it('re-packs a Spine zone in start order on a Tidy, and only then', async () => {
    const { client, web, startedByAnAgent } = await ruleDaemon();
    const spawned: string[] = [];
    for (const name of ['a', 'b', 'c', 'd']) spawned.push((await client.call('agent.spawn', { zoneId: web.id, name, ...SIZE })).sessionId);
    for (const sessionId of spawned) startedByAnAgent(sessionId);
    const [first, second, third, fourth] = spawned as [string, string, string, string];
    await client.call('orchestrator.zoneLayout', { zoneId: web.id, mode: 'spine' });
    // Three bands fill the first column; the fourth starts the next.
    await vi.waitFor(async () => expect((await placeOf(client, fourth))!.x).toBeGreaterThan((await placeOf(client, first))!.x), { timeout: 5000 });
    const top = (await placeOf(client, first))!;
    const next = (await placeOf(client, second))!;
    const right = (await placeOf(client, fourth))!;
    await client.call('agent.delete', { sessionId: second, force: true });
    await client.call('agent.delete', { sessionId: third, force: true });
    await vi.waitFor(async () => expect((await client.call('agent.list')).filter((agent) => agent.zoneId === web.id)).toHaveLength(2), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, RULE_SETTLE_MS * 3));
    // The fourth keeps its column, though the first has room again; a pass without a Tidy keeps it there too.
    expect(await placeOf(client, fourth)).toMatchObject({ x: right.x, y: right.y });
    await client.call('zone.followRule', { id: web.id, tiles: [] });
    expect(await placeOf(client, fourth)).toMatchObject({ x: right.x, y: right.y });
    // A Tidy lays the bands out afresh: the fourth goes under the first.
    await client.call('zone.followRule', { id: web.id, tiles: [], reflow: true });
    expect(await placeOf(client, first)).toMatchObject({ x: top.x, y: top.y });
    expect(await placeOf(client, fourth)).toMatchObject({ x: next.x, y: next.y });
  });

  it("never marks a tile an agent moves, wherever it puts it; the user's own move does", async () => {
    const { client, web } = await ruleDaemon();
    const tile = await client.call('agent.spawn', { zoneId: web.id, name: 'impl', ...SIZE });
    await client.call('zone.configure', { id: web.id, layoutRule: 'lanes' });
    await client.call('orchestrator.move', { target: { kind: 'agent', id: tile.sessionId }, zoneId: web.id, at: { x: 600, y: 300 } });
    expect((await zoneOf(client, web.id)).handPlaced).toEqual([]);
    await client.call('agent.move', { sessionId: tile.sessionId, zoneId: web.id, x: 600, y: 300, byHand: true });
    expect((await zoneOf(client, web.id)).handPlaced).toEqual([`agent:${tile.sessionId}`]);
  });

  it("marks a tile free only as the user puts it wholly outside a laid-out zone's lanes area, and keeps it free wherever the area goes", async () => {
    const { client, web } = await ruleDaemon();
    const tile = await client.call('agent.spawn', { zoneId: web.id, name: 'impl', ...SIZE });
    const key = `agent:${tile.sessionId}`;
    const layout = { x: web.x, y: web.y, width: web.width, height: web.height };
    await client.call('zone.configure', { id: web.id, layoutMode: 'shelves' });
    await client.call('zone.update', { id: web.id, ...layout, lanes: { x: 0, y: 0, width: 500, height: 400 } });
    const free = async () => (await zoneOf(client, web.id)).free;
    // Not the user's: a tile slotted or spawned outside the lanes is still laid out.
    await client.call('agent.move', { sessionId: tile.sessionId, zoneId: web.id, x: 700, y: 40 });
    expect(await free()).toEqual([]);
    // Over the lanes' edge, part of it would lie on them.
    await client.call('agent.move', { sessionId: tile.sessionId, zoneId: web.id, x: 400, y: 40, byHand: true });
    expect(await free()).toEqual([]);
    await client.call('agent.move', { sessionId: tile.sessionId, zoneId: web.id, x: 700, y: 40, byHand: true });
    expect(await free()).toEqual([key]);
    // The lanes area grown over it, it stays free; a move that isn't the user's keeps it so.
    await client.call('zone.update', { id: web.id, ...layout, lanes: { x: 0, y: 0, width: 1100, height: 400 } });
    await client.call('agent.move', { sessionId: tile.sessionId, zoneId: web.id, x: 720, y: 40 });
    expect(await free()).toEqual([key]);
    // Put back in the lanes, it is laid out again.
    await client.call('agent.move', { sessionId: tile.sessionId, zoneId: web.id, x: 40, y: 40, byHand: true });
    expect(await free()).toEqual([]);
    // Lanes that fill the zone again leave it no free area.
    await client.call('zone.update', { id: web.id, ...layout, lanes: { x: 0, y: 0, width: 500, height: 400 } });
    await client.call('agent.move', { sessionId: tile.sessionId, zoneId: web.id, x: 700, y: 40, byHand: true });
    expect(await free()).toEqual([key]);
    await client.call('zone.update', { id: web.id, ...layout, lanes: null });
    await client.call('zone.update', { id: web.id, ...layout, lanes: { x: 0, y: 0, width: 500, height: 400 } });
    expect(await free()).toEqual([]);
    // Undone or redone, it goes back free or not as it was, whatever its place says.
    await client.call('agent.move', { sessionId: tile.sessionId, zoneId: web.id, x: 40, y: 40, free: true });
    expect(await free()).toEqual([key]);
    await client.call('agent.move', { sessionId: tile.sessionId, zoneId: web.id, x: 700, y: 40, free: false });
    expect(await free()).toEqual([]);
    // In a free zone, nothing is.
    await client.call('zone.configure', { id: web.id, layoutMode: 'free' });
    await client.call('agent.move', { sessionId: tile.sessionId, zoneId: web.id, x: 700, y: 60, byHand: true });
    expect(await free()).toEqual([]);
  });

  it('forgets the mark of a tile seen in another zone, or gone, so it is not pinned again when it comes back', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.exec("INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height, layout_rule) VALUES ('z', '/code/app', '', 'app', '#4c6ef5', 0, 0, 300, 200, 'lanes')");
    const zones = createZoneTable(db, () => {}, () => undefined, '/repos', '/groups');
    const marks = () => (db.prepare('SELECT tile_key, zone_id FROM zone_hand_placed ORDER BY tile_key').all() as { tile_key: string; zone_id: string }[]).map((row) => `${row.tile_key}@${row.zone_id}`);
    for (const key of ['agent:a', 'agent:b', 'shell:s']) zones.tileMoved(key, 'z', true, null);
    expect(marks()).toEqual(['agent:a@z', 'agent:b@z', 'shell:s@z']);
    // Still in its zone, it keeps the mark; elsewhere, loose or gone, it loses it.
    zones.tileSeen('agent:a', 'z');
    zones.tileSeen('agent:b', 'elsewhere');
    zones.tileSeen('shell:s', undefined);
    expect(marks()).toEqual(['agent:a@z']);
    zones.tileSeen('agent:a', null);
    expect(marks()).toEqual([]);
  });
});
