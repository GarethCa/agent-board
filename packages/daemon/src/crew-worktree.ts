// A crew worktree shared by several members, each with paths of its own to write. Members don't commit: the board
// commits each one's own files under its name. It builds the commit's tree from HEAD's and those files alone, as git
// objects, never through the shared index, so nothing anyone staged there gets in; after, only those files' entries in
// the shared index are set to the commit's. The worktree's uncommitted work can be recorded as a tree the same way, and
// put back after a member's git wiped it. Git is run without a shell and with the repo's hooks off.
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { checkCheckoutConfig, runGit, type GitResult, type RunGitOptions } from './git.ts';

/** Git with the repo's hooks off: a hooks path that isn't a folder runs none. */
const NO_HOOKS = ['-c', 'core.hooksPath=/dev/null'];

/** How long one git call may take. */
const GIT_TIMEOUT_MS = 30_000;

/** The waits between tries while another git holds the shared index's lock. */
const LOCK_DELAYS_MS = [50, 100, 200, 400, 800];

/** The most paths given to one git call. */
const CHUNK = 100;

/** The board's own folder in a worktree, never a member's work. */
const BOARD_DIR = '.agent-board/';

/** A crew member sharing the worktree, and the repo-relative paths it writes (a folder ends in `/`). */
export interface Sharer {
  member: string;
  writes: readonly string[];
}

/** A path as own paths compare it: in one Unicode spelling and one case, as names are on macOS and Windows. */
export const samePath = (path: string) => path.normalize('NFC').toLowerCase();

/**
 * Whether repo-relative file `path` is in `writes`: equal to a file entry or under a folder entry, in any case and
 * either Unicode spelling.
 */
export function ownsPath(writes: readonly string[], path: string): boolean {
  const file = samePath(path);
  return writes.some((entry) => {
    const own = samePath(entry);
    return own.endsWith('/') ? file.startsWith(own) : file === own;
  });
}

/** The member whose writes hold `path`, or null for nobody's. */
export function ownerOf(path: string, sharers: readonly Sharer[]): string | null {
  return sharers.find((sharer) => ownsPath(sharer.writes, path))?.member ?? null;
}

const git = (dir: string, args: string[], env?: Record<string, string>, options?: RunGitOptions) => runGit(dir, args, GIT_TIMEOUT_MS, env, options);

/** For a read that hashes the worktree's files, which would run their clean filter: the repo's own filters off. */
const FILTERS_OFF: RunGitOptions = { repoFiltersOff: true };

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

const literal = (file: string) => `:(literal)${file}`;

const chunks = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += CHUNK) out.push(items.slice(at, at + CHUNK));
  return out;
};

const failed = (what: string, stderr: string) => new Error(`${what} failed${stderr ? `: ${stderr}` : ''}`);

/** Git's answer, or throws saying what failed. */
async function must(dir: string, args: string[], what: string, options?: RunGitOptions): Promise<string> {
  const result = await git(dir, args, undefined, options);
  if (!result.ok) throw failed(what, result.stderr);
  return result.stdout;
}

/**
 * The entries of `--name-status --no-renames -z` output (`<status>\0<path>\0`). Its status comes first, so the trimming
 * runGit does can't eat a path's own leading or trailing spaces.
 */
function nameStatus(stdout: string): { status: string; path: string }[] {
  const parts = stdout.split('\0');
  const entries: { status: string; path: string }[] = [];
  for (let at = 0; at + 1 < parts.length; at += 2) {
    const [status, path] = [parts[at], parts[at + 1]];
    if (status === undefined || status === '' || path === undefined) break;
    entries.push({ status, path });
  }
  return entries;
}

const notBoards = (paths: Iterable<string>) => [...new Set(paths)].filter((path) => !path.startsWith(BOARD_DIR)).sort();

/** Files changed in the worktree against HEAD: tracked ones modified, added or deleted (staged or not) and untracked ones not ignored, repo-relative, sorted, never under `.agent-board/`. */
export async function changedFiles(worktree: string): Promise<string[]> {
  const [tracked, untracked] = await Promise.all([
    must(worktree, ['diff', 'HEAD', '--name-status', '--no-renames', '-z', '--'], 'git diff', FILTERS_OFF),
    // `-t` puts a tag before each path, for the same reason as nameStatus.
    must(worktree, ['ls-files', '-t', '-z', '--others', '--exclude-standard'], 'git ls-files'),
  ]);
  const others = untracked
    .split('\0')
    .filter((entry) => entry !== '')
    .map((entry) => entry.slice(2));
  return notBoards([...nameStatus(tracked).map((entry) => entry.path), ...others]);
}

