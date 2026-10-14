import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isSafeRepo, shortFailure } from '../src/zone-sources.ts';
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
      { repo: 'acme/app', name: 'app', description: 'The app', localPath: null, clonePath: join(reposDir, 'acme', 'app'), onBoard: false },
      { repo: 'acme/ops', name: 'ops', description: null, localPath: local, clonePath: join(reposDir, 'acme', 'ops'), onBoard: true },
    ]);
    expect(zone.repoRoot).toBe(local);
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
