// Demo capture (`AGENT_BOARD_DEMO=1`, never in a packaged build): records the board's window to a video file for the
// promo, from its offscreen paints through ffmpeg. A Playwright spec starts and stops it through `electronApp.evaluate`,
// which reaches it as `globalThis.agentBoardDemo`. The window must paint offscreen (headless mode): a shown window
// sends no paints.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import type { BrowserWindow, NativeImage, WebContents } from 'electron';
import { createFrameTap, type CaptureStats, type Encoder, type EncoderResult, type FrameTap } from './demo-capture-core';

/** ffmpeg's output settings for each encoder a capture may ask for. The VideoToolbox ones run on the Mac's media engine. */
export const DEMO_ENCODERS = {
  prores: ['-c:v', 'prores_videotoolbox', '-profile:v', 'hq'],
  'prores-sw': ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le'],
  h264: ['-c:v', 'h264_videotoolbox', '-b:v', '80M', '-pix_fmt', 'yuv420p'],
  x264: ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p'],
} as const;
export type DemoEncoder = keyof typeof DEMO_ENCODERS;

/** The device pixels per CSS pixel the board's window paints at in demo mode, for frames sharp enough to zoom into. */
export const DEMO_SCALE = 2;

/** How often the tap checks for due frames: several times a frame, so none waits long past its time. */
const TICK_MS = 4;

/**
 * The most frames ffmpeg may have queued unread: the tap waits for it from there, so a slow encoder can't fill the memory.
 * Node writes a pipe's queue in one call, which macOS refuses (EINVAL) past 2 GB: 60 frames at 4K.
 */
const MAX_QUEUED_FRAMES = 8;

/** How long ffmpeg may take to finish once its input ends before it is stopped: it has at most a few frames left. */
const FINISH_MS = 30_000;

export interface DemoCaptureOptions {
  /** The video file, `.mov` for ProRes, `.mp4` otherwise. */
  out: string;
  encoder?: DemoEncoder;
  fps?: number;
}

export interface DemoCapture {
  start(options: DemoCaptureOptions): void;
  /** How the running capture is going, and ffmpeg's pid while it runs. */
  stats(): (CaptureStats & { ffmpegPid?: number }) | undefined;
  /** Writes the newest paint as a PNG, at the size it was painted. */
  still(path: string): Promise<void>;
  stop(): Promise<CaptureStats & EncoderResult>;
}

export interface FfmpegOptions {
  /** The ffmpeg to run: `AGENT_BOARD_FFMPEG`, or `ffmpeg` on the PATH, by default. */
  binary?: string;
  out: string;
  encoder: DemoEncoder;
  size: { width: number; height: number };
  fps: number;
  /** How long ffmpeg may take to finish once its input ends before it is stopped. */
  finishMs?: number;
}

/**
 * ffmpeg reading raw BGRA frames of `size` on stdin and writing `out`. It runs in a process group of its own, so that
 * stopping it also stops whatever it started: a wrapper script's real ffmpeg, say. The group is stopped if the app exits
 * while it runs; only an app killed outright (SIGKILL) leaves it running.
 */
