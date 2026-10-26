// Pictures of zones for orchestrators (`orchestrator.screenshot`): the daemon asks, and the app draws the zone in a
// hidden window that paints offscreen, captures it and hands the PNG back (capture-core.ts). The board's own window,
// and the user's view of it, are never touched. These are the Electron windows it draws in.
import { BrowserWindow, ipcMain, type NativeImage, type WebContents } from 'electron';
import type { DaemonLink } from '@agent-board/daemon/client';
import { CAPTURE_IPC } from '../preload/api';
import { captureSize, type CaptureFrame } from '../shared/capture';
import { createCapturer, type CaptureWindow, type Picture } from './capture-core';

/** How long a capture window may take to load the board and settle before the picture is given up. */
const READY_TIMEOUT_MS = 10_000;

/** What taking pictures needs: the daemon, and a way to open a hidden board window framed on `frame`. */
export interface CaptureOptions {
  daemon: Pick<DaemonLink, 'call' | 'onEvent' | 'onConnected'>;
  openBoard(frame: CaptureFrame): BrowserWindow;
  /** Once this connection serves captures, and so is the app's: what is said only from the app's connection. */
  served?(): void;
}

const picture = (image: NativeImage): Picture => ({
  size: () => image.getSize(),
  resize: (size) => picture(image.resize({ ...size, quality: 'best' })),
  png: () => image.toPNG(),
});

/** Rejects once `contents`' page goes, which no wait on it would otherwise hear. */
const whenGone = (contents: WebContents) =>
  new Promise<never>((_resolve, reject) => contents.once('render-process-gone', (_event, details) => reject(new Error(`the capture window's page went (${details.reason})`))));

/** `window` as the capturer uses one, drawn once `drawn` resolves. */
function captureWindow(window: BrowserWindow, drawn: () => Promise<void>): CaptureWindow {
  return {
    contentSize: () => {
      const [width = 0, height = 0] = window.getContentSize();
      return { width, height };
    },
    drawn: () => Promise.race([drawn(), whenGone(window.webContents)]),
    capture: async () => picture(await window.webContents.capturePage()),
    destroy: () => {
      if (!window.isDestroyed()) window.destroy();
    },
  };
}

export function registerCaptures({ daemon, openBoard, served }: CaptureOptions): void {
  /** The board windows waiting to settle, by their contents' id: each resolves as its board says it is ready. */
  const settled = new Map<number, () => void>();
  ipcMain.on(CAPTURE_IPC.ready, (event) => settled.get(event.sender.id)?.());

  const capturer = createCapturer({
    daemon,
    openBoard: (frame) => {
      const window = openBoard(frame);
      const id = window.webContents.id;
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the board didn't settle within ${READY_TIMEOUT_MS / 1000} s`)), READY_TIMEOUT_MS);
        settled.set(id, () => {
          clearTimeout(timer);
          resolve();
        });
      }).finally(() => settled.delete(id));
      ready.catch(() => {});
      return captureWindow(window, () => ready);
    },
    // The daemon's plain drawing, shown as an image (so nothing in it runs) in a bare hidden window.
    openSketch: (frame, svg) => {
      const window = bareWindow(captureSize(frame));
      const image = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
      const page = `<!doctype html><html><body style="margin:0;background:#fff"><img src="${image}" style="display:block"></body></html>`;
      const loaded = window.loadURL(`data:text/html;base64,${Buffer.from(page).toString('base64')}`);
      // Loaded is not yet painted: the next paint after it, which asking for one brings, is.
      return captureWindow(window, async () => {
        await loaded;
        const painted = new Promise<void>((resolve) => window.webContents.once('paint', () => resolve()));
        window.webContents.invalidate();
        await painted;
      });
    },
  });

  daemon.onEvent((event) => {
    if (event.type === 'capture.requested') void capturer.enqueue(event);
  });
  // Each connection, the first and every one after the daemon restarts, offers to take pictures.
  daemon.onConnected(() => {
    daemon.call('capture.serve').then(
      () => served?.(),
      (error: unknown) => console.error('agent-board: could not offer to take pictures:', error),
    );
  });
}

/** A window that is never shown and paints offscreen, with no preload and no script: for a page the app makes itself. */
function bareWindow(size: { width: number; height: number }): BrowserWindow {
  return new BrowserWindow({
    ...size,
    useContentSize: true,
    enableLargerThanScreen: true,
    show: false,
    frame: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, javascript: false },
  });
}
