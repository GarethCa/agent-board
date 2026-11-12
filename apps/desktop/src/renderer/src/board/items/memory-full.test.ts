import { describe, expect, it } from 'vitest';
import type { HistoryVersion, MemoryEntry } from '@agent-board/daemon/protocol';
import {
  docBlocks,
  draftOf,
  editFor,
  escapeStays,
  factDraftError,
  historyLines,
  incoming,
  insertMarkdown,
  NO_FILTER,
  onLeave,
  shownEntries,
  tabCounts,
  titleError,
  writers,
  type Edited,
  type Focused,
} from './memory-full';

const NOW = new Date(2026, 10, 5, 15, 0);
const impl = { kind: 'agent', sessionId: 's1', name: 'impl-2' } as const;
const lead = { kind: 'agent', sessionId: 's2', name: 'lead' } as const;

function entry(id: string, fields: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    memoryId: 'm1',
    key: id,
    file: false,
    text: `value of ${id}`,
    pinned: false,
    madeBy: { kind: 'user' },
    changedBy: { kind: 'user' },
    createdAt: '2026-11-05T09:00:00.000Z',
    updatedAt: '2026-11-05T09:00:00.000Z',
    ...fields,
  };
}

const ENTRIES = [
  entry('guide', { file: true, text: '# Testing\n\nRerun board-mcp-http once.', changedBy: impl, updatedAt: '2026-11-05T12:00:00.000Z' }),
  entry('checklist', { file: true, text: '- tag\n- notes', updatedAt: '2026-11-03T12:00:00.000Z' }),
  entry('test-cmd', { text: 'vitest run', pinned: true, updatedAt: '2026-11-01T12:00:00.000Z' }),
  entry('node', { text: 'Node 22.4', changedBy: lead, updatedAt: '2026-09-20T12:00:00.000Z' }),
  entry('flaky', { text: 'rerun once', changedBy: impl, updatedAt: '2026-11-05T14:00:00.000Z' }),
];
const ids = (entries: MemoryEntry[]) => entries.map((each) => each.id);

describe("a memory's full-screen list", () => {
  it('shows every entry pinned first, or the documents, or the facts; History has the newest change first', () => {
    expect(ids(shownEntries(ENTRIES, NO_FILTER, NOW))).toEqual(['test-cmd', 'flaky', 'guide', 'checklist', 'node']);
    expect(ids(shownEntries(ENTRIES, { ...NO_FILTER, tab: 'docs' }, NOW))).toEqual(['guide', 'checklist']);
    expect(ids(shownEntries(ENTRIES, { ...NO_FILTER, tab: 'facts' }, NOW))).toEqual(['test-cmd', 'flaky', 'node']);
    expect(ids(shownEntries(ENTRIES, { ...NO_FILTER, tab: 'history' }, NOW))).toEqual(['flaky', 'guide', 'checklist', 'test-cmd', 'node']);
    expect(tabCounts(ENTRIES)).toEqual({ all: 5, docs: 2, facts: 3 });
  });

  it("narrows to the pinned, the stale, or one writer's, and searches a document's whole text", () => {
    expect(ids(shownEntries(ENTRIES, { ...NO_FILTER, pinned: true }, NOW))).toEqual(['test-cmd']);
    expect(ids(shownEntries(ENTRIES, { ...NO_FILTER, stale: true }, NOW))).toEqual(['node']);
    expect(ids(shownEntries(ENTRIES, { ...NO_FILTER, by: 'impl-2' }, NOW))).toEqual(['flaky', 'guide']);
    expect(ids(shownEntries(ENTRIES, { ...NO_FILTER, search: 'RERUN' }, NOW))).toEqual(['flaky', 'guide']);
    expect(ids(shownEntries(ENTRIES, { ...NO_FILTER, tab: 'docs', search: 'board-mcp' }, NOW))).toEqual(['guide']);
    expect(writers(ENTRIES)).toEqual(['you', 'impl-2', 'lead']);
    expect(writers([ENTRIES[3]!])).toEqual(['lead']);
  });
});

