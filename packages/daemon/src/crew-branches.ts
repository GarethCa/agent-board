// A crew's own branch (ADR-0026). A crew with two or more makers on branches of their own gets a crew branch, in a
// crew worktree the crew owns, cut from its builder's branch as it starts. Each maker after the builder is cut from it;
// where makers' work meets (a member that takes the work of two, the next maker, an end) each maker's branch is merged
// into it with --no-ff. A merge that conflicts is aborted, with the files it was in, for the crew to send back. A ready
// end opens one pull request, of the crew branch. Git is run without a shell, on branch names it resolves to commits, and with the repo's hooks off.
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createPullRequest, listPullRequests } from '@agent-board/tracker';
import { changedFiles, samePath } from './crew-worktree.ts';
import { pushLfsObjects, runGit } from './git.ts';
import type { PrefabLine } from './protocol.ts';
import { call as trackerCall } from './trackers.ts';
import { addWorktree, agentWorktreePath, freeBranchName, freeWorktreePath, removeWorktree, unsavedWork } from './worktrees.ts';

/**
 * Git with the repo's hooks off: a hooks path that isn't a folder runs none, so a hook a maker committed (husky's
 * `.husky`, any in-tree `core.hooksPath`) never runs as the board merges or pushes its work, outside its permissions.
 */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

/** A crew's own branch: where it is, and the pull request the crew opened of it, once it has. */
export interface CrewBranch {
  repoRoot: string;
  branch: string;
  worktree: string;
  /** The URL of the draft pull request the crew opened of it at its ready end. */
  pr?: string;
  /** Set once it is cut: before, it is only placed (saved, for a cut a restart cuts once). */
  made?: true;
  /** Set once its worktree is removed, as the crew stopped for good. */
  released?: true;
  /**
   * Set for the builder's own branch and worktree, taken as the crew's when the builder shares it with other non-makers:
   * never cut, and never removed by the crew, as the builder's close removes them.
   */
  adopted?: true;
  /** The branch's tip as the board last left it: a move it didn't make is reported. */
  head?: string;
}

/**
 * What came of merging a maker's branch: merged, with the files it brought in (false: nothing new), the files it
 * conflicted in, the crew worktree's uncommitted files it would touch and so waits on, or why it failed.
 */
export type CrewMerge = { merged: false } | { merged: true; files: string[] } | { conflicts: string[] } | { waits: string[] } | { error: string };

/** Why a removal kept the crew branch: and its worktree too, while that has uncommitted changes. */
export interface CrewKept {
  why: string;
  worktree: boolean;
}

export interface CrewBranches {
  /** Where a crew branch cut from `from` goes: a branch name and a worktree path free now, neither made yet. */
  place(repoRoot: string, from: string): Promise<CrewBranch>;
  /**
   * Cuts the crew branch from the tip of `from`, in a worktree of its own: at `at`, placed (and saved) first, so a daemon
   * that stopped part-way finds it there, or checks its branch out again, rather than cutting a second.
   */
  cut(repoRoot: string, from: string, at?: CrewBranch): Promise<CrewBranch>;
  /**
   * Merges the tip of `branch` into the crew branch with a merge commit; one that conflicts is aborted. Uncommitted
   * changes in files it doesn't touch stay as they were, but unstaged; one in a file it touches makes it wait.
   */
  merge(crew: CrewBranch, branch: string, message: string): Promise<CrewMerge>;
  /**
   * Removes the crew worktree, and its branch unless `keepBranch` or it holds commits no other branch or remote has:
   * resolves to why such a branch was kept, else undefined. A worktree with uncommitted changes is kept, branch and all.
   */
  remove(crew: CrewBranch, keepBranch: boolean): Promise<CrewKept | undefined>;
  /** The files a worktree (a maker's) has uncommitted changes in, but for the board's own (`.agent-board/`). */
  uncommitted(worktree: string): Promise<string[]>;
}

