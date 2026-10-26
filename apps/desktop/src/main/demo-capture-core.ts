// The frame tap behind demo capture (demo-capture.ts), free of Electron and ffmpeg so it can be tested on a fake clock.
// An offscreen page paints only when something on it changes, at whatever rate it manages; a video needs a frame every
// 1/fps of a second. Each paint is written as the frame whose time is nearest it, so paints that arrive a little early or
// late, as they do, still land one to a frame. A frame whose time passes with no paint repeats the one before, on a
// clock, so a still page is repeated; a paint that arrives when its frame is already written waits for the next frame,
// and is lost if a newer paint comes first.

interface Size {
  width: number;
  height: number;
}

/** One paint of the page: its size, and its pixels (BGRA), read only when a frame is written. */
export interface PaintedFrame {
  size(): Size;
  bitmap(): Buffer;
}

/** What the encoder reports once it has finished. */
export interface EncoderResult {
  /** Frames the encoder says it encoded, when it says. */
  encodedFrames?: number;
  /** Why it failed, when it did. */
  error?: string;
}

/** Where frames go: `write` returns false once the encoder is behind, and `onDrain`'s listener runs when it catches up. */
export interface Encoder {
  write(bitmap: Buffer): boolean;
  onDrain(listener: () => void): void;
  end(): Promise<EncoderResult>;
}

/** How a capture went. `expected` is the frames its length needs; `written` falls short of it only if it stopped mid-stall. */
export interface CaptureStats {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  expected: number;
  /** Paints the page made. */
  paints: number;
  /** Frames sent to the encoder. */
  written: number;
  /** Frames sent that repeat the one before: the page painted nothing new in time. */
  repeated: number;
  /** Paints replaced by a newer one before they were written: motion the video never shows. */
  superseded: number;
  /** Frames written more than a frame after their time, catching up after a stall (a late timer, or a full encoder). */
  late: number;
  /** Times the encoder fell behind and the tap waited for it. */
  backpressure: number;
  /** Paints of another size than the first, left out: a video's frames all have one size. */
  resized: number;
}

/** The frame nearest `elapsedMs` after the first, which is frame 0. */
export function slotAt(elapsedMs: number, fps: number): number {
  return Math.round((elapsedMs * fps) / 1000);
}

export interface FrameTapOptions {
  fps: number;
  now(): number;
  /** Opens the encoder, at the first paint's size. */
  openEncoder(size: Size): Encoder;
  /** How long stop waits for a behind encoder to take another frame before it gives up (default 10 s). */
  stallMs?: number;
}

export interface FrameTap {
  paint(frame: PaintedFrame): void;
  /** Writes the frames whose time has passed with no paint; call it more often than once a frame. */
  tick(): void;
  stats(): CaptureStats;
  /** Writes the frames up to now, ends the encoder and reports. */
  stop(): Promise<CaptureStats & EncoderResult>;
}

export function createFrameTap({ fps, now, openEncoder, stallMs = 10_000 }: FrameTapOptions): FrameTap {
  let encoder: Encoder | undefined;
  let size: Size = { width: 0, height: 0 };
  let start = 0;
  let latest: PaintedFrame | undefined;
  let pixels: Buffer | undefined;
  let fresh = false;
  let behind = false;
  /** Set once stop begins: from then on no paint or tick reaches the encoder, whose input is about to end. */
  let stopping = false;
  /** Who waits for a behind encoder to catch up. */
  let drained: (() => void) | undefined;
  const counts = {
    paints: 0,
    written: 0,
    repeated: 0,
    superseded: 0,
    late: 0,
    backpressure: 0,
    resized: 0,
  };

  const frameMs = 1000 / fps;
  /** Writes the newest paint as every frame before `until` not yet written, unless the encoder is behind. */
  const fill = (until: number) => {
    if (encoder === undefined || latest === undefined) return;
    const elapsed = now() - start;
    while (counts.written < until && !behind) {
      // A frame's time is past once half a frame has gone by after it.
      if (elapsed - (counts.written + 0.5) * frameMs > frameMs) counts.late++;
      pixels ??= latest.bitmap();
      if (fresh) fresh = false;
      else counts.repeated++;
      counts.written++;
      if (!encoder.write(pixels)) {
        behind = true;
        counts.backpressure++;
      }
    }
  };

  const stats = (): CaptureStats => {
    const durationMs = encoder === undefined ? 0 : now() - start;
    return {
      ...size,
      fps,
      durationMs,
      expected: encoder === undefined ? 0 : slotAt(durationMs, fps) + 1,
      ...counts,
    };
  };

  return {
    paint(frame) {
      if (stopping) return;
      counts.paints++;
      const painted = frame.size();
      if (encoder === undefined) {
        size = painted;
        start = now();
        encoder = openEncoder(size);
        encoder.onDrain(() => {
          behind = false;
          drained?.();
        });
      } else if (painted.width !== size.width || painted.height !== size.height) {
        counts.resized++;
        return;
      }
      const slot = slotAt(now() - start, fps);
      fill(slot);
      if (fresh) counts.superseded++;
      latest = frame;
      pixels = undefined;
      fresh = true;
      if (counts.written === slot) fill(slot + 1);
    },
    tick: () => {
      if (!stopping) fill(slotAt(now() - start, fps));
    },
    stats,
    async stop() {
      stopping = true;
      // Frame by frame, as the encoder takes them: queuing them all at once could be gigabytes.
      const last = slotAt(now() - start, fps) + 1;
      const run = stats();
      fill(last);
      let stalled: string | undefined;
      while (counts.written < last && behind) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const caughtUp = await Promise.race([
          new Promise<boolean>((resolve) => (drained = () => resolve(true))),
          new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), stallMs))),
        ]);
        clearTimeout(timer);
        if (!caughtUp) {
          stalled = `the encoder took no frame for ${stallMs / 1000} s, with ${counts.written} of ${last} frames written`;
          break;
        }
        fill(last);
      }
      Object.assign(run, counts);
      const result = (await encoder?.end()) ?? {};
      // The encoder's own failure, such as ffmpeg exiting, says more than the stall it caused.
      const error = result.error ?? stalled;
      return { ...run, ...result, ...(error === undefined ? {} : { error }) };
    },
  };
}
