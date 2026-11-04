// Plan usage: the reading Claude agents' status lines post.
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
import {
  USAGE_STALE_MS,
  type DaemonEvent,
  type UsageReading,
  type UsageUpdatedEvent,
} from '../src/protocol.ts';
import { createUsageHost } from '../src/usage.ts';
import { connectTestClient, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const T0 = Date.parse('2026-10-28T10:00:00Z');
/** Epoch seconds `hours` after T0. */
const at = (hours: number) => Math.round(T0 / 1000 + hours * 3600);

const statusLine = (five: number, seven: number) => ({
  model: { display_name: 'Opus' },
  rate_limits: { five_hour: { used_percentage: five, resets_at: at(2) }, seven_day: { used_percentage: seven, resets_at: at(72) } },
});

function setup() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  const events: DaemonEvent[] = [];
  let now = T0;
  const usage = createUsageHost({ db, broadcast: (event) => events.push(event), now: () => now });
  return { db, usage, events, tick: (ms: number) => (now += ms) };
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
        broadcast: (event) => events.push(event),
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
      broadcast: () => {},
      now: () => T0 + 1000,
    });
    expect(again.reading()).toMatchObject({ fiveHour: { usedPercent: 72 }, stale: false });
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
