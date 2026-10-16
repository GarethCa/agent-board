import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { runGit } from './git.ts';

/** Where an agent's work went, besides its own branch: what `findPushedPullRequests` looks up. */
export interface PushTargets {
  /** The remote branches it went to: its branch's upstream first, then those its own commits were pushed to, those holding its newest first. */
  pushedTo: string[];
  /** Its newest own commit it is known to have pushed: none once the remote-tracking branches it went to are pruned. */
  commit?: string;
}

/** Reflog messages of a branch moving to a commit made on it, not one it was set to (created from, reset, merged in). */
const OWN_COMMIT = /^(commit|rebase|cherry-pick|revert)\b|^pull\b.*\(finish\)/;

/** A cherry-pick or rebase that only fast-forwarded the branch onto a commit someone else made. */
const FAST_FORWARD = /fast-forward/i;

/** A rebase's last entry names the commit it rebased onto: the branch is at it when nothing of its own was replayed. */
const ONTO = / onto ([0-9a-f]+)$/;

/** A commit id as git writes it: SHA-1, or SHA-256. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Reflog message of a remote-tracking branch moved by a push from this repo. */
const PUSHED = 'update by push';

/**
 * Where the work of the agent on `branch` in `worktree` went, read from git alone: its branch's upstream,
 * when on a remote, and the remote branches its own commits were pushed to, from the reflogs git keeps of its own
 * branch (the commits made on it) and of each remote-tracking branch (`update by push`). Those reflogs are shared by
 * every worktree of the repo, so only pushes of this branch's own commits count, not another worktree's. A commit is
 * its own only when made on it (a `pull --rebase` replay among them): not the one it was cut from, nor one a rebase or
 * cherry-pick merely fast-forwarded it to, nor one a remote-tracking branch got other than by a push from here (a
 * fetch). A push is forgotten once its remote-tracking branch is pruned, and its commit with it: `createPullRequestLookup`
 * remembers it. Without a reflog of its branch (a reftable
 * repo, or `core.logAllRefUpdates` off) only its upstream is known. Nothing outside a git repo.
 */
export async function pushTargets(worktree: string, branch: string): Promise<PushTargets> {
  const [commonDir, remote, merge] = await Promise.all([
    runGit(worktree, ['rev-parse', '--git-common-dir']),
    runGit(worktree, ['config', '--get', `branch.${branch}.remote`]),
    runGit(worktree, ['config', '--get', `branch.${branch}.merge`]),
  ]);
  const upstream = remote.ok && remote.stdout !== '.' && merge.stdout.startsWith('refs/heads/') ? [merge.stdout.slice('refs/heads/'.length)] : [];
  if (!commonDir.ok) return { pushedTo: upstream };
  const logs = join(resolve(worktree, commonDir.stdout), 'logs', 'refs');
  const made = (await reflog(join(logs, 'heads', branch))).filter(
    (entry) => OWN_COMMIT.test(entry.message) && !FAST_FORWARD.test(entry.message) && entry.sha !== ONTO.exec(entry.message)?.[1],
  );
  if (made.length === 0) return { pushedTo: upstream };
  const remotes = await Promise.all((await files(join(logs, 'remotes'))).map(async (file) => ({ file, entries: await reflog(file) })));
  const fetched = new Set(remotes.flatMap(({ entries }) => entries.filter((entry) => entry.message !== PUSHED).map((entry) => entry.sha)));
  const own = made.map((entry) => entry.sha).filter((sha) => !fetched.has(sha));
  const pushes: { branch: string; newest: number }[] = [];
  for (const { file, entries } of remotes) {
    // `<remote>/<branch>`, the branch itself perhaps holding slashes.
    const pushed = relative(join(logs, 'remotes'), file).split(sep).slice(1).join('/');
    const newest = Math.max(...entries.filter((entry) => entry.message === PUSHED).map((entry) => own.lastIndexOf(entry.sha)));
    if (newest >= 0) pushes.push({ branch: pushed, newest });
  }
  pushes.sort((a, b) => b.newest - a.newest);
  const pushedTo = [...new Set([...upstream, ...pushes.map((push) => push.branch)])];
  return pushes[0] === undefined ? { pushedTo } : { pushedTo, commit: own[pushes[0].newest]! };
}

/** A reflog's entries, oldest first: the commit each moved the ref to, and why. None when it has none; a line that isn't one is skipped. */
async function reflog(file: string): Promise<{ sha: string; message: string }[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').flatMap((line) => {
    const [move = '', message = ''] = line.split('\t');
    const sha = move.split(' ')[1] ?? '';
    return COMMIT_ID.test(sha) ? [{ sha, message }] : [];
  });
}

/** Every file under `dir`, at any depth; none when it doesn't exist. */
async function files(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
  } catch {
    return [];
  }
}
