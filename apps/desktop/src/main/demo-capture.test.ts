import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFrameTap } from './demo-capture-core';
import { ffmpegEncoder } from './demo-capture';

// The encoder's failure paths, against shell scripts standing in for ffmpeg: each must end promptly and say why.
const dir = mkdtempSync(join(tmpdir(), 'demo-capture-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in ffmpeg running `body` as a shell script. */
function fakeFfmpeg(name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const size = { width: 256, height: 256 };
const frame = Buffer.alloc(size.width * size.height * 4);
const encoder = (binary: string, finishMs?: number) =>
  ffmpegEncoder({ binary, out: join(dir, 'out.mov'), encoder: 'prores', size, fps: 60, ...(finishMs === undefined ? {} : { finishMs }) });

/** How long `promise` takes to settle, in ms, with what it settled to. */
async function timed<T>(promise: Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await promise;
  return { ms: performance.now() - start, value };
}

/** True while any process in `pid`'s process group lives. */
function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The limits below are loose on purpose, for a busy machine: they catch the 10 to 90 s waits these paths once had.
describe('ffmpegEncoder', { timeout: 20_000 }, () => {
  it('hands every frame to an ffmpeg that reads them all, and reports the frames it counted', async () => {
    const ffmpeg = encoder(fakeFfmpeg('reads-all', 'cat > /dev/null; echo "frame=    3 fps=60" >&2'));
    for (let i = 0; i < 3; i++) ffmpeg.write(frame);
    await expect(ffmpeg.end()).resolves.toEqual({ encodedFrames: 3 });
  });

  it('ends cleanly when no frame was written', async () => {
    const ffmpeg = encoder(fakeFfmpeg('no-frames', 'cat > /dev/null'));
    await expect(ffmpeg.end()).resolves.toEqual({});
  });

  it('names a binary that is not there, rather than an exit code', async () => {
    const missing = join(dir, 'no-such-ffmpeg');
    const ffmpeg = encoder(missing);
    ffmpeg.write(frame);
    const { error } = await ffmpeg.end();
    expect(error).toContain(missing);
    expect(error).toContain('ENOENT');
  });

  it('reports a crash by ffmpeg’s exit and what it printed, ahead of the broken pipe it leaves', async () => {
    const ffmpeg = encoder(fakeFfmpeg('crashes', 'head -c 100000 > /dev/null; echo boom >&2; exit 3'));
    for (let i = 0; i < 4; i++) ffmpeg.write(frame);
    await expect(ffmpeg.end()).resolves.toMatchObject({ error: 'ffmpeg exited with 3: boom' });
  });

  it('frees a tap waiting on a full pipe when ffmpeg dies, so stop is prompt and says why', async () => {
    const ffmpeg = encoder(fakeFfmpeg('dies-unread', 'sleep 0.3; echo boom >&2; exit 3'));
    const tap = createFrameTap({ fps: 60, now: () => performance.now(), openEncoder: () => ffmpeg });
    tap.paint({ size: () => size, bitmap: () => frame });
    const timer = setInterval(() => tap.tick(), 4);
    await new Promise((resolve) => setTimeout(resolve, 600));
    clearInterval(timer);
    // More than the queue's limit was due while ffmpeg read nothing: the tap was waiting on a pipe that never drains.
    expect(tap.stats().backpressure).toBeGreaterThan(0);
    const { ms, value } = await timed(tap.stop());
    expect(ms).toBeLessThan(5_000);
    expect(value.error).toBe('ffmpeg exited with 3: boom');
  });

  it('keeps tiny frames flowing once a late ffmpeg catches up, rather than wait for a drain that never comes', async () => {
    // 1.5 KB frames: more than the OS pipe holds arrive before ffmpeg reads, yet 8 of them stay under Node's 16 KB mark,
    // past which alone it promises a 'drain'.
    const tiny = { width: 24, height: 16 };
    const ffmpeg = ffmpegEncoder({ binary: fakeFfmpeg('reads-tiny-late', 'sleep 1; cat > /dev/null'), out: join(dir, 'tiny.mov'), encoder: 'prores', size: tiny, fps: 60 });
    const tap = createFrameTap({ fps: 60, now: () => performance.now(), openEncoder: () => ffmpeg, stallMs: 1_000 });
    tap.paint({ size: () => tiny, bitmap: () => Buffer.alloc(tiny.width * tiny.height * 4) });
    const timer = setInterval(() => tap.tick(), 4);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    clearInterval(timer);
    const result = await tap.stop();
    expect(result.error).toBeUndefined();
    expect(result.written).toBe(result.expected);
  });

  it('stops an ffmpeg that never finishes, once the finish time has passed', async () => {
    const ffmpeg = encoder(fakeFfmpeg('never-reads', 'exec sleep 600'), 300);
    ffmpeg.write(frame);
    const { ms, value } = await timed(ffmpeg.end());
    expect(ms).toBeLessThan(5_000);
    expect(value.error).toBe("ffmpeg didn't finish within 0.3 s of its input ending, so it was stopped");
    expect(groupAlive(ffmpeg.pid!)).toBe(false);
  });

  it('stops what a wrapper script started too, rather than wait for it to exit by itself', async () => {
    const ffmpeg = encoder(fakeFfmpeg('wrapper', 'sleep 600'), 300);
    ffmpeg.write(frame);
    const { ms, value } = await timed(ffmpeg.end());
    expect(ms).toBeLessThan(5_000);
    expect(value.error).toBe("ffmpeg didn't finish within 0.3 s of its input ending, so it was stopped");
    expect(groupAlive(ffmpeg.pid!)).toBe(false);
  });
});
