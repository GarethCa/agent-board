import { describe, expect, it } from 'vitest';
import { createFrameTap, slotAt, type Encoder, type PaintedFrame } from './demo-capture-core';

describe('slotAt', () => {
  it('is the frame whose time is nearest, so half a frame either side of a frame’s time is that frame’s', () => {
    expect(slotAt(0, 10)).toBe(0);
    expect(slotAt(49, 10)).toBe(0);
    expect(slotAt(50, 10)).toBe(1);
    expect(slotAt(149, 10)).toBe(1);
    expect(slotAt(1000, 60)).toBe(60);
  });
});

/** A painted frame whose bitmap is `label`, which counts how often its pixels were read. */
function frame(label: string, size = { width: 4, height: 2 }) {
  const reads = { count: 0 };
  const painted: PaintedFrame = {
    size: () => size,
    bitmap: () => (reads.count++, Buffer.from(label)),
  };
  return Object.assign(painted, { reads });
}

/** An encoder that keeps what it is sent and refuses more while `full` is set, until `drain()`. */
function fakeEncoder() {
  let onDrain: (() => void) | undefined;
  const encoder = {
    sizes: [] as { width: number; height: number }[],
    frames: [] as string[],
    full: false,
    ended: false,
    open(size: { width: number; height: number }): Encoder {
      encoder.sizes.push(size);
      return {
        write: (bitmap) => (encoder.frames.push(bitmap.toString()), !encoder.full),
        onDrain: (listener) => (onDrain = listener),
        end: async () => {
          encoder.ended = true;
          return { encodedFrames: encoder.frames.length };
        },
      };
    },
    drain() {
      encoder.full = false;
      onDrain?.();
    },
  };
  return encoder;
}

/** A tap at 10 fps (a frame each 100 ms) on a clock the test moves; `run` moves it ticking every 10 ms, as a timer would. */
function tap(fps = 10, stallMs?: number) {
  const clock = { ms: 1_000 };
  const encoder = fakeEncoder();
  const capture = createFrameTap({
    fps,
    now: () => clock.ms,
    openEncoder: (size) => encoder.open(size),
    ...(stallMs === undefined ? {} : { stallMs }),
  });
  const run = (ms: number) => {
    for (let step = 0; step < ms; step += 10) {
      clock.ms += 10;
      capture.tick();
    }
  };
  /** Ticks every 10 ms up to `ms` after the first paint (at 1000), painting `label` there. */
  const paintAt = (ms: number, label: string) => {
    while (clock.ms + 10 < 1_000 + ms) {
      clock.ms += 10;
      capture.tick();
    }
    clock.ms = 1_000 + ms;
    capture.paint(frame(label));
  };
  return { clock, encoder, capture, run, paintAt };
}

