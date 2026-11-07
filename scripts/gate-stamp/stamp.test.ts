import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPass, readStamp, readTreeStamp, STAMP_KEEP_DAYS, stampDir, treeOf, writeStamp } from './stamp.ts';

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const SHA = 'a'.repeat(40);
const TREE = 'd'.repeat(40);

it('reads back when a commit passed the full gate', () => {
  dir = join(mkdtempSync(join(tmpdir(), 'ab-stamp-')), 'stamps');
  writeStamp(dir, SHA, new Date('2026-10-23T17:02:00Z'));
  expect(readStamp(dir, SHA)).toEqual(new Date('2026-10-23T17:02:00Z'));
});

it('has no stamp for a commit that never passed', () => {
  dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
  writeStamp(dir, SHA, new Date('2026-10-23T17:02:00Z'));
  expect(readStamp(dir, 'b'.repeat(40))).toBeUndefined();
  expect(readStamp(join(dir, 'missing'), SHA)).toBeUndefined();
});

it('a later pass of the same commit replaces the earlier one', () => {
  dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
  writeStamp(dir, SHA, new Date('2026-10-23T10:00:00Z'));
  writeStamp(dir, SHA, new Date('2026-10-23T17:02:00Z'));
  expect(readStamp(dir, SHA)).toEqual(new Date('2026-10-23T17:02:00Z'));
});

it(`forgets stamps more than ${STAMP_KEEP_DAYS} days old when it writes one, so the directory does not grow for ever`, () => {
  dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
  const day = 86_400_000;
  const now = new Date('2026-10-23T17:00:00Z');
  const old = 'b'.repeat(40);
  const recent = 'c'.repeat(40);
  writeStamp(dir, old, new Date(now.getTime() - (STAMP_KEEP_DAYS + 1) * day));
  writeStamp(dir, recent, new Date(now.getTime() - (STAMP_KEEP_DAYS - 1) * day));
  writeStamp(dir, SHA, now);
  expect(readStamp(dir, old)).toBeUndefined();
  expect(readStamp(dir, recent)).toBeInstanceOf(Date);
  expect(readStamp(dir, SHA)).toEqual(now);
});

it('refuses anything but a full commit SHA, so a short or symbolic ref never matches', () => {
  dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
  expect(() => writeStamp(dir!, 'abc1234', new Date())).toThrow(/full commit SHA/);
  expect(() => writeStamp(dir!, '../../etc/x', new Date())).toThrow(/full commit SHA/);
  expect(readStamp(dir, 'HEAD')).toBeUndefined();
});

it('lives beside the e2e lock unless CHECK_STAMP_DIR says otherwise', () => {
  expect(stampDir({ HOME: '/Users/dev' })).toBe('/Users/dev/.cache/agent-board-gate/stamps');
  expect(stampDir({ HOME: '/Users/dev', CHECK_STAMP_DIR: '/tmp/s' })).toBe('/tmp/s');
});

describe('tree stamps', () => {
  it('records the pass against the tree too, with the commit that ran the gate', () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
    writeStamp(dir, SHA, new Date('2026-11-06T09:00:00Z'), TREE);
    expect(readTreeStamp(dir, TREE)).toEqual({ at: new Date('2026-11-06T09:00:00Z'), commit: SHA });
    expect(readStamp(dir, SHA)).toEqual(new Date('2026-11-06T09:00:00Z'));
  });

  it('writes none without a tree, and finds none for a tree that never passed', () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
    writeStamp(dir, SHA, new Date('2026-11-06T09:00:00Z'));
    expect(readTreeStamp(dir, TREE)).toBeUndefined();
    expect(readdirSync(join(dir, 'trees'))).toEqual([]);
    expect(readTreeStamp(join(dir, 'missing'), TREE)).toBeUndefined();
  });

  it('keeps a tree stamp and a commit stamp apart, though both are 40 hex digits', () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
    writeStamp(dir, SHA, new Date('2026-11-06T09:00:00Z'), TREE);
    expect(readStamp(dir, TREE)).toBeUndefined();
    expect(readTreeStamp(dir, SHA)).toBeUndefined();
  });

  it('refuses a tree that is not a full hash, writing neither stamp', () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
    expect(() => writeStamp(dir!, SHA, new Date(), '../x')).toThrow(/full tree hash/);
    expect(() => writeStamp(dir!, SHA, new Date(), 'abc1234')).toThrow(/full tree hash/);
    expect(readStamp(dir, SHA)).toBeUndefined();
    expect(readTreeStamp(dir, '../x')).toBeUndefined();
  });

  it('ignores a tree stamp file that is damaged', () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
    mkdirSync(join(dir, 'trees'));
    for (const text of ['', 'not a date\n', '2026-11-06T09:00:00.000Z\n', `2026-11-06T09:00:00.000Z abc\n`, `2026-11-06T09:00:00.000Z ${SHA} extra\n`]) {
      writeFileSync(join(dir, 'trees', TREE), text);
      expect(readTreeStamp(dir, TREE)).toBeUndefined();
    }
  });

  it(`forgets tree stamps more than ${STAMP_KEEP_DAYS} days old when it writes one`, () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
    const now = new Date('2026-11-06T09:00:00Z');
    const day = 86_400_000;
    writeStamp(dir, 'b'.repeat(40), new Date(now.getTime() - (STAMP_KEEP_DAYS + 1) * day), 'e'.repeat(40));
    writeStamp(dir, 'c'.repeat(40), new Date(now.getTime() - (STAMP_KEEP_DAYS - 1) * day), 'f'.repeat(40));
    writeStamp(dir, SHA, now, TREE);
    expect(readTreeStamp(dir, 'e'.repeat(40))).toBeUndefined();
    expect(readTreeStamp(dir, 'f'.repeat(40))?.commit).toBe('c'.repeat(40));
    expect(readTreeStamp(dir, TREE)?.at).toEqual(now);
  });
});

