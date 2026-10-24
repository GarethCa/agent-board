import { describe, expect, it } from 'vitest';
import type { DocumentSummary } from '@agent-board/daemon/protocol';
import { changedLineCount, docMeta, docTypeTag, editHint, htmlPreview, newlyShown, previewLines } from './doc-view';

describe('what the Document tab and a document card say', () => {
  it('tags a document by its format and says who wrote its version', () => {
    expect(docTypeTag('markdown')).toBe('MD');
    expect(docTypeTag('html')).toBe('HTML');
    const today = new Date().toISOString();
    expect(docMeta({ version: 3, writtenBy: 'agent', writtenAt: today }, 'Release orchestrator')).toMatch(/^v3 · written by Release orchestrator \d\d:\d\d$/);
    expect(docMeta({ version: 4, writtenBy: 'user', writtenAt: today }, 'Release orchestrator')).toMatch(/^v4 · written by you /);
  });

  it('previews a Markdown document’s first lines, and an HTML page’s visible words', () => {
    expect(previewLines('# Plan\n\n## Scope\n- One\n\n- Two\n- Three', 4)).toBe('**Plan**\n**Scope**\n- One\n- Two');
    expect(previewLines('# Plan\n\n## Scope\n- One', 4, 'Plan')).toBe('**Scope**\n- One');
    expect(htmlPreview('<html><head><title>T</title><style>p{}</style></head><body><h1>Bench</h1><p>SQLite&nbsp;41 ms &amp; more</p><script>x()</script></body></html>')).toBe(
      'Bench SQLite 41 ms & more',
    );
  });

  it('counts the lines a draft changes, and says so in the Edit bar', () => {
    expect(changedLineCount('a\nb', 'a\nb')).toBe(0);
    expect(changedLineCount('a\nb\nc', 'a\nB\nc')).toBe(1);
    expect(changedLineCount('a', 'a\nb\nc')).toBe(2);
    expect(editHint(0, '⌘S', 'esc')).toBe('esc cancels · ⌘S saves');
    expect(editHint(1, '⌘S', 'esc')).toBe('1 change · ⌘S saves and tells the agent');
    expect(editHint(3, '⌘S', 'esc')).toBe('3 changes · ⌘S saves and tells the agent');
    // With the extended keys off, neither key does anything, so neither is offered.
    expect(editHint(0, undefined, undefined)).toBe('Cancel or Save');
    expect(editHint(2, undefined, undefined)).toBe('2 changes · Save tells the agent');
    // A plan's edit is saved as the user's version.
    expect(editHint(1, '⌘S', 'esc', 'makes it v3, yours')).toBe('1 change · ⌘S saves and makes it v3, yours');
  });
});

describe('the documents an agent shows while the board is open', () => {
  const doc = (id: string, shownAt: string) => ({ id, shownAt }) as unknown as DocumentSummary;
  it('finds none at the first look, then each one shown or shown again since, oldest first', () => {
    const first = newlyShown(undefined, [{ docs: [doc('a', '1')] }]);
    expect(first.shown).toEqual([]);
    const agent = { docs: [doc('a', '3'), doc('b', '2'), doc('c', '1')] };
    const later = newlyShown(new Map([['a', '1'], ['c', '1']]), [agent]);
    expect(later.shown.map(({ document }) => document.id)).toEqual(['b', 'a']);
    expect(newlyShown(later.seen, [agent]).shown).toEqual([]);
  });
});
