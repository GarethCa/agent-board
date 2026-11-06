import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentPageStore, pageFor } from './agent-page.ts';
import { MAX_PAGE_BLOCKS, PAGE_ICONS, PAGE_TONES } from './protocol.ts';

const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agent-page-')));
writeFileSync(join(cwd, 'sample.csv'), 'a,b\n');

/** A page of `blocks`, named and iconed. */
const page = (...blocks: unknown[]) => ({ name: 'Export', icon: 'route', blocks });
const refused = (value: unknown) => {
  try {
    pageFor(cwd, value);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('not refused');
};

describe("an agent's page", () => {
  it('keeps every kind of block, each with its title, icon and tone, defaulting to none and neutral', () => {
    expect(
      pageFor(
        cwd,
        page(
          { kind: 'heading', title: "Where I'm up to", text: 'Writing the export.\nThen docs.', progress: 60, icon: 'feather' },
          { kind: 'figures', figures: [{ value: '214', label: 'tests passing', icon: 'flask-conical', tone: 'green' }, { value: '18k', label: 'rows a second' }] },
          { kind: 'checklist', items: [{ text: 'Columns', state: 'done' }, { text: 'Tests', state: 'doing' }, { text: 'Docs' }] },
          { kind: 'callout', text: 'No tax column before 2024.', icon: 'lightbulb', tone: 'violet' },
          { kind: 'links', title: 'Try it', links: [{ url: 'http://localhost:5173/exports', label: 'Preview' }, { path: 'sample.csv' }] },
          { kind: 'note', title: 'Test logins', text: 'ann, bob · demo', tone: 'teal' },
        ),
      ),
    ).toEqual({
      name: 'Export',
      icon: 'route',
      blocks: [
        { kind: 'heading', title: "Where I'm up to", text: 'Writing the export.\nThen docs.', progress: 60, icon: 'feather', tone: 'neutral' },
        {
          kind: 'figures',
          title: null,
          icon: null,
          tone: 'neutral',
          figures: [
            { value: '214', label: 'tests passing', icon: 'flask-conical', tone: 'green' },
            { value: '18k', label: 'rows a second', icon: null, tone: 'neutral' },
          ],
        },
        { kind: 'checklist', title: null, icon: null, tone: 'neutral', items: [{ text: 'Columns', state: 'done' }, { text: 'Tests', state: 'doing' }, { text: 'Docs', state: 'todo' }] },
        { kind: 'callout', title: null, icon: 'lightbulb', tone: 'violet', text: 'No tax column before 2024.' },
        {
          kind: 'links',
          title: 'Try it',
          icon: null,
          tone: 'neutral',
          links: [
            { target: { kind: 'link', url: 'http://localhost:5173/exports' }, label: 'Preview' },
            { target: { kind: 'file', path: join(cwd, 'sample.csv') }, label: null },
          ],
        },
        { kind: 'note', title: 'Test logins', icon: null, tone: 'teal', text: 'ann, bob · demo' },
      ],
    });
  });

  it('keeps a name, title or label on one line, trimmed, and a block’s text with its line breaks', () => {
    const written = pageFor(cwd, { name: '  Ex\nport ', icon: 'route', blocks: [{ kind: 'callout', title: ' A\n\tnote ', text: '  one\r\ntwo  ' }] });
    expect(written.name).toBe('Ex port');
    expect(written.blocks[0]).toMatchObject({ title: 'A note', text: 'one\ntwo' });
  });

  it('takes out control characters and bidi controls, which would hide or turn round what the sidebar draws, but keeps joiners', () => {
    const written = pageFor(cwd, {
      name: 'a\u0000b\u202E',
      icon: 'route',
      blocks: [{ kind: 'callout', title: '\u2066Done\u2069 \u{1F468}\u200D\u{1F4BB}', text: 'one\u0007\n\ttwo\u200F' }],
    });
    expect(written.name).toBe('ab');
    expect(written.blocks[0]).toMatchObject({ title: 'Done \u{1F468}\u200D\u{1F4BB}', text: 'one\n\ttwo' });
  });

  it('offers only the curated icons and the agent tones, never orange or red', () => {
    expect(PAGE_ICONS.length).toBeGreaterThanOrEqual(36);
    expect(PAGE_ICONS.length).toBeLessThanOrEqual(44);
    // The board's own marks keep one meaning each: the sidebar's sections and controls, its shelves, a tile's branch
    // and timers, needs-you's flag, Ask Claude, and the faces of a link's, a note's and a file's rows. Typed by hand:
    // when the renderer gives an icon a fixed meaning, add it here (and drop it from PAGE_ICONS).
    const boardMarks = [
      'book-open', 'bot', 'calendar-clock', 'circle-dot', 'columns-2', 'file-stack', 'file-text', 'folder-git-2', 'git-pull-request', 'git-merge',
      'octagon-x', 'pause', 'pin', 'play', 'rows-2', 'shield-check', 'square-x', 'users-round', 'zap', 'package', 'activity', 'circle-alert',
      'triangle-alert', 'flag', 'git-branch', 'globe', 'sticky-note', 'timer', 'hourglass', 'alarm-clock', 'clock', 'clipboard-list', 'workflow',
      'message-circle-question-mark', 'list-todo', 'sparkles', 'layers',
    ];
    expect(PAGE_ICONS.filter((icon) => boardMarks.includes(icon))).toEqual([]);
    expect(PAGE_TONES).toEqual(['neutral', 'blue', 'green', 'violet', 'teal']);
    expect(refused({ ...page({ kind: 'callout', text: 'x' }), icon: 'bot' })).toMatch(/^page: icon must be one of route, feather/);
    expect(refused(page({ kind: 'callout', text: 'x', tone: 'orange' }))).toBe('block 1 (callout): tone must be one of neutral, blue, green, violet, teal');
    expect(refused(page({ kind: 'figures', figures: [{ value: '1', label: 'x', tone: 'red' }] }))).toMatch(/^block 1 \(figures\), figure 1: tone must be one of/);
  });

  it('refuses a page past its limits, naming the block and field', () => {
    expect(refused(null)).toMatch(/page must be an object/);
    expect(refused({ ...page({ kind: 'callout', text: 'x' }), name: 'Thirteen char' })).toBe('page: name is at most 12 characters');
    expect(refused({ ...page({ kind: 'callout', text: 'x' }), name: '  ' })).toBe('page: name must not be empty');
    expect(refused(page())).toBe('page: blocks must be a list of at least one block');
    expect(refused(page(...Array.from({ length: MAX_PAGE_BLOCKS + 1 }, () => ({ kind: 'callout', text: 'x' }))))).toBe('page: at most 12 blocks');
    expect(refused(page({ kind: 'html', text: '<b>' }))).toBe('block 1: kind must be one of heading, figures, checklist, callout, links, note');
    expect(refused(page({ kind: 'callout', text: 'x' }, { kind: 'heading', text: 'no title' }))).toBe('block 2 (heading): title must not be empty');
    expect(refused(page({ kind: 'heading', title: 'Up to', progress: 101 }))).toBe('block 1 (heading): progress must be a whole number from 0 to 100');
    expect(refused(page({ kind: 'figures', figures: [1, 2, 3] }))).toBe('block 1 (figures): at most 2 figures');
    expect(refused(page({ kind: 'figures', figures: [{ value: '1234567890123', label: 'x' }] }))).toBe('block 1 (figures), figure 1: value is at most 12 characters');
    expect(refused(page({ kind: 'checklist', items: [] }))).toBe('block 1 (checklist): items must be a list of at least one');
    expect(refused(page({ kind: 'checklist', items: [{ text: 'x', state: 'yes' }] }))).toBe('block 1 (checklist), item 1: state must be one of todo, doing, done');
    expect(refused(page({ kind: 'checklist', items: [{ text: 'a', state: 'doing' }, { text: 'b', state: 'doing' }] }))).toBe('block 1 (checklist): at most one item is doing');
    expect(refused(page({ kind: 'note', title: 'Logins', text: 'x'.repeat(2001) }))).toBe('block 1 (note): text is at most 2000 characters');
  });

  it('refuses a field a block, item or page does not take, so none goes missing quietly', () => {
    expect(refused(page({ kind: 'callout', text: 'x', html: '<b>' }))).toBe('block 1 (callout): html is not a field here; it takes kind, title, icon, tone, text');
    expect(refused(page({ kind: 'callout', text: 'x', progress: 3, figures: [] }))).toMatch(/^block 1 \(callout\): progress, figures are not fields here/);
    expect(refused(page({ kind: 'checklist', items: [{ text: 'x', checked: true }] }))).toBe('block 1 (checklist), item 1: checked is not a field here; it takes text, state');
    expect(refused({ ...page({ kind: 'callout', text: 'x' }), tone: 'blue' })).toBe('page: tone is not a field here; it takes name, icon, blocks');
  });

  it('counts characters as they are seen, an emoji or an accented letter one each', () => {
    expect(pageFor(cwd, { ...page({ kind: 'callout', text: 'x' }), name: '🚀🚀🚀🚀🚀🚀🚀' }).name).toBe('🚀🚀🚀🚀🚀🚀🚀');
    // Written decomposed (e and a combining accent), kept composed.
    expect(pageFor(cwd, { ...page({ kind: 'callout', text: 'x' }), name: 'Re\u0301sume\u0301 tests' }).name).toBe('Résumé tests');
    expect(pageFor(cwd, page({ kind: 'figures', figures: [{ value: '👩‍💻'.repeat(12), label: 'pairs' }] })).blocks).toHaveLength(1);
  });

  it('takes a link a web tab opens or a file that is there, one of them, as a pin does', () => {
    expect(refused(page({ kind: 'links', links: [{ url: 'javascript:alert(1)' }] }))).toMatch(/^block 1 \(links\), link 1: javascript:alert\(1\) is not a link a web tab opens/);
    expect(refused(page({ kind: 'links', links: [{ url: 'https://example.com' }, { path: 'missing.csv' }] }))).toMatch(/^block 1 \(links\), link 2: missing.csv is not a file/);
    expect(refused(page({ kind: 'links', links: [{ url: `https://example.com/${'a'.repeat(2048)}` }] }))).toBe('block 1 (links), link 1: a link is at most 2048 characters');
    expect(refused(page({ kind: 'links', links: [{ url: 'https://example.com', path: 'sample.csv' }] }))).toBe('block 1 (links), link 1: give one of url and path');
    expect(refused(page({ kind: 'links', links: [{ label: 'Nothing' }] }))).toBe('block 1 (links), link 1: give one of url and path');
  });
});

describe('a stored page, read back', () => {
  /** A store over a bare `agent_records`, and a way to put a row in it as a daemon, this one or a later one, wrote it. */
  const store = () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE agent_records (session_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL,
      recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), deleted_at TEXT, PRIMARY KEY (session_id, kind, key))`);
    const write = (data: unknown) => db.prepare("INSERT OR REPLACE INTO agent_records (session_id, kind, key, data) VALUES ('s', 'page', 'page', ?)").run(JSON.stringify(data));
    return { pages: createAgentPageStore(db), write };
  };

  it('is the page written', () => {
    const { pages } = store();
    const written = pages.put('s', pageFor(cwd, page({ kind: 'checklist', items: [{ text: 'Docs', state: 'doing' }] })));
    expect(written).toMatchObject({ name: 'Export', icon: 'route', writtenAt: expect.any(String), blocks: [{ kind: 'checklist', items: [{ text: 'Docs', state: 'doing' }] }] });
    expect(pages.of('s')).toEqual(written);
    expect(pages.clear('s')).toBe(true);
    expect(pages.of('s')).toBeUndefined();
    expect(pages.clear('s')).toBe(false);
  });

  it("from a later daemon, keeps what this one draws: an icon or tone it doesn't offer is none, a kind or shape it doesn't know is left out", () => {
    const { pages, write } = store();
    write({
      name: 'Export',
      icon: 'future-icon',
      blocks: [
        { kind: 'callout', text: 'Kept', icon: 'skull', tone: 'magenta', glow: true },
        { kind: 'figures' },
        { kind: 'chart', series: [1, 2] },
        { kind: 'checklist', items: [{ text: 'Docs', state: 'blocked' }] },
        { kind: 'links', links: [{ target: { kind: 'file', path: '/gone.csv' }, label: null }] },
      ],
    });
    expect(pages.of('s')).toMatchObject({
      icon: 'compass',
      blocks: [
        { kind: 'callout', text: 'Kept', icon: null, tone: 'neutral' },
        { kind: 'checklist', items: [{ text: 'Docs', state: 'todo' }] },
        { kind: 'links', links: [{ target: { kind: 'file', path: '/gone.csv' }, label: null }] },
      ],
    });
    expect((pages.of('s')!.blocks[0] as Record<string, unknown>).glow).toBeUndefined();
  });

  it('is no page when none of its blocks can be drawn, or it is not a page at all', () => {
    const { pages, write } = store();
    write({ name: 'Export', icon: 'route', blocks: [{ kind: 'chart' }, { kind: 'figures', figures: 'junk' }] });
    expect(pages.of('s')).toBeUndefined();
    write({ icon: 'route', blocks: [] });
    expect(pages.of('s')).toBeUndefined();
  });
});
