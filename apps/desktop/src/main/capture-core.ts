// How the app takes a picture of a zone for the daemon (`capture.requested`), apart from Electron: windows and images
// come in through `CaptureWindow` and `Picture`, so the rules (one at a time, never past the daemon's deadline, the
// window always closed, the frame's own shape, under the size a model takes) are tested with fakes.
import type { DaemonLink } from '@agent-board/daemon/client';
import { MAX_CAPTURE_PNG_BYTES, type CaptureRequestedEvent } from '@agent-board/daemon/protocol';
import { captureSize, type CaptureFrame } from '../shared/capture';

/** A captured image, as the capturer uses one. */
export interface Picture {
  size(): { width: number; height: number };
  resize(size: { width: number; height: number }): Picture;
  png(): Buffer;
}

/** A hidden window drawing a picture to take. */
export interface CaptureWindow {
  /** Its page's size, px. */
  contentSize(): { width: number; height: number };
  /** Resolves once its page is drawn and may be captured; rejects if it can't be (it timed out, or its page went). */
  drawn(): Promise<void>;
  capture(): Promise<Picture>;
  destroy(): void;
}

export interface CapturerOptions {
  daemon: Pick<DaemonLink, 'call'>;
  /** A hidden board window framed on `frame`. */
  openBoard(frame: CaptureFrame): CaptureWindow;
  /** A hidden bare window showing `svg` as an image, at `frame`'s size. */
  openSketch(frame: CaptureFrame, svg: string): CaptureWindow;
  now?: () => number;
  /** Most bytes of PNG to hand back: `MAX_CAPTURE_PNG_BYTES`. */
  maxBytes?: number;
}

/** How much before the daemon's deadline the capturer gives up, so its answer still reaches the daemon in time. */
const DEADLINE_MARGIN_MS = 500;
/** How many times a picture over the byte limit is drawn smaller before it is given up. */
const SHRINK_TRIES = 4;

/**
 * `picture` at `size`: as it is, or scaled evenly when it was drawn at a multiple of it (a 2× display). Throws when its
 * shape differs from the frame's: a window the system made smaller than asked, whose picture would come out stretched.
 */
export function fitPicture(picture: Picture, size: { width: number; height: number }): Picture {
  const drawn = picture.size();
  if (drawn.width === size.width && drawn.height === size.height) return picture;
  const across = drawn.width / size.width;
  const down = drawn.height / size.height;
  if (Math.abs(across - down) > 0.01 || Math.abs(drawn.width / across - size.width) > 1) {
    throw new Error(`the window was drawn at ${drawn.width}×${drawn.height} px, not the zone's ${size.width}×${size.height}`);
  }
  return picture.resize(size);
}

/** `picture`'s PNG, drawn smaller (keeping its shape) until it takes at most `maxBytes`. */
export function pngUnder(picture: Picture, maxBytes: number): { png: Buffer; width: number; height: number } {
  let current = picture;
  for (let tries = 0; ; tries++) {
    const png = current.png();
    const { width, height } = current.size();
    if (png.length <= maxBytes) return { png, width, height };
    if (tries === SHRINK_TRIES) throw new Error(`the picture takes ${png.length} bytes, over the ${maxBytes} a model takes, even drawn smaller`);
    // Bytes go about with the area: shrink both sides by the root of how far over it is, and a little more.
    const by = Math.sqrt(maxBytes / png.length) * 0.9;
    current = current.resize({ width: Math.max(1, Math.floor(width * by)), height: Math.max(1, Math.floor(height * by)) });
  }
}

/** Rejects with `message` once `ms` have passed, unless `work` settles first. */
function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => (timer = setTimeout(() => reject(new Error(message)), Math.max(0, ms))));
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** Takes the pictures the daemon asks for, one at a time. `take` resolves once the daemon has its answer. */
export function createCapturer({ daemon, openBoard, openSketch, now = Date.now, maxBytes = MAX_CAPTURE_PNG_BYTES }: CapturerOptions) {
  const draw = async (event: CaptureRequestedEvent) => {
    const frame: CaptureFrame = { zoneId: event.zoneId, ...event.rect, scale: event.scale };
    const size = captureSize(frame);
    const window = event.style === 'lofi' && event.svg !== undefined ? openSketch(frame, event.svg) : openBoard(frame);
    try {
      const work = (async () => {
        const content = window.contentSize();
        // A pixel either way is display scaling rounding the window's size, not a window the system made smaller.
        if (Math.abs(content.width - size.width) > 1 || Math.abs(content.height - size.height) > 1) {
          throw new Error(`the window opened at ${content.width}×${content.height} px, not the zone's ${size.width}×${size.height}`);
        }
        await window.drawn();
        return pngUnder(fitPicture(await window.capture(), size), maxBytes);
      })();
      // Given up on, it may still fail later, into nothing.
      work.catch(() => {});
      return await within(work, event.deadline - DEADLINE_MARGIN_MS - now(), 'the picture took too long');
    } finally {
      window.destroy();
    }
  };

  const take = async (event: CaptureRequestedEvent): Promise<void> => {
    // The daemon has stopped waiting for it: nothing to draw.
    if (now() >= event.deadline - DEADLINE_MARGIN_MS) return;
    try {
      const { png, width, height } = await draw(event);
      await daemon.call('capture.deliver', { id: event.id, png: png.toString('base64'), width, height });
    } catch (error) {
      await daemon.call('capture.fail', { id: event.id, message: (error as Error).message }).catch(() => {});
    }
  };

  let queue = Promise.resolve();
  return {
    take,
    /** Takes `event` after every picture asked for before it. */
    enqueue(event: CaptureRequestedEvent): Promise<void> {
      queue = queue.then(() => take(event));
      return queue;
    },
  };
}
