import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Session, WebContents } from 'electron';
import { lockDownContents, lockDownSession, mayRequest } from './web-lockdown';

/** A web contents with only what the lockdown touches. */
function fakeContents() {
  const contents = Object.assign(new EventEmitter(), {
    openHandler: undefined as undefined | ((details: { url: string }) => { action: string }),
    setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
      contents.openHandler = handler;
    },
  });
  return contents;
}

type PermissionRequest = (contents: unknown, permission: string, callback: (granted: boolean) => void) => void;
type BeforeRequest = (details: { url: string }, callback: (response: { cancel: boolean }) => void) => void;

/** The handlers a session was given. */
interface SessionHandlers {
  permissionRequest?: PermissionRequest;
  permissionCheck?: (...args: unknown[]) => boolean;
  devicePermission?: (...args: unknown[]) => boolean;
  beforeRequest?: BeforeRequest;
}

/** A session with only what the lockdown touches, and the handlers it is given. */
function fakeSession() {
  const handlers: SessionHandlers = {};
  const session = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: (handler: PermissionRequest) => (handlers.permissionRequest = handler),
    setPermissionCheckHandler: (handler: (...args: unknown[]) => boolean) => (handlers.permissionCheck = handler),
    setDevicePermissionHandler: (handler: (...args: unknown[]) => boolean) => (handlers.devicePermission = handler),
    webRequest: { onBeforeRequest: (handler: BeforeRequest) => (handlers.beforeRequest = handler) },
  });
  return { session, handlers };
}

/** An event the lockdown may prevent, as Electron passes one. */
const navigation = (url: string, isMainFrame = true) => {
  const event = { url, isMainFrame, prevented: false, preventDefault: () => (event.prevented = true) };
  return event;
};

function lockedContents() {
  const contents = fakeContents();
  const blocked: string[] = [];
  const offered: string[] = [];
  lockDownContents(contents as unknown as WebContents, { onBlocked: (url) => blocked.push(url), onWindowOpen: (url) => offered.push(url) });
  return { contents, blocked, offered };
}

