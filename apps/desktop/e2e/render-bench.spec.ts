import { expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test';
import type { DaemonClient } from '@agent-board/daemon/client';
import { EXPANDED_VIEW_KEY, tileSizeKey } from '@agent-board/daemon/board-layout';
import { STICKY_COLORS, type Shell } from '@agent-board/daemon/protocol';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { SHELL_ENV } from './agent-helpers.ts';
import { withDaemon } from './board-helpers.ts';
import { test, connectedDaemonPid, launchApp, removeDataDir, tempDataDir } from './launch.ts';

/**
 * The rendering benchmark, run by hand (`pnpm bench:render`), never by a gate:
 * a board of shells with long scrollback, each expanded in place with its live terminal, beside many notes, zoomed and
 * panned while frame gaps, long tasks, terminal mounts and memory are recorded. Plain `sh` sessions stand in for agents:
 * the board draws an agent's terminal and a shell's alike, and nothing here spends a token.
 *
 * From the environment: `BENCH_SHELLS` (20), `BENCH_LINES` of scrollback each (8000), `BENCH_LIVE` shells that keep
 * printing a line every half second (5), `BENCH_NOTES` agent notes and as many sticky notes (60), `BENCH_TRACE=1` to
 * save a DevTools trace of each phase beside the results, `BENCH_CPU_SLOWDOWN` to throttle the renderer's CPU (4 for a
 * slower laptop), and `BENCH_APP_ENV` (JSON) for more of the app's environment.
 * `AGENT_BOARD_HEADED=1` draws on the display, at its own refresh rate; without it the window paints offscreen at 60 Hz.
 */
const SIZE = {
  shells: Number(process.env.BENCH_SHELLS ?? 20),
  lines: Number(process.env.BENCH_LINES ?? 8000),
  live: Number(process.env.BENCH_LIVE ?? 5),
  notes: Number(process.env.BENCH_NOTES ?? 60),
};
const TRACE = process.env.BENCH_TRACE === '1';
/** How many times slower the renderer's CPU runs (DevTools' CPU throttling), to stand in for a slower laptop: 1, none, by default. */
const CPU_SLOWDOWN = Number(process.env.BENCH_CPU_SLOWDOWN ?? 1);
const APP_ENV = JSON.parse(process.env.BENCH_APP_ENV ?? '{}') as Record<string, string>;

/** How big each shell's tile is expanded, and how far apart the tiles are laid out, in board px. */
const EXPANDED = { width: 720, height: 460 };
const COLUMNS = 5;
const PITCH = { x: 820, y: 560 };
/** Where the notes start: below the shells, the sticky notes on the left and the agent notes right of them. */
const NOTES_TOP = Math.ceil(SIZE.shells / COLUMNS) * PITCH.y + 400;
const NOTE_PITCH = 300;
const AGENT_NOTES_LEFT = 10 * NOTE_PITCH + 400;
/** A frame this long is a hitch the eye sees. */
const HITCH_MS = 50;

const NOTE_TEXT = [
  '**Plan**: move the session store to SQLite.',
  '- read the old JSON once',
  '- write rows in one transaction',
  '- keep a backup for a release',
  '',
  'Then _measure_ the start-up time again, and `vacuum` once a week.',
].join('\n');

/** Fills the board through the daemon: the shells, their scrollback (and a live line in some), and the notes. */
async function seed(client: DaemonClient): Promise<Shell[]> {
  const shells: Shell[] = [];
  for (let index = 0; index < SIZE.shells; index++) {
    const position = { x: (index % COLUMNS) * PITCH.x, y: Math.floor(index / COLUMNS) * PITCH.y };
    shells.push(await client.call('shell.create', { zoneId: null, position }));
  }
  // Coloured, numbered lines, as an agent's transcript has: scrollback the daemon keeps and sends on every attachment.
  const fill = `awk 'BEGIN { for (i = 0; i < ${SIZE.lines}; i++) printf "\\033[3%dm%06d\\033[0m \\033[1mtool\\033[0m Read src/session/store-%d.ts: the quick brown fox jumps over the lazy dog\\n", i % 7 + 1, i, i % 97 }'`;
  const live = 'while :; do date; sleep 0.5; done';
  for (const [index, shell] of shells.entries()) {
    await client.call('session.write', { sessionId: paneOf(shell), data: `${fill}${index < SIZE.live ? `; ${live}` : ''}\n` });
  }
  for (let index = 0; index < SIZE.notes; index++) {
    const x = (index % 10) * NOTE_PITCH;
    const y = NOTES_TOP + Math.floor(index / 10) * NOTE_PITCH;
    await client.call('item.create', { kind: 'sticky', zoneId: null, x, y, width: 200, height: 200, data: { text: NOTE_TEXT, color: STICKY_COLORS[index % STICKY_COLORS.length]!.value } });
    await client.call('item.create', {
      kind: 'agent-note',
      zoneId: null,
      x: AGENT_NOTES_LEFT + x,
      y,
      width: 272,
      height: 260,
      data: { text: NOTE_TEXT, agent: { sessionId: '', name: 'lead', harness: 'claude', role: 'orchestrator' }, writtenAt: '2026-10-28T12:00:00.000Z', editedByUser: false },
    });
  }
  // Let the shells print their scrollback.
  await sleep(3000);
  return shells;
}

const paneOf = (shell: Shell): string => {
  if (shell.layout.type !== 'pane') throw new Error('a new shell has one pane');
  return shell.layout.sessionId;
};

/** Installs the recorders in the window: the gaps between frames and the long tasks, while `recording`. */
async function installRecorders(window: Page): Promise<void> {
  await window.evaluate(() => {
    const bench = { recording: false, since: 0, gaps: [] as number[], longTasks: [] as number[], timings: [] as { name: string; startTime: number; duration: number; detail: unknown }[] };
    (window as unknown as { bench: typeof bench }).bench = bench;
    let last = performance.now();
    const tick = (now: number) => {
      if (bench.recording) bench.gaps.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    new PerformanceObserver((list) => {
      if (bench.recording) for (const entry of list.getEntries()) bench.longTasks.push(entry.duration);
    }).observe({ type: 'longtask' });
    // TerminalPane's User Timing measures (`terminal.*`): it clears each as it writes it, so only an observer hears them.
    new PerformanceObserver((list) => {
      for (const { name, startTime, duration, detail } of list.getEntries() as PerformanceMeasure[]) {
        if (name.startsWith('terminal.')) bench.timings.push({ name, startTime, duration, detail });
      }
    }).observe({ type: 'measure' });
  });
}

/**
 * Counts React's renders, by component, while `window.benchRenders.counting`: a stand-in for React DevTools' hook,
 * installed before the page loads. A fiber rendered in a commit if its parent's children were cloned (a subtree React
 * skipped keeps its old children) and it performed work.
 */
function countRenders(): void {
  type Fiber = { tag: number; type: unknown; flags: number; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null };
  const renders = { counting: false, commits: 0, byComponent: {} as Record<string, number> };
  (window as unknown as { benchRenders: typeof renders }).benchRenders = renders;
  const nameOf = (type: unknown): string | undefined => {
    if (typeof type === 'function') return (type as { displayName?: string; name?: string }).displayName ?? (type as { name?: string }).name;
    if (typeof type === 'object' && type !== null) return nameOf((type as { type?: unknown; render?: unknown }).type ?? (type as { render?: unknown }).render);
    return undefined;
  };
  const walk = (fiber: Fiber) => {
    if (fiber.alternate !== null && fiber.alternate.child === fiber.child) return;
    for (let child = fiber.child; child !== null; child = child.sibling) {
      const name = nameOf(child.type);
      // PerformedWork.
      if (name !== undefined && (child.flags & 1) === 1) renders.byComponent[name] = (renders.byComponent[name] ?? 0) + 1;
      walk(child);
    }
  };
  (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    checkDCE: () => {},
    onScheduleFiberRoot: () => {},
    onCommitFiberUnmount: () => {},
    onPostCommitFiberRoot: () => {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      if (!renders.counting) return;
      renders.commits++;
      walk(root.current);
    },
  };
}

interface Phase {
  name: string;
  frames: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Frames longer than `HITCH_MS`. */
  hitches: number;
  longTasks: number;
  longTaskMs: number;
  /** Terminals mounted during the phase (TerminalPane's User Timing marks), and what their snapshots took. */
  mounts: number;
  /** From the mount to the terminal opened and fitted, summed, ms. */
  openMs: number;
  /** The slowest snapshot, from attaching to parsed, ms; and the bytes of all of them. */
  slowestSnapshotMs: number;
  snapshotKb: number;
  /** After the phase: terminals mounted, the renderer's live JS heap (after a collection) and working set, and the page's elements. */
  terminals: number;
  heapMb: number;
  rendererMb: number;
  gpuMb: number;
  domNodes: number;
  /** React commits during the phase, and the components rendered most. */
  commits: number;
  renders: number;
  topRenders: string;
}

function percentiles(gaps: number[]) {
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (p: number) => (sorted.length === 0 ? 0 : Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!.toFixed(1)));
  return { frames: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: at(1), hitches: sorted.filter((gap) => gap > HITCH_MS).length };
}

/** The working set of the board's renderer and of the GPU process, MB. */
async function processMemory(app: ElectronApplication): Promise<{ rendererMb: number; gpuMb: number }> {
  return app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const pid = BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId();
    const metrics = electronApp.getAppMetrics();
    const mb = (kb = 0) => Math.round(kb / 1024);
    return { rendererMb: mb(metrics.find((each) => each.pid === pid)?.memory.workingSetSize), gpuMb: mb(metrics.find((each) => each.type === 'GPU')?.memory.workingSetSize) };
  });
}

