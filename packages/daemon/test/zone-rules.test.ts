import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import type { DaemonClient } from '../src/client.ts';
import { migrate } from '../src/migrate.ts';
import type { DaemonCall } from '../src/orchestrator-layout.ts';
import { zoneSnapshot, type Agent, type BoardItem, type FlowEdge, type Shell, type Zone } from '../src/protocol.ts';
import { createZoneRules, RULE_SETTLE_MS, zonesChangedBy, type RuleInputs } from '../src/zone-rules.ts';
import { createZoneTable } from '../src/zones.ts';
import { createFakeClock } from './fake-clock.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

// A zone's layout rule, kept: what sets a zone off to be laid out again, the engine that does it, and the rule on a
// real daemon.

const zone = (fields: Partial<Zone> = {}) => ({ id: 'z1', name: 'web', layoutRule: 'lanes', layoutMode: 'free', spacing: 'normal', width: 1200, folded: false, handPlaced: [], ...fields }) as Zone;
const agent = (fields: Partial<Agent> = {}) =>
  ({ sessionId: 's1', name: 'impl', zoneId: 'z1', issue: null, role: null, reviewOf: null, reviews: null, spawnedBy: null, branch: '', endedAt: null, state: 'idle', shellSessionId: null, shellHarness: null, position: { x: 0, y: 0 }, ...fields }) as Agent;

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

  it('is a zone changing its rule, width, folding or tiles placed by hand, never its place or height', () => {
    const inputs: RuleInputs = new Map();
    expect(zonesChangedBy({ type: 'zone.updated', zone: zone() }, inputs)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'zone.updated', zone: zone({ x: 500, y: 90, height: 2000 }) }, inputs)).toEqual([]);
    expect(zonesChangedBy({ type: 'zone.updated', zone: zone({ folded: true }) }, inputs)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'zone.updated', zone: zone({ folded: true, handPlaced: ['agent:s1'] }) }, inputs)).toEqual(['z1']);
    expect(zonesChangedBy({ type: 'zone.updated', zone: zone({ folded: true, handPlaced: ['agent:s1'], width: 900 }) }, inputs)).toEqual(['z1']);
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
    expect(zonesChangedBy({ type: 'item.removed', id: 'n1' }, inputs)).toEqual([]);
    expect(zonesChangedBy({ type: 'item.removed', id: 'c1' }, inputs)).toEqual(['z1']);
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
    const daemon = await startTestDaemon({ dataDir: tempDataDir(), worktreesDir: tempDataDir(), agentEnv: fakeHarnessEnv({ scenario: 'waiting', home: tempDataDir() }) });
    const client = await connectTestClient(daemon);
    await client.call('settings.set', { arrangeSpacing: 'normal' });
    const web = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0, width: 1200, height: 600, name: 'web' });
    return { client, web };
  }
  const placeOf = async (client: DaemonClient, sessionId: string) => (await client.call('agent.list')).find((each) => each.sessionId === sessionId)?.position;
  const zoneOf = async (client: DaemonClient, id: string) => (await client.call('zone.list')).find((each) => each.id === id)!;

  it('keeps the rule apart from the views, and through a snapshot', async () => {
    const { client, web } = await ruleDaemon();
    expect(web).toMatchObject({ layoutRule: 'off', layoutMode: 'free', handPlaced: [] });
    await client.call('zone.configure', { id: web.id, layoutMode: 'shelves' });
    // A rule sets the zone free of its view; a view sets the rule off.
    expect(await client.call('zone.configure', { id: web.id, layoutRule: 'lanes' })).toMatchObject({ layoutRule: 'lanes', layoutMode: 'free' });
    expect(await client.call('zone.configure', { id: web.id, layoutMode: 'clusters' })).toMatchObject({ layoutRule: 'off', layoutMode: 'clusters' });
    await expect(client.call('zone.configure', { id: web.id, layoutRule: 'lanes', layoutMode: 'shelves' })).rejects.toThrow(/a layout rule or a shelves view, not both/);
    await expect(client.call('zone.configure', { id: web.id, layoutRule: 'spine' as never })).rejects.toThrow(/layoutRule must be one of off, lanes/);

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
    expect(free).toMatchObject({ layoutRule: 'off', layoutMode: 'free', handPlaced: [] });
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

  it("never marks a tile an agent moves, wherever it puts it; the user's own move does", async () => {
    const { client, web } = await ruleDaemon();
    const tile = await client.call('agent.spawn', { zoneId: web.id, name: 'impl', ...SIZE });
    await client.call('zone.configure', { id: web.id, layoutRule: 'lanes' });
    await client.call('orchestrator.move', { target: { kind: 'agent', id: tile.sessionId }, zoneId: web.id, at: { x: 600, y: 300 } });
    expect((await zoneOf(client, web.id)).handPlaced).toEqual([]);
    await client.call('agent.move', { sessionId: tile.sessionId, zoneId: web.id, x: 600, y: 300, byHand: true });
    expect((await zoneOf(client, web.id)).handPlaced).toEqual([`agent:${tile.sessionId}`]);
  });

  it('forgets the mark of a tile seen in another zone, or gone, so it is not pinned again when it comes back', () => {
    const db = new DatabaseSync(':memory:');
    migrate(db);
    db.exec("INSERT INTO zones (id, repo_root, folder, name, color, x, y, width, height, layout_rule) VALUES ('z', '/code/app', '', 'app', '#4c6ef5', 0, 0, 300, 200, 'lanes')");
    const zones = createZoneTable(db, () => {}, () => undefined, '/repos', '/groups');
    const marks = () => (db.prepare('SELECT tile_key, zone_id FROM zone_hand_placed ORDER BY tile_key').all() as { tile_key: string; zone_id: string }[]).map((row) => `${row.tile_key}@${row.zone_id}`);
    for (const key of ['agent:a', 'agent:b', 'shell:s']) zones.tileMoved(key, 'z', true);
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