describe("the editor's Markdown buttons", () => {
  /** A text with its selection marked by [ and ]. */
  const at = (marked: string): Edited => {
    const start = marked.indexOf('[');
    const end = marked.indexOf(']') - 1;
    return { text: marked.replace('[', '').replace(']', ''), start, end };
  };
  const show = ({ text, start, end }: Edited) => `${text.slice(0, start)}[${text.slice(start, end)}]${text.slice(end)}`;

  it('wraps the selection in bold, italics, code or a link, or puts a word in to type over', () => {
    expect(show(insertMarkdown(at('run [vitest] now'), 'bold'))).toBe('run **[vitest]** now');
    expect(show(insertMarkdown(at('run [vitest] now'), 'italic'))).toBe('run _[vitest]_ now');
    expect(show(insertMarkdown(at('run [vitest] now'), 'code'))).toBe('run `[vitest]` now');
    expect(show(insertMarkdown(at('see [the docs]'), 'link'))).toBe('see [[the docs]](https://)');
    expect(show(insertMarkdown(at('run []'), 'bold'))).toBe('run **[bold text]**');
  });

  it('fences code over more than one line', () => {
    expect(show(insertMarkdown(at('[a\nb]'), 'code'))).toBe('```\n[a\nb]\n```');
  });

  it('marks each line it touches as a heading or a bullet, and unmarks them when all are marked', () => {
    expect(show(insertMarkdown(at('one\nt[wo\nthr]ee\nfour'), 'bullet'))).toBe('one\n- t[wo\n- thr]ee\nfour');
    expect(show(insertMarkdown(at('- t[wo\n- thr]ee'), 'bullet'))).toBe('t[wo\nthr]ee');
    expect(show(insertMarkdown(at('Run[]ning tests'), 'heading'))).toBe('## Run[]ning tests');
    expect(show(insertMarkdown(at('[one\n]two'), 'bullet'))).toBe('- [one\n]two');
    // The caret inside the marker taken off: it stays a caret, at the line's start.
    expect(insertMarkdown({ text: '- a', start: 1, end: 1 }, 'bullet')).toEqual({ text: 'a', start: 0, end: 0 });
  });
});

describe("a document's blocks", () => {
  it('draws headings and fenced code on their own, and the rest as Markdown', () => {
    expect(docBlocks('# Testing\n\n- one\n- two\n\n## Fakes\n```\nnpm test\n```\nlast')).toEqual([
      { type: 'heading', level: 1, text: 'Testing' },
      { type: 'markdown', text: '\n- one\n- two\n' },
      { type: 'heading', level: 2, text: 'Fakes' },
      { type: 'code', text: 'npm test' },
      { type: 'markdown', text: 'last' },
    ]);
    expect(docBlocks('#hashtag stays text')).toEqual([{ type: 'markdown', text: '#hashtag stays text' }]);
    expect(docBlocks('```\nnever closed')).toEqual([{ type: 'code', text: 'never closed' }]);
  });
});

describe("an entry's history", () => {
  const version = (n: number, action: string, value: Partial<MemoryEntry> | null, by: HistoryVersion<MemoryEntry>['by'] = impl): HistoryVersion<MemoryEntry> => ({
    version: n,
    action,
    value: value === null ? null : entry('guide', { file: true, ...value }),
    by,
    at: `2026-11-0${n}T12:00:00.000Z`,
  });

  it('says what each change did, by whom; Put back takes an earlier version that differs from the newest', () => {
    const lines = historyLines([
      version(7, 'confirm', null, lead),
      version(6, 'edit', { text: 'v3', pinned: true }, { kind: 'user' }),
      version(5, 'edit', { text: 'v3' }),
      version(4, 'edit', { text: 'v2' }),
      version(3, 'add', { text: 'v1' }),
    ]);
    expect(lines.map(({ who, what }) => `${who} ${what}`)).toEqual(['lead said it is still true', 'you pinned it', 'impl-2 changed the text', 'impl-2 changed the text', 'impl-2 wrote it']);
    expect(lines.map((line) => line.restorable)).toEqual([false, false, false, true, true]);
  });

  it('names a removal, a restore and a rename', () => {
    const lines = historyLines([version(4, 'restore', { text: 'v1', key: 'Guide' }), version(3, 'remove', null), version(2, 'edit', { text: 'v1', key: 'Guide' }), version(1, 'add', { text: 'v1' })]);
    expect(lines.map((line) => line.what)).toEqual(['put back an earlier version', 'removed it', 'renamed it', 'wrote it']);
  });
});

describe('what the editor checks before it saves', () => {
  it("wants a fact's value, a one-line key, and a short enough text", () => {
    expect(factDraftError('k', ' ', 120, 4000)).toBe('A fact needs a value');
    expect(factDraftError('a\nb', 'x', 120, 4000)).toMatch(/one line/);
    expect(factDraftError('k', 'x'.repeat(4001), 120, 4000)).toMatch(/as a document/);
    expect(factDraftError('', 'x', 120, 4000)).toBeUndefined();
  });

  it("wants a document's title on one line, and not another entry's", () => {
    expect(titleError('  ', 120, ENTRIES)).toMatch(/1 to 120/);
    expect(titleError('guide', 120, ENTRIES)).toBe('This memory has “guide” already');
    expect(titleError('guide', 120, ENTRIES, 'guide')).toBeUndefined();
    expect(titleError('New one', 120, ENTRIES)).toBeUndefined();
  });
});

