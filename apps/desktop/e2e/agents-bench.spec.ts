import { expect, type ElectronApplication } from '@playwright/test';
import type { DaemonClient } from '@agent-board/daemon/client';
import { EXPANDED_VIEW_KEY, tileSizeKey } from '@agent-board/daemon/board-layout';
import type { Agent, Zone } from '@agent-board/daemon/protocol';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { countRenders, installRecorders, phase, processUsage, tracer, zoomTo, type Phase } from './bench-helpers.ts';
import { withDaemon } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, removeDataDir, tempDataDir } from './launch.ts';

/**
 * The many-agents benchmark, run by hand (`pnpm bench:agents`), never by a gate: a board
 * of fake Claude agents across zones of uneven size, some paused, some live at their prompt and some streaming a turn
 * that never ends (the fake harness's `busy` scenario), with a few expanded in place. It records frame gaps, React
 * renders, and the CPU and memory of the board's renderer, the app's main process, the GPU process and the daemon,
 * first with no app at all, then while the board sits, zooms into a zone and pans from zone to zone and back.
 *
 * From the environment: `BENCH_AGENTS` (40), `BENCH_PAUSED` of them (20), `BENCH_BUSY` of the live ones streaming
 * (10), `BENCH_EXPANDED` live ones expanded in place (6, half of them busy), `BENCH_STEP_MS` between a busy agent's
 * redraws (100), `BENCH_LINES` of an earlier conversation each agent prints first, as scrollback (8000), and as the rendering benchmark has: `BENCH_CPU_SLOWDOWN`, `BENCH_TRACE=1`, `BENCH_APP_ENV` (JSON) and
 * `AGENT_BOARD_HEADED=1`; `BENCH_SHOTS=1` too.
 */
const SIZE = {
  agents: Number(process.env.BENCH_AGENTS ?? 40),
  paused: Number(process.env.BENCH_PAUSED ?? 20),
  busy: Number(process.env.BENCH_BUSY ?? 10),
  expanded: Number(process.env.BENCH_EXPANDED ?? 6),
  stepMs: Number(process.env.BENCH_STEP_MS ?? 100),
  lines: Number(process.env.BENCH_LINES ?? 8000),
};
const TRACE = process.env.BENCH_TRACE === '1';
/** `BENCH_SHOTS=1` saves a screenshot of the window after each phase, to check what each one showed. */
const SHOTS = process.env.BENCH_SHOTS === '1';
const CPU_SLOWDOWN = Number(process.env.BENCH_CPU_SLOWDOWN ?? 1);
const APP_ENV = JSON.parse(process.env.BENCH_APP_ENV ?? '{}') as Record<string, string>;

/** The share of the agents each zone holds, largest first, as on a busy real board: 16, 13, 7, 2, 1 and 1 of 40. */
const ZONE_SHARES = [16, 13, 7, 2, 1, 1];
/** Far enough apart that a zone the board flies to fills the view without its neighbours'. */
const ZONE_PITCH = 9000;
const EXPANDED = { width: 720, height: 460 };

/** A git repo with one commit, for a zone to bind to. */
function repo(dir: string, name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'README.md'), `# ${name}\n`);
  const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args]);
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Bench', '-c', 'user.email=bench@example.com', 'commit', '--quiet', '-m', 'initial');
  return path;
}

/**
 * How many of `total` agents each zone gets, by `ZONE_SHARES`, the biggest zone first: a share rounded down, the rest
 * to the biggest zone. Zones whose share rounds to none are left out, so a small board has fewer zones.
 */
function zoneCounts(total: number): number[] {
  const sum = ZONE_SHARES.reduce((a, b) => a + b, 0);
  const counts = ZONE_SHARES.map((share) => Math.floor((share / sum) * total));
  counts[0]! += total - counts.reduce((a, b) => a + b, 0);
  return counts.filter((count) => count > 0);
}

type Kind = 'paused' | 'idle' | 'busy';

/**
 * `total` kinds in an even mix (paused, idle and busy by `SIZE`), each placed where it falls furthest behind its share,
 * so any run of them, a zone's, holds each kind in about its share.
 */
function mixedKinds(total: number): Kind[] {
  const wanted: Record<Kind, number> = { paused: SIZE.paused, idle: total - SIZE.paused - SIZE.busy, busy: SIZE.busy };
  const given: Record<Kind, number> = { paused: 0, idle: 0, busy: 0 };
  const kinds: Kind[] = [];
  for (let index = 0; index < total; index++) {
    const behind = (kind: Kind) => (wanted[kind] * (index + 1)) / total - given[kind];
    const kind = (['paused', 'idle', 'busy'] as const).filter((each) => given[each] < wanted[each]).reduce((a, b) => (behind(b) > behind(a) ? b : a));
    given[kind] += 1;
    kinds.push(kind);
  }
  return kinds;
}

