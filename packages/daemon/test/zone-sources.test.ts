import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gitHubRepoOf, isSafeRepo, scanForCopies, shortFailure } from '../src/zone-sources.ts';
import { describe, expect, it, onTestFinished } from 'vitest';
import { createGitHubTracker } from '@agent-board/tracker';
import {
  createFakeGitHub,
  createFakeTracker,
  createMemoryCredentialStore,
  FAKE_GITHUB_STATE,
  type FakeGitHubState,
} from '@agent-board/tracker/testing';
import type { DaemonOptions } from '../src/daemon.ts';
import { migrate } from '../src/migrate.ts';
import { daemonPaths } from '../src/paths.ts';
import type { DaemonEvent, ZoneRemovedEvent, ZoneUpdatedEvent } from '../src/protocol.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, tempDataDir, tempRepo } from './helpers.ts';

const at = { x: 40, y: 80 };

/**
 * A daemon whose GitHub is a fake gh on `state` (acme/app clones from a local repo), whose Linear is the fake tracker,
 * and whose managed repos go to a temp dir.
 */
async function sourcesDaemon(state: Partial<FakeGitHubState> = {}, options: Partial<DaemonOptions> = {}) {
  const source = tempRepo('app');
  const github = createFakeGitHub({
    ...FAKE_GITHUB_STATE,
    repos: [
      { nameWithOwner: 'acme/app', description: 'The app', cloneFrom: source },
      { nameWithOwner: 'acme/ops', description: null },
    ],
    ...state,
  });
  onTestFinished(github.dispose);
  const reposDir = join(tempDataDir(), 'repos');
  const dataDir = options.dataDir ?? tempDataDir();
  const credentials = createMemoryCredentialStore();
  await credentials.set('linear', 'lin_api_good');
  const daemon = await startTestDaemon({
    dataDir,
    reposDir,
    credentials,
    trackers: {
      github: () => createGitHubTracker({ gh: github.gh }),
      linear: () => createFakeTracker(),
    },
    gh: github.gh,
    ...options,
  });
  const client = await connectTestClient(daemon);
  return { daemon, client, github, reposDir, source, dataDir };
}

const zoneRemoved = (id: string) => (event: DaemonEvent): event is ZoneRemovedEvent =>
  event.type === 'zone.removed' && event.id === id;
const zoneCloned = (id: string) => (event: DaemonEvent): event is ZoneUpdatedEvent =>
  event.type === 'zone.updated' && event.zone.id === id && event.zone.clone === null && event.zone.repoRoot !== null;

describe('adding a zone with its name, colour, size and tracker', () => {
  it('takes them all at once, for a folder and for an unbound zone', async () => {
    const { client } = await sourcesDaemon();
    const repo = tempRepo('web');

    const zone = await client.call('zone.add', {
      path: repo,
      ...at,
      width: 640,
      height: 360,
      name: 'Web',
      color: '#12B886',
      tracker: { provider: 'github', scope: 'Acme/App' },
    });
    expect(zone).toMatchObject({
      kind: 'repo',
      repoRoot: repo,
      name: 'Web',
      color: '#12b886',
      width: 640,
      height: 360,
      tracker: { provider: 'github', scope: 'acme/app' },
      clone: null,
    });

    const unbound = await client.call('zone.addUnbound', {
      name: 'Tracker work',
      ...at,
      width: 500,
      height: 300,
      tracker: { provider: 'linear', scope: 'ACME' },
    });
    expect(unbound).toMatchObject({ kind: 'unbound', width: 500, height: 300, tracker: { provider: 'linear', scope: 'ACME' } });
  });

  it('adds nothing when the tracker or the size is refused', async () => {
    const { client } = await sourcesDaemon();
    await expect(
      client.call('zone.add', { path: tempRepo(), ...at, tracker: { provider: 'github', scope: 'acme/nope' } }),
    ).rejects.toThrow(/acme\/nope/);
    await expect(client.call('zone.addUnbound', { name: 'Tiny', ...at, width: 10, height: 10 })).rejects.toThrow(/at least/);
    expect(await client.call('zone.list')).toEqual([]);
  });

  it('tells every client about a new zone', async () => {
    const { client } = await sourcesDaemon();
    const events = recordEvents(client);
    const zone = await client.call('zone.addUnbound', { name: 'Notes', ...at });
    await events.waitFor((event): event is ZoneUpdatedEvent => event.type === 'zone.updated' && event.zone.id === zone.id);
  });
});

