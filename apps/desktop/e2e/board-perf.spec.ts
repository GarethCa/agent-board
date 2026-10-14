import { expect, type Page } from '@playwright/test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { test, connectedDaemonPid, launchApp, removeDataDir, tempDataDir } from './launch.ts';

/**
 * What the board is filled with. The gate is 200 tiles; a second scenario adds 300 sticky notes beside 30 tiles, under the
 * same budget.
 */
const SCENARIOS = [
  { name: '200 placeholder tiles', tiles: 200, stickies: 0 },
  { name: '300 placeholder sticky notes and 30 tiles', tiles: 30, stickies: 300 },
] as const;
/**
 * "Smooth", per phase, sampled only while input is being sent. The p95 budget is in display frames, measured on the
 * machine running the test, because CI runners draw at 60 Hz and a dev Mac at 120 Hz. Headless, as e2e runs, the window
 * paints offscreen at 60 Hz, and the frames it measures are those (`AGENT_BOARD_HEADED=1` measures the display's). 2.5
 * frames leaves room for the zoom loop's own pacing: on a 60 Hz runner it waits a round trip per wheel step, which
 * makes two-frame gaps normal. p99 catches hitches. It fails the test locally, but on CI it is only reported, because
 * shared runners stall now and then whatever the board does. The blurred tile shadow this gate exists to catch fails
 * p95 on all three (offscreen, a blur on every tile measured p95 117 ms against a 42 ms budget). This spec runs in its
 * own Playwright project after the others, so no parallel app competes with it.
 */
const BUDGET = { p95Frames: 2.5, p99Ms: 100 };
const ON_CI = Boolean(process.env.CI);