/** Whether any existing component of repo-relative `path` (the path itself included) is a symbolic link, by lstat from the worktree root. */
export async function throughSymlink(worktree: string, path: string): Promise<boolean> {
  let at = worktree;
  for (const part of path.split('/').filter((part) => part !== '')) {
    at = join(at, part);
    try {
      if ((await lstat(at)).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Why `file` can't be committed or put back, or null when it can. */
async function refusal(worktree: string, file: string): Promise<string | null> {
  if (file === '' || isAbsolute(file) || file.split('/').includes('..')) return `${file} isn't a path in the worktree`;
  if (await throughSymlink(worktree, file)) return `${file} goes through a symbolic link`;
  return null;
}

/** Calls in flight for each worktree, chained so one runs at a time. */
const queues = new Map<string, Promise<unknown>>();

/** Runs `task` once every earlier call for `worktree` has settled. */
function oneAtATime<T>(worktree: string, task: () => Promise<T>): Promise<T> {
  const key = resolve(worktree);
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(task);
  queues.set(key, run);
  const forget = () => {
    if (queues.get(key) === run) queues.delete(key);
  };
  run.then(forget, forget);
  return run;
}

/** Runs `task` with a scratch folder of its own, deleted after. */
async function withScratch<T>(task: (scratch: string) => Promise<T>): Promise<T> {
  const scratch = await mkdtemp(join(tmpdir(), 'ab-crew-tree-'));
  try {
    return await task(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Whether the shared index's lock was free, or came free within the waits. */
async function lockFree(worktree: string): Promise<boolean> {
  const path = resolve(worktree, await must(worktree, ['rev-parse', '--git-path', 'index.lock'], 'git rev-parse --git-path'));
  for (const delay of LOCK_DELAYS_MS) {
    if (!existsSync(path)) return true;
    await sleep(delay);
  }
  return !existsSync(path);
}

/** Runs a git call that takes the shared index's lock, again while another git holds it: its result, or 'locked'. */
async function pastTheLock(run: () => Promise<GitResult>): Promise<GitResult | 'locked'> {
  for (const delay of [...LOCK_DELAYS_MS, undefined]) {
    const result = await run();
    if (result.ok || !/index\.lock/.test(result.stderr)) return result;
    if (delay === undefined) break;
    await sleep(delay);
  }
  return 'locked';
}

/** A tree entry: its mode as a raw tree spells it (`40000` for a folder) and its object id. */
interface Entry {
  mode: string;
  id: string;
}

/**
 * The blob each of `files` has in the worktree now, written to the object store, or null for one that is gone. A path
 * that is a folder (a submodule's, or a file that became one) is left out, to keep what the tree had.
 */
async function worktreeBlobs(worktree: string, files: readonly string[], scratch: string): Promise<Map<string, Entry | null>> {
  const blobs = new Map<string, Entry | null>();
  const regular: { file: string; mode: string }[] = [];
  for (const file of files) {
    const stat = await lstat(join(worktree, file)).catch(() => null);
    if (stat === null) blobs.set(file, null);
    else if (stat.isSymbolicLink()) {
      const target = join(scratch, `link-${blobs.size}`);
      await writeFile(target, await readlink(join(worktree, file)));
      blobs.set(file, { mode: '120000', id: await must(worktree, ['hash-object', '-w', '--no-filters', '--', target], 'git hash-object') });
    } else if (stat.isFile()) regular.push({ file, mode: stat.mode & 0o100 ? '100755' : '100644' });
  }
  for (const chunk of chunks(regular)) {
    // Run from the worktree with its own paths, so its attributes' filters apply as `git add` would apply them: those
    // the user's own config names, as the repo's own are off.
    const ids = (await must(worktree, ['hash-object', '-w', '--', ...chunk.map((each) => each.file)], 'git hash-object', FILTERS_OFF)).split('\n');
    if (ids.length !== chunk.length) throw new Error(`git hash-object gave ${ids.length} ids for ${chunk.length} files`);
    chunk.forEach((each, at) => blobs.set(each.file, { mode: each.mode, id: ids[at]! }));
  }
  return blobs;
}

/** The entries of tree `id`, by name. */
async function treeEntries(worktree: string, id: string): Promise<Map<string, Entry>> {
  const entries = new Map<string, Entry>();
  for (const line of (await must(worktree, ['ls-tree', '-z', id], 'git ls-tree')).split('\0')) {
    const [, mode, object, name] = /^(\d+) \w+ ([0-9a-f]+)\t(.*)$/s.exec(line) ?? [];
    if (mode !== undefined && object !== undefined && name !== undefined) entries.set(name, { mode: mode.replace(/^0+/, ''), id: object });
  }
  return entries;
}

/** Writes a tree of `entries` to the object store, in git's order (a folder sorts as its name and a slash). */
async function writeTreeObject(worktree: string, entries: Map<string, Entry>, scratch: string): Promise<string> {
  const key = (name: string, entry: Entry) => Buffer.from(entry.mode === '40000' ? `${name}/` : name);
  const sorted = [...entries].sort(([a, x], [b, y]) => Buffer.compare(key(a, x), key(b, y)));
  const body = Buffer.concat(sorted.flatMap(([name, entry]) => [Buffer.from(`${entry.mode} ${name}\0`), Buffer.from(entry.id, 'hex')]));
  const file = join(scratch, `tree-${Math.random().toString(36).slice(2)}`);
  await writeFile(file, body);
  return must(worktree, ['hash-object', '-w', '-t', 'tree', '--', file], 'git hash-object -t tree');
}

/**
 * Tree `base` with `changes` made to it (a path to its new entry, or null to remove it), written to the object store:
 * the new tree's id, or null for a folder left empty. Only the folders a change is in are read and written again.
 */
async function changedTree(worktree: string, base: string | null, changes: Map<string, Entry | null>, scratch: string, root = true): Promise<string | null> {
  const entries = base === null ? new Map<string, Entry>() : await treeEntries(worktree, base);
  const inFolders = new Map<string, Map<string, Entry | null>>();
  for (const [path, entry] of changes) {
    const slash = path.indexOf('/');
    if (slash < 0) {
      if (entry === null) entries.delete(path);
      else entries.set(path, entry);
      continue;
    }
    const folder = path.slice(0, slash);
    if (!inFolders.has(folder)) inFolders.set(folder, new Map());
    inFolders.get(folder)!.set(path.slice(slash + 1), entry);
  }
  for (const [folder, under] of inFolders) {
    const had = entries.get(folder);
    const id = await changedTree(worktree, had?.mode === '40000' ? had.id : null, under, scratch, false);
    if (id !== null) entries.set(folder, { mode: '40000', id });
    else if (had?.mode === '40000') entries.delete(folder);
  }
  return entries.size === 0 && !root ? null : writeTreeObject(worktree, entries, scratch);
}

/** HEAD's tree with each of `files` as the worktree has it now, written to the object store (refs and indexes untouched). */
async function treeWith(worktree: string, head: string, files: readonly string[], scratch: string): Promise<string> {
  const base = await must(worktree, ['rev-parse', '--verify', `${head}^{tree}`], 'git rev-parse');
  return (await changedTree(worktree, base, await worktreeBlobs(worktree, files, scratch), scratch))!;
}

/** What a board commit came to: the commit and its files, nothing to commit, or why it failed. */
export type BoardCommit = { commit: string; files: string[] } | { nothing: true } | { error: string };

/**
 * Commits exactly `files` (repo-relative; each a change in the worktree, deletions included) on `branch`, authored as
 * `author`, from HEAD's tree and those files alone: whatever is staged in the shared index stays out, and stays staged.
 * After, the shared index's entries for those files are set to the new commit's. A file outside the worktree or through
 * a symbolic link is refused, and the branch is moved only from the HEAD the commit was made on. Calls for one worktree
 * run one at a time.
 */
export function commitPaths(options: { worktree: string; branch: string; files: readonly string[]; author: string; message: string }): Promise<BoardCommit> {
  return oneAtATime(options.worktree, () => withScratch((scratch) => commitNow(options, scratch)));
}

async function commitNow({ worktree, branch, files: given, author, message }: Parameters<typeof commitPaths>[0], scratch: string): Promise<BoardCommit> {
  const files = [...new Set(given)].sort();
  if (files.length === 0) return { nothing: true };
  for (const file of files) {
    const why = await refusal(worktree, file);
    if (why !== null) return { error: `couldn't commit: ${why}` };
  }
  if (!(await lockFree(worktree))) return { error: "couldn't commit: index.lock is held" };
  const head = await git(worktree, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (!head.ok) return { error: "couldn't commit: the worktree has no HEAD commit" };
  let tree: string;
  try {
    tree = await treeWith(worktree, head.stdout, files, scratch);
  } catch (error) {
    return { error: `couldn't commit: ${(error as Error).message}` };
  }
  const before = await git(worktree, ['rev-parse', `${head.stdout}^{tree}`]);
  if (before.ok && before.stdout === tree) return { nothing: true };

  const env = { GIT_AUTHOR_NAME: author, ...(await fallbackIdentity(worktree)) };
  const commit = await git(worktree, [...NO_HOOKS, 'commit-tree', tree, '-p', head.stdout, '-m', message, '--no-gpg-sign'], env);
  if (!commit.ok) return { error: `couldn't commit: ${failed('git commit-tree', commit.stderr).message}` };
  const moved = await git(worktree, [...NO_HOOKS, 'update-ref', '-m', message, `refs/heads/${branch}`, commit.stdout, head.stdout]);
  if (!moved.ok) return { error: `couldn't commit: ${branch} moved, or isn't where HEAD is, while the commit was made` };

  for (const chunk of chunks(files)) {
    // The reset hashes each file again to set its index entry: with the repo's filters off, as the commit stored it.
    const reset = await pastTheLock(() => git(worktree, [...NO_HOOKS, 'reset', '-q', commit.stdout, '--', ...chunk.map(literal)], undefined, FILTERS_OFF));
    if (reset === 'locked' || !reset.ok) {
      const why = reset === 'locked' ? 'index.lock is held' : failed('git reset', reset.stderr).message;
      return { error: `committed ${commit.stdout} on ${branch}, but the shared index is stale: ${why}` };
    }
  }
  return { commit: commit.stdout, files };
}

/** A committer (and author email) for a repo that has no identity of its own configured. */
async function fallbackIdentity(worktree: string): Promise<Record<string, string>> {
  const [name, email] = await Promise.all([git(worktree, ['config', 'user.name']), git(worktree, ['config', 'user.email'])]);
  return {
    ...(name.ok && name.stdout !== '' ? {} : { GIT_COMMITTER_NAME: 'agent-board' }),
    ...(email.ok && email.stdout !== '' ? {} : { GIT_AUTHOR_EMAIL: 'crew@agent-board.test', GIT_COMMITTER_EMAIL: 'crew@agent-board.test' }),
  };
}

/** The worktree's state now as a tree: HEAD's, with every changed file as the worktree has it. */
const workTree = (worktree: string, scratch: string) =>
  changedFiles(worktree).then((files) => treeWith(worktree, 'HEAD', files, scratch));

/**
 * Records the worktree's uncommitted work (untracked files not ignored included, `.agent-board/` left out) as a git
 * tree, moving no ref and touching no index. Resolves the tree id.
 */
export function recordWork(worktree: string): Promise<string> {
  return oneAtATime(worktree, () => withScratch((scratch) => workTree(worktree, scratch)));
}

/**
 * The files a record lost since: each the record changed against `base` (the commit HEAD was at when it was made),
 * deletions aside, that is now as HEAD has it, and that HEAD hasn't changed since `base`. Newer work in a file, and a
 * file committed since, are not lost.
 */
async function lostNow(worktree: string, tree: string, base: string): Promise<string[]> {
  const [recorded, changed, moved] = await Promise.all([
    must(worktree, ['diff-tree', '-r', '--name-status', '--no-renames', '-z', `${base}^{tree}`, tree], 'git diff-tree'),
    changedFiles(worktree),
    filesBetween(worktree, base, 'HEAD'),
  ]);
  const kept = new Set([...changed, ...moved]);
  return notBoards(nameStatus(recorded).flatMap((entry) => (entry.status === 'D' || kept.has(entry.path) ? [] : [entry.path])));
}

/** The files `restoreWork` would put back from record `tree`, made with HEAD at `base`. */
export function lostWork(worktree: string, tree: string, base: string): Promise<string[]> {
  return oneAtATime(worktree, () => lostNow(worktree, tree, base));
}

/**
 * Puts back, in the worktree only, the recorded version of each file record `tree` (as `recordWork` resolved it, with
 * HEAD at `base`) lost since (`lostWork`). Refuses (rejects, writing nothing) a file through a symbolic link, and
 * the whole restore when the repo's own config names a filter (`checkCheckoutConfig`), whose `smudge` writing
 * the files would run as the daemon; the restore runs with that check's pins, and fails, saying so, when the config named
 * a program no pin held by the time it was done. Resolves the files put back.
 */
export function restoreWork(worktree: string, tree: string, base: string): Promise<string[]> {
  return oneAtATime(worktree, async () => {
    const checked = await checkCheckoutConfig(worktree, 'put the work back', { trees: [tree], worktree: true });
    if ('refused' in checked) throw new Error(checked.refused);
    const files = await lostNow(worktree, tree, base);
    for (const file of files) {
      const why = await refusal(worktree, file);
      if (why !== null) throw new Error(`couldn't put the work back: ${why}`);
    }
    for (const chunk of chunks(files)) {
      // Writes the worktree alone; git takes the shared index's lock to refresh its file times, never its entries.
      const restore = await pastTheLock(() => git(worktree, [...NO_HOOKS, 'restore', `--source=${tree}`, '--worktree', '--', ...chunk.map(literal)], checked.env));
      if (restore === 'locked') throw new Error("couldn't put the work back: index.lock is held");
      if (!restore.ok) throw failed('git restore', restore.stderr);
    }
    const changed = await checked.after();
    if (changed !== undefined) throw new Error(changed);
    return files;
  });
}

/** The commit `refs/heads/<branch>` points at, or null. */
export async function branchHead(worktree: string, branch: string): Promise<string | null> {
  const head = await git(worktree, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  return head.ok && head.stdout !== '' ? head.stdout : null;
}

/** Files changed between two commits, or two trees (as `recordWork` resolves them). */
export async function filesBetween(worktree: string, from: string, to: string): Promise<string[]> {
  const diff = await must(worktree, ['diff', '--name-status', '--no-renames', '-z', from, to, '--'], 'git diff');
  return [...new Set(nameStatus(diff).map((entry) => entry.path))].sort();
}

/** What a crew loop does to a shared crew worktree, as one thing it can be given (and a test can fake). */
export interface SharedWorktree {
  /** The files changed in the worktree against HEAD (`changedFiles`). */
  changed(worktree: string): Promise<string[]>;
  /** Whether a part of a repo-relative path is a symbolic link (`throughSymlink`). */
  throughSymlink(worktree: string, path: string): Promise<boolean>;
  /** Commits exactly some files under a member's name (`commitPaths`). */
  commit(options: { worktree: string; branch: string; files: readonly string[]; author: string; message: string }): Promise<BoardCommit>;
  /** Records the uncommitted work as a tree (`recordWork`). */
  record(worktree: string): Promise<string>;
  /** The files a record lost since, made with HEAD at `base` (`lostWork`). */
  lost(worktree: string, tree: string, base: string): Promise<string[]>;
  /** Puts back what a record lost (`restoreWork`). */
  restore(worktree: string, tree: string, base: string): Promise<string[]>;
  /** The commit a branch points at, or null (`branchHead`). */
  head(worktree: string, branch: string): Promise<string | null>;
  /** The files changed between two commits or trees (`filesBetween`). */
  between(worktree: string, from: string, to: string): Promise<string[]>;
}

/** The shared worktree, done with git. */
export const gitSharedWorktree: SharedWorktree = {
  changed: changedFiles,
  throughSymlink,
  commit: commitPaths,
  record: recordWork,
  lost: lostWork,
  restore: restoreWork,
  head: branchHead,
  between: filesBetween,
};

/** The tools whose PostToolUse payload names the file they edited, and the field it is in. */
const EDIT_TOOLS: Record<string, string> = { Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' };

/** The files a Claude Code PostToolUse hook payload says were edited: absolute paths only; [] for any other tool. */
export function editedFiles(payload: Record<string, unknown>): string[] {
  const field = typeof payload.tool_name === 'string' && Object.hasOwn(EDIT_TOOLS, payload.tool_name) ? EDIT_TOOLS[payload.tool_name] : undefined;
  const input = payload.tool_input;
  if (field === undefined || typeof input !== 'object' || input === null) return [];
  const path = (input as Record<string, unknown>)[field];
  return typeof path === 'string' && isAbsolute(path) ? [path] : [];
}