describe('recent folders', () => {
  it('lists the folders zones were added for, newest first, with their branch and whether a zone has them', async () => {
    const { client } = await sourcesDaemon();
    const first = tempRepo('first');
    const second = tempRepo('second');
    const kept = await client.call('zone.add', { path: first, ...at });
    const removed = await client.call('zone.add', { path: join(second, 'apps', 'web'), ...at });
    await client.call('zone.remove', { id: removed.id });

    const recent = await client.call('zone.recentFolders');

    expect(recent).toEqual([
      expect.objectContaining({ path: join(second, 'apps', 'web'), name: 'web', branch: expect.any(String), onBoard: false }),
      expect.objectContaining({ path: first, name: 'first', onBoard: true }),
    ]);
    expect(kept.id).toBeDefined();
  });

  it('leaves out folders that are gone', async () => {
    const { client } = await sourcesDaemon();
    const repo = tempRepo('gone');
    const zone = await client.call('zone.add', { path: join(repo, 'apps', 'web'), ...at });
    await client.call('zone.remove', { id: zone.id });
    git(repo, 'rm', '-rq', 'apps');
    expect(await client.call('zone.recentFolders')).toEqual([]);
  });
});

describe('GitHub repos as zone sources', () => {
  it('lists the repos gh sees, with a local clone where one is known and where a new one would go', async () => {
    const { client, reposDir } = await sourcesDaemon();
    const local = tempRepo('ops');
    git(local, 'remote', 'add', 'origin', 'git@github.com:Acme/ops.git');
    const zone = await client.call('zone.add', { path: local, ...at });

    const repos = await client.call('zone.githubRepos');

    expect(repos).toEqual([
      { repo: 'acme/app', name: 'app', description: 'The app', localPath: null, clonePath: join(reposDir, 'acme', 'app'), foundCopy: false, onBoard: false },
      { repo: 'acme/ops', name: 'ops', description: null, localPath: local, clonePath: join(reposDir, 'acme', 'ops'), foundCopy: false, onBoard: true },
    ]);
    expect(zone.repoRoot).toBe(local);
  });
});

