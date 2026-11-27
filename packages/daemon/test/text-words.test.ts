import { describe, expect, it } from 'vitest';
import { ago, cutText, plural } from '../src/text-words.ts';

describe('plural', () => {
  it('adds an s except for one', () => {
    expect([0, 1, 2].map((n) => plural(n, 'task'))).toEqual(['0 tasks', '1 task', '2 tasks']);
  });
  it('takes an irregular plural', () => {
    expect([1, 2].map((n) => plural(n, 'entry', 'entries'))).toEqual(['1 entry', '2 entries']);
  });
});

describe('ago', () => {
  const now = Date.parse('2026-11-20T12:00:00Z');
  const at = (ms: number) => new Date(now - ms).toISOString();
  const MIN = 60_000;
  const H = 60 * MIN;
  const D = 24 * H;
  const cases: [string, number, string, string, string][] = [
    ['under a minute', 59_000, 'just now', 'now', 'now'],
    ['a minute', MIN, '1 min ago', '1 min ago', '1 min'],
    ['59 minutes', 59 * MIN + 59_000, '59 min ago', '59 min ago', '59 min'],
    ['an hour', H, '1 h ago', '1 h ago', '1 h'],
    ['23 hours', 23 * H + 59 * MIN, '23 h ago', '23 h ago', '23 h'],
    ['a day', D, '1 d ago', '1 day ago', '1 d'],
    ['three days', 3 * D + H, '3 d ago', '3 days ago', '3 d'],
    ['the future', -5 * MIN, 'just now', 'now', 'now'],
  ];
  it.each(cases)('%s', (_name, ms, inbox, device, short) => {
    expect([ago(at(ms), now, 'inbox'), ago(at(ms), now, 'device'), ago(at(ms), now, 'short')]).toEqual([inbox, device, short]);
  });
});

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('cutText', () => {
  it('leaves text that fits as it is', () => {
    expect(cutText('done', 4)).toBe('done');
  });

  it('cuts longer text short with an ellipsis, at most the length given', () => {
    expect(cutText('arrange the crew', 8)).toBe('arrange…');
  });

  it('never splits an emoji, even where a cut by UTF-16 units would land inside it', () => {
    // '🤖' is two UTF-16 units: a cut at 6 units would keep its first half.
    const cut = cutText('note 🤖 lead · 23:15', 7);
    expect(cut).toBe('note 🤖…');
    expect(JSON.stringify(cut)).not.toMatch(/\\ud8/);
    expect(loneSurrogate.test(cutText('🤖🤖🤖🤖', 3))).toBe(false);
  });

  it('keeps a family or flag emoji whole: one character as the reader sees it', () => {
    expect(cutText('👨‍👩‍👧 and 🇬🇧 here', 3)).toBe('👨‍👩‍👧…');
    expect(cutText('ab🇬🇧cd', 4)).toBe('ab🇬🇧…');
  });
});