describe('createFrameTap', () => {
  it('writes nothing until the first paint, and opens the encoder at that paint’s size', () => {
    const { clock, encoder, capture } = tap();
    clock.ms += 500;
    capture.tick();
    expect(encoder.sizes).toEqual([]);
    capture.paint(frame('a', { width: 2560, height: 1600 }));
    capture.tick();
    expect(encoder.sizes).toEqual([{ width: 2560, height: 1600 }]);
    expect(encoder.frames).toEqual(['a']);
  });

  it('repeats the last frame on the clock while the page paints nothing, reading its pixels once', () => {
    const { encoder, capture, run } = tap();
    const still = frame('a');
    capture.paint(still);
    capture.tick();
    run(350);
    expect(encoder.frames).toEqual(['a', 'a', 'a', 'a']);
    expect(still.reads.count).toBe(1);
    expect(capture.stats()).toMatchObject({
      paints: 1,
      written: 4,
      repeated: 3,
      superseded: 0,
      late: 0,
    });
  });

  it('writes the newest paint, counting the ones it replaced before they were written', () => {
    const { encoder, capture, run } = tap();
    capture.paint(frame('a'));
    capture.tick();
    capture.paint(frame('b'));
    capture.paint(frame('c'));
    // Frame 1's time is 100 ms, and it is open to a paint until 150.
    run(150);
    expect(encoder.frames).toEqual(['a', 'c']);
    expect(capture.stats()).toMatchObject({
      paints: 3,
      written: 2,
      repeated: 0,
      superseded: 1,
    });
  });

  it('gives each paint the frame nearest its time, so paints a little early or late are neither repeated nor lost', () => {
    const { encoder, capture, paintAt } = tap();
    paintAt(0, 'a');
    paintAt(95, 'b');
    paintAt(210, 'c');
    paintAt(290, 'd');
    expect(encoder.frames).toEqual(['a', 'b', 'c', 'd']);
    expect(capture.stats()).toMatchObject({ paints: 4, written: 4, repeated: 0, superseded: 0, late: 0 });
  });

  it('waits while the encoder is behind, then fills the frames it missed with the newest paint, counting the long-missed ones as late', () => {
    const { encoder, capture, run } = tap();
    encoder.full = true;
    capture.paint(frame('a'));
    capture.paint(frame('b'));
    run(300);
    expect(encoder.frames).toEqual(['a']);
    encoder.drain();
    capture.tick();
    expect(encoder.frames).toEqual(['a', 'b', 'b']);
    expect(capture.stats()).toMatchObject({ written: 3, late: 1, repeated: 1, backpressure: 1 });
  });

  it('counts a frame written more than a frame after its time as late, once', () => {
    const { clock, capture } = tap();
    capture.paint(frame('a'));
    clock.ms += 350;
    capture.tick();
    capture.tick();
    expect(capture.stats()).toMatchObject({ written: 4, late: 1 });
  });

  it('drops a paint of another size rather than corrupt the stream, and counts it', () => {
    const { encoder, capture } = tap();
    capture.paint(frame('a'));
    capture.tick();
    capture.paint(frame('b', { width: 8, height: 4 }));
    expect(capture.stats()).toMatchObject({ paints: 2, resized: 1 });
    expect(encoder.sizes).toHaveLength(1);
  });

  it('on stop writes what is still due, ends the encoder, and reports the run', async () => {
    const { clock, encoder, capture } = tap();
    capture.paint(frame('a'));
    clock.ms += 200;
    const result = await capture.stop();
    expect(encoder.ended).toBe(true);
    expect(encoder.frames).toEqual(['a', 'a', 'a']);
    expect(result).toMatchObject({
      width: 4,
      height: 2,
      fps: 10,
      durationMs: 200,
      expected: 3,
      written: 3,
      encodedFrames: 3,
    });
  });

  it('reports the run as it was when stopped, not after the encoder took its time to finish', async () => {
    const { clock, encoder, capture } = tap();
    const opened = encoder.open;
    encoder.open = (size) => {
      const inner = opened(size);
      return { ...inner, end: () => ((clock.ms += 5_000), inner.end()) };
    };
    capture.paint(frame('a'));
    clock.ms += 200;
    await expect(capture.stop()).resolves.toMatchObject({ durationMs: 200, expected: 3, written: 3 });
  });

  it('on stop waits for a behind encoder to catch up between writes, rather than queue every frame it missed at once', async () => {
    const { clock, encoder, capture } = tap();
    encoder.full = true;
    capture.paint(frame('a'));
    clock.ms += 300;
    const stopping = capture.stop();
    await Promise.resolve();
    expect(encoder.frames).toEqual(['a']);
    expect(encoder.ended).toBe(false);
    encoder.drain();
    await expect(stopping).resolves.toMatchObject({ written: 4 });
    expect(encoder.ended).toBe(true);
  });

  it('on stop gives up on an encoder that takes no frame for the stall time, ends it and says why, rather than hang', async () => {
    const { clock, encoder, capture } = tap(10, 20);
    encoder.full = true;
    capture.paint(frame('a'));
    clock.ms += 300;
    const result = await capture.stop();
    expect(encoder.ended).toBe(true);
    expect(result).toMatchObject({ written: 1, expected: 4, error: 'the encoder took no frame for 0.02 s, with 1 of 4 frames written' });
  });

  it('on stop reports the encoder’s own failure ahead of the stall it caused', async () => {
    const { clock, encoder, capture } = tap(10, 20);
    const opened = encoder.open;
    encoder.open = (size) => {
      const inner = opened(size);
      return { ...inner, end: async () => ({ ...(await inner.end()), error: 'ffmpeg exited with SIGABRT' }) };
    };
    encoder.full = true;
    capture.paint(frame('a'));
    clock.ms += 300;
    await expect(capture.stop()).resolves.toMatchObject({ error: 'ffmpeg exited with SIGABRT' });
  });

  it('takes no paint or tick once stopping, so nothing reaches the encoder after its input has ended', async () => {
    const { clock, encoder, capture } = tap();
    const opened = encoder.open;
    let ending: (() => void) | undefined;
    encoder.open = (size) => {
      const inner = opened(size);
      return { ...inner, end: () => new Promise((resolve) => (ending = () => resolve(inner.end()))) };
    };
    capture.paint(frame('a'));
    clock.ms += 200;
    const stopping = capture.stop();
    await Promise.resolve();
    clock.ms += 200;
    capture.paint(frame('late'));
    capture.tick();
    ending!();
    await expect(stopping).resolves.toMatchObject({ written: 3, paints: 1 });
    expect(encoder.frames).toEqual(['a', 'a', 'a']);
  });

  it('stops cleanly when nothing ever painted', async () => {
    const { encoder, capture } = tap();
    await expect(capture.stop()).resolves.toMatchObject({
      paints: 0,
      written: 0,
    });
    expect(encoder.sizes).toEqual([]);
  });
});
