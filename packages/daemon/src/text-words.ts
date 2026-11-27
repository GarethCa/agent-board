// The small words the daemon, the app and the CLI all write the same way: a count with its noun, how long ago, and a
// text cut short. Pure, no Node APIs, so the app's windows can load it.

/** `n` with its noun: `1 task`, `2 tasks`; `many` for an irregular plural (`1 entry`, `2 entries`). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The ways a "how long ago" is written today:
 * - `inbox`: `just now`, `4 min ago`, `2 h ago`, `3 d ago`.
 * - `device`: `now`, `4 min ago`, `2 h ago`, `3 days ago`.
 * - `short`: `now`, `4 min`, `2 h`, `3 d`, for a row's corner (a caller shows a date once it is old).
 */
export type AgoStyle = 'inbox' | 'device' | 'short';

/** How long ago `at` was at `now` (ms), whole minutes, hours and days, rounded down. */
export function ago(at: string, now: number, style: AgoStyle): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  const tail = style === 'short' ? '' : ' ago';
  if (minutes < 1) return style === 'inbox' ? 'just now' : 'now';
  if (minutes < 60) return `${minutes} min${tail}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h${tail}`;
  const days = Math.floor(hours / 24);
  return style === 'device' ? `${plural(days, 'day')} ago` : `${days} d${tail}`;
}

// Text cut short for a line, a label or a note: by the characters a reader sees (graphemes), so an emoji is never
// split into half a surrogate pair.

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** `text` as it is if it has at most `length` characters, else its first ones and an ellipsis, `length` in all. */
export function cutText(text: string, length: number): string {
  // A string has at least as many UTF-16 units as characters: one that short fits without segmenting it.
  if (text.length <= length) return text;
  const characters = Array.from(graphemes.segment(text), (segment) => segment.segment);
  if (characters.length <= length) return text;
  return `${characters.slice(0, Math.max(0, length - 1)).join('').trimEnd()}…`;
}
