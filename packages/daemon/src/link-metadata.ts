import type { TrackerProvider } from '@agent-board/tracker/providers';

/** What a link card shows of a page, from its HTML alone. */
export interface LinkMetadata {
  title?: string;
  /** The URL's host, without `www.`. */
  domain: string;
  /** Where the page's icon is: an https URL. */
  faviconUrl: string;
}

/** The `fetch` a page is read with; tests give a fake one, so nothing in them touches the network. */
export type FetchLike = (url: string, init: { signal: AbortSignal; redirect: 'follow'; headers: Record<string, string> }) => Promise<Response>;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  mdash: '—',
  ndash: '–',
  hellip: '…',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** The attributes of a tag's source (`a="1" b='2' c=3`), by lowercase name. */
function attributes(source: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of source.matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    const name = match[1]!.toLowerCase();
    if (!found.has(name)) found.set(name, decodeEntities(match[2] ?? match[3] ?? match[4] ?? ''));
  }
  return found;
}

const tidy = (text: string) => decodeEntities(text).replace(/\s+/g, ' ').trim();

/**
 * Reads a link card's title and icon out of a page's HTML without a DOM and without running anything in it: comments,
 * scripts and styles are cut out first, then `<meta>`, `<link>` and `<title>` tags are read as text. The title is the
 * page's `og:title`, else its `<title>`; the icon its icon link, else `/favicon.ico`.
 */
export function parseLinkMetadata(html: string, pageUrl: string): LinkMetadata {
  const page = new URL(pageUrl);
  const source = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '');
  let ogTitle: string | undefined;
  let icon: string | undefined;
  for (const [, tag, rest] of source.matchAll(/<(meta|link)\b([^>]*)>/gi)) {
    const attrs = attributes(rest!);
    if (tag!.toLowerCase() === 'meta') {
      const key = attrs.get('property') ?? attrs.get('name');
      if (ogTitle === undefined && key?.toLowerCase() === 'og:title') ogTitle = tidy(attrs.get('content') ?? '');
    } else if (icon === undefined && (attrs.get('rel') ?? '').toLowerCase().split(/\s+/).includes('icon')) {
      const href = attrs.get('href');
      if (href) icon = httpsUrl(href, page);
    }
  }
  const title = ogTitle || tidy(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source)?.[1] ?? '');
  return {
    ...(title ? { title } : {}),
    domain: domainOf(page),
    faviconUrl: icon ?? new URL('/favicon.ico', page).href,
  };
}

/** `href` resolved against `base`, if that is an https URL: an icon is never fetched over plain http. */
function httpsUrl(href: string, base: URL): string | undefined {
  try {
    const url = new URL(href, base);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export function domainOf(url: URL): string {
  return url.hostname.replace(/^www\./, '');
}

/** How long a page may take to answer. */
const LINK_FETCH_TIMEOUT_MS = 5_000;
/** How much of a page is read: the head is at the start. */
const MAX_PAGE_BYTES = 512 * 1024;

export interface FetchLinkOptions {
  fetch?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Fetches the page at `url` and reads its metadata. Best effort: any failure (offline, a bad status, a page that isn't
 * HTML, no answer in `timeoutMs`) gives just the domain. Nothing in the page is run.
 */
export async function fetchLinkPage(
  url: string,
  options: FetchLinkOptions = {},
): Promise<Partial<LinkMetadata> & { domain: string }> {
  const page = new URL(url);
  const bare = { domain: domainOf(page) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? LINK_FETCH_TIMEOUT_MS);
  try {
    const response = await (options.fetch ?? (globalThis.fetch as FetchLike))(page.href, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'text/html', 'user-agent': 'agent-board link preview' },
    });
    if (!response.ok || !/html/i.test(response.headers.get('content-type') ?? '')) return bare;
    const bytes = (await readCapped(response, options.maxBytes ?? MAX_PAGE_BYTES)).bytes;
    return parseLinkMetadata(decodePage(bytes, response.headers.get('content-type') ?? ''), page.href);
  } catch {
    return bare;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The first `maxBytes` of a response's body, and whether there was more. A server that streams on is cut off, never
 * buffered whole.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (response.body === null) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
    if (length > maxBytes) {
      truncated = true;
      break;
    }
  }
  await reader.cancel().catch(() => {});
  return { bytes: Buffer.concat(chunks).subarray(0, maxBytes), truncated };
}

/** A page's text, in the charset its content type names (else its `<meta charset>`, else UTF-8). */
function decodePage(bytes: Buffer, contentType: string): string {
  const named =
    /charset\s*=\s*["']?([\w:.-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?([\w:.-]+)/i.exec(bytes.subarray(0, 2048).toString('latin1'))?.[1];
  try {
    return new TextDecoder(named ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** An issue or pull request a URL points to in a tracker. */
export interface LinkTrackerRef {
  provider: TrackerProvider;
  /** The team key or `owner/repo` a zone's tracker is scoped to. */
  scope: string;
  /** The tracker's ID for it: `ACME-49`, `acme/app#34`. */
  id: string;
  kind: 'issue' | 'pr';
}

/** The issue or pull request a Linear or GitHub URL names, or undefined for any other URL. */
export function linkTrackerRef(url: string): LinkTrackerRef | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parsed.hostname === 'linear.app' && parts[1] === 'issue' && parts[2] !== undefined) {
    const key = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(parts[2]);
    if (key) return { provider: 'linear', scope: key[1]!.toUpperCase(), id: parts[2].toUpperCase(), kind: 'issue' };
  }
  if (parsed.hostname.replace(/^www\./, '') === 'github.com' && parts.length >= 4 && /^\d+$/.test(parts[3]!)) {
    const scope = `${parts[0]}/${parts[1]}`;
    if (parts[2] === 'issues') return { provider: 'github', scope, id: `${scope}#${parts[3]}`, kind: 'issue' };
    if (parts[2] === 'pull') return { provider: 'github', scope, id: `${scope}#${parts[3]}`, kind: 'pr' };
  }
  return undefined;
}
