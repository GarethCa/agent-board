import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import type { DaemonClient } from '@agent-board/daemon/client';
import { EXPANDED_VIEW_KEY, tileSizeKey } from '@agent-board/daemon/board-layout';
import type { Agent, Zone } from '@agent-board/daemon/protocol';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import type { CDPSession } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { countRenders, installRecorders, phase, type Phase, type Tracer } from './bench-helpers.ts';
import { withDaemon } from './board-helpers.ts';
import { test, BACKGROUND_ENV, connectedDaemonPid, launchApp, tempDataDir, trackApp } from './launch.ts';

/**
 * The pan and zoom profile, run by hand (`pnpm --filter @agent-board/desktop exec playwright test pan-zoom-bench
 * --project bench`, see docs/research/pan-zoom.md), never by a gate. It fills a board of 100+ objects through the
 * daemon: fake Claude agents across three zones (most paused, some at their prompt, a few streaming), some of them
 * expanded in place, and sticky notes beside each zone. Then it pans and zooms the way a trackpad does, one wheel event
 * a frame, and records frame gaps, long tasks, React commits and a DevTools trace of each gesture, with a breakdown of
 * where each trace's time went (script, style, layout, paint, raster, GPU) beside it.
 *
 * Each gesture runs once per variant: the board as built, then with styles put on the page that try a fix without
 * building one (`will-change` on the board's moving layer only while it moves; no shadows; no minimap).
 *
 * From the environment: `BENCH_EXECUTABLE`, an installed app's executable to profile in place of this checkout's
 * build (`~/Applications/agent-board.app/Contents/MacOS/agent-board`); `BENCH_AGENTS` (72), `BENCH_PAUSED` of them
 * (48), `BENCH_BUSY` (8), `BENCH_EXPANDED` (8), `BENCH_NOTES` a zone (14); `BENCH_VARIANTS`, a comma list of
 * `baseline`, `moving-layer`, `no-shadows`, `no-minimap` (all four); `BENCH_KEEP_TERMINALS=1` turns on the setting that keeps an
 * expanded tile's terminal alive off screen, and its chat view too; `BENCH_CHAT=1` opens the expanded tiles on their chat
 * view in place of their terminal; `BENCH_TRACE=0` records no traces.
 */
const SIZE = {
  agents: Number(process.env.BENCH_AGENTS ?? 72),
  paused: Number(process.env.BENCH_PAUSED ?? 48),
  busy: Number(process.env.BENCH_BUSY ?? 8),
  expanded: Number(process.env.BENCH_EXPANDED ?? 8),
  notes: Number(process.env.BENCH_NOTES ?? 14),
};
const EXECUTABLE = process.env.BENCH_EXECUTABLE;
const TRACE = process.env.BENCH_TRACE !== '0';
const KEEP_TERMINALS = process.env.BENCH_KEEP_TERMINALS === '1';
const CHAT = process.env.BENCH_CHAT === '1';
const VARIANTS = (process.env.BENCH_VARIANTS ?? 'baseline,moving-layer,no-shadows,no-minimap').split(',') as Variant[];
/** About a 16-inch laptop's board window. */
const WINDOW = { width: 1600, height: 1000 };
const ZONE_SHARES = [36, 24, 12];
const ZONE_PITCH = 5000;
const EXPANDED = { width: 720, height: 460 };
/** How far a pinch's wheel event zooms, in doublings per unit of `deltaY`: React Flow's wheel delta on a Mac. */
const PINCH_OCTAVES = 0.02;
/** A zoom of 0.12 to 1 (about three doublings) over 90 frames, a second and a half: a quick pinch. */
const PINCH_STEP = 1.7;

type Variant = 'baseline' | 'moving-layer' | 'no-shadows' | 'no-minimap';

/**
 * Each variant's change to the page, as a script run in it. `moving-layer` gives the board's moving layer its own
 * compositor layer from the first wheel of a gesture until 150 ms after the last, so the GPU moves and scales it while
 * it moves and Chromium draws it sharp again once it stops. `no-minimap` runs no script: it turns the minimap off with
 * its button, so it runs last.
 */
