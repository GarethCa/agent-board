/**
 * The gate's pre-flight: the checks that take a second and would otherwise fail a 35-minute run near its end. Each looks
 * at the tree this branch makes once merged into main, not only at the branch, so a clash that only exists after the
 * merge (two branches that each add migration 0072) fails before anyone merges.
 *
 *  - The branch merges into the base with no conflict.
 *  - No tracked file holds a conflict marker line left by an earlier merge.
 *  - The merged tree's daemon migrations are numbered 1..n, each number once.
 */
import { execFileSync } from 'node:child_process';

/** Where the daemon's migrations live, `NNNN_name.sql` each (packages/daemon/src/migrate.ts). */
export const MIGRATIONS_DIR = 'packages/daemon/src/migrations';

const MIGRATION_NAME = /^(\d+)_[\w-]+\.sql$/;

/**
 * What is wrong with a migrations folder holding these file names, in words; empty when they are numbered 1..n with
 * each number used once, which `migrate()` needs to start.
 */
export function migrationProblems(names: readonly string[]): string[] {
  const problems: string[] = [];
  const byNumber = new Map<number, string[]>();
  for (const name of names.filter((n) => n.endsWith('.sql')).toSorted()) {
    const match = MIGRATION_NAME.exec(name);
    if (!match) {
      problems.push(`migration ${name} is not named NNNN_name.sql`);
      continue;
    }
    const version = Number(match[1]);
    byNumber.set(version, [...(byNumber.get(version) ?? []), name]);
  }
  const pad = (n: number): string => String(n).padStart(4, '0');
  for (const [version, files] of byNumber) {
    if (files.length > 1) problems.push(`${files.length} migrations are numbered ${pad(version)}: ${files.join(', ')}; renumber yours to the next free number`);
  }
  const highest = Math.max(0, ...byNumber.keys());
  const missing = Array.from({ length: highest }, (_, i) => i + 1).filter((n) => !byNumber.has(n));
  if (missing.length > 0) problems.push(`migrations must be numbered 1..n, but ${missing.map(pad).join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing`);
  return problems;
}

export interface PreflightResult {
  /** One line per problem found; the pre-flight passes when there are none. */
  problems: string[];
  /** What it checked, for the log. */
  notes: string[];
}

/**
 * Runs the pre-flight on the repo at `root`, against `base` (a ref such as origin/main); with no base, only on HEAD
 * itself. A base that does not exist, or shares no history with HEAD (as in a shallow clone), is a problem: the merged
 * tree is the point, and checking HEAD alone would pass a clash silently.
 */
export function preflight(root: string, base: string | undefined, now: Date = new Date()): PreflightResult {
  const git = (...args: string[]): string => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const succeeds = (...args: string[]): boolean => {
    try {
      git(...args);
      return true;
    } catch {
      return false;
    }
  };
  const problems: string[] = [];
  const notes: string[] = [];

  let tree: string | undefined = 'HEAD';
  if (base !== undefined) {
    if (!succeeds('rev-parse', '--verify', '-q', `${base}^{commit}`)) {
      problems.push(`there is no commit ${base} to check the merge against: fetch it, or pass --base <ref>`);
      tree = undefined;
    } else if (!succeeds('merge-base', base, 'HEAD')) {
      const shallow = git('rev-parse', '--is-shallow-repository').trim() === 'true';
      problems.push(`HEAD shares no history with ${base}${shallow ? ', as this clone is shallow' : ''}: fetch the full history, or pass --base <ref>`);
      tree = undefined;
    } else {
      const against = `${base} (${describeCommit(git, base, now)})`;
      try {
        tree = git('merge-tree', '--write-tree', '--name-only', base, 'HEAD').split('\n')[0]!;
        notes.push(`HEAD merges into ${against} with no conflict`);
      } catch (error) {
        const { status, stdout } = error as { status?: number; stdout?: string };
        if (status === 129) throw new Error('git merge-tree --write-tree needs git 2.38 or newer', { cause: error });
        // Exit 1 is a conflict: the tree id, then the conflicted paths, then a blank line and git's messages.
        if (status !== 1 || stdout === undefined) throw error;
        const [treeId, ...rest] = stdout.split('\n');
        tree = treeId!;
        const paths = rest.slice(0, rest.indexOf('')).filter(Boolean);
        problems.push(`HEAD conflicts with ${against} in ${paths.join(', ')}: merge ${base} and resolve them`);
      }
    }
  }

  const marked = conflictMarkerFiles(git);
  if (marked.length > 0) problems.push(`conflict markers left in ${marked.join(', ')}`);
  else notes.push('no conflict markers in tracked files');

  // With no merged tree to read, HEAD's migrations are still worth checking; the base's problem already fails the run.
  const checked = tree ?? 'HEAD';
  if (!succeeds('cat-file', '-e', `${checked}:${MIGRATIONS_DIR}`)) {
    problems.push(`there is no ${MIGRATIONS_DIR} folder to check`);
    return { problems, notes };
  }
  const names = git('ls-tree', '--name-only', `${checked}:${MIGRATIONS_DIR}`).split('\n').filter(Boolean);
  const migrations = migrationProblems(names);
  problems.push(...migrations);
  const count = names.filter((name) => MIGRATION_NAME.test(name)).length;
  if (migrations.length === 0) notes.push(`${count} migrations numbered 1..${count}${tree === undefined || tree === 'HEAD' ? '' : ` once merged into ${base}`}`);
  return { problems, notes };
}

/** A commit's short sha and age, `c3e1c4f, 2 h ago`: a stale base passes what the current main would not. */
function describeCommit(git: (...args: string[]) => string, ref: string, now: Date): string {
  const [sha, seconds] = git('log', '-1', '--format=%h %ct', ref).trim().split(' ');
  const minutes = Math.max(0, Math.round((now.getTime() / 1000 - Number(seconds)) / 60));
  const age = minutes < 60 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} days`;
  return `${sha}, ${age} ago`;
}

/**
 * Tracked files, as in the working tree, with a line that starts a conflict: `<<<<<<< ` or `>>>>>>> `. The `=======`
 * between them is left out, as a Markdown heading may be underlined with it.
 */
function conflictMarkerFiles(git: (...args: string[]) => string): string[] {
  try {
    return git('grep', '-l', '-I', '-E', '^(<{7}|>{7})( |$)').split('\n').filter(Boolean);
  } catch (error) {
    // git grep exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}
