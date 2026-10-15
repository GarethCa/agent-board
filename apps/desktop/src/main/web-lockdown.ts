// What a web tab's page may do (BI2): go to https pages and to this machine over http, and nothing else. It
// opens no window, shows no dialog, gets no permission, downloads nothing and picks no device; only a page on this
// machine reaches this machine. Its session's partition is its own.
import type { Session, WebContents } from 'electron';
import { isLocalUrl, isWebTabRequest, isWebTabUrl } from '@agent-board/daemon/web-url';

export interface LockDownOptions {
  /** A navigation or redirect to `url` was stopped, as the tab may not show it. */
  onBlocked(url: string): void;
  /**
   * The page asked to open the https `url` in a new window, which it never does by itself: a page could do so on a timer,
   * flooding the OS browser. The tab offers it, for the user to open with a click.
   */
  onWindowOpen(url: string): void;
}

/** A request a web tab's page makes, as `webRequest` sees it. */
export interface PageRequest {
  url: string;
  resourceType: string;
  method: string;
  /**
   * The origin that makes it (`null` for an opaque one, a sandboxed frame's); undefined for the tab's own navigation,
   * from its address row or its history, which no page asked for.
   */
  from: string | undefined;
  /** Whether the user clicked or typed in the page a moment before. */
  gesture: boolean;
}

/**
 * Whether a web tab's page may make `request`: only to where a web tab may load (`isWebTabRequest`), and to this
 * machine only from a page on this machine, so an https site can't reach a dev server, its hot reload socket or any
 * other local service. The tab itself may go there from anywhere: by its address row or history, or by a link the user
 * clicked; never by a page's form post or script alone.
 */
export function mayRequest({ url, resourceType, method, from, gesture }: PageRequest): boolean {
  if (!isWebTabRequest(url)) return false;
  if (!isLocalUrl(url) || (from !== undefined && isLocalUrl(from))) return true;
  if (resourceType !== 'mainFrame') return false;
  return from === undefined || (method === 'GET' && gesture);
}

/** How long after the user clicks or types in a page what it does counts as theirs, as a browser's user activation does. */
const GESTURE_MS = 1000;

/** When the user last pressed a key or a mouse button in each web tab's page. */
const lastGesture = new WeakMap<WebContents, number>();

/** Whether the user clicked or typed in the page a moment ago. */
const recentGesture = (contents: WebContents | undefined): boolean =>
  contents !== undefined && Date.now() - (lastGesture.get(contents) ?? -Infinity) < GESTURE_MS;

/** The navigation events the lockdown may prevent. */
interface Prevented {
  url: string;
  isMainFrame: boolean;
  preventDefault(): void;
}

/** The empty pages a frame inside a page may hold (a dev server's overlay, `srcdoc`), which load nothing. */
const EMPTY_FRAMES: ReadonlySet<string> = new Set(['about:blank', 'about:srcdoc']);

/** Where a locked-down view's frames may go, and what it hears of what they may not. */
export interface ViewRules {
  /** Whether a frame (the page itself for `isMainFrame`) may navigate or be redirected to `url`. */
  mayGo(url: string, isMainFrame: boolean): boolean;
  onBlocked(url: string): void;
  /** The page asked to open `url` in a new window, which it never does. */
  onWindowOpen(url: string): void;
}

/**
 * Holds a locked-down view's page to `rules`: a navigation or redirect it may not make is stopped, and `window.open`
 * opens nothing. A page can't keep the user on it ("Leave this page?"), attach a webview or pick a bluetooth device,
 * and the user's clicks and keys in it are noted, for `mayRequest`.
 */
export function guardContents(contents: WebContents, rules: ViewRules): void {
  contents.setWindowOpenHandler(({ url }) => {
    rules.onWindowOpen(url);
    return { action: 'deny' };
  });
  const stay = (event: Prevented) => {
    if (rules.mayGo(event.url, event.isMainFrame)) return;
    event.preventDefault();
    rules.onBlocked(event.url);
  };
  contents.on('will-frame-navigate', stay);
  contents.on('will-redirect', stay);
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-prevent-unload', (event) => event.preventDefault());
  contents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown') lastGesture.set(contents, Date.now());
  });
  contents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseDown') lastGesture.set(contents, Date.now());
  });
  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault();
    callback('');
  });
}

/**
 * Keeps the page's every frame on what a web tab may show (`isWebTabUrl`), or a frame inside it empty: a navigation or a
 * redirect anywhere else, `file:`, `data:` and `javascript:` among them, is stopped. `window.open` opens nothing; an
 * https target is offered to the user (`onWindowOpen`). A page can't keep the user on it ("Leave this page?"), and the
 * user's clicks and keys in it are noted, for `mayRequest`.
 */
export function lockDownContents(contents: WebContents, { onBlocked, onWindowOpen }: LockDownOptions): void {
  guardContents(contents, {
    mayGo: (url, isMainFrame) => isWebTabUrl(url) || (!isMainFrame && EMPTY_FRAMES.has(url)),
    onBlocked,
    onWindowOpen: (url) => {
      if (url.startsWith('https:') && isWebTabUrl(url)) onWindowOpen(url);
    },
  });
}

/**
 * Denies the session every permission (camera, microphone, notifications, geolocation…) and device, cancels every
 * download, and lets it make only the requests `mayRequest` allows, so a redirect of anything it loads is checked too.
 */
export function lockDownSession(session: Session): void {
  denyEverything(session);
  session.webRequest.onBeforeRequest((details, callback) => {
    const request = { url: details.url, resourceType: details.resourceType, method: details.method, from: requester(details), gesture: recentGesture(details.webContents) };
    callback({ cancel: !mayRequest(request) });
  });
}

/** Denies the session every permission and device, and cancels every download. */
export function denyEverything(session: Session): void {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.setDevicePermissionHandler(() => false);
  session.on('will-download', (event) => event.preventDefault());
  session.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  session.on('select-serial-port', (event, _ports, _contents, callback) => {
    event.preventDefault();
    callback('');
  });
  session.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
}

/**
 * The origin making a request: the one Chromium names, which a redirect keeps and a `srcdoc` or `about:blank` frame
 * takes from its parent; else, for a request the browser started, nothing for the tab's own navigation and otherwise its
 * frame's origin, its referrer or its page's URL.
 */
function requester(details: Electron.OnBeforeRequestListenerDetails): string | undefined {
  if (details.initiatorOrigin !== undefined) return details.initiatorOrigin;
  if (details.resourceType === 'mainFrame') return undefined;
  try {
    const origin = details.frame?.origin;
    if (origin) return origin;
  } catch {
    // A frame gone by now has no origin to ask.
  }
  return details.referrer || details.webContents?.getURL() || 'null';
}
