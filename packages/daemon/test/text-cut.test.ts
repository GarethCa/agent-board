import { describe, expect, it } from 'vitest';
import { cutText } from '../src/text-cut.ts';

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