async function untilAgents(client: DaemonClient, done: (agents: Agent[]) => boolean, what: string): Promise<Agent[]> {
  let agents: Agent[] = [];
  for (let tries = 0; tries < 240; tries++) {
    agents = await client.call('agent.list');
    if (done(agents)) return agents;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}: ${agents.map((agent) => `${agent.name} ${agent.state}`).join(', ')}`);
}

/**
 * Fills the board through the daemon: the zones, then their agents, zone by zone, each zone with paused, idle and busy
 * ones in about their shares. The paused ones pause once at their prompt; the busy ones start last, so none of them is
 * in a turn while the others pause.
 */
async function seed(client: DaemonClient, dir: string): Promise<{ zones: Zone[]; busy: Agent[]; idle: Agent[] }> {
  const counts = zoneCounts(SIZE.agents);
  const zones: Zone[] = [];
  for (const [index] of counts.entries()) {
    zones.push(await client.call('zone.add', { path: repo(dir, `project-${index + 1}`), x: (index % 3) * ZONE_PITCH, y: Math.floor(index / 3) * ZONE_PITCH, trustsFolder: true }));
  }
  const kinds = mixedKinds(SIZE.agents);
  const homes = counts.flatMap((count, index) => Array.from({ length: count }, () => zones[index]!));
  const planned = homes.map((zone, index) => ({ zone, kind: kinds[index]!, name: `agent ${index + 1}` }));
  console.log(JSON.stringify({ zones: zones.map((zone) => ({ name: zone.name, ...Object.fromEntries((['paused', 'idle', 'busy'] as const).map((kind) => [kind, planned.filter((each) => each.zone === zone && each.kind === kind).length])) })) }));
  const spawn = ({ zone, name }: (typeof planned)[number], prompt: string) =>
    client.call('agent.spawn', { zoneId: zone.id, prompt, name, harness: 'claude', noTemplate: true, cols: 100, rows: 30 });
  const quiet: { kind: Kind; agent: Agent }[] = [];
  for (const each of planned.filter(({ kind }) => kind !== 'busy')) quiet.push({ kind: each.kind, agent: await spawn(each, 'Look around the repo') });
  const atPrompt = (agent: Agent) => agent.state === 'idle' || agent.state === 'waiting';
  await untilAgents(client, (agents) => agents.length === quiet.length && agents.every(atPrompt), 'the quiet agents to reach their prompt');
  const toPause = quiet.filter(({ kind }) => kind === 'paused').map(({ agent }) => agent.sessionId);
  for (const sessionId of toPause) await client.call('agent.pause', { sessionId });
  await untilAgents(client, (agents) => agents.filter((agent) => agent.state === 'hibernated').length === toPause.length, 'the paused agents to pause');
  const busyIds = new Set<string>();
  for (const each of planned.filter(({ kind }) => kind === 'busy')) busyIds.add((await spawn(each, 'Keep busy: refactor the store')).sessionId);
  const inTurn = (agent: Agent) => agent.state === 'running' || agent.state === 'thinking';
  const all = await untilAgents(client, (agents) => agents.filter((agent) => busyIds.has(agent.sessionId) && inTurn(agent)).length === busyIds.size, 'the busy agents to be in their turn');
  const idleIds = new Set(quiet.filter(({ kind }) => kind === 'idle').map(({ agent }) => agent.sessionId));
  return {
    zones: await client.call('zone.list'),
    busy: all.filter((agent) => busyIds.has(agent.sessionId)),
    idle: all.filter((agent) => idleIds.has(agent.sessionId)),
  };
}

test.describe.configure({ timeout: 1_800_000 });

test('many-agents benchmark: paused, idle and busy agents across zones, panes expanded, zone to zone and back', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-bench-agents-')));
  const home = join(dir, 'home');
  mkdirSync(home);
  const fake = fakeHarnessEnv({ scenario: 'busy', home, stepDelayMs: SIZE.stepMs, idleNotifyMs: 300, backlogLines: SIZE.lines, base: {} });
  const env: Record<string, string> = {
    PATH: `${fake.PATH}:${process.env.PATH}`,
    HOME: home,
    FAKE_HARNESS_SCENARIO: fake.FAKE_HARNESS_SCENARIO!,
    FAKE_HARNESS_STEP_DELAY_MS: fake.FAKE_HARNESS_STEP_DELAY_MS!,
    FAKE_HARNESS_IDLE_NOTIFY_MS: fake.FAKE_HARNESS_IDLE_NOTIFY_MS!,
    FAKE_HARNESS_BACKLOG_LINES: fake.FAKE_HARNESS_BACKLOG_LINES!,
    AGENT_BOARD_WORKTREES_DIR: join(dir, 'worktrees'),
    AGENT_BOARD_SCRATCH_DIR: join(dir, 'scratch'),
    AGENT_BOARD_LOGIN_SHELL: '0',
    SHELL: '/bin/sh',
    // The renderer the app gives its users, where the e2e specs keep to the DOM one.
    AGENT_BOARD_TERMINAL_RENDERER: 'auto',
    ...APP_ENV,
  };
  const dataDir = tempDataDir();
  let first: ElectronApplication | undefined;
  let app: ElectronApplication | undefined;
  try {
    // As in the rendering benchmark, the board is filled under a first app and the panes' expansion saved once it has
    // closed, so the second opens on them expanded. Between the two, the daemon runs with no app attached.
    first = await launchApp(dataDir, env);
    const daemonPid = await connectedDaemonPid(await first.firstWindow());
    const { zones, busy, idle } = await withDaemon(dataDir, (client) => seed(client, dir));
    await first.close();
    first = undefined;
    // Half the expanded panes are busy agents, half idle ones, all in the biggest zone: the view the board leaves and
    // comes back to.
    const inBig = (agent: Agent) => agent.zoneId === zones[0]!.id;
    const busyOpen = busy.filter(inBig).slice(0, Math.ceil(SIZE.expanded / 2));
    const expanded = [...busyOpen, ...idle.filter(inBig).slice(0, SIZE.expanded - busyOpen.length)];
    await withDaemon(dataDir, (client) => client.call('view.set', { key: EXPANDED_VIEW_KEY, value: expanded.map((agent) => ({ id: tileSizeKey('agent', agent.sessionId), ...EXPANDED })) }));
    // The daemon alone: its agents' output parsed and kept, with no board drawing it. With no live session it has ended
    // with the app, and the next app starts another.
    const daemonAlone = await (async () => {
      const before = processUsage(daemonPid);
      if (before === undefined) return undefined;
      await sleep(10_000);
      const after = processUsage(daemonPid);
      return after && { daemonCpu: Math.round(((after.cpuSeconds - before.cpuSeconds) / 10) * 100), daemonMb: after.mb };
    })();
    console.log(JSON.stringify({ name: 'daemon, no app', ...daemonAlone }));

    const board = (app = await launchApp(dataDir, env));
    const window = await board.firstWindow();
    await connectedDaemonPid(window);
    await board.context().addInitScript(countRenders);
    await window.reload();
    const boardDaemonPid = await connectedDaemonPid(window);
    await expect(window.getByTestId('agent-tile').first()).toBeVisible();
    if (SIZE.expanded > 0) await expect(window.getByTestId('expanded-tile')).not.toHaveCount(0);
    await installRecorders(window);
    const cdp = await board.context().newCDPSession(window);
    const trace = TRACE ? tracer(cdp) : undefined;
    if (CPU_SLOWDOWN > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    const centre = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 };
    const phases: Phase[] = [];
    const run = async (name: string, input: () => Promise<void>) => {
      phases.push(await phase(board, window, cdp, name, input, { trace, daemonPid: boardDaemonPid }));
      console.log(JSON.stringify(phases.at(-1)));
      if (SHOTS) await window.screenshot({ path: test.info().outputPath(`${phases.length}-${name.replaceAll(/\W+/g, '-')}.png`) });
    };
    // The zones' chips at the board's foot bring each into view, as a user moves from zone to zone.
    const goTo = async (zone: Zone) => {
      await window.getByRole('button', { name: zone.name, exact: true }).click();
      await sleep(1500);
    };
    const [big, second, third] = zones;
    if (third === undefined) throw new Error(`${SIZE.agents} agents make ${zones.length} zones: the benchmark moves between three`);
    console.log(JSON.stringify({ expanded: expanded.map((agent) => [agent.name, zones.find((zone) => zone.id === agent.zoneId)?.name]) }));

    await sleep(5000);
    await run('overview, idle', () => sleep(8000));
    // A zone's chip brings it into view without zooming in: into the biggest zone, then in to where its tiles read.
    await run('to the biggest zone', async () => {
      await goTo(big!);
      await zoomTo(window, 0.5, centre);
    });
    await run('one zone, idle', () => sleep(8000));
    // To another zone and back, twice: what coming back to a view with open panes costs.
    await run('to the next zone', () => goTo(second!));
    await run('back to the first', () => goTo(big!));
    await run('to the third zone', () => goTo(third!));
    await run('back to the first again', () => goTo(big!));
    await run('zoom out to the overview', () => zoomTo(window, 0.1, centre));
    await run('overview, idle again', () => sleep(8000));

    const result = { size: SIZE, cpuSlowdown: CPU_SLOWDOWN, headed: process.env.AGENT_BOARD_HEADED === '1', appEnv: APP_ENV, daemonAlone, phases };
    writeFileSync(test.info().outputPath('agents-bench.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.table(phases.map(({ name, p95Ms, p99Ms, maxMs, hitches, longTaskMs, mounts, terminals, rendererCpu, mainCpu, gpuCpu, daemonCpu, rendererMb, daemonMb, commits, renders }) => ({ name, p95Ms, p99Ms, maxMs, hitches, longTaskMs, mounts, terminals, rendererCpu, mainCpu, gpuCpu, daemonCpu, rendererMb, daemonMb, commits, renders })));
    console.log(`results in ${test.info().outputPath('agents-bench.json')}`);
  } finally {
    // Stopping the daemon (in removeDataDir) ends its agents, the busy ones too.
    await first?.close();
    await app?.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
});
