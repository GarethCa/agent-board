import { describe, expect, it } from 'vitest';
import type { Agent, QueueJob } from '@agent-board/daemon/protocol';
import type { NeedsYouEntry } from '../../../../shared/needs-you';
import { itemKind, lookCount, lookItems, lookKey, needsInScope, needsLine } from './to-look-at';

const job = (id: string, fields: Partial<QueueJob> = {}) => ({ id, text: `item ${id}`, link: null, state: 'queued', kind: 'job', ...fields }) as QueueJob;
const asking = (sessionId: string, zoneId: string | null) =>
  ({ agent: { sessionId, name: sessionId, zoneId, ask: { question: 'Keep the old cursor param?' } } as unknown as Agent, kind: 'asks', since: '2026-11-05T09:00:00Z' }) as NeedsYouEntry;

describe("the user's queue", () => {
  it('says what kind each item is from its link: a pull request, an issue, a document, a page, or a note', () => {
    expect(itemKind(job('a', { link: 'https://example.test/acme/api/pull/214' }))).toMatchObject({ chip: 'PR #214', head: 'PULL REQUEST #214', open: 'Open pull request' });
    expect(itemKind(job('a', { link: 'https://example.test/acme/api/issues/12' })).chip).toBe('#12');
    expect(itemKind(job('a', { link: '#31' })).chip).toBe('#31');
    expect(itemKind(job('a', { link: 'docs/plans/checkout.md' }))).toMatchObject({ chip: 'doc', open: 'Read it' });
    expect(itemKind(job('a', { link: 'https://example.test/dashboards/load' })).chip).toBe('link');
    expect(itemKind(job('a')).chip).toBe('note');
  });

  it("shows its zone's Needs-you rows (every one, loose), first, and counts them with its open items", () => {
    const needs = [asking('impl-3', 'api'), asking('impl-5', 'web')];
    expect(needsInScope(needs, 'api').map((entry) => entry.agent.sessionId)).toEqual(['impl-3']);
    expect(needsInScope(needs, null)).toHaveLength(2);
    const items = lookItems([job('a'), job('d', { state: 'done' }), job('b')], needsInScope(needs, 'api'));
    expect(items.map(lookKey)).toEqual(['needs:impl-3:asks', 'a', 'b']);
    expect(lookCount(2, needsInScope(needs, 'api'))).toBe(3);
    expect(needsLine(needs[0]!)).toEqual({ tag: 'asks', line: 'Keep the old cursor param?' });
  });
});
