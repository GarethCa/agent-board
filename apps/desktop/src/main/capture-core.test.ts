import { describe, expect, it } from 'vitest';
import type { CaptureRequestedEvent } from '@agent-board/daemon/protocol';
import { createCapturer, fitPicture, pngUnder, type CaptureWindow, type Picture } from './capture-core';

/** A picture of `width`×`height` whose PNG takes a byte per `pxPerByte` px. */
function fakePicture(width: number, height: number, pxPerByte = 1): Picture {
  return {
    size: () => ({ width, height }),
    resize: (size) => fakePicture(size.width, size.height, pxPerByte),
    png: () => Buffer.alloc(Math.ceil((width * height) / pxPerByte)),
  };
}

/** A window that opens at `content`, is drawn as `drawn` says, and captures `picture`; it records being closed. */
function fakeWindow({ content = { width: 300, height: 200 }, drawn = () => Promise.resolve(), picture = () => Promise.resolve(fakePicture(300, 200)) }: {
  content?: { width: number; height: number };
  drawn?: () => Promise<void>;
  picture?: () => Promise<Picture>;
} = {}) {
  const window = { destroyed: false } as CaptureWindow & { destroyed: boolean };
  Object.assign(window, { contentSize: () => content, drawn, capture: picture, destroy: () => (window.destroyed = true) });
  return window;
}

/** A daemon that records what it is told, refusing a delivery with `refuse`. */
function fakeDaemon(refuse?: string) {
  const calls: [string, Record<string, unknown>][] = [];
  return {
    calls,
    call: (async (method: string, params: Record<string, unknown>) => {
      calls.push([method, params]);
      if (method === 'capture.deliver' && refuse !== undefined) throw new Error(refuse);
      return null;
    }) as never,
  };
}

const request = (fields: Partial<CaptureRequestedEvent> = {}): CaptureRequestedEvent => ({
  type: 'capture.requested',
  id: 'c1',
  zoneId: 'z1',
  style: 'board',
  rect: { x: 0, y: 0, width: 300, height: 200 },
  scale: 1,
  deadline: Date.now() + 15_000,
  ...fields,
});

/** A capturer whose board window is `window`. */
function capturer(window: CaptureWindow, daemon = fakeDaemon(), maxBytes?: number) {
  const opened: string[] = [];
  const capture = createCapturer({
    daemon,
    openBoard: () => (opened.push('board'), window),
    openSketch: () => (opened.push('sketch'), window),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  });
  return { capture, daemon, opened };
}

