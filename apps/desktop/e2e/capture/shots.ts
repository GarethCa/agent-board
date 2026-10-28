import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_ENCODERS, type DemoCapture, type DemoEncoder } from '../../src/main/demo-capture.ts';
import { launch } from '../agent-helpers.ts';
import { PROMO_AGENTS, promoEnv, seedPromoBoard, type PromoAgent, type PromoBoard, type PromoPace } from '../demo-board.ts';
import { removeDataDir, tempDataDir } from '../launch.ts';
import { scratch } from '../scratch.ts';
import { PROMO_RENDER_ARGS, RECORDING_SIZE, RENDER_ENV } from '../render.ts';

// What the board recordings share: where they go, the ffmpeg they use, the app launched in its recording profile, and
// a recorder that writes each shot's video with a cue log beside it. The cue log is what an edit cuts by: each beat's
// time in the footage, its clicks, and the frame rectangles to punch in on.

export const OUT = process.env.PROMO_OUT ?? join(import.meta.dirname, '..', '..', 'test-results', 'promo');
// The run's own AGENT_BOARD_* variables never reach the app (global-setup.ts), so the binary comes in under another name.
export const FFMPEG = process.env.PROMO_FFMPEG;

/**
 * The window's CSS size and the encoder, from PROMO_SIZE (else `fallback`) and PROMO_ENCODER, or a failure that says
 * what they take.
 */
export function settings(fallback = '1280x720'): { width: number; height: number; encoder: DemoEncoder } {
  const size = process.env.PROMO_SIZE ?? fallback;
  const encoder = process.env.PROMO_ENCODER ?? 'prores';
  const match = /^([1-9]\d{2,3})x([1-9]\d{2,3})$/.exec(size);
  if (match === null) throw new Error(`PROMO_SIZE is ${size}: give the window's CSS size as WIDTHxHEIGHT, such as 1280x720`);
  if (!Object.hasOwn(DEMO_ENCODERS, encoder)) throw new Error(`PROMO_ENCODER is ${encoder}: give one of ${Object.keys(DEMO_ENCODERS).join(', ')}`);
  return { width: Number(match[1]), height: Number(match[2]), encoder: encoder as DemoEncoder };
}

/** Fails at once, saying what to do, unless the ffmpeg the app will run starts and has the encoder: a recording needs both. */
export function checkFfmpeg(encoder: DemoEncoder): void {
  const binary = FFMPEG ?? 'ffmpeg';
  const codec = DEMO_ENCODERS[encoder][1];
  const run = spawnSync(binary, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 15_000 });
  const why =
    run.error?.message ??
    (run.status === 0 ? undefined : `it exited with ${run.status ?? run.signal}: ${run.stderr.trim().split('\n').slice(0, 3).join(' ')}`) ??
    (new RegExp(`\\s${codec}\\s`).test(run.stdout) ? undefined : `it has no ${codec} encoder`);
  if (why === undefined) return;
  throw new Error(
    `ffmpeg (${binary}) can't record: ${why}. Set PROMO_FFMPEG to an ffmpeg that runs and has ${codec}, or PROMO_ENCODER to one this ffmpeg has ` +
      `(${Object.keys(DEMO_ENCODERS).join(', ')}). Where Homebrew's ffmpeg fails to load a library, \`brew reinstall ffmpeg\` fixes it.`,
  );
}

/** Demo capture in the app's main process (main/demo-capture.ts), there only in demo mode. */
type Demo = { agentBoardDemo: DemoCapture };

/**
 * The app in its recording profile, on the agents' environment `env`: demo mode (two device pixels per CSS pixel, no dev
 * chrome), the Workbench light theme, the window at PROMO_SIZE (by default `RECORDING_SIZE`) and no minimap.
 */
async function launchForShot(dataDir: string, env: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
  const { width, height, encoder } = settings(RECORDING_SIZE);
  checkFfmpeg(encoder);
  const { app, window: page } = await launch(
    dataDir,
    { ...env, ...RENDER_ENV, AGENT_BOARD_DEMO: '1', AGENT_BOARD_APPEARANCE: 'light', ...(FFMPEG === undefined ? {} : { AGENT_BOARD_FFMPEG: FFMPEG }) },
    PROMO_RENDER_ARGS,
  );
  await app.evaluate(({ BrowserWindow }, [width, height]) => BrowserWindow.getAllWindows()[0]!.setContentSize(width, height), [width, height] as const);
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight, window.devicePixelRatio])).toEqual([width, height, 2]);
  const minimap = page.getByRole('button', { name: 'Minimap' });
  if ((await minimap.getAttribute('aria-pressed')) === 'true') await minimap.click();
  await expect(page.locator('.board-minimap')).toHaveCount(0);
  return { app, page };
}

