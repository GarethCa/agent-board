import { describe, expect, it } from 'vitest';
import { lineDiff } from '../src/text-diff.ts';

describe('a line diff, as an agent reads what the user changed in its document', () => {
  it('marks a changed line as removed then added, with a line of context either side', () => {
    const before = ['# Release plan', '', '## Order', 'Merge the flake fix first, then the pin bump.', '', '## Risks'].join('\n');
    const after = ['# Release plan', '', '## Order', 'Hold the pin bump to 1.5.', '', '## Risks'].join('\n');
    expect(lineDiff(before, after)).toBe(['  ## Order', '- Merge the flake fix first, then the pin bump.', '+ Hold the pin bump to 1.5.', '  '].join('\n'));
  });

  it('shows lines added at the end, and far-apart changes as separate hunks', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
    const after = ['A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n');
    expect(lineDiff(before, after)).toBe(['- a', '+ A', '  b', '…', '  h', '+ i'].join('\n'));
  });

  it('is empty when nothing changed but a final newline', () => {
    expect(lineDiff('one\ntwo\n', 'one\ntwo')).toBe('');
  });
});
