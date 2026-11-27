// How a queue's jobs are typed, as one line or many: read the same by the CLI, the MCP and the board.

import { MAX_JOB_HEADLINE } from './protocol.ts';

/**
 * A queue's lines as typed: one job (or note) a line, a bullet or `[ ]` before it dropped, and ` -> link` at its end its
 * link, when what follows the arrow is one word (a URL, a path, `#12`); else the arrow is the job's own.
 */
export function jobsFrom(text: string): { text: string; link: string | null }[] {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/^(?:[-*+]|\d{1,3}[.)])\s+/, '').replace(/^\[[ ]?\]\s*/, '').trim())
    .filter((line) => line !== '')
    .map((line) => {
      const at = line.lastIndexOf(' -> ');
      const link = at < 0 ? '' : line.slice(at + 4).trim();
      return link === '' || /\s/.test(link) ? { text: line, link: null } : { text: line.slice(0, at).trim(), link };
    });
}

/**
 * A job's brief, as it goes to the agent that is to do it: its text, its link, and how to finish it or put it back. A
 * drained agent is started with it; the user's hand-on starts from it, and sends what they make of it.
 */
export function jobBrief(queue: { title: string; ref: string }, jobId: string, text: string, link: string | null, how: 'taken for you' | 'handed to you'): string {
  const short = jobId.slice(0, 8);
  // The commands name the queue by its ref: unique where its title may not be, and nothing in it a shell reads.
  return [
    text,
    ...(link === null ? [] : ['', `Link: ${link}`]),
    '',
    `This is job #${short} from the queue “${queue.title}”, ${how}. When it is done: agent-board queue done ${queue.ref} ${short}. To put it back for someone else: agent-board queue drop ${queue.ref} ${short}.`,
  ].join('\n');
}

/**
 * A job's headline and body: its first line, and the rest without the blank lines between. A first line longer than a
 * headline is cut short with an ellipsis, and the body is then the whole text, so nothing is lost.
 */
export function jobParts(text: string): { headline: string; body: string } {
  const at = text.indexOf('\n');
  const first = (at < 0 ? text : text.slice(0, at)).trim();
  const rest = at < 0 ? '' : text.slice(at + 1).replace(/^\s*\n/, '').trimEnd();
  if (first.length <= MAX_JOB_HEADLINE) return { headline: first, body: rest };
  return { headline: `${first.slice(0, MAX_JOB_HEADLINE - 1).trimEnd()}…`, body: text.trim() };
}

/**
 * The row `said` names among `rows`: by its whole id, or the start of its id (at least 4 characters), a `#` before it
 * dropped. `ref` is what was said, so trimmed; `starts` counts the rows a start matched, more than one leaving `row` unset.
 */
export function rowNamed<Row extends { id: string }>(rows: readonly Row[], said: string): { ref: string; row: Row | undefined; starts: number } {
  const ref = said.trim().replace(/^#/, '');
  const exact = rows.find((row) => row.id === ref);
  if (ref === '' || exact !== undefined) return { ref, row: exact, starts: 0 };
  const starts = ref.length < 4 ? [] : rows.filter((row) => row.id.startsWith(ref));
  return { ref, row: starts.length === 1 ? starts[0] : undefined, starts: starts.length };
}

/** A job's text from a headline and a body: one line, then a blank line and the body, when it has one. */
export const jobTextOf = (headline: string, body: string | undefined): string => (body === undefined || body.trim() === '' ? headline.trim() : `${headline.trim()}\n\n${body.trim()}`);