describe('what a draft sends', () => {
  const base = { key: 'test-cmd', text: 'npm test' };

  it("sends nothing the daemon would trim away: a fact's spaces round its text, a key's spaces", () => {
    expect(editFor({ key: 'test-cmd', text: 'npm test ' }, base, false)).toBeUndefined();
    expect(editFor({ key: ' test-cmd ', text: 'npm test' }, base, false)).toBeUndefined();
    expect(editFor({ key: 'test-cmd', text: 'npm test --watch' }, base, false)).toEqual({ text: 'npm test --watch' });
    expect(editFor({ key: ' cmd ', text: ' npm test ' }, base, false)).toEqual({ key: 'cmd' });
    expect(editFor({ key: '  ', text: 'npm test' }, base, false)).toEqual({ key: null });
  });

  it("keeps a document's text as typed, spaces and all", () => {
    expect(editFor({ key: 'test-cmd', text: 'npm test ' }, base, true)).toEqual({ text: 'npm test ' });
    expect(editFor({ key: 'test-cmd ', text: 'npm test' }, base, true)).toBeUndefined();
  });
});

describe('an entry changed while the user has it open', () => {
  const at = (minute: number) => `2026-11-05T12:${String(minute).padStart(2, '0')}:00.000Z`;
  const base = { key: 'test-cmd', text: 'npm test', updatedAt: at(0) };
  const clean = { key: 'test-cmd', text: 'npm test' };
  const mine = { key: 'test-cmd', text: 'pnpm test' };
  const theirs = (fields: Partial<MemoryEntry>) => entry('e1', { key: 'test-cmd', text: 'npm test', updatedAt: at(5), ...fields });

  it('waits for a save in flight, and takes no older entry', () => {
    expect(incoming(theirs({ text: 'yarn test' }), base, mine, true)).toBe('none');
    expect(incoming(theirs({ text: 'yarn test', updatedAt: at(0) }), base, mine, false)).toBe('none');
  });

  it('moves the base on a change that leaves the text and key alone: a pin, a confirm', () => {
    expect(incoming(theirs({ pinned: true }), base, mine, false)).toBe('rebase');
    expect(incoming(theirs({ text: 'npm test ' }), base, mine, false)).toBe('rebase');
  });

  it('takes theirs over a clean draft, or a draft that already says the same', () => {
    expect(incoming(theirs({ text: 'yarn test' }), base, clean, false)).toBe('take');
    expect(incoming(theirs({ text: 'pnpm test' }), base, mine, false)).toBe('take');
  });

  it('holds a draft that differs from both', () => {
    expect(incoming(theirs({ text: 'yarn test' }), base, mine, false)).toBe('hold');
    expect(incoming(theirs({ key: 'cmd' }), base, mine, false)).toBe('hold');
  });

  it('reads a draft from an entry with no key as an empty key', () => {
    expect(draftOf(entry('e2', { key: null, text: 'x' }))).toEqual({ key: '', text: 'x' });
  });
});

describe('a draft as its editor closes', () => {
  const base = { key: 'k', text: 'old' };
  const fine = { file: false, error: false, held: false, removing: false };

  it('saves a changed draft, and does nothing for one that is unchanged or being removed', () => {
    expect(onLeave({ key: 'k', text: 'new' }, base, fine)).toBe('save');
    expect(onLeave({ key: 'k', text: 'old ' }, base, fine)).toBe('none');
    expect(onLeave({ key: 'k', text: 'new' }, base, { ...fine, removing: true })).toBe('none');
  });

  it("offers back a draft it can't save: one that fails its checks, or waits on a change made meanwhile", () => {
    expect(onLeave({ key: 'k', text: 'new' }, base, { ...fine, error: true })).toBe('offer');
    expect(onLeave({ key: 'k', text: 'new' }, base, { ...fine, held: true })).toBe('offer');
  });
});

describe('Esc in the full screen', () => {
  const focused = (inside: string[], value?: string): Focused => ({
    closest: (selector) => (inside.includes(selector) ? {} : null),
    matches: (selector) => inside.includes(selector),
    ...(value === undefined ? {} : { value }),
  });

  it('clears a search with text, and cancels a new entry, instead of closing', () => {
    expect(escapeStays(focused(['.memory-full-search input'], 'tues'))).toBe(true);
    expect(escapeStays(focused(['.memory-full-new']))).toBe(true);
  });

  it('closes from an empty search, anywhere else, or with nothing focused', () => {
    expect(escapeStays(focused(['.memory-full-search input'], ''))).toBe(false);
    expect(escapeStays(focused([]))).toBe(false);
    expect(escapeStays(null)).toBe(false);
  });
});
