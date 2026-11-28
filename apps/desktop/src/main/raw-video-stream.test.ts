import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegEncoder } from './demo-capture';
import { rawVideoFrameHeader, rawVideoHeader } from './raw-video-stream';

interface Element {
  id: number;
  /** Undefined for a size marked unknown. */
  size?: number;
  body: Buffer;
}

/** Reads the EBML element at `at` in `bytes`: its ID, its size and its body (to the end, for an unknown size). */
function readElement(bytes: Buffer, at: number): Element & { end: number } {
  const idLength = Math.clz32(bytes[at]!) - 23;
  const id = bytes.readUIntBE(at, idLength);
  const sizeAt = at + idLength;
  const sizeLength = Math.clz32(bytes[sizeAt]!) - 23;
  const raw = bytes.subarray(sizeAt, sizeAt + sizeLength);
  const unknown = raw.every((byte, index) => (index === 0 ? byte === (0xff >> (sizeLength - 1)) : byte === 0xff));
  const masked = Buffer.from(raw);
  masked[0] = masked[0]! & (0xff >> sizeLength);
  const size = unknown ? undefined : Number(masked.readBigUInt64BE(0) >> BigInt(8 * (8 - sizeLength)));
  const bodyAt = sizeAt + sizeLength;
  const end = size === undefined ? bytes.length : bodyAt + size;
  return { id, ...(size === undefined ? {} : { size }), body: bytes.subarray(bodyAt, end), end };
}

/** Every element in `bytes`, in order. */
function children(bytes: Buffer): Element[] {
  const found: Element[] = [];
  for (let at = 0; at < bytes.length; ) {
    const { end, ...each } = readElement(bytes, at);
    found.push(each);
    at = end;
  }
  return found;
}

const child = (bytes: Buffer, id: number) => children(bytes).find((each) => each.id === id)!.body;

describe('rawVideoHeader', () => {
  const header = rawVideoHeader({ width: 2560, height: 1600, fps: 60 });
  const [ebml, segment] = children(header);

  it('opens a Matroska document, then a segment of unknown size so frames can follow for as long as the capture runs', () => {
    expect(ebml!.id).toBe(0x1a45dfa3);
    expect(child(ebml!.body, 0x4282).toString()).toBe('matroska');
    expect(segment!.id).toBe(0x18538067);
    expect(segment!.size).toBeUndefined();
  });

  it('describes one uncompressed BGRA video track of the frame size, a frame every 1/fps s, timed in microseconds', () => {
    const info = child(segment!.body, 0x1549a966);
    expect(child(info, 0x2ad7b1).readBigUInt64BE()).toBe(1_000n);
    const track = child(child(segment!.body, 0x1654ae6b), 0xae);
    expect(child(track, 0x86).toString()).toBe('V_UNCOMPRESSED');
    expect(child(track, 0x23e383).readBigUInt64BE()).toBe(16_666_667n);
    const video = child(track, 0xe0);
    expect(child(video, 0xb0).readBigUInt64BE()).toBe(2560n);
    expect(child(video, 0xba).readBigUInt64BE()).toBe(1600n);
    expect(child(video, 0x2eb524).toString()).toBe('BGRA');
  });
});

describe('rawVideoFrameHeader', () => {
  it('makes each frame a cluster at its own time, whose one keyframe block on track 1 holds exactly the frame', () => {
    const frame = Buffer.alloc(12, 7);
    const [cluster, ...rest] = children(Buffer.concat([rawVideoFrameHeader(3, frame.length, 60), frame]));
    expect(rest).toEqual([]);
    expect(cluster!.id).toBe(0x1f43b675);
    expect(child(cluster!.body, 0xe7).readBigUInt64BE()).toBe(50_000n);
    const block = child(cluster!.body, 0xa3);
    expect([...block.subarray(0, 4)]).toEqual([0x81, 0, 0, 0x80]);
    expect(block.subarray(4)).toEqual(frame);
  });

  it('times frames to the nearest microsecond, so none drifts at a rate that does not divide a second', () => {
    const at = (index: number) => child(children(rawVideoFrameHeader(index, 0, 30_000 / 1001))[0]!.body, 0xe7).readBigUInt64BE();
    expect(at(1)).toBe(33_367n);
    expect(at(30_000)).toBe(1_001_000_000n);
  });
});

describe('ffmpegEncoder, as ffmpeg sees it', { timeout: 20_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'raw-video-stream-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const size = { width: 4, height: 2 };
  /** Frame `n`, every byte `n`, so the stream shows which frame went where. */
  const frame = (n: number) => Buffer.alloc(size.width * size.height * 4, n);

  it('asks ffmpeg to read Matroska from stdin, then writes the header and each frame as a cluster at its own time', async () => {
    const binary = join(dir, 'ffmpeg');
    writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${dir}/args'\ncat > '${dir}/stream'\n`);
    chmodSync(binary, 0o755);
    const ffmpeg = ffmpegEncoder({ binary, out: join(dir, 'out.mov'), encoder: 'prores', size, fps: 60 });
    for (const n of [1, 2, 3]) ffmpeg.write(frame(n));
    await expect(ffmpeg.end()).resolves.toEqual({});

    const args = readFileSync(join(dir, 'args'), 'utf8').trim().split('\n');
    const input = args.indexOf('-i');
    expect(args.slice(input - 2, input + 4)).toEqual(['-f', 'matroska', '-i', 'pipe:0', '-r', '60']);

    const [ebml, segment, ...after] = children(readFileSync(join(dir, 'stream')));
    expect([ebml!.id, segment!.id, after]).toEqual([0x1a45dfa3, 0x18538067, []]);
    const [info, tracks, ...clusters] = children(segment!.body);
    expect([info!.id, tracks!.id]).toEqual([0x1549a966, 0x1654ae6b]);
    const video = child(child(tracks!.body, 0xae), 0xe0);
    expect([child(video, 0xb0).readBigUInt64BE(), child(video, 0xba).readBigUInt64BE()]).toEqual([4n, 2n]);
    expect(clusters.map((cluster) => cluster.id)).toEqual([0x1f43b675, 0x1f43b675, 0x1f43b675]);
    expect(clusters.map((cluster) => child(cluster.body, 0xe7).readBigUInt64BE())).toEqual([0n, 16_667n, 33_333n]);
    expect(clusters.map((cluster) => child(cluster.body, 0xa3).subarray(4))).toEqual([frame(1), frame(2), frame(3)]);
  });

  // Only with a real ffmpeg named in DEMO_CAPTURE_FFMPEG (the test setup clears AGENT_BOARD_*): it must read the stream
  // and encode every frame. Without one it is skipped, never failed.
  const real = process.env.DEMO_CAPTURE_FFMPEG;
  it.skipIf(!real)('is read by a real ffmpeg, which encodes every frame', async () => {
    const ffmpeg = ffmpegEncoder({ binary: real!, out: join(dir, 'real.mov'), encoder: 'prores-sw', size: { width: 64, height: 32 }, fps: 60 });
    for (let n = 0; n < 5; n++) ffmpeg.write(Buffer.alloc(64 * 32 * 4, n * 40));
    await expect(ffmpeg.end()).resolves.toEqual({ encodedFrames: 5 });
  });
});
