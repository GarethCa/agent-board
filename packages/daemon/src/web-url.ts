// What a web tab (BI2) may show: https anywhere, and plain http only from this machine (a dev server). Pure,
// so the daemon (which keeps a tab's URL), the main process (which loads it) and the app (its address row) share it.

/** The hosts of this machine a web tab may load over plain http, as `URL` writes them. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** What a web tab may show, said wherever it refuses something. */
export const WEB_TAB_RULE = 'A web tab shows https pages, and http ones on this machine (localhost, 127.0.0.1, [::1]).';

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** Whether `url`, parsed, is on an allowed host for its scheme: `secure` anywhere, `plain` only on this machine. */
function allowed(parsed: URL | undefined, secure: readonly string[], plain: readonly string[]): boolean {
  if (parsed === undefined || parsed.hostname === '' || parsed.username !== '' || parsed.password !== '') return false;
  if (secure.includes(parsed.protocol)) return true;
  return plain.includes(parsed.protocol) && LOCAL_HOSTS.has(parsed.hostname);
}

/**
 * Whether a web tab may show `url`, load it or be sent to it: https, or http to localhost, 127.0.0.1 or [::1]. Never
 * `file:`, `data:`, `javascript:` or any other scheme, nor a URL carrying a name or password.
 */
export const isWebTabUrl = (url: string): boolean => allowed(parse(url), ['https:'], ['http:']);

/** Whether a page in a web tab may fetch `url`: what it may show, and websockets to the same places (a dev server's hot reload). */
export const isWebTabRequest = (url: string): boolean => allowed(parse(url), ['https:', 'wss:'], ['http:', 'ws:']);

/** Whether `url` is on this machine, over any scheme. */
export const isLocalUrl = (url: string): boolean => LOCAL_HOSTS.has(parse(url)?.hostname ?? '');

/**
 * The URL a web tab keeps for its next start: where its page is, without its query or fragment, which may hold a
 * sign-in's code or token (`/auth/callback?code=…`, `#access_token=…`). Undefined for one it may not show.
 */
export function keptWebUrl(url: string): string | undefined {
  const parsed = parse(url);
  if (parsed === undefined || !isWebTabUrl(parsed.href)) return undefined;
  return `${parsed.origin}${parsed.pathname}`;
}

/** Whether `host`, as typed (with any port), names this machine. */
const isLocalHost = (host: string): boolean => LOCAL_HOSTS.has(parse(`http://${host}`)?.hostname ?? '');

/**
 * The URL a web tab goes to for what was typed in its address row, if it may: as typed with a scheme, else over http
 * for this machine (`localhost:5173`) and https for anywhere else (`example.com`).
 */
export function webTabUrl(typed: string): string | undefined {
  const text = typed.trim();
  if (text === '') return undefined;
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text) || /^[a-z]+:(?!\d)/i.test(text) ? text : `${isLocalHost(text.split('/')[0]!) ? 'http' : 'https'}://${text}`;
  const parsed = parse(withScheme);
  // A host needs a dot or to be this machine's: "not a url at all" is no address.
  if (parsed === undefined || !isWebTabUrl(parsed.href) || (!LOCAL_HOSTS.has(parsed.hostname) && !parsed.hostname.includes('.'))) return undefined;
  return parsed.href;
}

/** What a web tab is called: its URL's host, with the port where it has one (`localhost:5173`). */
export const webTabLabel = (url: string): string => parse(url)?.host || url;

/** A local web address in a line of output, and where it is in the line. */
export interface LocalWebLink {
  url: string;
  start: number;
  end: number;
}

const LOCAL_LINK = new RegExp(
  `\\bhttps?://(?:${[...LOCAL_HOSTS].map((host) => host.replace(/[.[\]]/g, '\\$&')).join('|')})(?::\\d+)?(?![\\w-]|\\.[\\w-])(?:[/?#][^\\s"'\`<>()[\\]{}]*)?`,
  'g',
);

/**
 * The addresses on this machine in a line of an agent's output (a dev server's "Local: http://localhost:5173/"), for
 * a web tab to open: never one elsewhere. Trailing punctuation is the sentence's, not the URL's.
 */
export function localWebLinks(line: string): LocalWebLink[] {
  return [...line.matchAll(LOCAL_LINK)].flatMap((match) => {
    const text = match[0].replace(/[.,;:!?]+$/, '');
    const parsed = parse(text);
    if (parsed === undefined || !isWebTabUrl(parsed.href) || !LOCAL_HOSTS.has(parsed.hostname)) return [];
    return [{ url: parsed.href, start: match.index, end: match.index + text.length }];
  });
}