describe("a web tab's page", () => {
  it.each(['file:///etc/passwd', 'data:text/html,hi', 'javascript:alert(1)', 'http://example.com/', 'ftp://example.com/'])('never navigates to %s, and says so', (url) => {
    const { contents, blocked } = lockedContents();
    const event = navigation(url);
    contents.emit('will-frame-navigate', event);
    expect(event.prevented).toBe(true);
    expect(blocked).toEqual([url]);
  });

  it('goes to https pages and to its own machine', () => {
    const { contents, blocked } = lockedContents();
    for (const url of ['https://example.com/', 'http://localhost:5173/a', 'http://127.0.0.1:3000/']) {
      const event = navigation(url);
      contents.emit('will-frame-navigate', event);
      expect(event.prevented).toBe(false);
    }
    expect(blocked).toEqual([]);
  });

  it('lets a frame inside it be empty, but never the page itself', () => {
    const { contents, blocked } = lockedContents();
    for (const url of ['about:blank', 'about:srcdoc']) {
      const frame = navigation(url, false);
      contents.emit('will-frame-navigate', frame);
      expect(frame.prevented).toBe(false);
    }
    const page = navigation('about:blank');
    contents.emit('will-frame-navigate', page);
    expect(page.prevented).toBe(true);
    const elsewhere = navigation('file:///etc/passwd', false);
    contents.emit('will-frame-navigate', elsewhere);
    expect(elsewhere.prevented).toBe(true);
    expect(blocked).toEqual(['about:blank', 'file:///etc/passwd']);
  });

  it('is never redirected anywhere it may not go', () => {
    const { contents, blocked } = lockedContents();
    const away = navigation('file:///etc/passwd');
    contents.emit('will-redirect', away);
    expect(away.prevented).toBe(true);
    const local = navigation('http://localhost:5173/login');
    contents.emit('will-redirect', local);
    expect(local.prevented).toBe(false);
    expect(blocked).toEqual(['file:///etc/passwd']);
  });

  it('opens no window: an https one is offered to the user, anything else is dropped', () => {
    const { contents, offered } = lockedContents();
    expect(contents.openHandler!({ url: 'https://example.com/' })).toEqual({ action: 'deny' });
    expect(contents.openHandler!({ url: 'http://localhost:5173/' })).toEqual({ action: 'deny' });
    expect(contents.openHandler!({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(offered).toEqual(['https://example.com/']);
  });

  it('never keeps the user on it with "Leave this page?"', () => {
    const { contents } = lockedContents();
    const unload = navigation('');
    contents.emit('will-prevent-unload', unload);
    expect(unload.prevented).toBe(true);
  });

  it('attaches no webview and picks no bluetooth device', () => {
    const { contents } = lockedContents();
    const attach = navigation('');
    contents.emit('will-attach-webview', attach);
    expect(attach.prevented).toBe(true);
    const picked: string[] = [];
    const select = navigation('');
    contents.emit('select-bluetooth-device', select, [{ deviceId: 'd' }], (id: string) => picked.push(id));
    expect(select.prevented).toBe(true);
    expect(picked).toEqual(['']);
  });
});

describe("a web tab's session", () => {
  function locked() {
    const { session, handlers } = fakeSession();
    lockDownSession(session as unknown as Session);
    return Object.assign(session, handlers);
  }

  it('grants no permission: camera, microphone, notifications, geolocation or any other', () => {
    const session = locked();
    for (const permission of ['media', 'notifications', 'geolocation', 'clipboard-read', 'midi']) {
      const answers: boolean[] = [];
      session.permissionRequest!({}, permission, (granted) => answers.push(granted));
      expect(answers).toEqual([false]);
    }
    expect(session.permissionCheck!({}, 'media')).toBe(false);
    expect(session.devicePermission!({})).toBe(false);
  });

  it('downloads nothing and picks no device', () => {
    const session = locked();
    const download = navigation('https://example.com/file.zip');
    session.emit('will-download', download, {}, {});
    expect(download.prevented).toBe(true);
    // The serial port picker is told of the page asking too, before its callback.
    for (const [kind, ...details] of [['select-hid-device', { deviceList: [] }], ['select-serial-port', [], {}], ['select-usb-device', { deviceList: [] }]] as const) {
      const picked: unknown[] = [];
      const select = navigation('');
      session.emit(kind, select, ...details, (id?: string) => picked.push(id));
      expect(select.prevented).toBe(true);
      expect(picked).toHaveLength(1);
    }
  });

  it('loads only what a web tab may show, and websockets to the same places', () => {
    const session = locked();
    const verdict = (url: string, initiatorOrigin: string | undefined = 'http://localhost:5173') => {
      let cancel: boolean | undefined;
      session.beforeRequest!({ url, method: 'GET', resourceType: 'script', referrer: '', initiatorOrigin } as never, (response) => (cancel = response.cancel));
      return cancel;
    };
    expect(verdict('https://cdn.example.com/a.js')).toBe(false);
    expect(verdict('ws://localhost:5173/')).toBe(false);
    expect(verdict('http://example.com/a.js')).toBe(true);
    expect(verdict('file:///etc/passwd')).toBe(true);
    // Asked from an https site, or a sandboxed frame's opaque origin, this machine is out of reach.
    expect(verdict('ws://localhost:5173/', 'https://example.com')).toBe(true);
    expect(verdict('http://localhost:5173/a.js', 'null')).toBe(true);
  });

  it("takes a srcdoc frame's request as its page's, whose origin it has, not as from about:srcdoc", () => {
    const session = locked();
    let cancel: boolean | undefined;
    const frame = { url: 'about:srcdoc', origin: 'http://127.0.0.1:3000' };
    session.beforeRequest!({ url: 'http://127.0.0.1:3000/static/logo.png', method: 'GET', resourceType: 'image', referrer: '', frame } as never, (response) => (cancel = response.cancel));
    expect(cancel).toBe(false);
  });

  it('lets a page on an https site send the tab to this machine only by a link the user just clicked', () => {
    const session = locked();
    const contents = fakeContents();
    lockDownContents(contents as unknown as WebContents, { onBlocked: () => {}, onWindowOpen: () => {} });
    const verdict = (method: string) => {
      let cancel: boolean | undefined;
      const details = { url: 'http://127.0.0.1:3000/', method, resourceType: 'mainFrame', referrer: '', initiatorOrigin: 'https://example.com', webContents: contents };
      session.beforeRequest!(details as never, (response) => (cancel = response.cancel));
      return cancel;
    };
    expect(verdict('GET')).toBe(true);
    contents.emit('before-mouse-event', {}, { type: 'mouseDown' });
    expect(verdict('GET')).toBe(false);
    expect(verdict('POST')).toBe(true);
  });
});

describe("a web tab's page reaching this machine", () => {
  const request = (fields: Partial<Parameters<typeof mayRequest>[0]>) => mayRequest({ url: 'http://localhost:5173/api', resourceType: 'xhr', method: 'GET', from: 'https://example.com', gesture: false, ...fields });

  it('may from a page on this machine: a dev server fetching its own files, its hot reload socket', () => {
    expect(request({ url: 'http://localhost:5173/src/main.ts', resourceType: 'script', from: 'http://localhost:5173' })).toBe(true);
    expect(request({ url: 'ws://127.0.0.1:24678/', resourceType: 'webSocket', from: 'http://localhost:5173' })).toBe(true);
    expect(request({ resourceType: 'mainFrame', method: 'POST', from: 'http://localhost:5173' })).toBe(true);
  });

  it('may when the tab goes there by its address row or history, which no page asked for', () => {
    expect(request({ resourceType: 'mainFrame', from: undefined })).toBe(true);
  });

  it('may from an https site only as the tab following a link the user clicked: never a form post, nor a script alone', () => {
    expect(request({ resourceType: 'mainFrame', gesture: true })).toBe(true);
    expect(request({ resourceType: 'mainFrame' })).toBe(false);
    expect(request({ resourceType: 'mainFrame', method: 'POST', gesture: true })).toBe(false);
  });

  it('may not from an https site: no fetch, image, form, frame or socket to a local service', () => {
    for (const resourceType of ['xhr', 'image', 'subFrame', 'webSocket', 'other']) {
      expect(request({ resourceType, gesture: true })).toBe(false);
      expect(request({ url: 'https://localhost:8443/api', resourceType })).toBe(false);
    }
    expect(request({ from: undefined })).toBe(false);
    expect(request({ from: 'null' })).toBe(false);
  });

  it('leaves an https site its own requests elsewhere', () => {
    expect(request({ url: 'https://cdn.example.com/a.js', resourceType: 'script' })).toBe(true);
  });
});
