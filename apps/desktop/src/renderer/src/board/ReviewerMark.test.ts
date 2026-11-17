import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReviewerMark } from './ReviewerMark';

const render = (reviewOf: string | null, implementer?: { name: string }) => renderToStaticMarkup(createElement(ReviewerMark, { agent: { reviewOf }, implementer }));

describe("a reviewer's mark after its state word on a glance tile", () => {
  it('is drawn for a reviewer, whatever its state, as an icon with an accessible label', () => {
    const html = render('builder-1');
    expect(html).toContain('data-testid="tile-reviewer-mark"');
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Reviewer"');
    expect(html).toContain('<svg');
  });

  it('names the agent whose work it reviews, to the eye and to a screen reader, when that agent is on the board', () => {
    expect(render('builder-1', { name: 'Fix login redirect' })).toContain('title="Reviews Fix login redirect"');
    expect(render('builder-1')).toContain('title="Reviews another agent&#x27;s work"');
    expect(render('builder-1', { name: 'Fix login redirect' })).toContain('aria-label="Reviewer of Fix login redirect"');
  });

  it('is not drawn for an agent that reviews nothing', () => {
    expect(render(null)).toBe('');
  });
});
