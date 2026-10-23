import { isLocalUrl, isWebTabUrl, localWebLinks } from '@agent-board/daemon/web-url';

/** Where a ⌘-click on an address in the output goes. */
export type LinkTarget = 'web-tab' | 'browser';

/** An address in a run of text, and where it is in it. */
export interface TextLink {
  url: string;
  start: number;
  end: number;
}

const HTTPS_LINK = /\bhttps:\/\/[^\s"'`<>[\]{}]+/g;

/** The URL inside `text` without the sentence's punctuation, and a closing bracket only where an opening one is in it. */
function trimmed(text: string): string {
  let url = text.replace(/[.,;:!?]+$/, '');
  while (url.endsWith(')') && (url.match(/\)/g) ?? []).length > (url.match(/\(/g) ?? []).length) url = url.slice(0, -1).replace(/[.,;:!?]+$/, '');
  return url;
}

/** The addresses in `text` that a ⌘-click can open: https anywhere, and http or https on this machine. Never another scheme. */
export function textLinks(text: string): TextLink[] {
  const remote = [...text.matchAll(HTTPS_LINK)].flatMap((match) => {
    const url = trimmed(match[0]);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return [];
    }
    if (isLocalUrl(parsed.href) || parsed.username !== '' || parsed.password !== '') return [];
    return [{ url: parsed.href, start: match.index, end: match.index + url.length }];
  });
  return [...localWebLinks(text), ...remote].sort((a, b) => a.start - b.start);
}

/**
 * The address an OSC 8 hyperlink points at, if a ⌘-click may open it: https anywhere, http on this machine, no password,
 * by the rules of a web tab. The target is an exact URI, not prose, so it is parsed whole: `'`, brackets, braces, a
 * trailing `.` or `)` and an upper-case scheme are all part of it. Whitespace or a control character in it is no URI.
 */
export function hyperlinkAddress(target: string): string | undefined {
  if (/[\s\p{Cc}]/u.test(target)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return undefined;
  }
  return isWebTabUrl(parsed.href) ? parsed.href : undefined;
}

/** The longest target a hover shows whole, in characters. */
const SHOWN_TARGET_CHARS = 200;

/**
 * What hovering an OSC 8 hyperlink says: where it goes, as its label may say otherwise, then what a click does. Where it
 * goes is the parsed address that would open, never the target as written, so a bidirectional override or a lookalike
 * in the target can't disguise it (a parsed host is punycode, and its controls are encoded). For a target that may not be
 * opened from here, that it can't be.
 */
export function hyperlinkHint(target: string, webTabs: boolean, keys: { open: string; browser: string }): string {
  const cut = (text: string) => (text.length > SHOWN_TARGET_CHARS ? `${text.slice(0, SHOWN_TARGET_CHARS)}…` : text);
  const address = hyperlinkAddress(target);
  if (address === undefined) return `${cut(target)} — can't be opened from here: only https, or http on this machine`;
  const what = linkHint(address, webTabs, keys);
  return what === '' ? cut(address) : `${cut(address)} — ${what}`;
}

/**
 * Where a ⌘-click on `url` goes: a web tab by default (where the window has tabs), the OS browser with Shift (https
 * only: the browser is never sent a local http address). Undefined where it can go nowhere.
 */
export function linkTarget(url: string, shift: boolean, webTabs: boolean): LinkTarget | undefined {
  const https = url.startsWith('https://');
  if (shift) return https ? 'browser' : undefined;
  if (webTabs && isWebTabUrl(url)) return 'web-tab';
  // A window without tabs has no web tab to open: an https address goes to the browser instead.
  return https ? 'browser' : undefined;
}

/** One row of the terminal's buffer. */
export interface BufferRow {
  /** What each cell holds: `''` for a blank one, `undefined` for the second half of a wide glyph. */
  cells: (string | undefined)[];
  /** Whether the terminal soft-wrapped it onto the row above. */
  wrapped: boolean;
}

/** An address in the buffer: 1-based cells, `end` the last cell of the address (inclusive), on any of the rows it spans. */
export interface BufferLink {
  url: string;
  start: { x: number; y: number };
  end: { x: number; y: number };
}

/** The longest address that is a link, in characters (xterm's own link finder reads about as many). */
export const MAX_LINK_CHARS = 2048;

/**
 * The addresses on the row `y` (1-based) of the buffer, as the terminal's rows `rowAt` gives them (undefined past
 * either end), including those that wrap onto other rows. Only rows the terminal itself marked wrapped join: a row that
 * merely fills the width, as a full-screen UI draws its lines, is a line of its own, however its last word looks.
 *
 * The rows read are as many as `MAX_LINK_CHARS` takes either side of `y`. An address longer than that is no link, and
 * nor is whatever the window cuts through: a cut-down address, or one nested in a longer one (`?next=https://…`), would
 * open something other than what is underlined.
 */
export function bufferLinks(rowAt: (y: number) => BufferRow | undefined, y: number, cols: number): BufferLink[] {
  const reach = Math.max(2, Math.ceil(MAX_LINK_CHARS / Math.max(cols, 1)) + 1);
  let top = y;
  while (top > 1 && y - top < reach && rowAt(top)?.wrapped) top--;
  let bottom = y;
  while (bottom - y < reach && rowAt(bottom + 1)?.wrapped) bottom++;
  const cutAbove = top > 1 && rowAt(top)?.wrapped === true;
  const cutBelow = rowAt(bottom + 1)?.wrapped === true;
  const text: string[] = [];
  const at: { x: number; y: number }[] = [];
  for (let r = top; r <= bottom; r++) {
    const row = rowAt(r);
    if (row === undefined) break;
    row.cells.slice(0, cols).forEach((cell, x) => {
      if (cell === undefined) return;
      // A blank cell is a space, so a word never runs across it. `text` is indexed by UTF-16 unit, as the match is.
      const chars = cell === '' ? ' ' : cell;
      for (let unit = 0; unit < chars.length; unit++) {
        text.push(chars[unit]!);
        at.push({ x: x + 1, y: r });
      }
    });
  }
  const joined = text.join('');
  // The word the window starts in and the one it ends in are cut where the chain goes on.
  const firstWordEnd = cutAbove ? joined.search(/\s|$/) : 0;
  const lastWordStart = cutBelow ? joined.search(/\S*$/) : joined.length;
  return textLinks(joined).flatMap(({ url, start, end }) => {
    if (start < firstWordEnd || end > lastWordStart || end - start > MAX_LINK_CHARS) return [];
    const first = at[start]!;
    const last = at[end - 1]!;
    return last.y < y || first.y > y ? [] : [{ url, start: first, end: last }];
  });
}

/** What hovering an address says a click does. */
export function linkHint(url: string, webTabs: boolean, keys: { open: string; browser: string }): string {
  const plain = linkTarget(url, false, webTabs);
  const browser = linkTarget(url, true, webTabs);
  const parts = [plain === undefined ? undefined : `${keys.open} to open in ${plain === 'web-tab' ? 'a web tab' : 'the browser'}`];
  if (browser !== undefined && plain !== 'browser') parts.push(`${keys.browser} for the browser`);
  return parts.filter((part) => part !== undefined).join(', ');
}
