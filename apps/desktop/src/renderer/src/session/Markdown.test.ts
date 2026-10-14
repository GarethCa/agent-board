import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Markdown } from './Markdown';

/** The message's HTML, without the component's own wrapper. */
const render = (text: string) =>
  renderToStaticMarkup(createElement(Markdown, { text, onOpenLink: () => {} })).replace(/^<div class="chat-md">|<\/div>$/g, '');

describe("an agent's reply as Markdown", () => {
  test('a GFM table is a table', () => {
    const html = render('| Tool | Runs |\n| --- | ---: |\n| Read | 3 |\n| Bash | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Tool</th>');
    expect(html).toMatch(/<td[^>]*>Bash<\/td>/);
  });

  test('headings, lists, task lists, quotes and inline code', () => {
    const html = render('## Plan\n\n- one\n- [x] done\n- [ ] to do\n\n> quoted\n\nRun `pnpm test`.');
    expect(html).toContain('<h2>Plan</h2>');
    expect(html).toContain('<li>one</li>');
    expect(html).toMatch(/<input type="checkbox" disabled="" checked=""\/> ?done/);
    expect(html).toContain('<blockquote>');
    expect(html).toContain('<code>pnpm test</code>');
  });

  test('a code fence in a language it knows is highlighted; one it does not is plain', () => {
    const known = render('```ts\nconst answer: number = 42;\n```');
    expect(known).toContain('<pre class="chat-md-code">');
    expect(known).toContain('class="hljs-keyword">const</span>');
    expect(known).toContain('class="hljs-number">42</span>');
    const unknown = render('```cobol\nDISPLAY "HI".\n```');
    expect(unknown).toContain('DISPLAY &quot;HI&quot;.');
    expect(unknown).not.toContain('hljs-');
  });

  test('raw HTML is never rendered, not even as a tag in a paragraph', () => {
    const html = render('<script>alert(1)</script>\n\nHello <img src="http://example.com/x.png" onerror="alert(2)"> there\n\n<div onclick="x()">block</div>');
    expect(html).not.toMatch(/<script|<img|<div|onerror|onclick/);
    expect(html).toContain('Hello');
  });

  test('a Markdown image is not loaded: its alt text shows instead', () => {
    const html = render('![a diagram](http://example.com/diagram.png)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('example.com');
    expect(html).toContain('a diagram');
  });

  test('an https link is a link; any other is only its text', () => {
    expect(render('[docs](https://example.com/docs)')).toContain('<a href="https://example.com/docs"');
    for (const href of ['javascript:alert(1)', 'file:///etc/passwd', 'http://example.com']) {
      const html = render(`[click](${href})`);
      expect(html).not.toContain('<a');
      expect(html).toContain('click');
    }
  });
});
