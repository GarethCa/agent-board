import { describe, expect, it } from 'vitest';
import type { DoneTicket } from '@agent-board/daemon/protocol';
import type { Node } from '@xyflow/react';
import { doneChipText, doneChipWidth, doneLabel, doneLineChips, donePartsOf, estimateTextWidth } from './done-line';

const ticket = (n: number, fields: Partial<DoneTicket> = {}): DoneTicket => ({
  key: `issue:ACME-${n}`,
  issue: { provider: 'linear', id: `ACME-${n}`, title: `Ticket ${n}`, url: `https://example.test/ACME-${n}` },
  title: `Ticket ${n}`,
  pr: { number: 600 + n, url: `https://example.test/pull/${600 + n}` },
  members: [`agent:s${n}`],
  notes: [],
  doneAt: '2026-11-15T10:00:00.000Z',
  ...fields,
});

describe('doneChipText', () => {
  it('names a chip by its issue and title, or by the title alone', () => {
    expect(doneChipText(ticket(7, { title: 'Cut list foot' }))).toBe('ACME-7 · Cut list foot');
    expect(doneChipText(ticket(7, { issue: null, title: 'Spike' }))).toBe('Spike');
  });
  it('cuts a long title short', () => {
    expect(doneChipText(ticket(7, { issue: null, title: 'A title that runs on far too long' }))).toBe('A title that runs on …');
  });
  it('counts the tickets in its label', () => expect(doneLabel(3)).toBe('Done · 3'));
});

describe('doneLineChips', () => {
  it('shows every chip when the row has room', () => {
    const tickets = [ticket(1), ticket(2)];
    expect(doneLineChips(tickets, 2000)).toEqual({ shown: tickets, folded: [] });
  });
  it('folds the oldest into +N once the row is full, keeping the newest', () => {
    const tickets = Array.from({ length: 8 }, (_, index) => ticket(index + 1));
    const { shown, folded } = doneLineChips(tickets, 600);
    expect(shown.length).toBeGreaterThan(0);
    expect(folded.length).toBeGreaterThan(0);
    expect([...folded, ...shown]).toEqual(tickets);
    expect(shown.at(-1)).toBe(tickets.at(-1));
  });
  it('always shows the newest chip, even in a narrow row', () => {
    const tickets = [ticket(1), ticket(2)];
    expect(doneLineChips(tickets, 100).shown).toEqual([tickets[1]]);
  });
});

describe('doneChipWidth', () => {
  it('measures its text, so a chip of capitals is wider than one of lower case the same length', () => {
    const lower = ticket(1, { issue: null, title: 'quiet title', pr: null });
    const upper = ticket(1, { issue: null, title: 'QUIET TITLE', pr: null });
    expect(doneChipWidth(upper, estimateTextWidth)).toBeGreaterThan(doneChipWidth(lower, estimateTextWidth));
  });
  it('fits by what the measure says, never by a guess', () => {
    const wide = (text: string) => text.length * 20;
    const tickets = [ticket(1), ticket(2)];
    expect(doneLineChips(tickets, 600, wide).shown).toEqual([tickets[1]]);
    expect(doneLineChips(tickets, 600, () => 10).shown).toEqual(tickets);
  });
  it("leaves no capital title clipped: the estimate is never narrower than a wide font's capitals", () => {
    expect(estimateTextWidth('WWWWWWWWWW')).toBeGreaterThanOrEqual(70);
  });
});

describe('donePartsOf', () => {
  const node = (id: string, data: Record<string, unknown>) => ({ id, position: { x: 0, y: 0 }, data }) as Node;
  const nodes = new Map<string, Node>([
    ['agent:s1', node('agent:s1', { label: 'impl', agent: { sessionId: 's1' } })],
    ['item:n1', node('item:n1', { item: { id: 'n1', kind: 'agent-note', data: { text: 'Cut the foot\nthen the rest' } } })],
    ['item:d1', node('item:d1', { item: { id: 'd1', kind: 'document', data: { title: 'Plan', documentId: 'doc-1', agent: { sessionId: 's1' } } } })],
  ]);
  it('lists its agents, then its notes and docs, each by name, with what opens it', () => {
    expect(donePartsOf(ticket(1, { members: ['agent:s1', 'agent:gone'], notes: ['n1', 'd1', 'lost'] }), (id) => nodes.get(id))).toEqual([
      { kind: 'agent', id: 'agent:s1', label: 'impl', sessionId: 's1' },
      { kind: 'agent', id: 'agent:gone', label: 'gone', sessionId: 'gone' },
      { kind: 'note', id: 'n1', label: 'Cut the foot', text: 'Cut the foot\nthen the rest' },
      { kind: 'doc', id: 'd1', label: 'Plan', sessionId: 's1', documentId: 'doc-1' },
    ]);
  });
});
