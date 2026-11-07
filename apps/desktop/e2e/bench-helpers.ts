import type { CDPSession, ElectronApplication, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from './launch.ts';

/**
 * What the benchmarks (`render-bench.spec.ts`, `agents-bench.spec.ts`) record and how they move the
 * board: frame gaps, long tasks, terminal mounts, React renders, memory and CPU, phase by phase.
 */

/** A frame this long is a hitch the eye sees. */
const HITCH_MS = 50;

/** Installs the recorders in the window: the gaps between frames and the long tasks, while `recording`. */
export async function installRecorders(window: Page): Promise<void> {
  await window.evaluate(() => {
    const bench = { recording: false, since: 0, gaps: [] as number[], frameTimes: [] as number[], longTasks: [] as number[], parked: undefined as { count: number; bytes: number } | undefined, timings: [] as { name: string; startTime: number; duration: number; detail: unknown }[] };
    (window as unknown as { bench: typeof bench }).bench = bench;
    let last = performance.now();
    const tick = (now: number) => {
      if (bench.recording) {
        bench.gaps.push(now - last);
        bench.frameTimes.push(now);
      }
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
        if (name === 'terminal.parked') bench.parked = detail as typeof bench.parked;
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
export function countRenders(): void {
  type Fiber = { tag: number; type: unknown; flags: number; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null };
  const renders = { counting: false, commits: 0, byComponent: {} as Record<string, number> };
  (window as unknown as { benchRenders: typeof renders }).benchRenders = renders;
  const nameOf = (type: unknown): string | undefined => {
    if (typeof type === 'function') return (type as { displayName?: string; name?: string }).displayName ?? (type as { name?: string }).name;
    if (typeof type === 'object' && type !== null) return nameOf((type as { type?: unknown; render?: unknown }).type ?? (type as { render?: unknown }).render);
    return undefined;
  };
  // An anonymous component (an arrow function, an unnamed memo) is named by the nearest named one it renders inside.
  const walk = (fiber: Fiber, inside: string) => {
    if (fiber.alternate !== null && fiber.alternate.child === fiber.child) return;
    for (let child = fiber.child; child !== null; child = child.sibling) {
      const own = nameOf(child.type);
      const name = own === '' ? `(anonymous in ${inside})` : own;
      // PerformedWork.
      if (name !== undefined && (child.flags & 1) === 1) renders.byComponent[name] = (renders.byComponent[name] ?? 0) + 1;
      walk(child, own ? own : inside);
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
      walk(root.current, 'the root');
    },
  };
}

export interface Phase {
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
  /** The slowest fill, from a snapshot arriving to its last byte parsed: how long a terminal is seen part drawn. */
  slowestFillMs: number;
  /** The most frames painted during one terminal's fill, each showing it part drawn. */
  mostFillFrames: number;
  /** The time spent making WebGL renderers on the main thread, all terminals together. */
  gpuMs: number;
  /** The time spent redrawing WebGL terminals for a new zoom on the main thread, all terminals together, and how many redraws. */
  rasterMs: number;
  rasters: number;
  /** How many times a terminal already attached resized its session; a new terminal's first size isn't among them. */
  resizes: number;
  /** The terminals parked off screen, as of the last that left its pane, and what they hold by the budget's estimate. */
  parked: number;
  parkedMb: number;
  /** Terminals let go during the phase, for the budget or because their session ended. */
  letGo: number;
  /** The longest wait for a snapshot to arrive after attaching: attach to parsed, less the fill. */
  slowestWaitMs: number;
  snapshotKb: number;
  /** After the phase: terminals mounted, the renderer's live JS heap (after a collection) and working set, and the page's elements. */
  terminals: number;
  heapMb: number;
  rendererMb: number;
  gpuMb: number;
  /** The app's main process's working set: a kept terminal holds a connection to the daemon there. */
  mainMb: number;
  /**
   * CPU over the phase, as a share of one core (100 is one core busy throughout): the board's renderer, the app's main
   * process, the GPU process and the daemon. And the daemon's resident memory after it, MB.
   */
  rendererCpu: number;
  mainCpu: number;
  gpuCpu: number;
  daemonCpu: number;
  daemonMb: number;
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

/**
 * The working set of the board's renderer and of the GPU process, MB, and their CPU and the main process's since the
 * last call (Electron's own reading, a share of one core).
 */
export async function processMetrics(app: ElectronApplication): Promise<{ rendererMb: number; gpuMb: number; mainMb: number; rendererCpu: number; mainCpu: number; gpuCpu: number }> {
  return app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const pid = BrowserWindow.getAllWindows()[0]!.webContents.getOSProcessId();
    const metrics = electronApp.getAppMetrics();
    const renderer = metrics.find((each) => each.pid === pid);
    const gpu = metrics.find((each) => each.type === 'GPU');
    const main = metrics.find((each) => each.type === 'Browser');
    const mb = (kb = 0) => Math.round(kb / 1024);
    const cpu = (share = 0) => Math.round(share);
    return {
      rendererMb: mb(renderer?.memory.workingSetSize),
      gpuMb: mb(gpu?.memory.workingSetSize),
      mainMb: mb(main?.memory.workingSetSize),
      rendererCpu: cpu(renderer?.cpu.percentCPUUsage),
      mainCpu: cpu(main?.cpu.percentCPUUsage),
      gpuCpu: cpu(gpu?.cpu.percentCPUUsage),
    };
  });
}

/**
 * A process's CPU time so far, seconds, and resident memory, MB, from `ps`: the daemon's, which Electron doesn't see.
 * Undefined once it has exited.
 */
export function processUsage(pid: number): { cpuSeconds: number; mb: number } | undefined {
  let line: string;
  try {
    line = execFileSync('ps', ['-o', 'time=,rss=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
  const [time = '0', rss = '0'] = line.split(/\s+/);
  // [[hh:]mm:]ss.cc
  const cpuSeconds = time.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  return { cpuSeconds, mb: Math.round(Number(rss) / 1024) };
}

/** The share of one core a process used between two readings `seconds` apart, and its memory after: NaN once it has gone. */
function usageBetween(before: ReturnType<typeof processUsage>, after: ReturnType<typeof processUsage>, seconds: number): { cpu: number; mb: number } {
  if (before === undefined || after === undefined) return { cpu: NaN, mb: NaN };
  return { cpu: Math.round(((after.cpuSeconds - before.cpuSeconds) / seconds) * 100), mb: after.mb };
}

export async function phase(app: ElectronApplication, window: Page, cdp: CDPSession, name: string, input: () => Promise<void>, { trace, daemonPid }: { trace?: Tracer; daemonPid: number }): Promise<Phase> {
  // Each reading is of the time since the one before: these start the phase's.
  await processMetrics(app);
  const daemonBefore = processUsage(daemonPid);
  const startedAt = performance.now();
  await window.evaluate(() => {
    const bench = (window as unknown as { bench: { recording: boolean; since: number } }).bench;
    bench.since = performance.now();
    bench.recording = true;
    const renders = (window as unknown as { benchRenders?: { counting: boolean; commits: number; byComponent: Record<string, number> } }).benchRenders;
    if (renders) Object.assign(renders, { counting: true, commits: 0, byComponent: {} });
  });
  if (trace) await trace.start();
  await input();
  // Every terminal the input built parses its snapshot within the phase, however slow, before it settles (a kept one
  // taken over parses none).
  for (let tries = 0; tries < 100; tries++) {
    const pending = await window.evaluate(() => {
      const { since, timings } = (window as unknown as { bench: { since: number; timings: { name: string; startTime: number; detail: unknown }[] } }).bench;
      const count = (name: string) => timings.filter((each) => each.name === name && each.startTime >= since && !(each.detail as { kept?: boolean } | null)?.kept).length;
      return count('terminal.mount') - count('terminal.snapshot');
    });
    if (pending <= 0) break;
    if (tries === 99) console.log(`${name}: ${pending} terminal(s) never parsed a snapshot within the phase (unmounted first?)`);
    await sleep(200);
  }
  // What the input started (mounts, snapshots) finishes inside the phase.
  await sleep(1500);
  if (trace) await trace.stop(name);
  const processes = await processMetrics(app);
  const daemonAfter = processUsage(daemonPid);
  const seconds = (performance.now() - startedAt) / 1000;
  const seen = await window.evaluate(() => {
    const bench = (window as unknown as { bench: { recording: boolean; since: number; gaps: number[]; frameTimes: number[]; longTasks: number[]; parked?: { count: number; bytes: number }; timings: { name: string; startTime: number; duration: number; detail: unknown }[] } }).bench;
    bench.recording = false;
    const renders = (window as unknown as { benchRenders?: { counting: boolean; commits: number; byComponent: Record<string, number> } }).benchRenders ?? { counting: false, commits: 0, byComponent: {} };
    renders.counting = false;
    const since = (entry: { startTime: number }) => entry.startTime >= bench.since;
    const timings = bench.timings.splice(0).filter(since);
    const named = (name: string) => timings.filter((each) => each.name === name);
    const snapshots = named('terminal.snapshot');
    const frameTimes = bench.frameTimes.splice(0);
    // Each terminal's fill, and the frames painted while it was part drawn: the top-down look.
    const fills = named('terminal.fill').map(({ startTime, duration }) => ({
      ms: duration,
      frames: frameTimes.filter((at) => at > startTime && at < startTime + duration).length,
    }));
    return {
      gpuMs: named('terminal.gpu').map((each) => each.duration),
      rasterMs: named('terminal.raster').map((each) => each.duration),
      resizes: named('terminal.resize').length,
      // The parked terminals, as of the last that left its pane, and how many the phase let go.
      parked: bench.parked ?? { count: 0, bytes: 0 },
      letGo: named('terminal.letGo').length,
      // The wait before each terminal's snapshot arrived: attach to parsed, less the fill.
      waitMs: snapshots.map((snapshot) => {
        const id = (snapshot.detail as { sessionId: string }).sessionId;
        const fill = named('terminal.fill').find((each) => (each.detail as { sessionId: string }).sessionId === id);
        return fill === undefined ? 0 : snapshot.duration - fill.duration;
      }),
      fillMs: fills.map((each) => each.ms),
      fillFrames: fills.map((each) => each.frames),
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
    slowestFillMs: Math.round(Math.max(0, ...seen.fillMs)),
    gpuMs: Math.round(seen.gpuMs.reduce((sum, each) => sum + each, 0)),
    rasterMs: Math.round(seen.rasterMs.reduce((sum, each) => sum + each, 0)),
    rasters: seen.rasterMs.length,
    resizes: seen.resizes,
    parked: seen.parked.count,
    parkedMb: Math.round(seen.parked.bytes / 1e6),
    letGo: seen.letGo,
    slowestWaitMs: Math.round(Math.max(0, ...seen.waitMs)),
    mostFillFrames: Math.max(0, ...seen.fillFrames),
    snapshotKb: Math.round(seen.snapshotBytes / 1024),
    terminals: seen.terminals,
    heapMb: Math.round(heap.usedSize / 1e6),
    ...processes,
    daemonCpu: usageBetween(daemonBefore, daemonAfter, seconds).cpu,
    daemonMb: usageBetween(daemonBefore, daemonAfter, seconds).mb,
    domNodes: seen.domNodes,
    commits: seen.commits,
    renders: byCount.reduce((sum, [, count]) => sum + count, 0),
    topRenders: byCount.slice(0, 16).map(([name, count]) => `${name} ${count}`).join(', '),
  };
}

/** A DevTools trace of a phase, saved beside the results, to open in the Performance panel. */
export interface Tracer {
  start(): Promise<void>;
  stop(name: string): Promise<void>;
}

export function tracer(session: CDPSession): Tracer {
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
export async function pan(window: Page, dx: number, dy: number, perStep = 30): Promise<void> {
  const { zoom } = await viewport(window);
  const steps = Math.max(1, Math.round(Math.hypot(dx, dy) * zoom / perStep));
  for (let step = 0; step < steps; step++) await wheel(window, (dx * zoom) / steps, (dy * zoom) / steps);
}

/** Pinches about the screen point `at` until the zoom passes `target`, in or out. */
export async function zoomTo(window: Page, target: number, at: { x: number; y: number }): Promise<void> {
  const zoomingIn = (await viewport(window)).zoom < target;
  for (let step = 0; step < 200; step++) {
    const { zoom } = await viewport(window);
    if (zoomingIn ? zoom >= target : zoom <= target) return;
    await wheel(window, 0, zoomingIn ? -20 : 20, { pinch: true, at });
  }
  throw new Error(`the zoom never reached ${target}`);
}

/** Pans the board so the board point (`x`, `y`) is at the screen point `to`, in one step. */
export async function bringTo(window: Page, x: number, y: number, to: { x: number; y: number }): Promise<void> {
  const view = await viewport(window);
  const pane = (await window.locator('.react-flow__pane').boundingBox())!;
  await wheel(window, view.x + x * view.zoom - (to.x - pane.x), view.y + y * view.zoom - (to.y - pane.y));
}