const VARIANT_SCRIPTS: Record<Variant, string> = {
  baseline: '',
  'moving-layer': `(() => {
    const layer = () => document.querySelector('.react-flow__viewport');
    let timer;
    window.addEventListener('wheel', () => {
      const el = layer();
      if (el) el.style.willChange = 'transform';
      clearTimeout(timer);
      timer = setTimeout(() => { const el = layer(); if (el) el.style.willChange = ''; }, 150);
    }, { capture: true, passive: true });
  })()`,
  'no-shadows': `(() => {
    const style = document.createElement('style');
    style.textContent = '.react-flow__node, .react-flow__node * { box-shadow: none !important; filter: none !important; backdrop-filter: none !important; }';
    document.head.append(style);
  })()`,
  'no-minimap': '',
};

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

async function untilAgents(client: DaemonClient, done: (agents: Agent[]) => boolean, what: string): Promise<Agent[]> {
  let agents: Agent[] = [];
  for (let tries = 0; tries < 360; tries++) {
    agents = await client.call('agent.list');
    if (done(agents)) return agents;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}: ${agents.map((agent) => `${agent.name} ${agent.state}`).join(', ')}`);
}

/**
 * Fills the board: three zones side by side, their agents (paused, at their prompt and busy, each zone with each kind
 * in its share), and sticky notes in a grid to the right of each zone. Returns the zones as they ended up, the agents
 * to expand (busy first, all in the biggest zone while it has enough), and how many objects the board holds.
 */
async function seed(client: DaemonClient, dir: string): Promise<{ zones: Zone[]; expand: Agent[]; objects: number }> {
  const sum = ZONE_SHARES.reduce((a, b) => a + b, 0);
  const counts = ZONE_SHARES.map((share) => Math.floor((share / sum) * SIZE.agents));
  counts[0]! += SIZE.agents - counts.reduce((a, b) => a + b, 0);
  const made: Zone[] = [];
  for (const index of counts.keys()) made.push(await client.call('zone.add', { path: repo(dir, `project-${index + 1}`), x: index * ZONE_PITCH, y: 0, trustsFolder: true }));
  // Every sixth agent is busy and every third of the rest at its prompt, until each kind has its count.
  const kinds = Array.from({ length: SIZE.agents }, () => 'paused' as 'paused' | 'idle' | 'busy');
  let busy = 0;
  let idle = 0;
  const idleCount = SIZE.agents - SIZE.paused - SIZE.busy;
  for (let index = 0; index < SIZE.agents; index++) {
    if (index % 6 === 0 && busy < SIZE.busy) [kinds[index], busy] = ['busy', busy + 1];
    else if (index % 3 === 1 && idle < idleCount) [kinds[index], idle] = ['idle', idle + 1];
  }
  for (let index = 0; index < SIZE.agents && idle < idleCount; index++) if (kinds[index] === 'paused') [kinds[index], idle] = ['idle', idle + 1];
  const homes = counts.flatMap((count, index) => Array.from({ length: count }, () => made[index]!));
  const planned = homes.map((zone, index) => ({ zone, kind: kinds[index]!, name: `agent ${index + 1}` }));
  const spawn = ({ zone, name }: (typeof planned)[number], prompt: string) =>
    client.call('agent.spawn', { zoneId: zone.id, prompt, name, harness: 'claude', noTemplate: true, cols: 100, rows: 30 });
  const quiet: { kind: string; agent: Agent }[] = [];
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
  const zones = await client.call('zone.list');
  // Notes in a grid to the right of each zone, loose on the board, as a user leaves them beside a project.
  for (const zone of zones) {
    for (let index = 0; index < SIZE.notes; index++) {
      const column = index % 2;
      const row = Math.floor(index / 2);
      await client.call('item.create', {
        kind: 'sticky',
        zoneId: null,
        x: zone.x + zone.width + 120 + column * 240,
        y: zone.y + row * 220,
        width: 200,
        height: 180,
        data: { text: `Note ${index + 1}: check the build, then the docs`, color: '#fff3a3' },
      });
    }
  }
  const live = all.filter((agent) => agent.state !== 'hibernated');
  const inBig = (agent: Agent) => agent.zoneId === zones[0]!.id;
  const byBusyFirst = (a: Agent, b: Agent) => Number(busyIds.has(b.sessionId)) - Number(busyIds.has(a.sessionId));
  const expand = [...live.filter(inBig).sort(byBusyFirst), ...live.filter((agent) => !inBig(agent)).sort(byBusyFirst)].slice(0, SIZE.expanded);
  return { zones, expand, objects: all.length + zones.length + zones.length * SIZE.notes };
}

/** The installed app at `EXECUTABLE`, on the profile's data dir, its window hidden like the e2e specs' apps and closed by the fixture. */
function launchInstalled(executable: string, dataDir: string, env: Record<string, string>): Promise<ElectronApplication> {
  return trackApp(electron.launch({
    executablePath: executable,
    env: {
      ...process.env,
      ...BACKGROUND_ENV,
      AGENT_BOARD_DATA_DIR: dataDir,
      AGENT_BOARD_HOOK_SHIM: join(dataDir, 'bin', 'agent-board-hook'),
      AGENT_BOARD_FAKE_NOTIFICATIONS: '1',
      AGENT_BOARD_APPEARANCE: 'light',
      ...env,
    },
  }));
}

/** Thread names a breakdown keeps, and what it calls them. */
const THREADS: [RegExp, string][] = [
  [/^CrRendererMain$/, 'main'],
  [/^Compositor$/, 'compositor'],
  [/^CompositorTileWorker/, 'raster'],
  [/^VizCompositorThread$/, 'viz'],
  [/^CrGpuMain$/, 'gpu'],
];

/**
 * Trace events a breakdown sums, by name, each thread's own. The entries nest, so a thread's entries don't add up:
 * `ThreadControllerImpl::RunTask` is the thread's busy time (it holds `RunTask`, which holds the rest), and pairs such
 * as `FunctionCall` and `v8.callFunction`, or `GPUTask` and `CommandBufferStub::OnAsyncFlush`, time the same work.
 */
const KEPT_EVENTS = new Set([
  'RunTask',
  'ThreadControllerImpl::RunTask',
  'FunctionCall',
  'EventDispatch',
  'FireAnimationFrame',
  'TimerFire',
  'v8.callFunction',
  'MajorGC',
  'MinorGC',
  'V8.GC_SCAVENGER',
  'V8.GC_MARK_COMPACTOR',
  'UpdateLayoutTree',
  'Layout',
  'PrePaint',
  'Paint',
  'PaintImage',
  'Layerize',
  'Commit',
  'UpdateLayer',
  'RasterTask',
  'ImageDecodeTask',
  'GPUTask',
  'CommandBufferStub::OnAsyncFlush',
  'Display::DrawAndSwap',
  'ProxyMain::BeginMainFrame',
  'LayerTreeHostImpl::PrepareToDraw',
]);

interface TraceEvent {
  ph: string;
  name: string;
  pid: number;
  tid: number;
  dur?: number;
  args?: { name?: string };
}

/** Where a trace's time went: for each thread kept, the summed ms of each event kept, and its frames' count. */
function breakdown(events: TraceEvent[]): Record<string, Record<string, number>> {
  const threadNames = new Map<string, string>();
  for (const event of events) if (event.ph === 'M' && event.name === 'thread_name') threadNames.set(`${event.pid}:${event.tid}`, event.args?.name ?? '');
  const sums: Record<string, Record<string, number>> = {};
  for (const event of events) {
    if (event.ph !== 'X' || event.dur === undefined || !KEPT_EVENTS.has(event.name)) continue;
    const threadName = threadNames.get(`${event.pid}:${event.tid}`) ?? '';
    const kept = THREADS.find(([pattern]) => pattern.test(threadName));
    if (kept === undefined) continue;
    const thread = (sums[kept[1]] ??= {});
    thread[event.name] = (thread[event.name] ?? 0) + event.dur / 1000;
  }
  for (const thread of Object.values(sums)) for (const name of Object.keys(thread)) thread[name] = Math.round(thread[name]!);
  return sums;
}

/** The bench helpers' tracer, with the compositor's, raster's and GPU's events too, and a breakdown beside each trace. */
function deepTracer(session: CDPSession, breakdowns: Record<string, unknown>): Tracer {
  let events: TraceEvent[] = [];
  session.on('Tracing.dataCollected', ({ value }) => events.push(...(value as unknown as TraceEvent[])));
  return {
    async start() {
      events = [];
      await session.send('Tracing.start', {
        transferMode: 'ReportEvents',
        traceConfig: {
          includedCategories: [
            'toplevel',
            'cc',
            'gpu',
            'viz',
            'devtools.timeline',
            'disabled-by-default-devtools.timeline',
            'disabled-by-default-devtools.timeline.frame',
            'disabled-by-default-v8.cpu_profiler',
            'v8.execute',
            'blink.user_timing',
            'latencyInfo',
          ],
        },
      });
    },
    async stop(name) {
      const done = new Promise<void>((resolve) => session.once('Tracing.tracingComplete', () => resolve()));
      await session.send('Tracing.end');
      await done;
      const file = name.replaceAll(/\W+/g, '-');
      writeFileSync(test.info().outputPath(`trace-${file}.json`), JSON.stringify({ traceEvents: events }));
      breakdowns[name] = breakdown(events);
      console.log(JSON.stringify({ breakdown: name, ...breakdowns[name] as object }));
    },
  };
}

/**
 * A gesture as a trackpad sends it: one wheel event on the board's pane each frame for `frames` frames, each moving
 * (`dx`, `dy`) screen px, or with `pinch` zooming about `at` by `dy` (negative zooms in). It runs in the page, so no
 * round trip to the test sits between two events.
 */
async function gesture(window: Page, { frames, dx = 0, dy = 0, pinch = false, at = { x: 0, y: 0 } }: { frames: number; dx?: number; dy?: number; pinch?: boolean; at?: { x: number; y: number } }): Promise<void> {
  await window.evaluate(
    ({ frames, dx, dy, pinch, at }) =>
      new Promise<void>((resolve) => {
        const pane = document.querySelector('.react-flow__pane')!;
        let left = frames;
        const step = () => {
          pane.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: dx, deltaY: dy, ctrlKey: pinch, clientX: at.x, clientY: at.y }));
          if (--left > 0) requestAnimationFrame(step);
          else requestAnimationFrame(() => resolve());
        };
        requestAnimationFrame(step);
      }),
    { frames, dx, dy, pinch, at },
  );
}

async function zoomOf(window: Page): Promise<number> {
  const style = (await window.locator('.react-flow__viewport').getAttribute('style')) ?? '';
  return Number(/scale\(([\d.e-]+)\)/.exec(style)?.[1] ?? Number.NaN);
}

test.describe.configure({ timeout: 2_400_000 });

test('pan and zoom profile: a 100+ object board, panned and zoomed as a trackpad does, per variant', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-bench-pan-zoom-')));
  const home = join(dir, 'home');
  mkdirSync(home);
  const fake = fakeHarnessEnv({ scenario: 'busy', home, stepDelayMs: 100, idleNotifyMs: 300, backlogLines: 2000, base: {} });
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
    // The renderer the app gives its users (WebGL where it can), where the e2e specs keep to the DOM one.
    AGENT_BOARD_TERMINAL_RENDERER: 'auto',
    AGENT_BOARD_CLICK_OPENS: '',
  };
  const launch = (dataDir: string) => (EXECUTABLE ? launchInstalled(EXECUTABLE, dataDir, env) : launchApp(dataDir, env));
  const dataDir = tempDataDir();
  let first: ElectronApplication | undefined;
  let app: ElectronApplication | undefined;
  try {
    // The board is filled under a first app, and the expanded tiles saved once it has closed, so the second opens on them.
    first = await launch(dataDir);
    await connectedDaemonPid(await first.firstWindow());
    const { zones, expand, objects } = await withDaemon(dataDir, (client) => seed(client, dir));
    await first.close();
    first = undefined;
    await withDaemon(dataDir, async (client) => {
      await client.call('view.set', { key: EXPANDED_VIEW_KEY, value: expand.map((agent) => ({ id: tileSizeKey('agent', agent.sessionId), ...EXPANDED })) });
      if (KEEP_TERMINALS) await client.call('view.set', { key: 'keepTerminals', value: true });
    });

    const board = (app = await launch(dataDir));
    const window = await board.firstWindow();
    await connectedDaemonPid(window);
    await board.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height), WINDOW);
    await board.context().addInitScript(countRenders);
    // Each expanded tile picks its chat, as a click on its Chat switch stores it, before the board reads the picks.
    if (CHAT) {
      const picks = JSON.stringify(Object.fromEntries(expand.map((agent) => [agent.sessionId, 'chat'])));
      await board.context().addInitScript((stored) => localStorage.setItem('agent-board.session-views', stored), picks);
    }
    await window.reload();
    const daemonPid = await connectedDaemonPid(window);
    await expect(window.getByTestId('agent-tile').first()).toBeVisible();
    const cdp = await board.context().newCDPSession(window);
    const breakdowns: Record<string, unknown> = {};
    const trace = TRACE ? deepTracer(cdp, breakdowns) : undefined;
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    const centre = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 };
    const goTo = async (zone: Zone) => {
      await window.getByRole('button', { name: zone.name, exact: true }).click();
      await sleep(1500);
    };
    /** Pinches about the centre until the board's zoom is within 5% of `target`, ten frames a go. */
    const pinchTo = async (target: number) => {
      for (let tries = 0; tries < 20; tries++) {
        const zoom = await zoomOf(window);
        if (Math.abs(Math.log2(target / zoom)) < 0.07) return;
        await gesture(window, { frames: 10, dy: -Math.log2(target / zoom) / (10 * PINCH_OCTAVES), pinch: true, at: centre });
      }
    };
    const gpu = await board.evaluate(({ app }) => app.getGPUFeatureStatus());
    console.log(JSON.stringify({ objects, zones: zones.map((zone) => [zone.name, zone.width, zone.height]), expanded: expand.length, executable: EXECUTABLE ?? 'dev build', gpu }));

    const phases: (Phase & { variant: Variant })[] = [];
    for (const variant of VARIANTS) {
      await window.reload();
      await connectedDaemonPid(window);
      // The reload keeps the last gesture's camera, which may show no tile: go to a zone before waiting for one.
      await goTo(zones[0]!);
      await expect(window.getByTestId('agent-tile').first()).toBeVisible();
      await installRecorders(window);
      if (VARIANT_SCRIPTS[variant]) await window.evaluate(VARIANT_SCRIPTS[variant]);
      const minimap = window.getByRole('button', { name: 'Minimap', exact: true });
      if (variant === 'no-minimap' && (await minimap.getAttribute('aria-pressed')) === 'true') await minimap.click();
      const run = async (name: string, input: () => Promise<void>) => {
        const result = await phase(board, window, cdp, `${variant}: ${name}`, input, { trace, daemonPid });
        phases.push({ ...result, variant });
        console.log(JSON.stringify(phases.at(-1)));
      };
      const [big, second] = zones;
      await goTo(big!);
      await pinchTo(0.12);
      await sleep(3000);
      // Across the whole board, every tile small.
      await run('pan the overview', () => gesture(window, { frames: 120, dx: 24, dy: 4 }));
      await goTo(big!);
      await pinchTo(0.12);
      await sleep(2000);
      // Into the biggest zone until its tiles read, expanded tiles' terminals mounting as they come into view.
      await run('zoom in to a zone', () => gesture(window, { frames: 90, dy: -PINCH_STEP, pinch: true, at: centre }));
      await pinchTo(0.6);
      await sleep(3000);
      // Across the zone at a working zoom, tiles and expanded terminals entering and leaving the view.
      await run('pan a zone', async () => {
        await gesture(window, { frames: 120, dx: 28 });
        await gesture(window, { frames: 120, dx: -28, dy: 10 });
      });
      await sleep(2000);
      // Back out to the overview.
      await run('zoom out to the overview', () => gesture(window, { frames: 90, dy: PINCH_STEP, pinch: true, at: centre }));
      await sleep(2000);
      // From zone to zone at a middle zoom.
      await goTo(second!);
      await pinchTo(0.3);
      await sleep(2000);
      await run('pan between zones', () => gesture(window, { frames: 150, dx: -32 }));
      // Written after each variant, so a run that fails part way keeps what it measured.
      const result = { size: SIZE, objects, keepTerminals: KEEP_TERMINALS, chat: CHAT, executable: EXECUTABLE ?? 'dev build', window: WINDOW, gpu, phases, breakdowns };
      writeFileSync(test.info().outputPath('pan-zoom-bench.json'), `${JSON.stringify(result, null, 2)}\n`);
    }
  } finally {
    await first?.close().catch(() => {});
    await app?.close().catch(() => {});
    // The repos, the fake home with its backlogs, and the worktrees: the fixture removes only the data dir. The daemon and
    // its agents can still be writing there for a moment after the app closes, so a removal that meets a file written
    // under it tries again.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