/** The paths `-z` output lists, as git wrote them: no quotes, no escapes. */
const zPaths = (stdout: string) => stdout.split('\0').filter((path) => path !== '');

/** The crew branches of a board whose worktrees are made under `worktreesDir`. */
export function gitCrewBranches(worktreesDir: string): CrewBranches {
  const place = async (repoRoot: string, from: string): Promise<CrewBranch> => {
    const branch = await freeBranchName(repoRoot, `${from}-crew`);
    return { repoRoot, branch, worktree: freeWorktreePath(agentWorktreePath(worktreesDir, repoRoot, branch)) };
  };
  return {
    place,

    async cut(repoRoot, from, at) {
      const crew = at ?? (await place(repoRoot, from));
      if (existsSync(crew.worktree)) {
        const head = await runGit(crew.worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
        if (head.ok && head.stdout === crew.branch) return crew;
        throw new Error(`${crew.worktree} is there already, and isn't the crew branch ${crew.branch}`);
      }
      const cut = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${crew.branch}^{commit}`]);
      if (cut.ok) {
        await runGit(repoRoot, ['worktree', 'prune']);
        mkdirSync(dirname(crew.worktree), { recursive: true });
        // By its short name, a slug made here from a branch's (never an option), so git checks the branch out, not detached.
        const added = await runGit(repoRoot, [...NO_HOOKS, 'worktree', 'add', crew.worktree, crew.branch]);
        if (!added.ok) throw new Error(`could not check out its crew branch ${crew.branch} again: ${added.stderr}`);
        return crew;
      }
      if (!(await addWorktree(repoRoot, crew.worktree, crew.branch, from))) throw new Error(`git is too old to cut a crew branch from ${from}`);
      return crew;
    },

    async merge(crew, branch, message) {
      const tip = await runGit(crew.repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
      if (!tip.ok) return { error: `there is no branch ${branch} to merge` };
      // A merge left half-done (the daemon stopped between a conflict and its abort) is no one's now: it goes first.
      const mergeHead = () => runGit(crew.worktree, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']);
      if ((await mergeHead()).ok) {
        const aborted = await runGit(crew.worktree, [...NO_HOOKS, 'merge', '--abort']);
        if (!aborted.ok) return { error: `its crew worktree is mid-merge, and that merge wouldn't abort: ${aborted.stderr}` };
      }
      const done = await runGit(crew.worktree, ['merge-base', '--is-ancestor', tip.stdout, 'HEAD']);
      if (done.ok) return { merged: false };
      let dirty: string[];
      try {
        dirty = await changedFiles(crew.worktree);
      } catch (error) {
        return { error: `could not read its crew worktree's status: ${(error as Error).message}` };
      }
      const base = await runGit(crew.worktree, ['merge-base', 'HEAD', tip.stdout]);
      const touched = await runGit(crew.worktree, ['diff', '--name-only', '--no-renames', '-z', base.ok ? base.stdout : '4b825dc642cb6eb9a060e54bf8d69288fbee4904', tip.stdout]);
      if (!touched.ok) return { error: `could not read what ${branch} changes: ${touched.stderr}` };
      const files = zPaths(touched.stdout);
      const brought = new Set(files.map(samePath));
      const waits = dirty.filter((path) => brought.has(samePath(path)));
      if (waits.length > 0) return { waits };
      // A merge refuses an index that differs from HEAD: what an agent staged is unstaged, its files left as they are.
      const staged = await runGit(crew.worktree, ['diff', '--cached', '--quiet']);
      if (!staged.ok) {
        const unstaged = await runGit(crew.worktree, [...NO_HOOKS, 'reset', '--quiet']);
        if (!unstaged.ok) return { error: `could not unstage its crew worktree's index: ${unstaged.stderr}` };
      }
      const merged = await runGit(crew.worktree, [...NO_HOOKS, 'merge', '--no-ff', '--no-edit', '--no-verify', '-m', message, tip.stdout]);
      if (merged.ok) return { merged: true, files };
      const why = merged.stderr || merged.stdout;
      // A merge git refused before it began (a file in the way) left nothing to abort.
      if (!(await mergeHead()).ok) return { error: why };
      const unmerged = await runGit(crew.worktree, ['diff', '--name-only', '--diff-filter=U']);
      const conflicts = unmerged.ok ? unmerged.stdout.split('\n').filter((file) => file !== '') : [];
      const aborted = await runGit(crew.worktree, [...NO_HOOKS, 'merge', '--abort']);
      if (!aborted.ok) return { error: `the merge of ${branch} failed (${why}), and so did its abort: ${aborted.stderr}` };
      return conflicts.length > 0 ? { conflicts } : { error: why };
    },

    async remove(crew, keepBranch) {
      // Its members' work in progress is in no commit: removing the worktree would delete it.
      // One whose status can't be read is kept, as it may hold some.
      const dirty = existsSync(crew.worktree) ? await changedFiles(crew.worktree).catch((error: Error) => [`(its status: ${error.message})`]) : [];
      if (dirty.length > 0) {
        const files = `${dirty.length} ${dirty.length === 1 ? 'file' : 'files'}: ${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''}`;
        return { why: `its crew worktree ${crew.worktree} has uncommitted changes in ${files}, so the worktree is kept too: commit or drop them, then remove it`, worktree: true };
      }
      const unsaved = keepBranch ? undefined : await unsavedWork(crew.repoRoot, crew.worktree, crew.branch);
      await removeWorktree(crew.repoRoot, crew.worktree, crew.branch, keepBranch || unsaved !== undefined);
      return unsaved === undefined ? undefined : { why: unsaved, worktree: false };
    },

    uncommitted: changedFiles,
  };
}

