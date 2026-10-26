// Where a new zone comes from besides a picked folder: a GitHub repo, cloned by the daemon when there is no
// local clone of it, and the folders zones were made for before.
import { existsSync } from 'node:fs';
import { mkdir, readdir, realpath, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CloneOptions, CloneProgress } from '@agent-board/tracker';
import { runGit } from './git.ts';
import { keyedQueue } from './keyed-queue.ts';
import { invalidParams, paramsObject, stringParam } from './params.ts';
import type { DaemonMethods, GitHubRepoSource, RecentFolder, Zone } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';
import { defaultBranchOf } from './worktrees.ts';
import { zoneTrackerParam, type TrackerHost } from './trackers.ts';
import { newZoneParams, zoneFolder, type CloneFolders, type ZoneTable } from './zones.ts';

type SourceMethods = Pick<
  DaemonMethods,
  'zone.clone' | 'zone.cancelClone' | 'zone.recentFolders' | 'zone.githubRepos' | 'zone.checkFolder' | 'zone.checkoutState' | 'zone.findCopies'
>;

/** Clones a repo into a folder: `cloneRepo` through gh outside tests. */
export type RepoCloner = (repo: string, dir: string, options: Pick<CloneOptions, 'onProgress' | 'signal'>) => Promise<void>;

export interface ZoneSourceOptions {
  db: DatabaseSync;
  zones: ZoneTable;
  trackers: Pick<TrackerHost, 'checkScope' | 'scopes'>;
  /** Where `zone.clone` clones repos: `<reposDir>/<owner>/<repo>`. */
  reposDir: string;
  /** The folders `zone.findCopies` looks one level deep in, those that exist. */
  copyRoots: readonly string[];
  clone: RepoCloner;
  /** Removes a zone, announcing it (with why its clone failed, if it did) and the items it held. */
  removeZone(id: string, cloneFailed?: string): Promise<void>;
  log(message: string): void;
}

export interface ZoneSources {
  handlers<Context>(): RpcHandlers<SourceMethods, Context>;
  /** How far a zone's clone is, while it runs. */
  progress(zoneId: string): CloneProgress | undefined;
  /** Whether a clone is running: the daemon stays up for it. */
  busy(): boolean;
  /** Clears up the clones a daemon that went away left: their zones and folders go. */
  reconcile(): Promise<void>;
  /** Cancels every running clone and waits for each to be cleared up. */
  close(): Promise<void>;
}

/** How long each git read of `zone.checkoutState` may take: a checkout it can't read in time shows no warning. */
const CHECKOUT_READ_MS = 10_000;

/** Most recent folders `zone.recentFolders` lists. */
const MAX_RECENT = 20;
/** Least time between two announcements of a clone's progress. */
const PROGRESS_INTERVAL_MS = 250;
/** One segment of `owner/repo` that is safe as a folder name: never `.`, `..` or one that reads as a flag. */
const SEGMENT = /^(?!-)(?!\.{1,2}$)[\w.-]+$/;
/** The most of a clone's failure the user is told; the daemon's log keeps all of it. */
const MAX_FAILURE_LENGTH = 240;

/** Whether `repo` is `owner/repo` with both parts safe as folder names. */
export function isSafeRepo(repo: string): boolean {
  const parts = repo.split('/');
  return parts.length === 2 && parts.every((part) => SEGMENT.test(part));
}

/** The first line of a clone's failure, cut to `MAX_FAILURE_LENGTH`. */
export function shortFailure(message: string): string {
  const line = message.split('\n').find((each) => each.trim() !== '')?.trim() ?? message;
  return line.length > MAX_FAILURE_LENGTH ? `${line.slice(0, MAX_FAILURE_LENGTH - 1)}…` : line;
}

