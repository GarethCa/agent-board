import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReadingView } from './ReadingView';
import { REVIEW } from './reading-fixture';

const render = (text: string, title?: string) =>
  renderToStaticMarkup(createElement(ReadingView, { text, title, path: '/docs/review.md', onOpenLink: () => undefined, testId: 'doc-body' })).replace(/>\s+</g, '><');

describe('ReadingView', () => {
  const out = render(REVIEW, 'Review of the interface size change (PR #578), round 1');

  it('lists the decision, every section and the findings with their severity on the rail', () => {
    const rail = out.slice(out.indexOf('<nav class="read-rail"'), out.indexOf('</nav>'));
    expect(rail).toContain('The decision');
    for (const title of ['Checks run', 'Security', 'Findings', 'Summary for the tracker', 'For you (plain English)']) expect(rail).toContain(title);
    expect(rail.match(/class="read-dot"/g)).toHaveLength(7);
    expect(rail.match(/data-sev="blocker"/g)).toHaveLength(2);
    expect(rail).toContain('2 blockers · 1 major · 4 minor');
    expect(rail).toContain('0%</b> read');
  });

  it('marks the section the decision was lifted from as on top', () => {
    expect(out).toMatch(/For you \(plain English\)<span class="read-up">↑ on top<\/span>/);
  });

  it('opens on the decision: the verdict, the time and its findings, and where it came from', () => {
    const card = out.slice(out.indexOf('<section class="read-decision"'), out.indexOf('</section>'));
    expect(card).toContain('<span class="read-verdict" data-tone="waiting">Changes requested</span>');
    expect(card).toMatch(/\d+ min read · 7 findings: 2 blockers, 1 major, 4 minor/);
    expect(card).toContain('From the document’s first line and its “For you (plain English)” section.');
    expect(card).toContain('href="#read-for-you-plain-english"');
  });

  it('sets the document in one column with its findings folded, and no second title', () => {
    expect(out).toContain('<div class="read-scroll" tabindex="0" data-testid="doc-body">');
    expect(out.match(/<details class="finding"/g)).toHaveLength(7);
    expect(out).not.toMatch(/<details class="finding"[^>]* open/);
    expect(out).not.toMatch(/<h1[^>]*>Review of the interface size change/);
  });

  it('shows a short document with no summary without a card, and no rail findings', () => {
    const short = render('# Plan\n\n## Order\n\nMerge the fix first.\n', 'Plan');
    expect(short).not.toContain('read-decision');
    expect(short).toContain('Merge the fix first.');
    expect(short).not.toContain('read-dot');
    expect(short).not.toContain('<h1');
  });
});
