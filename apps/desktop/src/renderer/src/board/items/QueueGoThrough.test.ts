import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Agent, QueueJob } from '@agent-board/daemon/protocol';
import type { NeedsYouEntry } from '../../../../shared/needs-you';
import { GoThroughView } from './QueueGoThrough';
import type { LookItem } from './to-look-at';

const noop = () => {};
const ACTS = { onOpen: noop, onNext: noop, onSkip: noop, onDone: noop, onBack: noop };
const job = (fields: Partial<QueueJob>) => ({ id: 'a', text: 'Cache product images', link: null, state: 'queued', kind: 'review', madeBy: { kind: 'user' }, createdAt: '2026-11-05T09:00:00Z', ...fields }) as QueueJob;
const asking = { agent: { sessionId: 'impl-3', name: 'impl-3', zoneId: 'api', ask: { question: 'Keep the old cursor param?' } } as unknown as Agent, kind: 'asks', since: '2026-11-05T09:00:00Z' } as NeedsYouEntry;

const render = (item: LookItem) => renderToStaticMarkup(createElement(GoThroughView, { title: 'To look at', item, at: 2, total: 4, now: new Date('2026-11-05T15:00:00Z'), ...ACTS }));
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => match[1]!.replace(/<[^>]+>/g, '').trim());

describe('the tile going through its queue', () => {
  it('shows an item with its place, its kind, its headline and the rest of its text, and every action', () => {
    const html = render({ kind: 'job', job: job({ text: 'Cache product images\n\nThe CDN keeps them a day.', link: 'https://example.test/acme/api/pull/214' }) });
    expect(html).toContain('2 of 4');
    expect(html).toContain('PULL REQUEST #214');
    expect(html).toContain('The CDN keeps them a day.');
    expect(buttons(html)).toEqual(['← Back', 'Skip S', 'Done D', 'Next →', 'Open pull request ↵']);
  });

  it('has no open for a note with no link, and no Skip or Done for an agent that asks, which goes once answered', () => {
    expect(buttons(render({ kind: 'job', job: job({ kind: 'read' }) }))).toEqual(['← Back', 'Skip S', 'Done D', 'Next →']);
    const needs = render({ kind: 'needs', entry: asking });
    expect(needs).toContain('Keep the old cursor param?');
    expect(buttons(needs)).toEqual(['← Back', 'Next →', 'Open the agent ↵']);
  });

  it('is drawn in the tile, never as a dialog over the board', () => {
    expect(render({ kind: 'needs', entry: asking })).not.toContain('role="dialog"');
  });
});
