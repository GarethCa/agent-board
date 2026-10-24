// What the Document tab and a document's card on the board say of a document an agent showed: pure, so the words are
// unit-tested.
import type { DocumentSummary, PlanFormat } from '@agent-board/daemon/protocol';
import { shortWhen } from '../when';

/** A document's type tag: MD or HTML. */
export const docTypeTag = (format: PlanFormat): 'MD' | 'HTML' => (format === 'markdown' ? 'MD' : 'HTML');

/** The line under a document's title: its version, who last wrote it and when. */
export function docMeta(document: Pick<DocumentSummary, 'version' | 'writtenBy' | 'writtenAt'>, agentName: string): string {
  const by = document.writtenBy === 'user' ? 'you' : agentName;
  return `v${document.version} · written by ${by} ${shortWhen(document.writtenAt)}`;
}

/**
 * The first lines of a Markdown document for its card's preview, which draws a sticky's markdown: no blank lines, a
 * heading as a bold line, at most `count`, and not a first heading that is its `title`.
 */
export function previewLines(text: string, count = 8, title?: string): string {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  // The card says its title already: a first heading that is the title isn't said again.
  const first = /^#{1,6}\s+(.*?)\s*#*$/.exec(lines[0] ?? '')?.[1];
  return (first !== undefined && first === title ? lines.slice(1) : lines)
    .slice(0, count)
    .map((line) => line.replace(/^#{1,6}\s+(.*?)\s*#*$/, '**$1**'))
    .join('\n');
}

/** The visible text of an HTML page, for its card's preview: no tags, scripts or styles, collapsed to one paragraph. */
export function htmlPreview(html: string, length = 280): string {
  return html
    .replace(/<(script|style|title|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, length);
}

/** How many lines the draft changes from the text it started from: those it adds or takes out, by count of each line. */
export function changedLineCount(before: string, after: string): number {
  if (before === after) return 0;
  const counts = new Map<string, number>();
  for (const line of before.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  let added = 0;
  for (const line of after.split('\n')) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else added++;
  }
  const removed = [...counts.values()].reduce((sum, left) => sum + left, 0);
  return Math.max(added, removed, 1);
}

/**
 * The Edit bar's hint: the keys while nothing is changed (each undefined while the key setting turns it off), else how
 * much is, and what saving does besides (`does`).
 */
export function editHint(changed: number, saveKey: string | undefined, cancelKey: string | undefined, does = 'tells the agent'): string {
  const count = `${changed} ${changed === 1 ? 'change' : 'changes'}`;
  if (changed > 0) return saveKey === undefined ? `${count} · Save ${does}` : `${count} · ${saveKey} saves and ${does}`;
  return saveKey === undefined || cancelKey === undefined ? 'Cancel or Save' : `${cancelKey} cancels · ${saveKey} saves`;
}

/**
 * The documents shown since `seen` was taken (each document's `shownAt` by id), newest last, and `seen` as it is now.
 * The first look (`seen` undefined) finds none: what was shown before the board opened stays where it is.
 */
export function newlyShown<A extends { docs: readonly DocumentSummary[] }>(
  seen: ReadonlyMap<string, string> | undefined,
  agents: readonly A[],
): { shown: { agent: A; document: DocumentSummary }[]; seen: Map<string, string> } {
  const now = new Map(agents.flatMap((agent) => agent.docs.map((document) => [document.id, document.shownAt] as const)));
  if (seen === undefined) return { shown: [], seen: now };
  const shown = agents
    .flatMap((agent) => agent.docs.map((document) => ({ agent, document })))
    .filter(({ document }) => seen.get(document.id) !== document.shownAt)
    .sort((a, b) => a.document.shownAt.localeCompare(b.document.shownAt));
  return { shown, seen: now };
}

/** The document the agent showed last. */
export const latestShown = (docs: readonly DocumentSummary[]): DocumentSummary => docs.reduce((latest, each) => (each.shownAt > latest.shownAt ? each : latest));
