// Usage pacing: the reading Claude agents' status lines post, the user's priorities, and the budget hold the Captain
// may place only while the user lets it.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { claudeSettings, claudeStatusLineCommand, configuredStatusLine } from '../src/agent-spawns.ts';
import { usageText } from '../src/board-ops.ts';
import { HOOK_TOKEN_ENV, HOOK_URL_ENV } from '../src/hook-forwarder.ts';
import { migrate } from '../src/migrate.ts';
import type { Orchestrator, OrchestratorAccess } from '../src/orchestrators.ts';
import {
  BOARD_ERROR,
  DEFAULT_USAGE_THRESHOLDS,
  USAGE_STALE_MS,
  usagePace,
  type Agent,
  type DaemonEvent,
  type DaemonSettings,
  type UsageReading,
  type UsageUpdatedEvent,
  type Zone,
} from '../src/protocol.ts';
import { createUsageHost } from '../src/usage.ts';
import { createZoneTable } from '../src/zones.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const T0 = Date.parse('2026-10-28T10:00:00Z');
/** Epoch seconds `hours` after T0. */
const at = (hours: number) => Math.round(T0 / 1000 + hours * 3600);

const statusLine = (five: number, seven: number) => ({
  model: { display_name: 'Opus' },
  rate_limits: { five_hour: { used_percentage: five, resets_at: at(2) }, seven_day: { used_percentage: seven, resets_at: at(72) } },
});

function setup(settings: Partial<DaemonSettings> = {}) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const events: DaemonEvent[] = [];
  const zones = createZoneTable(db, () => {}, () => undefined, '/repos', '/groups');
  const add = (name: string) => zones.insert({ repoRoot: null, folder: '', name, color: '#4c6ef5', tracker: null, x: 0, y: 0, width: 400, height: 300 });
  const priority = (zone: Zone, value: Zone['priority']) => db.prepare('UPDATE zones SET priority = ? WHERE id = ?').run(value, zone.id);
  const paused: { sessionId: string; by: string | null; reason?: string }[] = [];
  const agentsById = new Map<string, Agent>();
  const released: string[] = [];
  let now = T0;
  const usage = createUsageHost({
    db,
    settings: () => ({ usagePacing: false, usageThresholds: DEFAULT_USAGE_THRESHOLDS, ...settings }) as DaemonSettings,
    zones,
    agents: {
      get: (sessionId) => agentsById.get(sessionId),
      pause: async (sessionId, by, _why, reason) => {
        paused.push({ sessionId, by, ...(reason === undefined ? {} : { reason }) });
        return agentsById.get(sessionId)!;
      },
    },
    released: (zoneId) => released.push(zoneId),
    broadcast: (event) => events.push(event),
    log: () => {},
    now: () => now,
  });
  return {
    db,
    usage,
    zones,
    add,
    priority,
    events,
    paused,
    released,
    agentsById,
    tick: (ms: number) => (now += ms),
  };
}

/** An access that lets everyone through, logging nothing: the gate under test is the usage host's own. */
function openAccess(): OrchestratorAccess {
  return {
    caller: (_method, params) => (params as { me: Orchestrator }).me,
    logged: async (_me, _action, _entry, act) => act(),
    reachesAgent: () => true,
    reachesZone: () => true,
    madeByCrew: () => true,
    wouldGainOrchestrating: () => false,
    scopeText: () => 'the board',
  };
}

const captain = { sessionId: 'captain', name: 'Captain', zoneId: null, repoRoot: '', orchestrate: 'board', agent: { master: true } as Agent } as Orchestrator;
const lead = { ...captain, sessionId: 'lead', name: 'lead', agent: { master: false } as Agent } as Orchestrator;
const user = { ...captain, sessionId: 'user', name: 'you', agent: null } as Orchestrator;

async function refusal(call: Promise<unknown>) {
  const error = await call.then(
    () => undefined,
    (thrown: { code: number; message: string }) => thrown,
  );
  expect(error?.code).toBe(BOARD_ERROR.notAllowed);
  return error!.message;
}

