// What an HTML plan's page may do (ADR-0014): an agent's plan is untrusted, so it is drawn in a view locked
// down harder than a web tab's. It is served from memory, loads nothing from anywhere else, goes nowhere, opens no
// window, gets no permission or device and downloads nothing. Its scripts run, inside that view alone: it has no Node,
// no preload, a sandbox and a partition of its own.
import type { Session, WebContents } from 'electron';
import { denyEverything, guardContents } from './web-lockdown';

/** The scheme a plan's page is served on, on its own partition only. */
const PLAN_SCHEME = 'agent-board-plan';

/** The plan's page: the one URL its view loads. */
export const PLAN_URL = `${PLAN_SCHEME}:plan`;

/**
 * The policy a plan's page is served with, over the request rule: its own inline scripts and styles, and images, fonts
 * and media it carries as `data:` or makes as `blob:`; nothing fetched, framed, posted or based elsewhere. It is
 * sandboxed with scripts alone allowed: no modal (`print()` among them, which `disableDialogs` doesn't stop), form,
 * popup, top navigation or download, and an opaque origin, so no storage and no file pickers.
 */
export const PLAN_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** Whether a plan's page may load `url`: itself, or what it carries (`data:`) or makes (`blob:`). Never the network. */
export function mayPlanRequest(url: string): boolean {
  return url === PLAN_URL || url.startsWith('data:') || url.startsWith('blob:');
}

/**
 * Keeps a plan's page where it is: every navigation and redirect, the page's own or a frame's, is stopped, and
 * `window.open` opens nothing; each is told to `onBlocked`. WebRTC, which no request rule sees, may use no UDP of its
 * own.
 */
export function lockDownPlanContents(contents: WebContents, onBlocked: (url: string) => void): void {
  guardContents(contents, { mayGo: () => false, onBlocked, onWindowOpen: onBlocked });
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
}

/**
 * Denies a plan view's session every permission, device and download, lets it make only the requests
 * `mayPlanRequest` allows, and serves `page()`, its plan, at `PLAN_URL`.
 */
export function lockDownPlanSession(session: Session, page: () => string | undefined): void {
  denyEverything(session);
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !mayPlanRequest(details.url) }));
  session.protocol.handle(PLAN_SCHEME, () => new Response(page() ?? '', { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': PLAN_CSP } }));
}
