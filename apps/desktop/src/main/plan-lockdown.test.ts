import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Session, WebContents } from 'electron';
import { lockDownPlanContents, lockDownPlanSession, mayPlanRequest, PLAN_CSP, PLAN_URL } from './plan-lockdown';

/** A web contents with only what the lockdown touches. */
function fakeContents() {
  return Object.assign(new EventEmitter(), {
    openHandler: undefined as undefined | ((details: { url: string }) => { action: string }),
    policy: undefined as string | undefined,
    setWindowOpenHandler(handler: (details: { url: string }) => { action: string }) {
      this.openHandler = handler;
    },
    setWebRTCIPHandlingPolicy(policy: string) {
      this.policy = policy;
    },
  });
}

const navigation = (url: string, isMainFrame = true) => {
  const event = { url, isMainFrame, prevented: false, preventDefault: () => (event.prevented = true) };
  return event;
};

describe("an HTML plan's page", () => {
  it('loads nothing but itself and what it carries: no network, no file, no app scheme', () => {
    expect(mayPlanRequest(PLAN_URL)).toBe(true);
    for (const url of ['data:image/png;base64,iVBOR', 'blob:null/1f2e']) expect(mayPlanRequest(url)).toBe(true);
    for (const url of ['https://example.com/', 'http://127.0.0.1:5173/', 'ws://localhost:5173/', 'file:///etc/passwd', 'agent-board-image://a.png', `${PLAN_URL}/other`]) {
      expect(mayPlanRequest(url)).toBe(false);
    }
  });

  it('navigates nowhere, opens no window, and says what it tried', () => {
    const contents = fakeContents();
    const blocked: string[] = [];
    lockDownPlanContents(contents as unknown as WebContents, (url) => blocked.push(url));
    for (const url of ['https://example.com/', 'http://localhost:5173/', 'about:blank']) {
      const event = navigation(url);
      contents.emit('will-frame-navigate', event);
      expect(event.prevented).toBe(true);
    }
    expect(contents.openHandler!({ url: 'https://example.com/' })).toEqual({ action: 'deny' });
    expect(blocked).toEqual(['https://example.com/', 'http://localhost:5173/', 'about:blank', 'https://example.com/']);
    // WebRTC, which no request rule sees, gets no UDP of its own.
    expect(contents.policy).toBe('disable_non_proxied_udp');
  });

  it('serves the plan from memory with a policy that lets in nothing from outside', async () => {
    let handler: ((request: Request) => Response) | undefined;
    let beforeRequest: ((details: { url: string }, callback: (response: { cancel: boolean }) => void) => void) | undefined;
    const session = Object.assign(new EventEmitter(), {
      setPermissionRequestHandler: () => {},
      setPermissionCheckHandler: () => {},
      setDevicePermissionHandler: () => {},
      webRequest: { onBeforeRequest: (listener: typeof beforeRequest) => (beforeRequest = listener) },
      protocol: { handle: (_scheme: string, serve: typeof handler) => (handler = serve) },
    });
    lockDownPlanSession(session as unknown as Session, () => '<h1>Plan</h1>');

    const response = handler!(new Request(PLAN_URL));
    expect(await response.text()).toBe('<h1>Plan</h1>');
    expect(response.headers.get('content-security-policy')).toBe(PLAN_CSP);
    expect(PLAN_CSP).toContain("default-src 'none'");
    expect(PLAN_CSP).toContain("form-action 'none'");
    // Scripts run, but nothing modal (print() included), no form, popup, top navigation or download, and no origin.
    expect(PLAN_CSP.split('; ')).toContain('sandbox allow-scripts');
    expect(PLAN_CSP).not.toContain('unsafe-eval');
    const verdicts: boolean[] = [];
    for (const url of [PLAN_URL, 'https://example.com/']) beforeRequest!({ url }, ({ cancel }) => verdicts.push(cancel));
    expect(verdicts).toEqual([false, true]);
  });
});