describe('the usage reading', () => {
  it('is stale with no windows before any status line posted one', () => {
    const { usage } = setup();
    expect(usage.reading()).toEqual({ fiveHour: null, sevenDay: null, readAt: null, stale: true });
  });

  it("keeps a status line's rate limits as the newest reading, fresh, with what is left and when each window resets", () => {
    const { usage, events } = setup();

    usage.record(statusLine(72, 41));

    const reading: UsageReading = {
      fiveHour: { usedPercent: 72, remainingPercent: 28, resetsAt: new Date(at(2) * 1000).toISOString() },
      sevenDay: { usedPercent: 41, remainingPercent: 59, resetsAt: new Date(at(72) * 1000).toISOString() },
      readAt: new Date(T0).toISOString(),
      stale: false,
    };
    expect(usage.reading()).toEqual(reading);
    expect(events).toEqual([{ type: 'usage.updated', usage: reading }]);
  });

  it('ignores a status line without rate limits, or with nonsense in them', () => {
    const { usage, events } = setup();
    usage.record({ model: { display_name: 'Opus' } });
    usage.record({ rate_limits: { five_hour: { used_percentage: 'lots' } } });
    usage.record('not json');
    expect(usage.reading().readAt).toBeNull();
    expect(events).toEqual([]);
  });

  it('goes stale once it is older than the stale limit, or a window it read has reset', () => {
    const { usage, tick } = setup();
    usage.record(statusLine(72, 41));
    tick(USAGE_STALE_MS - 1000);
    expect(usage.reading().stale).toBe(false);
    tick(2000);
    expect(usage.reading().stale).toBe(true);

    usage.record({ rate_limits: { five_hour: { used_percentage: 10, resets_at: Math.round((T0 + USAGE_STALE_MS + 1000 + 60_000) / 1000) } } });
    expect(usage.reading()).toMatchObject({ stale: false, sevenDay: null });
    tick(120_000);
    expect(usage.reading().stale).toBe(true);
  });

  it('tells clients of the same reading again at most once a minute, and of a changed one at once', () => {
    const { usage, events, tick } = setup();
    usage.record(statusLine(72, 41));
    tick(5000);
    usage.record(statusLine(72, 41));
    expect(events).toHaveLength(1);
    usage.record(statusLine(73, 41));
    expect(events).toHaveLength(2);
    tick(61_000);
    usage.record(statusLine(73, 41));
    expect(events).toHaveLength(3);
  });

  it('tells clients when a reading kept across a restart goes stale, with no newer one', async () => {
    const { usage, db } = setup();
    usage.record(statusLine(72, 41));
    usage.close();
    const events: DaemonEvent[] = [];
    vi.useFakeTimers({ now: T0 + 60_000 });
    try {
      const again = createUsageHost({
        db,
        settings: () => ({ usagePacing: false, usageThresholds: DEFAULT_USAGE_THRESHOLDS }) as DaemonSettings,
        zones: { list: () => [], find: () => undefined, setUsageHold: () => false },
        agents: { get: () => undefined, pause: async () => ({}) as Agent },
        released: () => {},
        broadcast: (event) => events.push(event),
        log: () => {},
      });
      expect(events).toEqual([]);
      await vi.advanceTimersByTimeAsync(USAGE_STALE_MS);
      expect(events).toEqual([{ type: 'usage.updated', usage: expect.objectContaining({ stale: true }) }]);
      again.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a restart of the daemon, as the reading it last had', () => {
    const { usage, db } = setup();
    usage.record(statusLine(72, 41));
    const again = createUsageHost({
      db,
      settings: () => ({ usagePacing: false, usageThresholds: DEFAULT_USAGE_THRESHOLDS }) as DaemonSettings,
      zones: { list: () => [], find: () => undefined, setUsageHold: () => false },
      agents: { get: () => undefined, pause: async () => ({}) as Agent },
      released: () => {},
      broadcast: () => {},
      log: () => {},
      now: () => T0 + 1000,
    });
    expect(again.reading()).toMatchObject({ fiveHour: { usedPercent: 72 }, stale: false });
  });
});

describe('usage priorities', () => {
  it("say what the user's thresholds allow in each zone, by its priority, and nothing on a stale reading", () => {
    const thresholds = DEFAULT_USAGE_THRESHOLDS;
    const reading = (five: number, seven: number, stale = false): UsageReading => ({
      fiveHour: { usedPercent: five, remainingPercent: 100 - five, resetsAt: null },
      sevenDay: { usedPercent: seven, remainingPercent: 100 - seven, resetsAt: null },
      readAt: new Date(T0).toISOString(),
      stale,
    });
    expect(usagePace(reading(70, 41), 'low', thresholds)).toEqual({ holdStarts: null, pauseIdle: null });
    expect(usagePace(reading(86, 41), 'low', thresholds)).toEqual({ holdStarts: '5h at 86%, zone low priority', pauseIdle: null });
    expect(usagePace(reading(86, 41), 'normal', thresholds)).toEqual({ holdStarts: '5h at 86%, zone normal priority', pauseIdle: null });
    expect(usagePace(reading(99, 95), 'high', thresholds)).toEqual({ holdStarts: null, pauseIdle: null });
    expect(usagePace(reading(50, 92), 'normal', thresholds)).toEqual({ holdStarts: '7d at 92%, zone normal priority', pauseIdle: null });
    expect(usagePace(reading(96, 41), 'low', thresholds)).toEqual({ holdStarts: '5h at 96%, zone low priority', pauseIdle: '5h at 96%, zone low priority' });
    expect(usagePace(reading(96, 41, true), 'low', thresholds)).toEqual({ holdStarts: null, pauseIdle: null });
  });

  it("list the switch, the thresholds and each zone's priority, hold and pace", async () => {
    const { usage, add, priority } = setup({ usagePacing: true });
    const web = add('web');
    const docs = add('docs');
    priority(docs, 'low');
    usage.record(statusLine(86, 41));

    const priorities = await usage.handlers(openAccess())['usage.priorities'](undefined, {} as never);

    expect(priorities).toEqual({
      pacing: true,
      thresholds: DEFAULT_USAGE_THRESHOLDS,
      zones: [
        { id: web.id, name: 'web', priority: 'normal', hold: null, pace: { holdStarts: '5h at 86%, zone normal priority', pauseIdle: null } },
        { id: docs.id, name: 'docs', priority: 'low', hold: null, pace: { holdStarts: '5h at 86%, zone low priority', pauseIdle: null } },
      ],
    });
  });
});

describe('the budget hold', () => {
  it('is refused while the user has not turned pacing on, whatever the reading', async () => {
    const { usage, add } = setup();
    const zone = add('docs');
    usage.record(statusLine(99, 99));
    const handlers = usage.handlers(openAccess());

    const message = await refusal(Promise.resolve().then(() => handlers['orchestrator.hold']({ zoneId: zone.id, me: captain } as never, {} as never)));

    expect(message).toMatch(/off in Settings › Usage/);
  });

  it('is refused with no reading, a stale one, or a zone within the thresholds', async () => {
    const { usage, add, tick } = setup({ usagePacing: true });
    const zone = add('docs');
    const handlers = usage.handlers(openAccess());
    const hold = () => Promise.resolve().then(() => handlers['orchestrator.hold']({ zoneId: zone.id, me: captain } as never, {} as never));

    expect(await refusal(hold())).toMatch(/no usage reading yet/);
    usage.record(statusLine(50, 41));
    expect(await refusal(hold())).toMatch(/within the user's thresholds/);
    usage.record(statusLine(90, 41));
    tick(USAGE_STALE_MS + 1);
    expect(await refusal(hold())).toMatch(/stale/);
  });

  it('is the Captain\'s alone among agents', async () => {
    const { usage, add } = setup({ usagePacing: true });
    const zone = add('docs');
    usage.record(statusLine(90, 41));
    const handlers = usage.handlers(openAccess());

    const message = await refusal(Promise.resolve().then(() => handlers['orchestrator.hold']({ zoneId: zone.id, me: lead } as never, {} as never)));

    expect(message).toMatch(/only the Captain/);
  });

  it("can't be lifted by any other agent: only the Captain, or the user's Override", async () => {
    const { usage, add } = setup({ usagePacing: true });
    const zone = add('docs');
    usage.record(statusLine(90, 41));
    const handlers = usage.handlers(openAccess());
    await handlers['orchestrator.hold']({ zoneId: zone.id, me: captain } as never, {} as never);

    const message = await refusal(Promise.resolve().then(() => handlers['orchestrator.release']({ zoneId: zone.id, me: lead } as never, {} as never)));

    expect(message).toMatch(/only the Captain/);
    expect((await handlers['orchestrator.release']({ zoneId: zone.id, me: captain } as never, {} as never)).usageHold).toBeNull();
  });

  it('holds the zone, with why, once allowed; a hand-off to its agents waits; the user lifts it', async () => {
    const { usage, add, zones, agentsById, released } = setup({ usagePacing: true });
    const zone = add('docs');
    agentsById.set('worker', { sessionId: 'worker', name: 'worker', zoneId: zone.id } as Agent);
    usage.record(statusLine(86, 41));
    const handlers = usage.handlers(openAccess());

    const held = await handlers['orchestrator.hold']({ zoneId: zone.id, me: captain } as never, {} as never);

    expect(held.usageHold).toEqual({ reason: '5h at 86%, zone normal priority', since: expect.any(String) });
    expect(usage.heldFor('worker')).toBe('held: 5h at 86%, zone normal priority');

    const lifted = await handlers['orchestrator.release']({ zoneId: zone.id, me: user } as never, {} as never);

    expect(lifted.usageHold).toBeNull();
    expect(zones.find(zone.id)!.usageHold).toBeNull();
    expect(usage.heldFor('worker')).toBeUndefined();
    expect(released).toEqual([zone.id]);
  });

  it('pauses an idle agent for usage only in a low-priority zone past the pause threshold, saying why', async () => {
    const { usage, add, priority, agentsById, paused } = setup({ usagePacing: true });
    const zone = add('docs');
    agentsById.set('worker', { sessionId: 'worker', name: 'worker', zoneId: zone.id } as Agent);
    usage.record(statusLine(96, 41));
    const handlers = usage.handlers(openAccess());
    const pause = () => Promise.resolve().then(() => handlers['orchestrator.usagePause']({ sessionId: 'worker', me: captain } as never, {} as never));

    expect(await refusal(pause())).toMatch(/within the user's thresholds/);
    priority(zone, 'low');
    await pause();

    expect(paused).toEqual([{ sessionId: 'worker', by: 'captain', reason: '5h at 96%, zone low priority' }]);
  });
});

describe("a Claude agent's status line", () => {
  /** Runs `command` as Claude runs a status line, `input` on its stdin, with the session's hook env; what it posts and prints. */
  async function runStatusLine(command: string, input: string) {
    const posts: { path: string; auth: string | undefined; body: string }[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        posts.push({ path: request.url ?? '', auth: request.headers.authorization, body });
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const printed = await new Promise<string>((resolve, reject) => {
        const child = execFile('/bin/sh', ['-c', command], { env: { PATH: process.env.PATH, [HOOK_URL_ENV]: `http://127.0.0.1:${port}/hooks`, [HOOK_TOKEN_ENV]: 'tok' } }, (error, stdout) =>
          error ? reject(error) : resolve(stdout),
        );
        child.stdin!.end(input);
      });
      return { posts, printed };
    } finally {
      server.close();
    }
  }

  it("posts what Claude passes it to the daemon's /usage with the session's token, then runs the status line the user had", async () => {
    const input = JSON.stringify(statusLine(72, 41));

    const { posts, printed } = await runStatusLine(claudeStatusLineCommand("sed 's/Opus/OPUS/' | cut -c1-30"), input);

    expect(posts).toEqual([{ path: '/usage', auth: 'Bearer tok', body: input }]);
    expect(printed).toBe(`${input.replace('Opus', 'OPUS').slice(0, 30)}\n`);
  });

  it("prints nothing of its own when the user had no status line, and never fails when the daemon isn't there", async () => {
    const { printed } = await runStatusLine(claudeStatusLineCommand(undefined).replace(HOOK_URL_ENV, 'NO_SUCH_URL'), '{}');
    expect(printed).toBe('');
  });

  it("chains the user's own status line, and leaves a project's alone: it never runs a repo's command from trusted settings", () => {
    const home = mkdtempSync(join(tmpdir(), 'statusline-home-'));
    const project = mkdtempSync(join(tmpdir(), 'statusline-project-'));
    const write = (file: string, settings: unknown) => {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(settings));
    };
    const env = { HOME: home };
    const folder = join(project, 'apps', 'web');
    const at = [folder, project];
    expect(configuredStatusLine(at, env)).toBeUndefined();
    expect(claudeSettings('http://127.0.0.1:1/hooks', 1000).statusLine?.command).toBe(claudeStatusLineCommand(undefined));
    write(join(home, '.claude', 'settings.json'), { statusLine: { type: 'command', command: '~/user-line.sh' } });
    expect(configuredStatusLine(at, env)).toEqual({ user: '~/user-line.sh' });
    expect(configuredStatusLine(at, { HOME: home, CLAUDE_CONFIG_DIR: join(home, 'elsewhere') })).toBeUndefined();
    write(join(project, '.claude', 'settings.json'), { statusLine: { type: 'command', command: 'project-line' } });
    expect(configuredStatusLine(at, env)).toEqual({ project: true });
    expect(claudeSettings('http://127.0.0.1:1/hooks', 1000, null)).not.toHaveProperty('statusLine');
  });
});

describe('`agent-board usage`', () => {
  it('says each window, what is left and when it resets, and how old the reading is', () => {
    const usage: UsageReading = {
      fiveHour: { usedPercent: 72, remainingPercent: 28, resetsAt: '2026-10-28T12:00:00.000Z' },
      sevenDay: null,
      readAt: '2026-10-28T09:59:00.000Z',
      stale: false,
    };
    expect(usageText(usage, T0)).toBe(
      ['5-hour window: 72% used, 28% left, resets 2026-10-28T12:00:00.000Z (in 2h 0m)', '7-day window : not in the reading', 'Read 1 min ago.'].join('\n'),
    );
    expect(usageText({ ...usage, stale: true, readAt: '2026-10-28T09:08:00.000Z' }, T0)).toMatch(/^Stale: read 52 min ago/m);
    expect(usageText({ fiveHour: null, sevenDay: null, readAt: null, stale: true }, T0)).toMatch(/^No usage reading yet/);
  });
});

describe('a reading from a running agent', () => {
  it("comes from a Claude agent's status line as its turn ends, the user's own status line still run", async () => {
    const resetsAt = Math.round(Date.now() / 1000) + 3600;
    const daemon = await startTestDaemon({
      worktreesDir: tempDataDir(),
      agentEnv: fakeHarnessEnv({ scenario: 'output', home: tempDataDir(), rateLimits: { five_hour: { used_percentage: 64, resets_at: resetsAt }, seven_day: { used_percentage: 12 } } }),
    });
    const client = await connectTestClient(daemon);
    const zone = await client.call('zone.add', { path: tempRepo(), x: 0, y: 0 });
    const updated = recordEvents(client).waitFor((event): event is UsageUpdatedEvent => event.type === 'usage.updated');

    await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Write the code', cols: 100, rows: 30 });

    expect((await updated).usage).toMatchObject({ fiveHour: { usedPercent: 64, remainingPercent: 36 }, sevenDay: { usedPercent: 12, resetsAt: null }, stale: false });
    expect(await client.call('usage.get', undefined)).toMatchObject({ fiveHour: { usedPercent: 64 } });
  });
});
