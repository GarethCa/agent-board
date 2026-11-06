import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, migrationProblems, preflight } from './preflight.ts';

describe('migrationProblems', () => {
  it('passes migrations numbered 1..n, once each', () => {
    expect(migrationProblems(['0001_sessions.sql', '0002_zones.sql', '0003_agents.sql'])).toEqual([]);
    expect(migrationProblems([])).toEqual([]);
  });

  it('names two migrations that share a number, the clash two branches make when each adds the next one', () => {
    expect(migrationProblems(['0001_a.sql', '0002_drop_reviewer_edges.sql', '0002_zone_layout_mode.sql'])).toEqual([
      '2 migrations are numbered 0002: 0002_drop_reviewer_edges.sql, 0002_zone_layout_mode.sql; renumber yours to the next free number',
    ]);
  });

  it('names the missing numbers in a gap', () => {
    expect(migrationProblems(['0001_a.sql', '0004_d.sql'])).toEqual(['migrations must be numbered 1..n, but 0002, 0003 are missing']);
  });

  it('names a file that is not NNNN_name.sql, and ignores files that are not SQL', () => {
    expect(migrationProblems(['0001_a.sql', 'second.sql', 'README.md'])).toEqual(['migration second.sql is not named NNNN_name.sql']);
  });
});

describe('preflight', () => {
  let repo: string | undefined;
  afterEach(() => {
    if (repo !== undefined) rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  });

  // Every commit is made two hours before NOW, so the base's age in the notes is fixed.
  const NOW = new Date('2026-11-04T20:00:00Z');
  const dated = { ...process.env, GIT_AUTHOR_DATE: '2026-11-04T18:00:00Z', GIT_COMMITTER_DATE: '2026-11-04T18:00:00Z' };
  const gitIn = (dir: string, ...args: string[]): string =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env: dated }).trim();
  const git = (...args: string[]): string => gitIn(repo!, ...args);
  /** How the notes name a base: its short sha and age. */
  const named = (ref: string): string => `${ref} (${git('rev-parse', '--short', ref)}, 2 h ago)`;
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(repo!, path)), { recursive: true });
    writeFileSync(join(repo!, path), text);
  };
  const commit = (message: string, files: Record<string, string>): void => {
    for (const [path, text] of Object.entries(files)) write(path, text);
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };
  /** A repo whose main has two migrations, and a branch off it. */
  const start = (): void => {
    repo = mkdtempSync(join(tmpdir(), 'ab-preflight-'));
    git('init', '-q', '-b', 'main');
    commit('base', { [`${MIGRATIONS_DIR}/0001_a.sql`]: 'a', [`${MIGRATIONS_DIR}/0002_b.sql`]: 'b', 'notes.md': 'one\n' });
    git('checkout', '-q', '-b', 'feature');
  };
  const marker = (char: string): string => char.repeat(7);

  it('passes a branch that merges cleanly and adds the next migration', () => {
    start();
    commit('next migration', { [`${MIGRATIONS_DIR}/0003_c.sql`]: 'c' });
    write(`${MIGRATIONS_DIR}/README.md`, 'not a migration\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'readme');
    expect(preflight(repo!, 'main', NOW)).toEqual({
      problems: [],
      notes: [`HEAD merges into ${named('main')} with no conflict`, 'no conflict markers in tracked files', '3 migrations numbered 1..3 once merged into main'],
    });
  });

  it("fails a branch whose new migration takes the number main's newest one took after it branched", () => {
    start();
    commit('my migration', { [`${MIGRATIONS_DIR}/0003_mine.sql`]: 'mine' });
    git('checkout', '-q', 'main');
    commit('their migration', { [`${MIGRATIONS_DIR}/0003_theirs.sql`]: 'theirs' });
    git('checkout', '-q', 'feature');
    // On the branch alone, the migrations are fine; only the merged tree has two numbered 0003.
    expect(preflight(repo!, undefined).problems).toEqual([]);
    expect(preflight(repo!, 'main').problems).toEqual([
      '2 migrations are numbered 0003: 0003_mine.sql, 0003_theirs.sql; renumber yours to the next free number',
    ]);
  });

  it('fails a branch that conflicts with main, naming the files', () => {
    start();
    commit('mine', { 'notes.md': 'mine\n' });
    git('checkout', '-q', 'main');
    commit('theirs', { 'notes.md': 'theirs\n' });
    git('checkout', '-q', 'feature');
    expect(preflight(repo!, 'main', NOW).problems).toEqual([`HEAD conflicts with ${named('main')} in notes.md: merge main and resolve them`]);
  });

  it('fails a tree that still holds conflict markers, committed or not', () => {
    start();
    commit('left a marker', { 'notes.md': `${marker('<')} HEAD\nmine\n=======\ntheirs\n${marker('>')} main\n` });
    write('other.ts', `${marker('<')} HEAD\n`);
    git('add', 'other.ts');
    expect(preflight(repo!, 'main').problems).toEqual(['conflict markers left in notes.md, other.ts']);
  });

  it('fails a base that does not exist, rather than checking HEAD alone', () => {
    start();
    expect(preflight(repo!, 'mian').problems).toEqual(['there is no commit mian to check the merge against: fetch it, or pass --base <ref>']);
  });

  it('fails a base it shares no history with', () => {
    start();
    git('checkout', '-q', '--orphan', 'elsewhere');
    git('rm', '-rq', '--cached', '.');
    commit('unrelated', { 'other.md': 'x\n' });
    git('checkout', '-q', '-f', 'feature');
    expect(preflight(repo!, 'elsewhere').problems).toEqual(['HEAD shares no history with elsewhere: fetch the full history, or pass --base <ref>']);
  });

  it('fails in a shallow clone whose history stops before the branch point, and says so', () => {
    start();
    commit('mine', { [`${MIGRATIONS_DIR}/0003_mine.sql`]: 'mine' });
    git('checkout', '-q', 'main');
    commit('theirs', { [`${MIGRATIONS_DIR}/0003_theirs.sql`]: 'theirs' });
    const clone = join(repo!, 'shallow');
    gitIn(repo!, 'clone', '-q', '--depth', '1', '--no-single-branch', '-b', 'feature', `file://${repo!}`, clone);
    expect(preflight(clone, 'origin/main').problems).toEqual([
      'HEAD shares no history with origin/main, as this clone is shallow: fetch the full history, or pass --base <ref>',
    ]);
  });

  it('fails a tree with no migrations folder', () => {
    start();
    git('rm', '-rq', MIGRATIONS_DIR);
    git('commit', '-q', '-m', 'no migrations');
    expect(preflight(repo!, undefined).problems).toEqual([`there is no ${MIGRATIONS_DIR} folder to check`]);
  });

  it('passes a Markdown heading underlined with equals signs', () => {
    start();
    commit('setext heading', { 'notes.md': 'Title\n=======\n' });
    expect(preflight(repo!, 'main').problems).toEqual([]);
  });
});