describe('using a local copy of a GitHub repo', () => {
  /** A repo whose `origin` is on GitHub as `slug`, in a folder named `name`. */
  const copyOf = (slug: string, name = 'copy') => {
    const repo = tempRepo(name);
    git(repo, 'remote', 'add', 'origin', `git@github.com:${slug}.git`);
    return repo;
  };

  it('accepts a folder whose origin is the repo, from its top level or from a subfolder, in any case', async () => {
    const { client } = await sourcesDaemon();
    const repo = copyOf('Acme/App');

    expect(await client.call('zone.checkFolder', { repo: 'acme/app', path: repo })).toEqual({
      path: repo,
      repoRoot: repo,
      gitHubRepo: 'acme/app',
      name: 'copy',
    });
    expect(await client.call('zone.checkFolder', { repo: 'ACME/app', path: join(repo, 'apps', 'web') })).toEqual({
      path: join(repo, 'apps', 'web'),
      repoRoot: repo,
      gitHubRepo: 'acme/app',
      name: 'copy/apps/web',
    });
  });

  it('names the repo a folder is the copy of when it is another, and binds nothing', async () => {
    const { client } = await sourcesDaemon();
    const repo = copyOf('acme/ops');

    await expect(client.call('zone.checkFolder', { repo: 'acme/app', path: repo })).rejects.toThrow(
      "That folder's origin is acme/ops, not acme/app",
    );
    expect(await client.call('zone.list')).toEqual([]);
  });

  it('refuses a folder that is not a git repo, has no GitHub origin, or is missing', async () => {
    const { client } = await sourcesDaemon();
    const plain = join(tempDataDir(), 'plain');
    mkdirSync(plain);
    const local = tempRepo('local');

    await expect(client.call('zone.checkFolder', { repo: 'acme/app', path: plain })).rejects.toThrow('not inside a git repository');
    await expect(client.call('zone.checkFolder', { repo: 'acme/app', path: local })).rejects.toThrow('no GitHub origin');
    await expect(client.call('zone.checkFolder', { repo: 'acme/app', path: join(plain, 'gone') })).rejects.toThrow('not a folder');
    await expect(client.call('zone.checkFolder', { repo: 'acme/app', path: 'relative/dir' })).rejects.toThrow('absolute');
  });

  it('resolves a link to the folder it points at', async () => {
    const { client } = await sourcesDaemon();
    const repo = copyOf('acme/app');
    const link = join(tempDataDir(), 'link');
    symlinkSync(repo, link);

    expect(await client.call('zone.checkFolder', { repo: 'acme/app', path: link })).toEqual({
      path: repo,
      repoRoot: repo,
      gitHubRepo: 'acme/app',
      name: 'copy',
    });
  });

  it('looks at any folder in a git repo without a repo to match, and says when it has no GitHub origin', async () => {
    const { client } = await sourcesDaemon();
    const local = tempRepo('local');

    expect(await client.call('zone.checkFolder', { path: join(local, 'apps') })).toEqual({
      path: join(local, 'apps'),
      repoRoot: local,
      gitHubRepo: null,
      name: 'local/apps',
    });
  });

  it('finds copies one level deep in the folders it is given, only when asked, and offers them as the repos clones', async () => {
    const roots = join(tempDataDir(), 'roots');
    const code = join(roots, 'code');
    mkdirSync(code, { recursive: true });
    const { client } = await sourcesDaemon({}, { copyRoots: [code, join(roots, 'missing')] });
    const app = copyOf('acme/app', 'app');
    renameSync(app, join(code, 'app'));
    const deeper = copyOf('acme/ops', 'ops');
    mkdirSync(join(code, 'nested'));
    renameSync(deeper, join(code, 'nested', 'ops'));
    const plain = join(code, 'not-a-repo');
    mkdirSync(plain);

    expect((await client.call('zone.githubRepos')).map((repo) => repo.localPath)).toEqual([null, null]);
    expect(await client.call('zone.findCopies')).toEqual({ found: 1 });

    const repos = await client.call('zone.githubRepos');
    expect(repos.map((repo) => [repo.repo, repo.localPath])).toEqual([
      ['acme/app', realpathSync(join(code, 'app'))],
      ['acme/ops', null],
    ]);
    expect(repos[0]?.onBoard).toBe(false);
    expect(repos.map((repo) => repo.foundCopy)).toEqual([true, false]);
  });

  it('skips linked worktrees and submodule-style .git files, and links, and takes the first of two copies by name', async () => {
    const code = join(tempDataDir(), 'code');
    mkdirSync(code);
    const { client } = await sourcesDaemon({}, { copyRoots: [code, join(tempDataDir(), 'unreadable')] });
    const second = copyOf('acme/app', 'b-app');
    renameSync(second, join(code, 'b-app'));
    const first = copyOf('acme/app', 'a-app');
    renameSync(first, join(code, 'a-app'));
    // A linked worktree of a-app has a .git file, not a folder; so does anything else that points at a repo elsewhere.
    git(join(code, 'a-app'), 'worktree', 'add', '-b', 'side', join(code, '0-worktree'));
    symlinkSync(join(code, 'b-app'), join(code, 'c-link'));
    const ops = copyOf('acme/ops', 'ops');
    renameSync(ops, join(code, 'ops'));
    git(join(code, 'ops'), 'worktree', 'add', '-b', 'side', join(code, '0-ops-worktree'));

    expect(await client.call('zone.findCopies')).toEqual({ found: 2 });

    const repos = await client.call('zone.githubRepos');
    expect(repos.map((repo) => [repo.repo, repo.localPath])).toEqual([
      ['acme/app', realpathSync(join(code, 'a-app'))],
      ['acme/ops', realpathSync(join(code, 'ops'))],
    ]);
  });

  it('keeps a clone a zone or the managed folder has over one it found', async () => {
    const code = join(tempDataDir(), 'code');
    mkdirSync(code);
    const { client } = await sourcesDaemon({}, { copyRoots: [code] });
    const known = copyOf('acme/app', 'known');
    await client.call('zone.add', { path: known, ...at });
    const found = copyOf('acme/app', 'found');
    renameSync(found, join(code, 'found'));

    expect(await client.call('zone.findCopies')).toEqual({ found: 1 });

    const [app] = await client.call('zone.githubRepos');
    expect(app).toMatchObject({ repo: 'acme/app', localPath: known, foundCopy: false });
  });

  it('shares one scan between overlapping requests', async () => {
    const code = join(tempDataDir(), 'code');
    mkdirSync(code);
    const { client } = await sourcesDaemon({}, { copyRoots: [code] });
    renameSync(copyOf('acme/app', 'app'), join(code, 'app'));

    expect(await Promise.all([client.call('zone.findCopies'), client.call('zone.findCopies')])).toEqual([{ found: 1 }, { found: 1 }]);
  });

  it('skips a folder it cannot read', async () => {
    const root = join(tempDataDir(), 'closed');
    mkdirSync(root);
    chmodSync(root, 0);
    onTestFinished(() => chmodSync(root, 0o700));
    const { client } = await sourcesDaemon({}, { copyRoots: [root] });

    expect(await client.call('zone.findCopies')).toEqual({ found: 0 });
  });
});