/**
 * Pushes the crew branch to origin, never forced, and opens a draft pull request of it: resolves to its URL. A branch
 * that has moved on at origin is the user's to sort out.
 */
export async function openCrewPullRequest(crew: CrewBranch, options: { gh: string; repo?: string; title: string; body: string }): Promise<string> {
  const lfs = await pushLfsObjects(crew.worktree, 'origin', `refs/heads/${crew.branch}`);
  if (!lfs.ok) throw new Error(`could not push ${crew.branch}'s Git LFS files: ${lfs.stderr}`);
  const pushed = await runGit(crew.worktree, [...NO_HOOKS, 'push', '--no-verify', 'origin', `refs/heads/${crew.branch}:refs/heads/${crew.branch}`]);
  if (!pushed.ok) throw new Error(`could not push ${crew.branch}: ${pushed.stderr}`);
  await runGit(crew.worktree, ['branch', `--set-upstream-to=origin/${crew.branch}`, crew.branch]);
  // One open of it already is the crew's: a daemon that stopped after opening it, before saving it, opened it.
  const of = await trackerCall(() => listPullRequests(crew.branch, { gh: options.gh, cwd: crew.worktree, repo: options.repo }));
  const open = of.find((pr) => pr.state === 'open' || pr.state === 'draft');
  if (open !== undefined) return open.url;
  return trackerCall(() =>
    createPullRequest({ gh: options.gh, cwd: crew.worktree, repo: options.repo, head: crew.branch, title: options.title, body: options.body, draft: true }),
  );
}

/**
 * The makers whose work reaches `id`: the nearest ones back along the lines into it, through members, loop gates and
 * Your OKs that aren't makers, never along a loop gate's way back.
 */
export function upstreamMakers(lines: readonly PrefabLine[], makers: ReadonlySet<string>, id: string): string[] {
  const found = new Set<string>();
  const seen = new Set([id]);
  const walk = (to: string) => {
    for (const line of lines) {
      if (line.to !== to || line.way === 'again' || seen.has(line.from)) continue;
      seen.add(line.from);
      if (makers.has(line.from)) found.add(line.from);
      else walk(line.from);
    }
  };
  walk(id);
  return [...found];
}
