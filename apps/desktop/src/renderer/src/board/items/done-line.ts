// What a zone's Done line shows: one row, a chip per finished ticket, the oldest folded into a "+N" chip once the row
// is full. Pure, so the row's fitting is tested without a browser.
import type { Node } from '@xyflow/react';
import { shortIssueId, type DoneTicket } from '@agent-board/daemon/protocol';
import { agentNoteData } from './agent-note';

/** How wide a text is, px, in the chips' font. */
export type MeasureText = (text: string) => number;

/**
 * A text's width before the font can be measured (tests, the first draw): generous, a capital or digit as wide as a
 * wide font draws it, so a chip is never fitted narrower than it draws.
 */
export const estimateTextWidth: MeasureText = (text) => [...text].reduce((width, char) => width + (/[A-Z0-9#@MW]/.test(char) ? 7.5 : 6.4), 0);

/** Each chip's padding, gap and glyphs, and the row's label and "+N" chip, px. */
const CHIP_CHROME = 46;
const LABEL_WIDTH = 92;
const MORE_WIDTH = 44;
/** The longest a chip's title runs before it is cut short. */
const TITLE_CHARS = 22;

/** A chip's words: "ACME-7 · Cut list foot", or the title alone for a ticket with no issue. */
export function doneChipText(ticket: DoneTicket): string {
  const title = ticket.title.length > TITLE_CHARS ? `${ticket.title.slice(0, TITLE_CHARS - 1)}…` : ticket.title;
  return ticket.issue === null ? title : `${shortIssueId(ticket.issue)} · ${title}`;
}

/** How wide a ticket's chip draws, by `measure`. */
export const doneChipWidth = (ticket: DoneTicket, measure: MeasureText): number =>
  CHIP_CHROME + measure(doneChipText(ticket)) + (ticket.pr === null ? 0 : measure(`#${ticket.pr.number}`) + 4);

/** The row's label, after its check: "Done · 3". */
export const doneLabel = (count: number): string => `Done · ${count}`;

/**
 * Which of `tickets` (oldest first) the row shows in `width`, and which fold into its "+N" chip: the newest that fit
 * stay, in the order they finished, and every older one folds.
 */
export function doneLineChips(tickets: readonly DoneTicket[], width: number, measure: MeasureText = estimateTextWidth): { shown: DoneTicket[]; folded: DoneTicket[] } {
  const chipWidth = (ticket: DoneTicket) => doneChipWidth(ticket, measure);
  let room = width - LABEL_WIDTH;
  let first = tickets.length;
  for (let index = tickets.length - 1; index >= 0; index -= 1) {
    const ticket = tickets[index] as DoneTicket;
    const needs = chipWidth(ticket) + (index > 0 ? MORE_WIDTH : 0);
    if (needs > room && first < tickets.length) break;
    room -= chipWidth(ticket);
    first = index;
  }
  return { shown: tickets.slice(first), folded: tickets.slice(0, first) };
}

/** One thing a finished ticket took to the Done line, as its row in the list shows it, with what opens it. */
export type DonePart =
  | { kind: 'agent'; id: string; label: string; sessionId: string }
  | { kind: 'note'; id: string; label: string; text: string }
  | { kind: 'doc'; id: string; label: string; sessionId: string; documentId: string };

/** The first line of a note, cut short, to name it by. */
const firstLine = (text: string): string => {
  const line = text.split('\n').find((each) => each.trim() !== '')?.trim() ?? '';
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
};

/**
 * What `ticket` holds, its agents then its notes and docs, read from the board's nodes (`nodeOf`, by node id): an agent
 * gone from the board is named by its session, an item gone is left out.
 */
export function donePartsOf(ticket: DoneTicket, nodeOf: (id: string) => Node | undefined): DonePart[] {
  const agents = ticket.members.map((id): DonePart => {
    const sessionId = id.slice(id.indexOf(':') + 1);
    const label = (nodeOf(id)?.data as { label?: unknown } | undefined)?.label;
    return { kind: 'agent', id, label: typeof label === 'string' && label !== '' ? label : sessionId, sessionId };
  });
  const items = ticket.notes.flatMap((id): DonePart[] => {
    const item = (nodeOf(`item:${id}`)?.data as { item?: { kind: string; data: Record<string, unknown> } } | undefined)?.item;
    if (item === undefined) return [];
    if (item.kind === 'document') {
      const data = item.data as { title?: unknown; documentId?: unknown; agent?: { sessionId?: unknown } };
      return [{ kind: 'doc', id, label: typeof data.title === 'string' ? data.title : 'Document', sessionId: String(data.agent?.sessionId ?? ''), documentId: String(data.documentId ?? '') }];
    }
    const text = item.kind === 'agent-note' ? agentNoteData(item.data).text : typeof item.data.title === 'string' ? item.data.title : '';
    return [{ kind: 'note', id, label: firstLine(text) || item.kind, text }];
  });
  return [...agents, ...items];
}
