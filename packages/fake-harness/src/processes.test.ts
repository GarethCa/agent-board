import { describe, expect, it } from 'vitest';
import { ancestry, descendants, leftovers, parsePs } from './processes.ts';

const listing = parsePs([
  '    1     0 /sbin/launchd',
  '   10     1 /bin/zsh',
  '   20    10 node pnpm test',
  '   30    20 node vitest run',
  '   31    30 node forks.js',
  '   40     1 node vitest run',
  '   41    40 node forks.js',
  '   42    41 node grandchild-of-orphan',
  '   50     1 node something-else',
].join('\n'));

describe('ancestry', () => {
  it('lists the parents up to but not including pid 1', () => {
    expect(ancestry(listing, 31)).toEqual([30, 20, 10]);
  });

  it('is empty for an orphan or an unknown pid', () => {
    expect(ancestry(listing, 40)).toEqual([]);
    expect(ancestry(listing, 999)).toEqual([]);
  });
});

describe('leftovers', () => {
  const node = (p: { command: string }) => p.command.startsWith('node ') && !p.command.includes('something-else');
  const pids = (found: { pid: number }[]) => found.map((p) => p.pid);

  it('finds the orphans the matcher picks and their matching descendants', () => {
    expect(pids(leftovers(listing, node))).toEqual([40, 41, 42]);
  });

  it('also finds the live descendants of an ancestor', () => {
    expect(pids(leftovers(listing, node, 20))).toEqual([30, 31, 40, 41, 42]);
  });
});

describe('descendants', () => {
  it('lists every process below a pid, and none above or beside it', () => {
    expect(descendants(listing, 20).map((p) => p.pid)).toEqual([30, 31]);
    expect(descendants(listing, 40).map((p) => p.pid)).toEqual([41, 42]);
    expect(descendants(listing, 31)).toEqual([]);
  });
});