/** A cue as an edit reads it (one per beat): milliseconds from the start of the footage, in its frame's pixels. */
export interface Cue {
  t: number;
  event: string;
  click?: boolean;
  /** The part of the frame to punch in on from this beat, which the edit eases to. */
  zoomRect?: { x: number; y: number; w: number; h: number };
}

/** A shot's cue log, written beside its video as `<shot>.cues.json`. */
export interface ShotCues {
  id: string;
  /** The video's file name, beside the cue log. */
  src: string;
  frame: { w: number; h: number };
  durationMs: number;
  cues: Cue[];
}

type Point = { x: number; y: number };

/** The gap between the pointer's steps as it glides: one frame at 60 fps. */
const FRAME_MS = 1000 / 60;

/** Slow in, slow out: a hand's move rather than a machine's. */
const easeInOut = (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * The cue log of a shot being recorded, and the hand that acts in it: each move, click and keystroke the shot makes is
 * done through it and logged as a cue at its time in the footage. The pointer glides, a step a frame, as a hand would,
 * and real hover states show on the way; the drawn cursor (demo mode's) is in the frames, so cues carry no pointer.
 */
class ShotLog {
  readonly cues: Cue[] = [];
  private readonly page: Page;
  /** Milliseconds into the footage now: the capture's clock, read once, then this process's. */
  private readonly clock: () => number;
  /** Frame pixels per CSS pixel of the page. */
  private readonly scale: number;
  private pointer: Point;

  constructor(page: Page, clock: () => number, scale: number, start: Point) {
    this.page = page;
    this.clock = clock;
    this.scale = scale;
    this.pointer = start;
  }

  /** Logs a beat now. */
  mark(event: string, extra: Omit<Cue, 't' | 'event'> = {}): void {
    this.cues.push({ t: Math.round(this.clock()), event, ...extra });
  }

  /** Logs a beat that punches in on `target`'s box (with `margin` CSS pixels round it), or back out to the whole frame. */
  async punch(event: string, target: Locator | 'out', margin = 40): Promise<void> {
    if (target === 'out') {
      const { innerWidth, innerHeight } = await this.page.evaluate(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight }));
      this.mark(event, { zoomRect: { x: 0, y: 0, w: Math.round(innerWidth * this.scale), h: Math.round(innerHeight * this.scale) } });
      return;
    }
    const box = await target.boundingBox();
    if (box === null) throw new Error(`nothing to punch in on for ${event}: the target isn't on screen`);
    const s = this.scale;
    this.mark(event, {
      zoomRect: { x: Math.round((box.x - margin) * s), y: Math.round((box.y - margin) * s), w: Math.round((box.width + 2 * margin) * s), h: Math.round((box.height + 2 * margin) * s) },
    });
  }

  /** Glides the pointer to `to` (a point, or a locator's centre) over `ms`, eased in and out. */
  async glide(to: Point | Locator, ms = 700): Promise<void> {
    const target = 'x' in to ? to : await centre(to);
    const from = this.pointer;
    const steps = Math.max(1, Math.round(ms / FRAME_MS));
    for (let step = 1; step <= steps; step++) {
      const p = easeInOut(step / steps);
      await this.page.mouse.move(from.x + (target.x - from.x) * p, from.y + (target.y - from.y) * p);
      await this.page.waitForTimeout(FRAME_MS);
    }
    this.pointer = target;
  }

  /** Glides to `target` and clicks it (twice for `double`), logging the click. */
  async click(event: string, target: Locator, { double = false, ms = 700 } = {}): Promise<void> {
    await this.glide(target, ms);
    this.mark(event, { click: true });
    if (double) await this.page.mouse.dblclick(this.pointer.x, this.pointer.y);
    else await this.page.mouse.click(this.pointer.x, this.pointer.y);
  }

  /** Types `text` at a typist's pace, logging when it starts. */
  async type(event: string, text: string, delay = 45): Promise<void> {
    this.mark(event);
    await this.page.keyboard.type(text, { delay });
  }

  /** Holds the shot for `ms`, so a beat has time to read. */
  async hold(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }
}