export function createZoneSources(options: ZoneSourceOptions): ZoneSources {
  const { db, zones, trackers, log } = options;
  const recent = db.prepare('SELECT path, used_at FROM recent_folders ORDER BY used_at DESC, rowid DESC');
  /** Local copies `zone.findCopies` found, by lowercase `owner/repo`: known until the daemon restarts. */
  let found: ReadonlyMap<string, string> = new Map();
  /** The scan under way, which a second `zone.findCopies` shares rather than starts over. */
  let scanning: Promise<{ found: number }> | undefined;
  const running = new Map<string, { controller: AbortController; done: Promise<void>; progress?: CloneProgress }>();
  /** Clones into one folder start one at a time: a second finds the first's zone, and reuses it. */
  const queue = keyedQueue();

  /**
   * Removes what a clone into `path` left: the folder itself only if the daemon made it, else what was cloned into it
   * (it was empty before); then its owner's folder, if the daemon made that and nothing else is in it now.
   */
  const removeCloned = async (path: string, made: CloneFolders) => {
    if (made.madeFolder) await rm(path, { recursive: true, force: true });
    else {
      const entries = await readdir(path).catch(() => [] as string[]);
      await Promise.all(entries.map((entry) => rm(join(path, entry), { recursive: true, force: true })));
    }
    if (made.madeOwner) await rmdir(dirname(path)).catch(() => {});
  };

  /** Removes what the zone's clone left, and the zone unless sessions were moved into it, saying why when it failed. */
  const clearUp = async (zone: Zone, cloneFailed?: string) => {
    if (zone.clone !== null) await removeCloned(zone.clone.path, zones.cloneFolders(zone.id));
    if (zones.holdsSessions(zone.id)) {
      zones.clearClone(zone.id);
      zones.announce(zone.id, cloneFailed === undefined ? {} : { cloneFailed });
      return;
    }
    await options.removeZone(zone.id, cloneFailed);
  };

  const start = (zone: Zone, made: CloneFolders) => {
    const { repo, path } = zone.clone!;
    const controller = new AbortController();
    let announced = 0;
    let trailing: NodeJS.Timeout | undefined;
    // At most one announcement per interval, the last progress always announced.
    const announce = () => {
      trailing = undefined;
      announced = Date.now();
      if (running.has(zone.id)) zones.announce(zone.id);
    };
    const entry: { controller: AbortController; done: Promise<void>; progress?: CloneProgress } = {
      controller,
      done: Promise.resolve(),
    };
    entry.done = (async () => {
      try {
        await options.clone(repo, path, {
          signal: controller.signal,
          onProgress: (progress) => {
            entry.progress = progress;
            const wait = announced + PROGRESS_INTERVAL_MS - Date.now();
            if (wait <= 0) announce();
            else trailing ??= setTimeout(announce, wait);
          },
        });
        clearTimeout(trailing);
        running.delete(zone.id);
        if (!zones.bind(zone.id, await realpath(path), '', { clone: true })) await removeCloned(path, made);
        log(`cloned ${repo} into ${path}`);
      } catch (error) {
        clearTimeout(trailing);
        running.delete(zone.id);
        const cancelled = controller.signal.aborted;
        const message = (error as Error).message;
        log(cancelled ? `cancelled the clone of ${repo}` : `could not clone ${repo} into ${path}: ${message}`);
        const reason = cancelled ? undefined : `Could not clone ${repo}: ${shortFailure(message)}`;
        const current = zones.find(zone.id);
        if (current !== undefined) await clearUp(current, reason);
        else await removeCloned(path, made);
      }
    })();
    running.set(zone.id, entry);
  };

  return {
    progress: (zoneId) => running.get(zoneId)?.progress,
    busy: () => running.size > 0,
    async reconcile() {
      for (const zone of zones.cloning()) {
        log(`clearing up the clone of ${zone.clone!.repo} a previous daemon left`);
        await clearUp(zone);
      }
    },
    async close() {
      const entries = [...running.values()];
      for (const entry of entries) entry.controller.abort();
      await Promise.all(entries.map((entry) => entry.done));
    },
    handlers: <Context>(): RpcHandlers<SourceMethods, Context> => ({
      'zone.clone': async (params) => {
        const fields = paramsObject(params);
        const wanted = stringParam(fields, 'repo').trim();
        if (!isSafeRepo(wanted)) throw invalidParams(`repo must be owner/repo, got ${wanted}`);
        const look = newZoneParams(fields, zones);
        const { scope: repo } = await trackers.checkScope({ provider: 'github', scope: wanted });
        // Its issues come from the repo, unless another tracker was asked for (a Linear team's zone bound to it).
        const asked = fields.tracker === undefined || fields.tracker === null ? null : zoneTrackerParam(fields);
        const tracker = asked === null ? { provider: 'github' as const, scope: repo } : await trackers.checkScope(asked);
        // The folder comes from GitHub's own spelling of the repo; it must still be a folder of the repos dir.
        const path = join(options.reposDir, ...repo.split('/'));
        const inside = relative(options.reposDir, path);
        if (!isSafeRepo(repo) || inside.startsWith('..') || isAbsolute(inside)) {
          throw invalidParams(`${repo} can't be cloned into ${options.reposDir}`);
        }
        return queue(path, async () => {
          // A clone into the folder is already under way (another window, a retry): its zone is the one.
          const under = zones.cloning().find((zone) => zone.clone?.path === path && running.has(zone.id));
          if (under !== undefined) return under;
          const exists = existsSync(path);
          if (exists && (await readdir(path)).length > 0) {
            throw invalidParams(`${path} already exists: add it as a folder instead`);
          }
          const madeOwner = !existsSync(dirname(path));
          await mkdir(dirname(path), { recursive: true });
          if (!exists) await mkdir(path);
          const made = { madeFolder: !exists, madeOwner };
          const zone = zones.insert({
            ...look,
            name: look.name ?? repo.split('/')[1]!,
            repoRoot: null,
            folder: '',
            tracker,
            clone: { repo, path, ...made },
          });
          start(zone, made);
          return zone;
        });
      },
      'zone.cancelClone': (params) => {
        const id = stringParam(paramsObject(params), 'id');
        const entry = running.get(id);
        if (entry === undefined) throw invalidParams(`zone ${id} is not cloning`);
        entry.controller.abort();
        return null;
      },
      'zone.recentFolders': async () => {
        const onBoard = boardFolders(zones.list());
        const rows = recent.all() as { path: string; used_at: string }[];
        const folders: RecentFolder[] = [];
        for (const row of rows) {
          if (folders.length >= MAX_RECENT) break;
          if (!existsSync(row.path)) continue;
          const head = await runGit(row.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
          if (!head.ok) continue;
          folders.push({
            path: row.path,
            name: basename(row.path),
            branch: head.stdout === 'HEAD' ? null : head.stdout,
            usedAt: row.used_at,
            onBoard: onBoard.has(row.path),
          });
        }
        return folders;
      },
      'zone.githubRepos': async () => {
        const scopes = await trackers.scopes('github');
        const known = await knownClones(options.reposDir, zones.list(), recent.all() as { path: string }[], found);
        const onBoard = boardFolders(zones.list());
        return scopes.map((scope): GitHubRepoSource => {
          const [owner, name] = scope.key.split('/') as [string, string];
          const localPath = known.clones.get(scope.key.toLowerCase()) ?? null;
          return {
            repo: scope.key,
            name: scope.name,
            description: scope.description ?? null,
            localPath,
            clonePath: join(options.reposDir, owner, name),
            foundCopy: localPath !== null && known.foundByScan.has(scope.key.toLowerCase()),
            onBoard: localPath !== null && onBoard.has(localPath),
          };
        });
      },
      'zone.checkFolder': async (params) => {
        const fields = paramsObject(params);
        const wanted = fields.repo === undefined ? undefined : stringParam(fields, 'repo').trim().toLowerCase();
        const picked = stringParam(fields, 'path');
        if (!isAbsolute(picked)) throw invalidParams(`path must be absolute, got ${picked}`);
        // The folder may be a link or hold `..`: it is judged, and bound, as the folder it really is. A repo git can't
        // read is refused with git's reason; only a folder outside git has no repo.
        const found = await zoneFolder(picked);
        const { path } = found;
        if (found.repoRoot === null) {
          if (wanted !== undefined) throw invalidParams(`${path} is not a git repo, so not a copy of ${wanted}`);
          return { path, repoRoot: null, gitHubRepo: null, name: basename(path) };
        }
        const origin = await runGit(path, ['remote', 'get-url', 'origin']);
        const gitHubRepo = (origin.ok ? gitHubRepoOf(origin.stdout) : undefined) ?? null;
        if (wanted !== undefined && gitHubRepo !== wanted) {
          throw invalidParams(
            gitHubRepo === null
              ? `${path} is a git repo with no GitHub origin, not a copy of ${wanted}`
              : `That folder's origin is ${gitHubRepo}, not ${wanted}`,
          );
        }
        const { repoRoot, folder } = found;
        return { path, repoRoot, gitHubRepo, name: folder === '' ? basename(repoRoot) : `${basename(repoRoot)}/${folder}` };
      },
      'zone.checkoutState': async (params) => {
        const path = stringParam(paramsObject(params), 'path');
        if (!isAbsolute(path)) throw invalidParams(`path must be absolute, got ${path}`);
        const top = await runGit(path, ['rev-parse', '--show-toplevel'], CHECKOUT_READ_MS);
        if (!top.ok) throw invalidParams(`${path} is not inside a git repository`);
        const [head, status, defaultBranch] = await Promise.all([
          runGit(top.stdout, ['symbolic-ref', '--quiet', '--short', 'HEAD'], CHECKOUT_READ_MS),
          runGit(top.stdout, ['status', '--porcelain'], CHECKOUT_READ_MS),
          defaultBranchOf(top.stdout),
        ]);
        return { branch: head.ok && head.stdout !== '' ? head.stdout : null, defaultBranch, dirty: status.ok && status.stdout !== '' };
      },
      'zone.findCopies': () => {
        scanning ??= scanForCopies(options.copyRoots)
          .then((copies) => {
            found = copies;
            return { found: copies.size };
          })
          .finally(() => {
            scanning = undefined;
          });
        return scanning;
      },
    }),
  };
}

/** The folders zones on the board are bound to: their repo root, or their folder in it. */
function boardFolders(zones: readonly Zone[]): Set<string> {
  return new Set(
    zones.flatMap((zone) => (zone.repoRoot === null ? [] : [zone.folder === '' ? zone.repoRoot : join(zone.repoRoot, zone.folder)])),
  );
}

/**
 * The local clones the daemon knows of, by lowercase `owner/repo`: the repos of zones and recent folders whose `origin`
 * is on GitHub, those in the managed folder, and those the user had the daemon look for.
 */
async function knownClones(
  reposDir: string,
  zones: readonly Zone[],
  recent: readonly { path: string }[],
  found: ReadonlyMap<string, string>,
): Promise<{ clones: Map<string, string>; foundByScan: Set<string> }> {
  const candidates = new Set<string>();
  for (const zone of zones) if (zone.repoRoot !== null) candidates.add(zone.repoRoot);
  for (const { path } of recent) if (existsSync(path)) candidates.add(path);
  const roots = new Set<string>();
  for (const path of candidates) {
    const top = await runGit(path, ['rev-parse', '--show-toplevel']);
    if (top.ok) roots.add(await realpath(top.stdout));
  }
  const managedOwners = await readdir(reposDir).catch(() => [] as string[]);
  for (const owner of managedOwners) {
    for (const repo of await readdir(join(reposDir, owner)).catch(() => [] as string[])) {
      if (existsSync(join(reposDir, owner, repo, '.git'))) roots.add(join(reposDir, owner, repo));
    }
  }
  const clones = new Map<string, string>();
  for (const root of roots) {
    const origin = await runGit(root, ['remote', 'get-url', 'origin']);
    const repo = origin.ok ? gitHubRepoOf(origin.stdout) : undefined;
    if (repo !== undefined && !clones.has(repo)) clones.set(repo, root);
  }
  const foundByScan = new Set<string>();
  for (const [repo, root] of found) {
    if (clones.has(repo) || !existsSync(root)) continue;
    clones.set(repo, root);
    foundByScan.add(repo);
  }
  return { clones, foundByScan };
}

/** The longest one `git remote get-url` may take in a scan, and the most that run at once. */
const SCAN_GIT_TIMEOUT_MS = 5000;
const SCAN_CONCURRENCY = 8;
/** How long a scan may run in all, and the most entries it looks at in a folder: a huge or slow folder is cut short. */
const SCAN_DEADLINE_MS = 20000;
const SCAN_MAX_ENTRIES = 2000;

/** What `scanForCopies` asks of the file system, so a test can make a mount hang. */
export interface ScanFs {
  readdir(path: string): Promise<string[]>;
  isDirectory(path: string): Promise<boolean>;
}

const realFs: ScanFs = {
  readdir: (path) => readdir(path).catch(() => []),
  isDirectory: async (path) => (await stat(path).catch(() => undefined))?.isDirectory() === true,
};

/**
 * The repos in the entries of `roots`, one level deep, by lowercase `owner/repo`: those whose own `.git` is a folder
 * (not a linked worktree's or a submodule's file) and whose `origin` is on GitHub. Of two copies of a repo the first
 * wins, by root order and then by name. It never runs past `deadlineMs`, not even on a `readdir` or `stat` that hangs
 * (a dead mount): it then resolves with what it has found so far.
 */
export function scanForCopies(
  roots: readonly string[],
  { deadlineMs = SCAN_DEADLINE_MS, fs = realFs }: { deadlineMs?: number; fs?: ScanFs } = {},
): Promise<Map<string, string>> {
  const deadline = Date.now() + deadlineMs;
  /** Each root's hits by entry, in root order: the order the first copy of a repo is chosen in. */
  const found: ({ repo: string; dir: string } | undefined)[][] = roots.map(() => []);
  const merged = () => {
    const copies = new Map<string, string>();
    for (const hit of found.flat()) if (hit !== undefined && !copies.has(hit.repo)) copies.set(hit.repo, hit.dir);
    return copies;
  };
  const scan = async () => {
    for (const [rootIndex, root] of roots.entries()) {
      const entries = (await fs.readdir(root)).sort().slice(0, SCAN_MAX_ENTRIES);
      const hits = found[rootIndex]!;
      let next = 0;
      const worker = async () => {
        while (next < entries.length && Date.now() < deadline) {
          const index = next++;
          const dir = join(root, entries[index]!);
          if (!(await fs.isDirectory(join(dir, '.git')))) continue;
          const origin = await runGit(dir, ['remote', 'get-url', 'origin'], SCAN_GIT_TIMEOUT_MS);
          const repo = origin.ok ? gitHubRepoOf(origin.stdout) : undefined;
          const real = repo === undefined ? undefined : await realpath(dir).catch(() => undefined);
          if (repo !== undefined && real !== undefined) hits[index] = { repo, dir: real };
        }
      };
      await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, entries.length) }, worker));
    }
  };
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(merged()), Math.max(0, deadline - Date.now()));
    scan().then(
      () => resolve(merged()),
      () => resolve(merged()),
    ).finally(() => clearTimeout(timer));
  });
}

/**
 * The lowercase `owner/repo` of a GitHub remote URL, or undefined for any other host (a lookalike such as
 * `notgithub.com` too): `https://` (with a user or port), `ssh://git@github.com[:port]/` and `git@github.com:`.
 */
export function gitHubRepoOf(url: string): string | undefined {
  const match =
    /^(?:https?:\/\/(?:[^@/\s]+@)?|ssh:\/\/(?:[^@/\s]+@)?|git@)github\.com(?::\d+)?[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return match?.[1]?.toLowerCase();
}
