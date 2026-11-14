import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';
import { markForReading, remarkFindings, slugOf } from './remark-findings';
import { REVIEW } from './reading-fixture';

const parse = (text: string) => fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
const html = (text: string) => renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkFindings] }, text)).replace(/>\s+</g, '><');

describe('slugOf', () => {
  it('makes an id from a heading, never meeting the app’s own', () => {
    expect(slugOf('For you (plain English)')).toBe('read-for-you-plain-english');
    expect(slugOf('!!!')).toBe('read-section');
  });
});

describe('markForReading', () => {
  it('maps the review: its sections and seven findings under Findings', () => {
    const outline = markForReading(parse(REVIEW), false);
    expect(outline.sections.map((section) => section.title)).toEqual([
      'Checks run',
      'Security',
      'Findings',
      'Acceptance criteria (from the ticket)',
      'Summary for the tracker',
      'For you (plain English)',
    ]);
    const findings = outline.sections.find((section) => section.title === 'Findings')!.findings;
    expect(findings.map((finding) => finding.severity)).toEqual(['blocker', 'blocker', 'major', 'minor', 'minor', 'minor', 'minor']);
    expect(findings[0]!.id).toMatch(/^read-finding-the-windows-keep/);
    expect(findings[0]!.headline).not.toMatch(/\[blocker\]/i);
  });

  it('gives a repeated heading a numbered id', () => {
    const tree = parse('## Notes\n\n## Notes\n');
    expect(markForReading(tree).sections.map((section) => section.id)).toEqual(['read-notes', 'read-notes-1']);
  });

  it('keeps findings above the first section as leading', () => {
    expect(markForReading(parse('- [minor] A nit.\n\n## Later\n')).leading).toEqual([{ id: 'read-finding-a-nit', severity: 'minor', headline: 'A nit.' }]);
  });

  it('never gives a heading the decision card’s id, or a finding’s', () => {
    const outline = markForReading(parse('## Decision\n\n## Finding: a nit\n\n- [minor] A nit.\n'));
    const ids = [...outline.sections.map((section) => section.id), ...outline.sections.flatMap((section) => section.findings.map((finding) => finding.id))];
    expect(ids).not.toContain('read-decision');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('maps first-level sections when a document has no second-level ones', () => {
    expect(markForReading(parse('# One\n\n- [major] Slow.\n\n# Two\n')).sections).toEqual([
      { id: 'read-one', title: 'One', findings: [{ id: 'read-finding-slow', severity: 'major', headline: 'Slow.' }] },
      { id: 'read-two', title: 'Two', findings: [] },
    ]);
  });
});

describe('remarkFindings', () => {
  it('folds a tagged item to its bold headline, with a chip, and the rest as its body', () => {
    const out = html('1. **[blocker] The tests fail.** They fail on Linux.\n2. Untagged item.\n');
    expect(out).toContain('<div class="findings-tools" data-count="1"></div>');
    expect(out).toContain('<div class="findings">');
    expect(out).toContain('<details class="finding" id="read-finding-the-tests-fail" data-severity="blocker"><summary><span class="sev" data-sev="blocker">Blocker</span> The tests fail.</summary>');
    expect(out).toContain('<div class="finding-body"><p>They fail on Linux.</p></div>');
    expect(out).toContain('<li>Untagged item.</li>');
  });

  it('folds a plain tagged item whole into its summary', () => {
    expect(html('- [Major] Too slow\n')).toContain('<summary><span class="sev" data-sev="major">Major</span> Too slow</summary></details></div>');
  });

  it('leaves an untagged list as a list', () => {
    const out = html('- one\n- two\n');
    expect(out).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  it('folds a tagged item in a nested list, and keeps the nested list in its parent', () => {
    const out = html('- Parent\n  - [minor] Nested nit.\n');
    expect(out).toContain('<li>Parent');
    expect(out).toContain('<details class="finding" id="read-finding-nested-nit" data-severity="minor">');
  });

  it('takes the first sentence after a bold that is only the tag as the headline', () => {
    const out = html('1. **[blocker]** The build breaks. Because x.\n');
    expect(out).toContain('<summary><span class="sev" data-sev="blocker">Blocker</span> The build breaks.</summary>');
    expect(out).toContain('<div class="finding-body"><p>Because x.</p></div>');
    expect(markForReading(parse('- **[minor]** One sentence only\n')).leading[0]!.headline).toBe('One sentence only');
  });

  it('puts no Open all inside a finding, for findings nested in it', () => {
    const out = html('- [blocker] Parent.\n  - [minor] Child.\n');
    expect(out.match(/findings-tools/g)).toHaveLength(1);
    expect(out).toContain('id="read-finding-child"');
  });

  it('keeps a finding’s nested list in its body', () => {
    const out = html('- **[minor] Headline.**\n  - detail one\n');
    expect(out).toMatch(/<div class="finding-body"><ul><li>detail one<\/li>/);
  });

  it('gives headings their ids', () => {
    expect(html('## Checks run\n')).toBe('<h2 id="read-checks-run">Checks run</h2>');
  });
});