describe('taking a picture', () => {
  it('hands the daemon the PNG once the window is drawn, and closes the window', async () => {
    const window = fakeWindow();
    const { capture, daemon } = capturer(window);
    await capture.take(request());
    expect(daemon.calls).toEqual([['capture.deliver', { id: 'c1', png: Buffer.alloc(60_000).toString('base64'), width: 300, height: 200 }]]);
    expect(window.destroyed).toBe(true);
  });

  it('draws the plain style in the sketch window', async () => {
    const { capture, opened } = capturer(fakeWindow());
    await capture.take(request({ style: 'lofi', svg: '<svg/>' }));
    expect(opened).toEqual(['sketch']);
  });

  it.each([
    ['its page went', () => Promise.reject(new Error("the capture window's page went (crashed)")), "the capture window's page went (crashed)"],
    ['it never settled', () => Promise.reject(new Error("the board didn't settle within 10 s")), "the board didn't settle within 10 s"],
  ])('says why when %s, and closes the window', async (_case, drawn, message) => {
    const window = fakeWindow({ drawn });
    const { capture, daemon } = capturer(window);
    await capture.take(request());
    expect(daemon.calls).toEqual([['capture.fail', { id: 'c1', message }]]);
    expect(window.destroyed).toBe(true);
  });

  it('gives up before the daemon does when the capture never comes, and closes the window', async () => {
    const window = fakeWindow({ picture: () => new Promise(() => {}) });
    const { capture, daemon } = capturer(window);
    await capture.take(request({ deadline: Date.now() + 700 }));
    expect(daemon.calls).toEqual([['capture.fail', { id: 'c1', message: 'the picture took too long' }]]);
    expect(window.destroyed).toBe(true);
  });

  it('draws nothing for a picture the daemon has stopped waiting for', async () => {
    const { capture, daemon, opened } = capturer(fakeWindow());
    await capture.take(request({ deadline: Date.now() - 1 }));
    expect(opened).toEqual([]);
    expect(daemon.calls).toEqual([]);
  });

  it('refuses a window the system opened smaller than the frame, rather than stretch its picture', async () => {
    const window = fakeWindow({ content: { width: 300, height: 150 } });
    const { capture, daemon } = capturer(window);
    await capture.take(request());
    expect(daemon.calls).toEqual([['capture.fail', { id: 'c1', message: "the window opened at 300×150 px, not the zone's 300×200" }]]);
    expect(window.destroyed).toBe(true);
  });

  it("takes a window a pixel off the frame, as display scaling rounds it, and hands back the frame's size", async () => {
    const window = fakeWindow({ content: { width: 301, height: 199 }, picture: () => Promise.resolve(fakePicture(301, 199)) });
    const { capture, daemon } = capturer(window);
    await capture.take(request());
    expect(daemon.calls.map(([method, params]) => [method, params.width, params.height])).toEqual([['capture.deliver', 300, 200]]);
  });

  it('tells the daemon it failed when the daemon refuses the picture', async () => {
    const { capture, daemon } = capturer(fakeWindow(), fakeDaemon('the picture must be at most 3500000 bytes of PNG'));
    await capture.take(request());
    expect(daemon.calls.map(([method]) => method)).toEqual(['capture.deliver', 'capture.fail']);
    expect(daemon.calls[1]![1]).toEqual({ id: 'c1', message: 'the picture must be at most 3500000 bytes of PNG' });
  });

  it('hands back a picture over the byte limit drawn smaller, its shape kept', async () => {
    const { capture, daemon } = capturer(fakeWindow(), fakeDaemon(), 15_000);
    await capture.take(request());
    const [[method, { width, height, png }]] = daemon.calls as [[string, { width: number; height: number; png: string }]];
    expect(method).toBe('capture.deliver');
    expect(Buffer.from(png, 'base64').length).toBeLessThanOrEqual(15_000);
    expect(width / height).toBeCloseTo(1.5, 1);
  });

  it('takes one picture at a time, in the order asked', async () => {
    let finishFirst!: () => void;
    const order: string[] = [];
    const first = fakeWindow({ drawn: () => new Promise((resolve) => (finishFirst = resolve)) });
    const second = fakeWindow();
    const windows = [first, second];
    const daemon = fakeDaemon();
    const capture = createCapturer({
      daemon,
      openBoard: () => (order.push('open'), windows.shift()!),
      openSketch: () => windows.shift()!,
    });
    const both = Promise.all([capture.enqueue(request({ id: 'a' })), capture.enqueue(request({ id: 'b' }))]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['open']);
    finishFirst();
    await both;
    expect(daemon.calls.map(([, params]) => params.id)).toEqual(['a', 'b']);
  });
});

describe('fitPicture', () => {
  it('scales a picture drawn at 2× down to the frame', () => {
    expect(fitPicture(fakePicture(600, 400), { width: 300, height: 200 }).size()).toEqual({ width: 300, height: 200 });
  });

  it('refuses a picture of another shape than the frame', () => {
    expect(() => fitPicture(fakePicture(300, 150), { width: 300, height: 200 })).toThrow("the window was drawn at 300×150 px, not the zone's 300×200");
  });
});

describe('pngUnder', () => {
  it('leaves a picture under the limit as it is', () => {
    expect(pngUnder(fakePicture(300, 200), 60_000)).toMatchObject({ width: 300, height: 200 });
  });

  it('gives up on one that stays over the limit however small it is drawn', () => {
    const stubborn: Picture = { size: () => ({ width: 10, height: 10 }), resize: () => stubborn, png: () => Buffer.alloc(100) };
    expect(() => pngUnder(stubborn, 50)).toThrow('the picture takes 100 bytes, over the 50 a model takes, even drawn smaller');
  });
});