describe('scanForCopies', () => {
  it('resolves at its deadline with what it found, though a stat or readdir never returns', async () => {
    const root = join(tempDataDir(), 'code');
    mkdirSync(root);
    const repo = tempRepo('app');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
    renameSync(repo, join(root, 'a-app'));
    mkdirSync(join(root, 'b-hung'));
    const never = new Promise<never>(() => {});
    const fs = {
      readdir: (path: string) => (path === 'hung-root' ? never : Promise.resolve(readdirSync(path))),
      isDirectory: (path: string) => (path.includes('b-hung') ? never : Promise.resolve(existsSync(path))),
    };

    const started = Date.now();
    const copies = await scanForCopies([root, 'hung-root'], { deadlineMs: 300, fs });

    expect(Date.now() - started).toBeLessThan(3000);
    expect([...copies.keys()]).toEqual(['acme/app']);
  });
});

/** Spelt apart so a remote URL with a user is not mistaken for an email address. */
const AT = '@';

describe('gitHubRepoOf', () => {
  it.each([
    ['git@github.com:Acme/App.git', 'acme/app'],
    ['https://github.com/acme/app', 'acme/app'],
    ['https://github.com/acme/app.git', 'acme/app'],
    ['https://github.com/acme/app/', 'acme/app'],
    [`https://user${AT}github.com/acme/app.git`, 'acme/app'],
    [`https://user:token${AT}github.com/acme/app.git`, 'acme/app'],
    ['ssh://git@github.com/acme/app.git', 'acme/app'],
    ['ssh://git@github.com:22/acme/app.git', 'acme/app'],
    ['HTTPS://GitHub.com/Acme/App', 'acme/app'],
    ['  git@github.com:acme/app.git\n', 'acme/app'],
    ['https://notgithub.com/acme/app', undefined],
    [`git${AT}evilgithub.com:acme/app.git`, undefined],
    ['https://evil.com/github.com/acme/app', undefined],
    ['https://gitlab.com/x/github.com/acme/app', undefined],
    ['https://github.com.evil.com/acme/app', undefined],
    ['https://github.com/acme', undefined],
    ['/srv/git/github.com/acme/app', undefined],
    ['', undefined],
  ])('reads %j as %j', (url, repo) => {
    expect(gitHubRepoOf(url)).toBe(repo);
  });
});