export function ffmpegEncoder({
  binary = process.env.AGENT_BOARD_FFMPEG ?? 'ffmpeg',
  out,
  encoder,
  size,
  fps,
  finishMs = FINISH_MS,
}: FfmpegOptions): Encoder & { pid?: number } {
  const input = ['-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${size.width}x${size.height}`, '-framerate', String(fps), '-i', 'pipe:0'];
  const child = spawn(binary, ['-hide_banner', '-loglevel', 'error', '-stats', ...input, ...DEMO_ENCODERS[encoder], '-y', out], {
    stdio: ['pipe', 'ignore', 'pipe'],
    detached: true,
  });
  let log = '';
  let failed: string | undefined;
  let unstarted: string | undefined;
  child.stderr.on('data', (chunk: Buffer) => (log = (log + chunk.toString()).slice(-4_000)));
  child.on('error', (error) => {
    if (child.pid === undefined) unstarted ??= `ffmpeg (${binary}) couldn't start: ${error.message}`;
    else failed ??= error.message;
  });
  // ffmpeg exiting early breaks the pipe, and its exit code says why, below; any other failed write is the capture's error.
  child.stdin.on('error', (error) => (failed ??= `writing to ffmpeg failed: ${error.message}`));
  // Its own process group, by the pid it was given: nothing else is signalled.
  const stopGroup = () => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // The group has gone already.
    }
  };
  process.once('exit', stopGroup);
  let exited = false;
  let ended = false;
  const closed = new Promise<string | number | null>((resolve) =>
    child.on('close', (code, signal) => {
      exited = true;
      process.off('exit', stopGroup);
      resolve(code ?? signal);
    }),
  );
  const drainListeners: (() => void)[] = [];
  // A pipe that breaks never drains: a tap waiting for it would wait for ever, so its going counts as a drain too.
  child.stdin.on('close', () => drainListeners.forEach((listener) => listener()));
  const frameBytes = size.width * size.height * 4;
  /** `closed`, or undefined once `ms` have passed without it. */
  const closedWithin = async (ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([closed, new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)))]);
    clearTimeout(timer);
    return code;
  };
  return {
    pid: child.pid,
    write: (bitmap) => {
      // Nothing should write once the input has ended; if something does, the report says where from.
      if (ended) failed ??= `a frame was written after ffmpeg's input ended: ${new Error().stack?.split('\n').slice(2, 5).join(' ')}`;
      // Once ffmpeg has gone, frames go nowhere: the tap is told all is well, so it finishes rather than wait for a drain.
      if (ended || exited || failed !== undefined) return true;
      // Behind only once Node itself says so, since only then will it say 'drain'; and then only past the queue's limit.
      return child.stdin.write(bitmap) || child.stdin.writableLength < MAX_QUEUED_FRAMES * frameBytes;
    },
    onDrain: (listener) => {
      drainListeners.push(listener);
      child.stdin.on('drain', listener);
    },
    async end() {
      ended = true;
      child.stdin.end();
      let code = await closedWithin(finishMs);
      const finished = code !== undefined;
      if (!finished) {
        stopGroup();
        failed ??= `ffmpeg didn't finish within ${finishMs / 1000} s of its input ending, so it was stopped`;
        // Its group is gone, so nothing holds its pipes open; should anything still, stop waiting on them.
        code = await closedWithin(2_000);
        child.stdin.destroy();
        child.stderr.destroy();
      }
      const counted = [...log.matchAll(/frame=\s*(\d+)/g)].at(-1)?.[1];
      // ffmpeg's exit says why a pipe broke, so it comes before the broken pipe.
      const exit = code === 0 || code === undefined ? undefined : `ffmpeg exited with ${code}: ${log.trim().slice(-500)}`;
      const error = unstarted ?? (finished ? (exit ?? failed) : failed);
      return {
        ...(counted === undefined ? {} : { encodedFrames: Number(counted) }),
        ...(error === undefined ? {} : { error }),
      };
    },
  };
}

/** Captures `contents()`, the board's page, one recording at a time. */
function createDemoCapture(contents: () => WebContents | undefined): DemoCapture {
  let running:
    | {
        tap: FrameTap;
        page: WebContents;
        timer: NodeJS.Timeout;
        listener: (event: unknown, dirty: unknown, image: NativeImage) => void;
        ffmpeg: { pid?: number };
      }
    | undefined;
  let newest: NativeImage | undefined;

  return {
    start({ out, encoder = 'prores', fps = 60 }) {
      if (running !== undefined) throw new Error('a demo capture is already running');
      const page = contents();
      if (page === undefined) throw new Error('there is no board window to capture');
      if (!page.isOffscreen()) throw new Error('the board window paints on screen, so it sends no frames: run headless');
      const ffmpeg: { pid?: number } = {};
      const tap = createFrameTap({
        fps,
        now: () => performance.now(),
        openEncoder: (size) => {
          const opened = ffmpegEncoder({ out, encoder, size, fps });
          ffmpeg.pid = opened.pid;
          return opened;
        },
      });
      const listener = (_event: unknown, _dirty: unknown, image: NativeImage) => {
        newest = image;
        tap.paint({
          size: () => image.getSize(),
          bitmap: () => image.toBitmap(),
        });
      };
      page.setFrameRate(fps);
      page.on('paint', listener);
      running = {
        tap,
        page,
        listener,
        ffmpeg,
        timer: setInterval(() => tap.tick(), TICK_MS),
      };
      // A still page sends no paint until something changes: ask for the first one now.
      page.invalidate();
    },
    stats: () =>
      running && {
        ...running.tap.stats(),
        ...(running.ffmpeg.pid === undefined ? {} : { ffmpegPid: running.ffmpeg.pid }),
      },
    async still(path) {
      if (newest === undefined) throw new Error('nothing has been painted yet');
      await writeFile(path, newest.toPNG());
    },
    async stop() {
      if (running === undefined) throw new Error('no demo capture is running');
      const { tap, page, timer, listener } = running;
      running = undefined;
      clearInterval(timer);
      if (!page.isDestroyed()) page.off('paint', listener);
      return tap.stop();
    },
  };
}

/** Puts demo capture where `electronApp.evaluate` reaches it, capturing whichever window `board()` gives. */
export function registerDemoCapture(board: () => BrowserWindow | undefined): void {
  (globalThis as { agentBoardDemo?: DemoCapture }).agentBoardDemo = createDemoCapture(() => {
    const window = board();
    return window === undefined || window.isDestroyed() ? undefined : window.webContents;
  });
}
