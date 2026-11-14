// The quick ask gallery's states of Claude's own question dialog and its plan approval, for the visual shots: each drawn
// from data alone, as the board would draw it.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QuickAskDialogGallery } from './QuickAskGallery';

const html = renderToStaticMarkup(createElement(QuickAskDialogGallery));
const cells = html.split('<figure').slice(1);
const cell = (caption: string) => cells.find((each) => each.includes(`<figcaption>${caption}</figcaption>`)) ?? '';

describe("the quick ask gallery's dialog states", () => {
  it('draws one question, unanswered, with the line saying it is in Claude\'s dialog', () => {
    const one = cell('Dialog: one question');
    expect(one).toContain('Which cache should the product pages use?');
    expect(one).toContain('In Claude&#x27;s dialog · its terminal asks too');
  });

  it('draws a question that takes several with tick boxes, some ticked', () => {
    const several = cell('Dialog: several to tick');
    expect(several.match(/role="checkbox"/g)).toHaveLength(4);
    expect(several.match(/aria-checked="true"/g)).toHaveLength(2);
  });

  it('draws an Other answer in the user\'s own words', () => {
    expect(cell('Dialog: Other, in your words')).toContain('Redis, but only for the product pages');
  });

  it('draws the answers sent, and Claude keeping its dialog open', () => {
    expect(cell('Dialog: sent')).toContain('Sent to its dialog. Waiting for Claude to take it.');
    const kept = cell('Dialog: kept open');
    expect(kept).toContain('Claude kept its dialog open. Answer it in its terminal.');
    expect(kept).toContain('Open');
  });

  it("draws Claude's plan approval folded, and with Read the plan open", () => {
    const folded = cell('Plan approval');
    expect(folded).toContain('Read the plan');
    expect(folded).not.toContain('data-open');
    const open = cell('Plan approval: the plan read');
    expect(open).toContain('Show less');
    expect(open).toContain('data-open="true"');
    expect(open).toContain('Roll out behind the');
  });
});
