// Passkeys in a web tab. Electron can't serve a passkey request from a page on an arbitrary site: its system passkeys
// (macOS 45+) need the site to list this app in its `apple-app-site-association`, and Touch ID credentials are bound to
// a signed app and to one session, which a web tab's own in-memory one doesn't outlive. With no prompt of its own, such
// a request neither succeeds nor fails: it stays pending until the page's timeout, which may be minutes. So the tab
// says so as soon as a page explicitly asks (`WebTabState.passkey`), offering the page in the OS browser, where
// passkeys work.
//
// What it misses, as there is no hook before a page's scripts without a preload, which the lockdown has none of:
// a request made before the page is ready (`dom-ready`), one in a frame inside the page (the probe isn't there), and one
// from a page that has silenced its console before the probe runs. Those fail silently, as before. A request for autofill (`mediation:
// 'conditional'`) is passive and meant to stay pending, so it is ignored.
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';

/**
 * What the probe logs when a page asks for a passkey, for the page whose secret is `token`: Electron names the main frame
 * for a message from any frame, so a frame inside the page is kept out by the token, not by where the message came from.
 * Only the page's own probe holds the token, as a cross-origin frame can't read it; a same-origin frame could, by
 * reading the probe's source or the page's own scripts, which are the page's own.
 */
export const passkeyAsked = (token: string): string => `\u2063agent-board:passkey-asked:${token}`;

/** Whether a web tab's page can't be served a passkey on `platform`: macOS, where Electron has no way to serve one for any site. */
export const passkeysUnavailable = (platform: NodeJS.Platform): boolean => platform === 'darwin';

/**
 * The probe the page runs, for the page whose secret is `token`: wraps `navigator.credentials.get` and `create` to log
 * `passkeyAsked(token)` when a page makes an explicit request for a public key (not an autofill one), and passes everything through untouched. It reads only
 * `options.publicKey` and `options.mediation`, and sends nothing; a page can see it is there (a marker on `credentials`,
 * the wrapped methods' source), run it away, or read the token from the source and log the message itself, which only
 * shows its tab's hint. It keeps the
 * console's `debug` as it was when it ran, so a page silencing it later doesn't hide a request.
 */
export const passkeyProbe = (token: string): string => `(() => {
  const credentials = navigator.credentials;
  if (!credentials || credentials.__agentBoardProbe) return;
  const log = console.debug.bind(console);
  for (const method of ['get', 'create']) {
    const original = credentials[method];
    if (typeof original !== 'function') continue;
    credentials[method] = function (options) {
      if (options && options.publicKey && options.mediation !== 'conditional') log(${JSON.stringify(passkeyAsked(token))});
      return original.apply(this, arguments);
    };
  }
  Object.defineProperty(credentials, '__agentBoardProbe', { value: true });
})();`;

/** Runs the probe in every page `contents` loads on `platform` where passkeys can't work, telling `onAsked` of each request its page's probe logs. */
export function probePasskeys(contents: WebContents, platform: NodeJS.Platform, onAsked: () => void): void {
  if (!passkeysUnavailable(platform)) return;
  // A new secret for each page, so one a page learned (from the probe's source) is no use on the next.
  let token = randomUUID();
  contents.on('dom-ready', () => {
    token = randomUUID();
    void contents.executeJavaScript(passkeyProbe(token)).catch(() => {});
  });
  contents.on('console-message', (event) => {
    if (event.message === passkeyAsked(token)) onAsked();
  });
}

/**
 * Whether a tab's page has asked for a passkey and the user hasn't dismissed that: kept with the tab, so it holds as
 * the tab moves between windows. `onChange` is told only when `shown` changes, so a page asking in a loop costs nothing.
 */
export function passkeyNotice(onChange: () => void) {
  let shown = false;
  const set = (next: boolean) => {
    if (next === shown) return;
    shown = next;
    onChange();
  };
  return {
    get shown() {
      return shown;
    },
    /** The page asked: the notice shows, unless it already does. */
    asked: () => set(true),
    /** The user dismissed it or went to their browser, or the page went elsewhere; the page asking again shows it again. */
    clear: () => set(false),
  };
}