describe('cloning a GitHub repo into a new zone', () => {
  it('makes a zone that clones into the managed folder, then binds it, with GitHub Issues as its tracker', async () => {
    const { client, reposDir } = await sourcesDaemon();
    const events = recordEvents(client);

    const zone = await client.call('zone.clone', { repo: 'Acme/App', ...at, name: 'App', color: '#7950f2' });

    const path = join(reposDir, 'acme', 'app');
    expect(zone).toMatchObject({
      kind: 'unbound',
      repoRoot: null,
      name: 'App',
      color: '#7950f2',
      clone: { repo: 'acme/app', path },
      tracker: { provider: 'github', scope: 'acme/app' },
    });
    const done = await events.waitFor(zoneCloned(zone.id));
    expect(done.zone).toMatchObject({ kind: 'repo', repoRoot: path, folder: '', clone: null });
    expect(existsSync(join(path, 'apps', 'web', 'index.ts'))).toBe(true);
    expect(await client.call('zone.recentFolders')).toEqual([expect.objectContaining({ path, onBoard: true })]);
    const repos = await client.call('zone.githubRepos');
    expect(repos.find((repo) => repo.repo === 'acme/app')).toMatchObject({ localPath: path, onBoard: true });
  });

  it('shows how far the clone is on the zone', async () => {
    const { client } = await sourcesDaemon({ cloneDelayMs: 500 });
    const events = recordEvents(client);
    const zone = await client.call('zone.clone', { repo: 'acme/app', ...at });
    const progress = await events.waitFor(
      (event): event is ZoneUpdatedEvent =>
        event.type === 'zone.updated' && event.zone.id === zone.id && event.zone.clone?.phase === 'Enumerating objects',
    );
    expect(progress.zone.clone).toMatchObject({ percent: 0 });
    await events.waitFor(zoneCloned(zone.id));
  });

  it('starts no agent while the repo clones', async () => {
    const { client } = await sourcesDaemon({ cloneDelayMs: 30_000 });
    const zone = await client.call('zone.clone', { repo: 'acme/app', ...at });
    await expect(client.call('agent.spawn', { zoneId: zone.id, prompt: 'go', cols: 80, rows: 24 })).rejects.toThrow(
      /still cloning/,
    );
    await expect(client.call('zone.bind', { id: zone.id, as: 'repo', path: tempRepo() })).rejects.toThrow(/still cloning/);
    await client.call('zone.cancelClone', { id: zone.id });
  });

  it('removes the zone and what it cloned when the clone is cancelled', async () => {
    const { client, reposDir } = await sourcesDaemon({ cloneDelayMs: 30_000 });
    const events = recordEvents(client);
    const zone = await client.call('zone.clone', { repo: 'acme/app', ...at });

    await client.call('zone.cancelClone', { id: zone.id });

    const removed = await events.waitFor(zoneRemoved(zone.id));
    expect(removed.cloneFailed).toBeUndefined();
    expect(await client.call('zone.list')).toEqual([]);
    expect(existsSync(join(reposDir, 'acme', 'app'))).toBe(false);
  });

  it('removes the zone, and says why, when the clone fails', async () => {
    const { client, reposDir } = await sourcesDaemon();
    const events = recordEvents(client);

    // acme/ops has nothing for the fake gh to clone from.
    const zone = await client.call('zone.clone', { repo: 'acme/ops', ...at });

    const removed = await events.waitFor(zoneRemoved(zone.id));
    expect(removed.cloneFailed).toMatch(/could not clone acme\/ops/i);
    expect(await client.call('zone.list')).toEqual([]);
    expect(existsSync(join(reposDir, 'acme', 'ops'))).toBe(false);
  });

  it('keeps a failed clone\'s zone, unbound, when sessions were moved into it meanwhile', async () => {
    const { client } = await sourcesDaemon({ cloneDelayMs: 1_000 });
    const events = recordEvents(client);
    const zone = await client.call('zone.clone', { repo: 'acme/ops', ...at });
    await client.call('shell.create', { zoneId: zone.id });

    const kept = await events.waitFor(
      (event): event is ZoneUpdatedEvent =>
        event.type === 'zone.updated' && event.zone.id === zone.id && event.zone.clone === null,
    );
    expect(kept.zone).toMatchObject({ kind: 'unbound', repoRoot: null, clone: null });
    expect(kept.cloneFailed).toMatch(/could not clone acme\/ops/i);
  });

  it('refuses a repo gh cannot see, and one whose managed folder is taken, adding no zone', async () => {
    const { client, reposDir } = await sourcesDaemon();
    await expect(client.call('zone.clone', { repo: 'acme/nope', ...at })).rejects.toThrow(/acme\/nope/);
    mkdirSync(join(reposDir, 'acme', 'app'), { recursive: true });
    writeFileSync(join(reposDir, 'acme', 'app', 'notes.txt'), 'mine');
    await expect(client.call('zone.clone', { repo: 'acme/app', ...at })).rejects.toThrow(/already exists/);
    expect(await client.call('zone.list')).toEqual([]);
    expect(existsSync(join(reposDir, 'acme', 'app', 'notes.txt'))).toBe(true);
  });

  it('cancels a clone the daemon was stopped during, and clears one a crashed daemon left', async () => {
    const first = await sourcesDaemon({ cloneDelayMs: 30_000 });
    const zone = await first.client.call('zone.clone', { repo: 'acme/app', ...at });
    await first.daemon.stop();
    expect(existsSync(join(first.reposDir, 'acme', 'app'))).toBe(false);

    // A crashed daemon leaves its row and its half-made clone, in a folder it made.
    const left = join(first.reposDir, 'acme', 'ops');
    mkdirSync(join(left, '.git'), { recursive: true });
    const db = new DatabaseSync(daemonPaths(first.dataDir).database);
    migrate(db);
    db.prepare(
      `INSERT INTO zones (id, name, color, x, y, width, height, clone_repo, clone_path, clone_made_folder, clone_made_owner)
        VALUES ('z2', 'ops', '#4c6ef5', 0, 0, 720, 480, 'acme/ops', ?, 1, 0)`,
    ).run(left);
    db.close();

    const second = await sourcesDaemon({}, { dataDir: first.dataDir, reposDir: first.reposDir });
    expect((await second.client.call('zone.list')).map((z) => z.id)).not.toContain(zone.id);
    expect(await second.client.call('zone.list')).toEqual([]);
    expect(existsSync(left)).toBe(false);
  });

  it('clones into a folder one at a time: a second clone of the repo meanwhile gets the first one\'s zone', async () => {
    const { client, reposDir } = await sourcesDaemon({ cloneDelayMs: 1_500 });
    const events = recordEvents(client);

    const [a, b] = await Promise.all([
      client.call('zone.clone', { repo: 'acme/app', ...at }),
      client.call('zone.clone', { repo: 'Acme/App', x: 900, y: 0 }),
    ]);

    expect(b.id).toBe(a.id);
    await events.waitFor(zoneCloned(a.id));
    expect(await client.call('zone.list')).toEqual([expect.objectContaining({ id: a.id, repoRoot: join(reposDir, 'acme', 'app') })]);
    expect(existsSync(join(reposDir, 'acme', 'app', '.git'))).toBe(true);
    expect(events.events.filter((event) => event.type === 'zone.removed')).toEqual([]);
  });

  it("removes only the folders it made when a clone fails: an empty folder that was there stays, and its owner's too", async () => {
    const { client, reposDir } = await sourcesDaemon();
    const events = recordEvents(client);
    const theirs = join(reposDir, 'acme', 'ops');
    mkdirSync(theirs, { recursive: true });

    const zone = await client.call('zone.clone', { repo: 'acme/ops', ...at });

    await events.waitFor(zoneRemoved(zone.id));
    expect(existsSync(theirs)).toBe(true);
    expect(readdirSync(theirs)).toEqual([]);
  });

  it("removes the owner's folder it made for a failed clone, once nothing else is in it", async () => {
    const { client, reposDir } = await sourcesDaemon();
    const events = recordEvents(client);
    const zone = await client.call('zone.clone', { repo: 'acme/ops', ...at });
    await events.waitFor(zoneRemoved(zone.id));
    expect(existsSync(join(reposDir, 'acme'))).toBe(false);
    expect(existsSync(reposDir)).toBe(true);
  });

  it("binds the zone to another tracker when asked, such as a Linear team's", async () => {
    const { client } = await sourcesDaemon();
    const events = recordEvents(client);
    const zone = await client.call('zone.clone', { repo: 'acme/app', ...at, tracker: { provider: 'linear', scope: 'ACME' } });
    expect(zone.tracker).toEqual({ provider: 'linear', scope: 'ACME' });
    await events.waitFor(zoneCloned(zone.id));
  });

  it('refuses a repo whose name would leave the repos folder, before asking gh', async () => {
    const { client, github } = await sourcesDaemon();
    for (const repo of ['../x', 'acme/..', './x', '-flag/x', 'acme/app/more']) {
      await expect(client.call('zone.clone', { repo, ...at })).rejects.toThrow(/owner\/repo/);
    }
    expect(github.calls()).toEqual([]);
  });
});

