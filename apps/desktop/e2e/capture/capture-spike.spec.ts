import { expect, type ElectronApplication, type Page } from '@playwright/test';
import type { NewZoneParams } from '@agent-board/daemon/protocol';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DemoCapture, DemoCaptureOptions, DemoEncoder } from '../../src/main/demo-capture.ts';
import { launch, tile } from '../agent-helpers.ts';
import { makeRepo } from '../demo-board.ts';
import { removeDataDir, tempDataDir, test } from '../launch.ts';
import { PROMO_RENDER_ARGS, RENDER_ENV } from '../render.ts';
import { scratch } from '../scratch.ts';
import { checkFfmpeg, FFMPEG, OUT, settings } from './shots.ts';

// Whether the board can be recorded for the promo: its offscreen paints at 60 fps and two device pixels per CSS pixel,
// piped to ffmpeg, through one camera flight and one run cycle of the working agents' characters. Run on its own by
// `pnpm --filter @agent-board/desktop promo:spike` (never by the gates); the videos, stills and a report of the frame
// counts, CPU and memory go to PROMO_OUT (default test-results/promo). PROMO_SIZE sets the window in CSS pixels
// (default 1280x720, so 2560x1440 frames, which hold 60 fps; 1920x1080 gives 4K frames, which don't),
// PROMO_ENCODER the encoder (default prores) and PROMO_FFMPEG the ffmpeg binary. CPU is in % of one core, for both the
// app (Chromium's figure for each of its processes, summed) and ffmpeg (ps).
test.use({ viewport: null });

/** Two zones far enough apart for a flight between them, two agents in the first and one in the second. */
async function seedBoard(page: Page, dir: string): Promise<void> {
  const zones = await page.evaluate(
    async ({ web, api }) => {
      const added = async (path: string, params: NewZoneParams) => {
        const result = await window.agentBoard.zones.addFolder(path, params);
        if (result.status !== 'added') throw new Error(result.message);
        return result.zone;
      };
      return {
        web: await added(web, { x: 0, y: 0, width: 840, height: 440, color: '#4c6ef5' }),
        api: await added(api, { x: 2400, y: 900, width: 640, height: 440, color: '#12b886' }),
      };
    },
    { web: makeRepo(dir, 'web-app'), api: makeRepo(dir, 'api-service') },
  );
  const spawn = (zoneId: string, prompt: string, x: number, y: number) =>
    page.evaluate(
      async (params) => {
        const result = await window.agentBoard.agents.spawn(params);
        if (result.status !== 'started') throw new Error(result.message);
      },
      { zoneId, prompt, position: { x, y }, cols: 100, rows: 30 },
    );
  await spawn(zones.web.id, 'Resize images', 30, 60);
  await spawn(zones.web.id, 'Trace session store', 480, 60);
  await spawn(zones.api.id, 'Fix checkout flake', 30, 60);
}

/** Waits until the board's view has stopped moving. */
async function stillView(page: Page): Promise<void> {
  let last = '';
  let stable = 0;
  await expect
    .poll(
      async () => {
        const now = await page.locator('.react-flow__viewport').evaluate((viewport) => (viewport as HTMLElement).style.transform);
        stable = now === last ? stable + 1 : 0;
        last = now;
        return stable;
      },
      { intervals: [100] },
    )
    .toBeGreaterThanOrEqual(5);
}

/** Demo capture in the app's main process (main/demo-capture.ts), there only in demo mode. */
type Demo = { agentBoardDemo: DemoCapture };

interface Sample {
  appCpu: number;
  appMemoryMb: number;
  ffmpegCpu?: number;
  ffmpegMemoryMb?: number;
}

/** ffmpeg's CPU % and resident KB, or nothing once it has exited. */
function ffmpegUsage(pid: number): [cpu?: number, rss?: number] {
  try {
    return execFileSync('ps', ['-o', '%cpu=,rss=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/).map(Number) as [number, number];
  } catch {
    return [];
  }
}

const stopCapture = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as Demo).agentBoardDemo.stop());