async function centre(target: Locator): Promise<Point> {
  const box = await target.boundingBox();
  if (box === null) throw new Error('the pointer has nowhere to go: its target is not on screen');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Where the pointer rests before a shot moves it: low on the board, clear of the tiles, so it sets off no hover. */
const REST: Point = { x: 860, y: 560 };

/**
 * Records shot `id` while `act` runs: the video to `OUT/<id>.mov` (or `.mp4`), and its cue log to `OUT/<id>.cues.json`.
 * The cue log's clock starts at the video's first frame. Its `start` and `end` cues are what an edit keeps: `act` may
 * mark either itself where the beat begins or ends (around a wait it can't time), else the footage keeps from its first
 * frame to its last.
 * The drawn cursor shows from the start, at `pointer`.
 */
export async function recordShot(app: ElectronApplication, page: Page, id: string, act: (log: ShotLog) => Promise<void>, pointer: Point = REST): Promise<ShotCues> {
  const { encoder } = settings(RECORDING_SIZE);
  mkdirSync(OUT, { recursive: true });
  const src = `${id}.${encoder.startsWith('prores') ? 'mov' : 'mp4'}`;
  // The drawn cursor follows the mouse from its next move.
  await page.evaluate(() => window.__demo!.cursor!(true));
  await page.mouse.move(pointer.x, pointer.y);
  await app.evaluate((_electron, start) => (globalThis as unknown as Demo).agentBoardDemo.start(start), { out: join(OUT, src), encoder });
  const capture = () => app.evaluate(() => (globalThis as unknown as Demo).agentBoardDemo.stats()!);
  // The capture's clock starts at its first paint: read once that has come, then kept by this process's.
  await expect.poll(async () => (await capture()).written).toBeGreaterThan(0);
  const at = await capture();
  const since = performance.now();
  const scale = at.width / (await page.evaluate(() => window.innerWidth));
  const log = new ShotLog(page, () => at.durationMs + performance.now() - since, scale, pointer);
  log.mark('rolling');
  try {
    await act(log);
  } catch (error) {
    // Stop the capture, so ffmpeg doesn't run on until the app quits; the shot's failure is the one reported.
    await app.evaluate(() => (globalThis as unknown as Demo).agentBoardDemo.stop()).catch(() => {});
    throw error;
  }
  if (!log.cues.some((cue) => cue.event === 'end')) log.mark('end');
  if (!log.cues.some((cue) => cue.event === 'start')) log.cues.unshift({ t: log.cues[0]!.t, event: 'start' });
  const result = await app.evaluate(() => (globalThis as unknown as Demo).agentBoardDemo.stop());
  expect(result.error).toBeUndefined();
  // Every frame the tap wrote reached the file.
  expect(result.encodedFrames).toBe(result.written);
  const shot: ShotCues = { id, src, frame: { w: result.width, h: result.height }, durationMs: Math.round(result.durationMs), cues: log.cues };
  writeFileSync(join(OUT, `${id}.cues.json`), `${JSON.stringify(shot, null, 2)}\n`);
  console.log(`${id}: ${result.written} frames (${result.repeated} repeated, ${result.late} late) in ${Math.round(result.durationMs)} ms, ${log.cues.length} cues`);
  return shot;
}

/**
 * Runs `shot` on a fresh promo board (`seedPromoBoard`) in the recording profile, then closes the app and clears up.
 * `later` names agents the shot starts itself; `pace` sets how fast the agents go.
 */
export async function onPromoBoard(
  { later, pace }: { later?: PromoAgent[]; pace?: PromoPace },
  shot: (on: { app: ElectronApplication; page: Page; board: PromoBoard; dir: string }) => Promise<void>,
): Promise<void> {
  const { dir, env } = scratch('output');
  const dataDir = tempDataDir();
  const { app, page } = await launchForShot(dataDir, promoEnv(dir, env, pace));
  try {
    const board = await seedPromoBoard(page, dir, { later });
    await shot({ app, page, board, dir });
  } finally {
    await app.close();
    await removeDataDir(dataDir);
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Waits until the board's view has stopped moving. */
export async function stillView(page: Page): Promise<void> {
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
    .toBeGreaterThanOrEqual(3);
}

/** Frames `rect` (board coordinates) with the demo camera over `ms`. */
export const camera = (page: Page, rect: { x: number; y: number; width: number; height: number }, ms: number) =>
  page.evaluate(([rect, ms]) => window.__demo!.camera!(rect, ms), [rect, ms] as const);

/** Frames zone `zoneId` with the demo camera over `ms`. */
export const fitZone = (page: Page, zoneId: string, ms: number) => page.evaluate(([zoneId, ms]) => window.__demo!.fit!(zoneId, ms), [zoneId, ms] as const);

/**
 * The box round promo agent `key`'s tile, in board coordinates (its place is kept in its zone's), grown by `margin`
 * for a camera to frame.
 */
export async function tileArea(page: Page, board: PromoBoard, key: PromoAgent, margin: { x: number; y: number; width: number; height: number }) {
  const agent = board.agents[key];
  if (agent === undefined) throw new Error(`${key} isn't on the board`);
  const at = await page.evaluate(async (id) => (await window.agentBoard.agents.list()).find((each) => each.sessionId === id)?.position, agent.sessionId);
  if (at == null) throw new Error(`${key} has no place on the board yet`);
  const zone = board.zones[PROMO_AGENTS[key].zone];
  return { x: zone.x + at.x - margin.x, y: zone.y + at.y - margin.y, width: margin.width, height: margin.height };
}