describe('isSafeRepo and shortFailure', () => {
  it('takes owner/repo with plain names only', () => {
    expect(isSafeRepo('acme/app.js')).toBe(true);
    expect(isSafeRepo('a-b/c_d')).toBe(true);
    for (const repo of ['..', 'acme/..', '../app', 'acme/.', '-x/app', 'acme/-x', 'acme', 'a/b/c', 'a b/c']) {
      expect(isSafeRepo(repo), repo).toBe(false);
    }
  });

  it("keeps a failure's first line, cut short", () => {
    expect(shortFailure('\nfatal: no\nmore detail')).toBe('fatal: no');
    expect(shortFailure('x'.repeat(500))).toHaveLength(240);
  });
});

describe('deleting a zone made from a GitHub clone', () => {
  async function clonedZone() {
    const world = await sourcesDaemon();
    const events = recordEvents(world.client);
    const zone = await world.client.call('zone.clone', { repo: 'acme/app', ...at });
    const done = await events.waitFor(zoneCloned(zone.id));
    return { ...world, events, zone: done.zone, path: join(world.reposDir, 'acme', 'app') };
  }

  it('says the zone is a managed clone, and a zone bound to any other repo is not', async () => {
    const { client, zone } = await clonedZone();
    const other = await client.call('zone.add', { path: tempRepo('mine'), ...at });
    expect(zone.managedClone).toBe(true);
    expect(other.managedClone).toBe(false);
  });

  it('takes the zone off the board and keeps the clone on disk', async () => {
    const { client, zone, path, events } = await clonedZone();
    await client.call('zone.dissolve', { id: zone.id });
    await events.waitFor(zoneRemoved(zone.id));
    expect(await client.call('zone.list')).toEqual([]);
    expect(existsSync(join(path, 'apps', 'web', 'index.ts'))).toBe(true);
  });

  it('deletes the clone too when asked, and the owner folder the clones were in once it is empty', async () => {
    const { client, zone, path, reposDir } = await clonedZone();
    await client.call('zone.dissolve', { id: zone.id, deleteClone: true });
    expect(await client.call('zone.list')).toEqual([]);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(reposDir, 'acme'))).toBe(false);
    expect(existsSync(reposDir)).toBe(true);
  });

  it('keeps the clone while a worktree with its own branch is linked to it, as a kept one is, and deletes it once that is gone', async () => {
    const { client, zone, path } = await clonedZone();
    const kept = join(tempDataDir(), 'kept-worktree');
    git(path, 'worktree', 'add', '-q', '-b', 'agent/kept', kept);
    await expect(client.call('zone.dissolve', { id: zone.id, deleteClone: true })).rejects.toThrow(/still has a worktree/);
    expect(await client.call('zone.list')).toEqual([zone]);
    expect(existsSync(path)).toBe(true);
    git(path, 'worktree', 'remove', '--force', kept);
    expect(await client.call('zone.dissolve', { id: zone.id, deleteClone: true })).toEqual({ cloneError: null });
    expect(existsSync(path)).toBe(false);
  });

  it('keeps the clone while a kept worktree has gone missing, moved or on a volume that is not mounted, and never prunes it', async () => {
    const { client, zone, path } = await clonedZone();
    const kept = join(tempDataDir(), 'kept-worktree');
    git(path, 'worktree', 'add', '-q', '-b', 'agent/kept', kept);
    renameSync(kept, `${kept}-moved`);
    await expect(client.call('zone.dissolve', { id: zone.id, deleteClone: true })).rejects.toThrow(/still has a worktree/);
    expect(existsSync(path)).toBe(true);
    // Asking did not forget it: it is still registered, and its branch is still there.
    expect(git(path, 'worktree', 'list', '--porcelain')).toContain(kept);
    expect(git(path, 'branch', '--list', 'agent/kept')).toContain('agent/kept');
  });

  it('keeps the clone when git cannot say what worktrees it has', async () => {
    const { client, zone, path } = await clonedZone();
    writeFileSync(join(path, '.git', 'HEAD'), 'garbage\n');
    await expect(client.call('zone.dissolve', { id: zone.id, deleteClone: true })).rejects.toThrow(/could not list the worktrees|worktree/);
    expect(existsSync(path)).toBe(true);
    expect(await client.call('zone.list')).toHaveLength(1);
  });

  it('keeps the clone while another zone is on it, and says which', async () => {
    const { client, zone, path } = await clonedZone();
    const folder = await client.call('zone.add', { path: join(path, 'apps', 'web'), ...at, name: 'Web' });
    await expect(client.call('zone.dissolve', { id: zone.id, deleteClone: true })).rejects.toThrow(/Web is on .* clone too/);
    expect(existsSync(path)).toBe(true);
    await client.call('zone.dissolve', { id: folder.id });
    await client.call('zone.dissolve', { id: zone.id, deleteClone: true });
    expect(existsSync(path)).toBe(false);
  });

  it("never touches the folder of a zone that is not a managed clone, even when asked to delete the clone", async () => {
    const { client } = await sourcesDaemon();
    const repo = tempRepo('mine');
    const zone = await client.call('zone.add', { path: repo, ...at });
    await expect(client.call('zone.dissolve', { id: zone.id, deleteClone: true })).rejects.toThrow(/not a clone/);
    expect(await client.call('zone.list')).toEqual([zone]);
    await client.call('zone.dissolve', { id: zone.id });
    expect(await client.call('zone.list')).toEqual([]);
    expect(existsSync(join(repo, '.git'))).toBe(true);
  });
});