/** Records `shot` while `act` runs, sampling the app's and ffmpeg's CPU and memory twice a second. */
async function record(app: ElectronApplication, shot: string, encoder: DemoEncoder, act: () => Promise<void>) {
  const options: DemoCaptureOptions = { out: join(OUT, `${shot}.${encoder.startsWith('prores') ? 'mov' : 'mp4'}`), encoder };
  await app.evaluate((_electron, start) => (globalThis as unknown as Demo).agentBoardDemo.start(start), options);
  const samples: Sample[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      // A sample the app can't give (it is quitting, say) ends the sampling; the shot's own outcome is what's reported.
      const both = await Promise.all([
        app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((metric) => ({ cpu: metric.cpu.percentCPUUsage, kb: metric.memory.workingSetSize }))),
        app.evaluate(() => (globalThis as unknown as Demo).agentBoardDemo.stats()),
      ]).catch(() => undefined);
      if (both === undefined) return;
      const [metrics, stats] = both;
      const sample: Sample = { appCpu: metrics.reduce((sum, metric) => sum + metric.cpu, 0), appMemoryMb: metrics.reduce((sum, metric) => sum + metric.kb, 0) / 1024 };
      // ffmpeg's pid, from the capture that started it: never looked up by name. Once it has exited, ps finds nothing.
      if (stats?.ffmpegPid !== undefined) {
        const [cpu, rss] = ffmpegUsage(stats.ffmpegPid);
        if (rss !== undefined) Object.assign(sample, { ffmpegCpu: cpu, ffmpegMemoryMb: rss / 1024 });
      }
      samples.push(sample);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  })();
  try {
    await act();
  } catch (error) {
    // Stop the capture, so ffmpeg doesn't run on until the app quits; the shot's failure is the one reported.
    sampling = false;
    await sampler;
    await stopCapture(app).catch(() => {});
    throw error;
  }
  sampling = false;
  await sampler;
  const result = await stopCapture(app);
  const summary = (key: keyof Sample) => {
    // Chromium's CPU figure is for the time since it was last asked, so the first of a shot covers the time before it.
    const values = (key === 'appCpu' ? samples.slice(1) : samples).map((sample) => sample[key]).filter((value): value is number => value !== undefined);
    if (values.length === 0) return undefined;
    return { mean: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length), max: Math.round(Math.max(...values)) };
  };
  const report = { shot, encoder, ...result, appCpu: summary('appCpu'), appMemoryMb: summary('appMemoryMb'), ffmpegCpu: summary('ffmpegCpu'), ffmpegMemoryMb: summary('ffmpegMemoryMb') };
  writeFileSync(join(OUT, `${shot}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  expect(result.error).toBeUndefined();
  // Every frame the tap wrote reached the file.
  expect(result.encodedFrames).toBe(result.written);
  return report;
}

test('the promo capture spike: a camera flight and a run cycle at 60 fps and 2x', async () => {
  test.setTimeout(240_000);
  const { width: WIDTH, height: HEIGHT, encoder } = settings();
  checkFfmpeg(encoder);
  mkdirSync(OUT, { recursive: true });
  // Every agent keeps three subagents at work for ten minutes, so their characters move all through the recording.
  const { dir, env } = scratch('subagents-working');
  const dataDir = tempDataDir();
  const { app, window: page } = await launch(dataDir, { ...env, ...RENDER_ENV, FAKE_HARNESS_SUBAGENT_WORK_MS: '600000', AGENT_BOARD_DEMO: '1', ...(FFMPEG === undefined ? {} : { AGENT_BOARD_FFMPEG: FFMPEG }) }, PROMO_RENDER_ARGS);
  try {
    await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, height), [WIDTH, HEIGHT] as const);
    await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([WIDTH, HEIGHT]);
    // The question the spike answers first: an offscreen page paints at the scale it is given.
    expect(await page.evaluate(() => window.devicePixelRatio)).toBe(2);

    await seedBoard(page, dir);
    const working = tile(page).filter({ hasText: 'Resize images' });
    await expect(working.getByTestId('character')).toHaveCount(3, { timeout: 30_000 });
    console.log(`poses: ${(await tile(page).getByTestId('character').evaluateAll((all) => all.map((one) => one.getAttribute('data-pose')))).join(', ')}`);

    // Slower flights than the app's own, as a camera move would be.
    await page.addStyleTag({ content: ':root { --motion-base: 1400ms; }' });
    const zone = (name: string) => page.getByRole('group', { name: 'Zones' }).getByRole('button', { name });
    await zone('web-app').click();
    await stillView(page);

    const flight = await record(app, 'flight', encoder, async () => {
      await zone('api-service').click();
      await stillView(page);
      await zone('web-app').click();
      await stillView(page);
    });
    expect(flight).toMatchObject({ width: WIDTH * 2, height: HEIGHT * 2 });

    // The view is back on the working agents' zone: four seconds of their characters running, with one frame as a still.
    await record(app, 'run-cycle', encoder, async () => {
      await page.waitForTimeout(2_000);
      await app.evaluate((_electron, path) => (globalThis as unknown as Demo).agentBoardDemo.still(path), join(OUT, 'run-cycle.png'));
      await page.waitForTimeout(2_000);
    });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
  }
});
