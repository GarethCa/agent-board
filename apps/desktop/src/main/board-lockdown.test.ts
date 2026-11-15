import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Session } from 'electron';
import { lockDownBoardSession } from './board-lockdown';

type PermissionRequest = (contents: unknown, permission: string, callback: (granted: boolean) => void) => void;
type PermissionCheck = (contents: unknown, permission: string) => boolean;

/** A session with only what the lockdown touches, and the handlers it is given. */
function lockedSession() {
  const handlers: { request?: PermissionRequest; check?: PermissionCheck; device?: () => boolean } = {};
  const session = Object.assign(new EventEmitter(), {
    setPermissionRequestHandler: (handler: PermissionRequest) => (handlers.request = handler),
    setPermissionCheckHandler: (handler: PermissionCheck) => (handlers.check = handler),
    setDevicePermissionHandler: (handler: () => boolean) => (handlers.device = handler),
  });
  lockDownBoardSession(session as unknown as Session);
  const request = (permission: string) => {
    let granted: boolean | undefined;
    handlers.request?.(undefined, permission, (answer) => (granted = answer));
    return granted;
  };
  return { session, handlers, request };
}

describe("the board's session", () => {
  it.each(['media', 'notifications', 'geolocation', 'clipboard-read', 'openExternal', 'fullscreen', 'midi'])('denies a request for %s', (permission) => {
    const { request, handlers } = lockedSession();
    expect(request(permission)).toBe(false);
    expect(handlers.check?.(undefined, permission)).toBe(false);
  });

  it('grants writing text to the clipboard, which its copy buttons use', () => {
    const { request, handlers } = lockedSession();
    expect(request('clipboard-sanitized-write')).toBe(true);
    expect(handlers.check?.(undefined, 'clipboard-sanitized-write')).toBe(true);
  });

  it('picks no device and downloads nothing', () => {
    const { session, handlers } = lockedSession();
    expect(handlers.device?.()).toBe(false);
    const download = { prevented: false, preventDefault: () => (download.prevented = true) };
    session.emit('will-download', download);
    expect(download.prevented).toBe(true);
  });
});