describe('readPass', () => {
  const other = 'b'.repeat(40);

  it("is the commit's own stamp when it has one", () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
    writeStamp(dir, SHA, new Date('2026-11-06T09:00:00Z'));
    expect(readPass(dir, SHA, TREE)).toEqual({ at: new Date('2026-11-06T09:00:00Z'), via: 'commit', commit: SHA });
  });

  it('is the stamp of another commit with the same tree when it has none of its own', () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
    writeStamp(dir, other, new Date('2026-11-06T09:00:00Z'), TREE);
    expect(readPass(dir, SHA, TREE)).toEqual({ at: new Date('2026-11-06T09:00:00Z'), via: 'tree', commit: other });
  });

  it('is the newer of the two when both exist, and the commit’s own on a tie', () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
    writeStamp(dir, SHA, new Date('2026-11-06T08:00:00Z'));
    writeStamp(dir, other, new Date('2026-11-06T09:00:00Z'), TREE);
    expect(readPass(dir, SHA, TREE)?.via).toBe('tree');
    writeStamp(dir, SHA, new Date('2026-11-06T09:00:00Z'));
    expect(readPass(dir, SHA, TREE)?.via).toBe('commit');
  });

  it('finds nothing for a commit and tree that never passed, or when the tree is unknown', () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
    writeStamp(dir, other, new Date('2026-11-06T09:00:00Z'), TREE);
    expect(readPass(dir, SHA, 'e'.repeat(40))).toBeUndefined();
    expect(readPass(dir, SHA, undefined)).toBeUndefined();
  });
});

describe('a squash merge of a gated branch', () => {
  it("counts as passed: the new commit has the branch's tree", () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' }).trim();
    git('init', '--quiet', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '--quiet', '-m', 'base');
    git('switch', '--quiet', '-c', 'feature');
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    git('commit', '--quiet', '-am', 'change');
    const tip = git('rev-parse', 'HEAD');
    git('switch', '--quiet', 'main');
    git('merge', '--squash', '--quiet', 'feature');
    git('commit', '--quiet', '-m', 'squash');
    const squash = git('rev-parse', 'HEAD');
    expect(squash).not.toBe(tip);
    expect(treeOf(repo, squash)).toBe(treeOf(repo, tip));

    const stamps = join(dir, 'stamps');
    writeStamp(stamps, tip, new Date('2026-11-06T09:00:00Z'), treeOf(repo, tip));
    expect(readStamp(stamps, squash)).toBeUndefined();
    expect(readPass(stamps, squash, treeOf(repo, squash))).toEqual({ at: new Date('2026-11-06T09:00:00Z'), via: 'tree', commit: tip });
    // A later commit changes the tree, so it does not count.
    writeFileSync(join(repo, 'a.txt'), 'three\n');
    git('commit', '--quiet', '-am', 'later');
    expect(readPass(stamps, git('rev-parse', 'HEAD'), treeOf(repo, 'HEAD'))).toBeUndefined();
  });

  it('has no tree for a commit git does not know', () => {
    dir = mkdtempSync(join(tmpdir(), 'ab-stamp-'));
    expect(treeOf(dir, 'f'.repeat(40))).toBeUndefined();
  });
});

describe('who may stamp', () => {
  // A stamp is trusted as a full pass of the whole gate on a clean tree, so only that run may write one: a subset
  // run (check:pr and its --recheck; their full fallback is check-local.sh, a full run), --quick and the release must never. Source scan, not a behaviour test:
  // the guard is that no other code path can reach the writer.
  const scripts = join(import.meta.dirname, '..');
  const sources = (readdirSync(scripts, { recursive: true, withFileTypes: true }) as { name: string; parentPath: string; isFile(): boolean }[])
    .filter((entry) => entry.isFile() && /\.(ts|sh)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !entry.parentPath.includes('node_modules'))
    .map((entry) => join(entry.parentPath, entry.name));

  it('writes stamps from gate-stamp/main.ts alone', () => {
    const writers = sources.filter((path) => /\bwriteStamp\(/.test(readFileSync(path, 'utf8'))).map((path) => path.slice(scripts.length + 1));
    expect(writers.toSorted()).toEqual(['gate-stamp/main.ts', 'gate-stamp/stamp.ts']);
  });

  it('runs that writer from check-local.sh alone, after a full run, and never for --quick', () => {
    const callers = sources.filter((path) => !path.endsWith('gate-stamp/main.ts') && /gate-stamp\/main\.ts/.test(readFileSync(path, 'utf8'))).map((path) => path.slice(scripts.length + 1));
    expect(callers).toEqual(['check-local.sh']);
    const gate = readFileSync(join(scripts, 'check-local.sh'), 'utf8');
    const call = gate.split('\n').findIndex((line) => line.includes('gate-stamp/main.ts write'));
    expect(gate.split('\n')[call - 2]).toBe('if [ -z "$quick" ] && [ $failed = 0 ] && [ -z "$dirty" ] && [ -z "$(git status --porcelain | head -n 1)" ] && [ "$(git rev-parse HEAD)" = "$sha" ]; then');
  });
});