interface PhaseResult {
  frames: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** Installs a frame recorder in the window that keeps the gaps between animation frames while `recording`. */
async function installFrameRecorder(window: Page): Promise<void> {
  await window.evaluate(() => {
    const recorder = { recording: false, gaps: [] as number[] };
    (window as unknown as { frameRecorder: typeof recorder }).frameRecorder = recorder;
    let last = performance.now();
    const tick = (now: number) => {
      if (recorder.recording) recorder.gaps.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Runs `input` with the recorder on, and returns the frame gaps seen while it ran. */
async function framesDuring(window: Page, input: () => Promise<void>): Promise<number[]> {
  const setRecording = (on: boolean) =>
    window.evaluate((value) => {
      (window as unknown as { frameRecorder: { recording: boolean } }).frameRecorder.recording = value;
    }, on);
  await setRecording(true);
  await input();
  await setRecording(false);
  return window.evaluate(() => {
    const recorder = (window as unknown as { frameRecorder: { gaps: number[] } }).frameRecorder;
    return recorder.gaps.splice(0);
  });
}

/** The display's refresh interval: the median gap between frames while nothing happens. */
async function frameInterval(window: Page): Promise<number> {
  const fortyFrames = () =>
    window.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let left = 40;
          const tick = () => (--left === 0 ? resolve() : requestAnimationFrame(tick));
          requestAnimationFrame(tick);
        }),
    );
  return summarise(await framesDuring(window, fortyFrames)).p50Ms;
}

function summarise(gaps: number[]): PhaseResult {
  const sorted = [...gaps].sort((a, b) => a - b);
  const at = (p: number) => Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!.toFixed(1));
  return { frames: sorted.length, p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: at(1) };
}

/** The board's viewport transform: pan offset in screen px, and zoom. */
async function viewport(window: Page): Promise<{ x: number; y: number; zoom: number }> {
  const style = (await window.locator('.react-flow__viewport').getAttribute('style')) ?? '';
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/.exec(style);
  if (!match) throw new Error(`unexpected viewport transform: ${style}`);
  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

/** Adds the numbers to the GitHub Actions job summary, so p99 is visible on CI even though it can't fail there. */
function reportOnCi(result: {
  scenario: string;
  frameMs: number;
  budget: { p95Ms: number; p99Ms: number };
  pan: PhaseResult;
  zoom: PhaseResult;
}): void {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const row = (name: string, phase: PhaseResult) =>
    `| ${name} | ${phase.frames} | ${phase.p50Ms} | ${phase.p95Ms} | ${phase.p99Ms}${phase.p99Ms >= result.budget.p99Ms ? ' ⚠️' : ''} | ${phase.maxMs} |`;
  appendFileSync(
    summary,
    [
      `### Board pan/zoom, ${result.scenario}`,
      '',
      `Frame ${result.frameMs} ms. p95 budget ${result.budget.p95Ms} ms (enforced); p99 budget ${result.budget.p99Ms} ms (reported only on CI).`,
      '',
      '| Phase | Frames | p50 ms | p95 ms | p99 ms | max ms |',
      '| --- | --- | --- | --- | --- | --- |',
      row('pan', result.pan),
      row('zoom', result.zoom),
      '',
    ].join('\n'),
  );
}

for (const scenario of SCENARIOS) {
  test(`pan and zoom stay smooth with ${scenario.name} on the board`, async () => {
    const testInfo = test.info();
    const dataDir = tempDataDir();
    const app = await launchApp(dataDir, {
      AGENT_BOARD_PLACEHOLDER_TILES: String(scenario.tiles),
      ...(scenario.stickies > 0 ? { AGENT_BOARD_PLACEHOLDER_STICKIES: String(scenario.stickies) } : {}),
    });
    try {
      const window = await app.firstWindow();
      await connectedDaemonPid(window);
      // The board opens fitted to every node, so nothing is culled: the worst case.
      await expect(window.locator('[data-representation="hybrid"]')).toHaveCount(scenario.tiles);
      await expect(window.getByTestId('sticky')).toHaveCount(scenario.stickies);
      await installFrameRecorder(window);
      const frameMs = await frameInterval(window);
      const p95BudgetMs = Number((BUDGET.p95Frames * frameMs).toFixed(1));

      const pane = (await window.locator('.react-flow__pane').boundingBox())!;
      const centre = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 };

      // Pan: drag bare desk above the grid (checked, so a drag can't grab a tile instead), there and back and there
      // again, ending 300 px right and 120 px lower than it started.
      // Just right of the board menu, between it and the creation toolbar.
      const menu = (await window.getByTestId('board-menu').boundingBox())!;
      const grab = { x: menu.x + menu.width + 30, y: pane.y + 20 };
      const onDesk = await window.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('react-flow__pane') ?? false,
        grab,
      );
      expect(onDesk, 'the pan grab point is bare desk').toBe(true);
      // With the Hand: in Select mode a drag on bare desk draws a marquee.
      await window.keyboard.press('h');
      await expect(window.getByRole('button', { name: 'Hand' })).toHaveAttribute('aria-pressed', 'true');
      const beforePan = await viewport(window);
      const pan = await framesDuring(window, async () => {
        for (const dx of [300, -300, 300]) {
          await window.mouse.move(grab.x, grab.y);
          await window.mouse.down();
          await window.mouse.move(grab.x + dx, grab.y + 40, { steps: 60 });
          await window.mouse.up();
        }
      });
      const afterPan = await viewport(window);
      expect(afterPan.zoom).toBe(beforePan.zoom);
      expect(afterPan.x - beforePan.x).toBeCloseTo(300, 0);
      expect(afterPan.y - beforePan.y).toBeCloseTo(120, 0);

      // Zoom: wheel in on the middle of the grid, then back out, one rendered frame per step.
      await window.mouse.move(centre.x, centre.y);
      let zoomedIn = 0;
      const zoom = await framesDuring(window, async () => {
        for (const [index, dy] of [...Array<number>(20).fill(-60), ...Array<number>(20).fill(60)].entries()) {
          // A pinch, as Chromium reports it: the wheel with Ctrl.
          await window.evaluate(
            ([x, y, deltaY]) =>
              document.elementFromPoint(x!, y!)!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY, ctrlKey: true })),
            [centre.x, centre.y, dy],
          );
          await window.evaluate(() => new Promise(requestAnimationFrame));
          if (index === 19) zoomedIn = (await viewport(window)).zoom;
        }
      });
      expect(zoomedIn).toBeGreaterThan(afterPan.zoom * 2);

      const result = {
        scenario: scenario.name,
        tiles: scenario.tiles,
        stickies: scenario.stickies,
        frameMs,
        budget: { p95Ms: p95BudgetMs, p99Ms: BUDGET.p99Ms, p99Enforced: !ON_CI },
        pan: summarise(pan),
        zoom: summarise(zoom),
      };
      const path = testInfo.outputPath('board-perf.json');
      writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
      await testInfo.attach('board-perf', { path, contentType: 'application/json' });
      console.log(`board pan/zoom with ${scenario.name}: ${JSON.stringify(result)}`);
      reportOnCi(result);

      for (const phase of ['pan', 'zoom'] as const) {
        expect(result[phase].frames, `${phase} frames`).toBeGreaterThan(30);
        expect(result[phase].p95Ms, `${phase} p95`).toBeLessThan(p95BudgetMs);
        if (ON_CI) {
          if (result[phase].p99Ms >= BUDGET.p99Ms) {
            testInfo.annotations.push({
              type: 'warning',
              description: `${phase} p99 ${result[phase].p99Ms} ms is over ${BUDGET.p99Ms} ms (reported only on CI)`,
            });
          }
        } else {
          expect(result[phase].p99Ms, `${phase} p99`).toBeLessThan(BUDGET.p99Ms);
        }
      }
    } finally {
      await app.close();
      await removeDataDir(dataDir);
    }
  });
}
