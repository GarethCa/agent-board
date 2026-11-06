import { describe, expect, it } from 'vitest';
import type { MemoryEntry } from '@agent-board/daemon/protocol';
import { countText, entryLine, entryName, filePreview, freshEntry, inListOrder, isOld, matching, memoryData, newestWrite, newMemoryData, scopeText, whenText, whoText } from './memory-card';

const NOW = new Date(2026, 10, 5, 15, 0);
const agent = { kind: 'agent', sessionId: 's1', name: 'impl-2' } as const;

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

describe('a memory card', () => {
  it('reads its saved data, filling in what an older card lacks, and names a new one after its zone', () => {
    expect(memoryData({ title: 'api memory', madeBy: agent, noAgents: true, count: 3 })).toEqual({ title: 'api memory', madeBy: agent, noAgents: true, count: 3, folded: false });
    expect(memoryData({})).toEqual({ title: 'Memory', madeBy: { kind: 'user' }, noAgents: false, count: 0, folded: false });
    expect(newMemoryData('api').title).toBe('api memory');
    expect(newMemoryData().title).toBe('Memory');
  });

  it('says who may use it: its zone, the whole board when loose, or no agents', () => {
    expect(scopeText(false, 'api')).toBe('Zone · api');
    expect(scopeText(false, undefined)).toBe('Board');
    expect(scopeText(true, 'api')).toBe('No agents');
  });

  it('lists pinned entries first, then the newest written', () => {
    const entries = [
      entry('old', { updatedAt: '2026-11-01T09:00:00.000Z' }),
      entry('pinned', { pinned: true, updatedAt: '2026-10-01T09:00:00.000Z' }),
      entry('new', { updatedAt: '2026-11-05T11:00:00.000Z' }),
    ];
    expect(inListOrder(entries).map((each) => each.id)).toEqual(['pinned', 'new', 'old']);
  });

  it('finds entries holding every word searched, in their key or text, any case', () => {
    const entries = [entry('db.fixtures', { text: 'Use seed-small' }), entry('test.cmd', { text: 'pnpm vitest run' }), entry('n', { key: null, text: 'Staging is down' })];
    expect(matching(entries, 'SEED db').map((each) => each.id)).toEqual(['db.fixtures']);
    expect(matching(entries, 'staging').map((each) => each.id)).toEqual(['n']);
    expect(matching(entries, '  ')).toHaveLength(3);
  });

  it('names a row by its key, "note" for a keyless one, and shows a file by its first line that says something', () => {
    expect(entryName(entry('a', { key: null }))).toBe('note');
    expect(entryLine(entry('a', { text: 'two\nlines' }))).toBe('two lines');
    expect(entryLine(entry('notes.md', { file: true, text: '\n\n# Release notes\nmore' }))).toBe('# Release notes');
    expect(entryLine(entry('empty.md', { file: true, text: '' }))).toBe('(empty file)');
  });

  it('says who wrote a row and when: the time today, the weekday this week, else the date; old after 30 days', () => {
    expect(whoText({ kind: 'user' })).toBe('you');
    expect(whoText(agent)).toBe('impl-2');
    expect(whenText(new Date(2026, 10, 5, 10, 40).toISOString(), NOW)).toBe('10:40');
    expect(whenText(new Date(2026, 10, 2, 10, 40).toISOString(), NOW)).toBe('Mon');
    expect(whenText(new Date(2026, 9, 20, 10, 40).toISOString(), NOW)).toBe('20 Oct');
    expect(isOld(entry('a', { updatedAt: new Date(2026, 9, 1).toISOString() }), NOW)).toBe(true);
    expect(isOld(entry('a', { updatedAt: new Date(2026, 9, 10).toISOString() }), NOW)).toBe(false);
  });

  it("shows and searches a file by its start: 40 lines, or 4000 characters of one huge line", () => {
    expect(filePreview('a\nb')).toBe('a\nb');
    expect(filePreview(Array.from({ length: 50 }, (_, at) => `line ${at}`).join('\n')).split('\n')).toHaveLength(41);
    expect(filePreview('x'.repeat(100_000))).toHaveLength(4002);
    const big = entry('bundle.js', { file: true, text: `${'x'.repeat(5000)} needle` });
    expect(matching([big], 'needle')).toEqual([]);
    expect(matching([big], 'bundle')).toHaveLength(1);
  });

  it('counts its entries and pins at its foot', () => {
    expect(countText([])).toBe('No entries yet');
    expect(countText([entry('a')])).toBe('1 entry');
    expect(countText([entry('a', { pinned: true }), entry('b')])).toBe('2 entries · 1 pinned');
  });

  it("flashes an agent's write made since it last read, but not the user's own nor what it had already seen", () => {
    const seen = '2026-11-05T09:00:00.000Z';
    const byAgent = entry('b', { changedBy: agent, updatedAt: '2026-11-05T10:00:00.000Z' });
    expect(freshEntry([entry('a'), byAgent], seen)?.id).toBe('b');
    expect(freshEntry([entry('a', { updatedAt: '2026-11-05T10:00:00.000Z' })], seen)).toBeUndefined();
    expect(freshEntry([byAgent], undefined)).toBeUndefined();
    expect(newestWrite([entry('a'), byAgent])).toBe('2026-11-05T10:00:00.000Z');
    expect(newestWrite([])).toBeUndefined();
  });
});