/** Runs `input` with the recorders on, and returns what they saw, with the memory and terminals after. */
async function phase(app: ElectronApplication, window: Page, cdp: CDPSession, name: string, input: () => Promise<void>, trace?: Tracer): Promise<Phase> {
  await window.evaluate(() => {
    const bench = (window as unknown as { bench: { recording: boolean; since: number } }).bench;
    bench.since = performance.now();
    bench.recording = true;
    const renders = (window as unknown as { benchRenders?: { counting: boolean; commits: number; byComponent: Record<string, number> } }).benchRenders;
    if (renders) Object.assign(renders, { counting: true, commits: 0, byComponent: {} });
  });
  if (trace) await trace.start();
  await input();
  // What the input started (mounts, snapshots) finishes inside the phase.
  await sleep(1500);
  if (trace) await trace.stop(name);
  const seen = await window.evaluate(() => {
    const bench = (window as unknown as { bench: { recording: boolean; since: number; gaps: number[]; longTasks: number[]; timings: { name: string; startTime: number; duration: number; detail: unknown }[] } }).bench;
    bench.recording = false;
    const renders = (window as unknown as { benchRenders?: { counting: boolean; commits: number; byComponent: Record<string, number> } }).benchRenders ?? { counting: false, commits: 0, byComponent: {} };
    renders.counting = false;
    const since = (entry: { startTime: number }) => entry.startTime >= bench.since;
    const timings = bench.timings.splice(0).filter(since);
    const named = (name: string) => timings.filter((each) => each.name === name);
    const snapshots = named('terminal.snapshot');
    return {
      gaps: bench.gaps.splice(0),
      longTasks: bench.longTasks.splice(0),
      mounts: named('terminal.mount').length,
      openMs: named('terminal.open').reduce((sum, each) => sum + each.duration, 0),
      snapshotMs: snapshots.map((each) => each.duration),
      snapshotBytes: snapshots.reduce((sum, each) => sum + (each.detail as { bytes: number }).bytes, 0),
      terminals: document.querySelectorAll('[data-testid="session-terminal"]').length,
      domNodes: document.getElementsByTagName('*').length,
      commits: renders.commits,
      byComponent: renders.byComponent,
    };
  });
  // The live heap, after a collection: what the phase leaves held.
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  const byCount = Object.entries(seen.byComponent).sort(([, a], [, b]) => b - a);
  return {
    name,
    ...percentiles(seen.gaps),
    longTasks: seen.longTasks.length,
    longTaskMs: Math.round(seen.longTasks.reduce((sum, each) => sum + each, 0)),
    mounts: seen.mounts,
    openMs: Math.round(seen.openMs),
    slowestSnapshotMs: Math.round(Math.max(0, ...seen.snapshotMs)),
    snapshotKb: Math.round(seen.snapshotBytes / 1024),
    terminals: seen.terminals,
    heapMb: Math.round(heap.usedSize / 1e6),
    ...(await processMemory(app)),
    domNodes: seen.domNodes,
    commits: seen.commits,
    renders: byCount.reduce((sum, [, count]) => sum + count, 0),
    topRenders: byCount.slice(0, 8).map(([name, count]) => `${name} ${count}`).join(', '),
  };
}

/** A DevTools trace of a phase, saved beside the results, to open in the Performance panel. */
interface Tracer {
  start(): Promise<void>;
  stop(name: string): Promise<void>;
}

function tracer(session: CDPSession): Tracer {
  let events: unknown[] = [];
  session.on('Tracing.dataCollected', ({ value }) => events.push(...value));
  return {
    async start() {
      events = [];
      await session.send('Tracing.start', {
        transferMode: 'ReportEvents',
        traceConfig: {
          includedCategories: [
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
      writeFileSync(test.info().outputPath(`trace-${name}.json`), JSON.stringify({ traceEvents: events }));
    },
  };
}

/** The board's viewport: React Flow's transform on its viewport element. */
async function viewport(window: Page): Promise<{ x: number; y: number; zoom: number }> {
  const style = (await window.locator('.react-flow__viewport').getAttribute('style')) ?? '';
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec(style);
  if (!match) throw new Error(`unexpected viewport transform: ${style}`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

/**
 * A wheel on the board's bare pane, one drawn frame after: a two-finger pan, or with `pinch` a pinch about (`x`, `y`).
 * Sent to the pane, not to what is under the pointer, so a terminal passing under it never takes the wheel.
 */
async function wheel(window: Page, deltaX: number, deltaY: number, { pinch = false, at = { x: 0, y: 0 } } = {}): Promise<void> {
  await window.evaluate(
    ({ deltaX, deltaY, pinch, at }) => {
      document.querySelector('.react-flow__pane')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX, deltaY, ctrlKey: pinch, clientX: at.x, clientY: at.y }));
      return new Promise(requestAnimationFrame);
    },
    { deltaX, deltaY, pinch, at },
  );
}

/** Pans the board by (`dx`, `dy`) board px at the current zoom, in steps of about `perStep` screen px. */
async function pan(window: Page, dx: number, dy: number, perStep = 30): Promise<void> {
  const { zoom } = await viewport(window);
  const steps = Math.max(1, Math.round(Math.hypot(dx, dy) * zoom / perStep));
  for (let step = 0; step < steps; step++) await wheel(window, (dx * zoom) / steps, (dy * zoom) / steps);
}

/** Pinches about the screen point `at` until the zoom passes `target`, in or out. */
async function zoomTo(window: Page, target: number, at: { x: number; y: number }): Promise<void> {
  const zoomingIn = (await viewport(window)).zoom < target;
  for (let step = 0; step < 200; step++) {
    const { zoom } = await viewport(window);
    if (zoomingIn ? zoom >= target : zoom <= target) return;
    await wheel(window, 0, zoomingIn ? -20 : 20, { pinch: true, at });
  }
  throw new Error(`the zoom never reached ${target}`);
}

/** Pans the board so the board point (`x`, `y`) is at the screen point `to`, in one step. */
async function bringTo(window: Page, x: number, y: number, to: { x: number; y: number }): Promise<void> {
  const view = await viewport(window);
  const pane = (await window.locator('.react-flow__pane').boundingBox())!;
  await wheel(window, view.x + x * view.zoom - (to.x - pane.x), view.y + y * view.zoom - (to.y - pane.y));
}

test.describe.configure({ timeout: 900_000 });

test('rendering benchmark: terminals coming into view, many notes, pan and zoom', async () => {
  const dataDir = tempDataDir();
  let first: ElectronApplication | undefined;
  let app: ElectronApplication | undefined;
  try {
    // The daemon outlives the app: the board is filled while a first app runs, and the shells' expansion saved once it
    // has closed (an open board saves its own), so the second opens on every shell expanded.
    first = await launchApp(dataDir, { ...SHELL_ENV, ...APP_ENV });
    await connectedDaemonPid(await first.firstWindow());
    const shells = await withDaemon(dataDir, seed);
    await first.close();
    first = undefined;
    await withDaemon(dataDir, (client) =>
      client.call('view.set', { key: EXPANDED_VIEW_KEY, value: shells.map((shell) => ({ id: tileSizeKey('shell', shell.id), ...EXPANDED })) }),
    );
    const board = (app = await launchApp(dataDir, { ...SHELL_ENV, ...APP_ENV }));
    const window = await board.firstWindow();
    await connectedDaemonPid(window);
    // The render counter must be in place before React loads: the board is loaded again with it.
    await board.context().addInitScript(countRenders);
    await window.reload();
    await connectedDaemonPid(window);
    if (SIZE.shells > 0) await expect(window.getByTestId('expanded-tile')).not.toHaveCount(0);
    else if (SIZE.notes > 0) await expect(window.getByTestId('sticky')).not.toHaveCount(0);
    await installRecorders(window);
    const cdp = await board.context().newCDPSession(window);
    const trace = TRACE ? tracer(cdp) : undefined;
    if (CPU_SLOWDOWN > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
    const pane = (await window.locator('.react-flow__pane').boundingBox())!;
    const centre = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 };
    const phases: Phase[] = [];
    const run = async (name: string, input: () => Promise<void>) => {
      phases.push(await phase(board, window, cdp, name, input, trace));
      console.log(JSON.stringify(phases.at(-1)));
    };

    // The board opens fitted to everything: every terminal and note is drawn.
    await sleep(3000);
    await run('overview, idle', () => sleep(5000));
    // Into the first shell, at the zoom one works at: the others leave the view.
    await bringTo(window, EXPANDED.width / 2, EXPANDED.height / 2, centre);
    await run('zoom in to a shell', () => zoomTo(window, 1, centre));
    await run('one shell, idle', () => sleep(5000));
    // Panning to the next shell along, three times, then down a row: each one comes into view as it is reached.
    await run('pan to the next shells', async () => {
      for (let column = 1; column < 4; column++) {
        await pan(window, PITCH.x, 0);
        await sleep(400);
      }
      await pan(window, 0, PITCH.y);
    });
    await run('pan back over them', () => pan(window, -3 * PITCH.x, -PITCH.y));
    // The notes, at the same zoom: down to the sticky notes, then along them to the agent notes.
    await run('pan down to the notes', () => pan(window, 0, NOTES_TOP));
    await run('pan across the notes', () => pan(window, AGENT_NOTES_LEFT + 6 * NOTE_PITCH, 0));
    // Back out to everything: every terminal and note comes back at once.
    await run('zoom out to the overview', () => zoomTo(window, 0.15, centre));
    await run('overview, idle again', () => sleep(5000));

    const result = { size: SIZE, cpuSlowdown: CPU_SLOWDOWN, headed: process.env.AGENT_BOARD_HEADED === '1', appEnv: APP_ENV, phases };
    writeFileSync(test.info().outputPath('render-bench.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.table(phases.map(({ name, frames, p50Ms, p95Ms, p99Ms, maxMs, hitches, longTaskMs, mounts, slowestSnapshotMs, terminals, rendererMb, commits, renders }) => ({ name, frames, p50Ms, p95Ms, p99Ms, maxMs, hitches, longTaskMs, mounts, slowestSnapshotMs, terminals, rendererMb, commits, renders })));
    console.log(`results in ${test.info().outputPath('render-bench.json')}`);
  } finally {
    // Stopping the daemon (in removeDataDir) ends its shells, the looping ones too.
    await first?.close();
    await app?.close();
    await removeDataDir(dataDir);
  }
});
