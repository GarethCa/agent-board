// Agents in a new folder or a brand-new repo: a zone on a folder outside git runs its agents in that folder itself, and a
// repo with no commits yet gives each agent a worktree on a branch of its own with no commits (or, where git is too old
// for that, its own checkout). Nothing here ever makes a commit in the user's repo.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join, relative } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { fakeHarnessEnv } from '@agent-board/fake-harness';
import * as gitModule from '../src/git.ts';
import { createGitHubTracker } from '@agent-board/tracker';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '@agent-board/tracker/testing';
import { RPC_ERROR, zoneSnapshot, type DaemonEvent, type HookEvent, type ZoneUpdatedEvent } from '../src/protocol.ts';
import { connectTestClient, git, recordEvents, startTestDaemon, tempDataDir } from './helpers.ts';

vi.mock('../src/git.ts', async (importOriginal) => {
  const original = await importOriginal<typeof gitModule>();
  return { ...original, runGit: vi.fn(original.runGit) };
});

const SIZE = { cols: 120, rows: 40 };
const at = { x: 40, y: 80, width: 600, height: 400 };

/** The folders git was run in since the test started. */
const gitDirs = () => vi.mocked(gitModule.runGit).mock.calls.map(([dir]) => dir);
/** Whether `dir` is `folder` or inside it. */
const within = (dir: string, folder: string) => !relative(folder, dir).startsWith('..');

/** A new, empty folder of the user's, outside any git repo. */
function plainFolder(name = 'notes'): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ab-plain-')));
  onTestFinished(() => rmSync(parent, { recursive: true, force: true }));
  const folder = join(parent, name);
  mkdirSync(folder);
  return folder;
}

/** A repo just made with `git init`: no commits yet, so its HEAD names a branch that doesn't exist. */
function freshRepo(name = 'fresh'): string {
  const folder = plainFolder(name);
  git(folder, 'init', '--quiet');
  return folder;
}

/** Whether the repo has a commit yet. */
const hasCommit = (repo: string) => {
  try {
    git(repo, 'rev-parse', '--verify', '--quiet', 'HEAD');
    return true;
  } catch {
    return false;
  }
};

/** Whether the git at `path` can add a worktree on a new branch with no commits. */
function canAddOrphan(path: string): boolean {
  try {
    execFileSync(path, ['worktree', 'add', '-h'], { encoding: 'utf8', stdio: 'pipe' });
    return false;
  } catch (error) {
    // `-h` prints its usage and exits 129.
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
    return `${stdout}${stderr}`.includes('--orphan');
  }
}

const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
/** A git on this machine that can add a worktree with no commits, if there is one. */
const orphanCapable = [realGit, '/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'].find((path) => existsSync(path) && canAddOrphan(path));

/** Puts `bin` first on PATH for the rest of the test, so the daemon's git is the one there. */
function gitFrom(bin: string) {
  const before = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${before ?? ''}`;
  onTestFinished(() => {
    process.env.PATH = before;
  });
}

/** A git that can add a worktree with no commits, first on PATH. */
function newGit() {
  const bin = tempDataDir();
  symlinkSync(orphanCapable!, join(bin, 'git'));
  gitFrom(bin);
}

/** A git too old to add a worktree with no commits, first on PATH: it says it is 2.38, and refuses `--orphan`. */
function oldGit() {
  const bin = tempDataDir();
  const script = join(bin, 'git');
  writeFileSync(
    script,
    `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "--version" ]; then echo "git version 2.38.1"; exit 0; fi\n  if [ "$arg" = "--orphan" ]; then echo "error: unknown option \\\`orphan'" >&2; exit 129; fi\ndone\nexec ${JSON.stringify(realGit)} "$@"\n`,
  );
  chmodSync(script, 0o755);
  gitFrom(bin);
}

async function setup(dataDir = tempDataDir(), scenario: 'waiting' | 'orchestrate' = 'waiting') {
  vi.mocked(gitModule.runGit).mockClear();
  const daemon = await startTestDaemon({
    dataDir,
    worktreesDir: tempDataDir(),
    agentEnv: fakeHarnessEnv({ scenario, home: tempDataDir(), idleNotifyMs: 200 }),
  });
  const client = await connectTestClient(daemon);
  const recorder = recordEvents(client);
  return { daemon, client, recorder, dataDir };
}

/** Commits a file on the branch checked out in `worktree`, as an agent's work would. */
function commitWork(worktree: string, file = 'work.md') {
  writeFileSync(join(worktree, file), 'the work\n');
  git(worktree, 'add', file);
  git(worktree, '-c', 'user.name=T', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'the work');
}

/** The empty tree, which a branch begun in a repo with no commits is compared with. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** An orchestrator in a zone of a repo with no commits, in its own checkout, and a connection as it. */
async function leadIn(repo: string) {
  const ctx = await setup(tempDataDir(), 'orchestrate');
  const zone = await ctx.client.call('zone.add', { path: repo, ...at });
  await ctx.client.call('zone.configure', { id: zone.id, agentsOrchestrate: true });
  const agent = await ctx.client.call('agent.spawn', { zoneId: zone.id, role: 'orchestrator', orchestrate: 'zone', checkout: 'main', noTemplate: true, prompt: 'Print your board identity', ...SIZE });
  await ctx.client.call('session.attach', { sessionId: agent.sessionId });
  await ctx.recorder.waitForText(agent.sessionId, ':end\r\n');
  const token = /identity:(.*):end\r\n/.exec(ctx.recorder.screenText(agent.sessionId))![1]!;
  const connection = await connectTestClient(ctx.daemon);
  await connection.call('board.identify', { token });
  return { ...ctx, zone, token, connection };
}

describe('a zone on a folder outside git', () => {
  it('is checked as a plain folder, with no repo', async () => {
    const { client } = await setup();
    const folder = plainFolder('notes');

    expect(await client.call('zone.checkFolder', { path: folder })).toEqual({ path: folder, repoRoot: null, gitHubRepo: null, name: 'notes' });
    // A copy of a GitHub repo must still be one.
    await expect(client.call('zone.checkFolder', { path: folder, repo: 'acme/app' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringContaining('is not a git repo, so not a copy of acme/app'),
    });
  });

  it('is never a repo git can’t read: a bare repo or a broken .git is refused, saying why', async () => {
    const { client } = await setup();
    const bare = plainFolder('bare.git');
    git(bare, 'init', '--quiet', '--bare');
    const broken = plainFolder('broken');
    writeFileSync(join(broken, '.git'), 'gitdir: /nowhere/at/all\n');

    for (const path of [bare, broken]) {
      for (const method of ['zone.add', 'zone.checkFolder'] as const) {
        await expect(client.call(method, { path, ...at })).rejects.toMatchObject({
          code: RPC_ERROR.invalidParams,
          message: expect.stringContaining(`git can't read ${path} as a repo:`),
        });
      }
    }
    expect(await client.call('zone.list')).toEqual([]);
  });

  it('is a group whose own folder is that folder, named after it', async () => {
    const { client } = await setup();
    const folder = plainFolder('notes');

    const zone = await client.call('zone.add', { path: folder, ...at });

    expect(zone).toMatchObject({ kind: 'unbound', repoRoot: null, defaultRepo: null, groupFolder: folder, name: 'notes' });
    expect(await client.call('zone.recentFolders')).toEqual([]);
  });

  it('starts an agent in the folder itself on the first try: no worktree, branch or git run there', async () => {
    const { client } = await setup();
    const folder = plainFolder('notes');
    const zone = await client.call('zone.add', { path: folder, ...at });
    // Adding the zone asked git whether the folder is in a repo; nothing after may run git there.
    vi.mocked(gitModule.runGit).mockClear();

    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Write it up', ...SIZE });

    expect(agent).toMatchObject({ plainFolder: true, ownsWorktree: false, branch: '', worktree: folder, repoRoot: folder, cwd: folder });
    expect(existsSync(join(folder, '.git'))).toBe(false);
    expect(gitDirs().filter((dir) => within(dir, folder))).toEqual([]);
  });

  it('keeps its agents as plain-folder ones across a restart, resumes them there, and leaves the folder when one is deleted', async () => {
    const dataDir = tempDataDir();
    const before = await setup(dataDir);
    const folder = plainFolder('notes');
    const zone = await before.client.call('zone.add', { path: folder, ...at });
    const agent = await before.client.call('agent.spawn', { zoneId: zone.id, prompt: 'Write it up', ...SIZE });
    writeFileSync(join(folder, 'notes.md'), 'kept\n');
    await before.daemon.stop();

    const after = await setup(dataDir);
    expect((await after.client.call('agent.list')).find((one) => one.sessionId === agent.sessionId)).toMatchObject({ plainFolder: true });
    // It starts again where it was.
    expect(await after.client.call('agent.resume', { sessionId: agent.sessionId })).toMatchObject({ plainFolder: true, worktree: folder });
    await after.client.call('agent.delete', { sessionId: agent.sessionId, force: true });
    expect(existsSync(join(folder, 'notes.md'))).toBe(true);
    expect(gitDirs().filter((dir) => within(dir, folder))).toEqual([]);
  });

  it('is refused as an agent’s repo, saying how to run agents in it', async () => {
    const { client } = await setup();
    const folder = plainFolder('notes');

    await expect(client.call('agent.spawn', { zoneId: null, position: at, repo: { path: folder }, prompt: 'Go', ...SIZE })).rejects.toMatchObject({
      message: `${folder} is not in a git repo: add a zone for it to run agents there outside git, or pick a repo`,
    });
  });

  it('takes no branch, base branch or reviewer role, saying what to do instead', async () => {
    const { client } = await setup();
    const zone = await client.call('zone.add', { path: plainFolder('notes'), ...at });

    for (const asked of [{ branch: 'mine' }, { baseBranch: 'main' }, { role: 'reviewer' }]) {
      await expect(client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', ...asked, ...SIZE })).rejects.toMatchObject({
        code: RPC_ERROR.invalidParams,
        message: expect.stringContaining('notes has no repo'),
      });
    }
  });

  it.skipIf(orphanCapable === undefined)('becomes a repo zone with no commits when made a git repo, and its agents then get worktrees', async () => {
    newGit();
    const { client } = await setup();
    const folder = plainFolder('notes');
    const zone = await client.call('zone.add', { path: folder, ...at });
    const before = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Write it up', ...SIZE });

    const made = await client.call('zone.initRepo', { id: zone.id });

    expect(made).toMatchObject({ kind: 'repo', repoRoot: folder, folder: '', groupFolder: null, userFolder: false });
    expect(existsSync(join(folder, '.git'))).toBe(true);
    expect(hasCommit(folder)).toBe(false);
    // The agent already there stays one of the folder; a new one gets a worktree of its own.
    expect((await client.call('agent.list')).find((one) => one.sessionId === before.sessionId)).toMatchObject({ plainFolder: true, worktree: folder });
    const after = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Start it', ...SIZE });
    expect(after).toMatchObject({ plainFolder: false, ownsWorktree: true, repoRoot: folder });
    expect(after.worktree).not.toBe(folder);
    expect(hasCommit(folder)).toBe(false);
  });

  it('says a folder that has gone can’t be made a git repo', async () => {
    const { client } = await setup();
    const folder = plainFolder('notes');
    const zone = await client.call('zone.add', { path: folder, ...at });
    rmSync(folder, { recursive: true });

    await expect(client.call('zone.initRepo', { id: zone.id })).rejects.toMatchObject({ message: `${folder} is gone: add a zone for the folder where it is now` });
  });

  it('comes back with its folder when a delete is undone, or with the app’s if the folder is a repo by then', async () => {
    const { client } = await setup();
    const folder = plainFolder('notes');
    const zone = await client.call('zone.add', { path: folder, ...at });

    await client.call('zone.remove', { id: zone.id });
    expect(await client.call('zone.restore', zoneSnapshot(zone))).toMatchObject({ kind: 'unbound', groupFolder: folder, userFolder: true });

    await client.call('zone.remove', { id: zone.id });
    git(folder, 'init', '--quiet');
    expect(await client.call('zone.restore', zoneSnapshot(zone))).toMatchObject({ kind: 'unbound', userFolder: false, groupFolder: expect.not.stringContaining(folder) });
  });

  it('refuses to make a git repo of a zone that has one, or of a group with no folder of the user’s', async () => {
    const { client } = await setup();
    const group = await client.call('zone.addUnbound', { name: 'Local Banking', ...at });
    const repo = await client.call('zone.add', { path: freshRepo('fresh'), ...at });

    await expect(client.call('zone.initRepo', { id: group.id })).rejects.toMatchObject({ message: expect.stringContaining('Local Banking has no folder of yours') });
    await expect(client.call('zone.initRepo', { id: repo.id })).rejects.toMatchObject({ message: expect.stringContaining('fresh is a git repo already') });
  });
});

describe('a repo with no commits yet', () => {
  it('can be a zone', async () => {
    const { client } = await setup();
    const repo = freshRepo('fresh');

    expect(await client.call('zone.add', { path: repo, ...at })).toMatchObject({ kind: 'repo', repoRoot: repo, name: 'fresh' });
  });

  it.skipIf(orphanCapable === undefined)('gives an agent a worktree on a new branch with no commits, and makes no commit', async () => {
    newGit();
    const { client } = await setup();
    const repo = freshRepo('fresh');
    const zone = await client.call('zone.add', { path: repo, ...at });

    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Start it', ...SIZE });

    expect(agent).toMatchObject({ ownsWorktree: true, plainFolder: false, repoRoot: repo });
    expect(agent.branch).not.toBe('');
    expect(agent.worktree).not.toBe(repo);
    expect(git(agent.worktree, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${agent.branch}`);
    expect(hasCommit(repo)).toBe(false);
    expect(hasCommit(agent.worktree)).toBe(false);

    // Deleting it removes its worktree, as for any agent.
    await client.call('agent.delete', { sessionId: agent.sessionId, force: true });
    expect(existsSync(agent.worktree)).toBe(false);
  });

  it('runs an agent in the repo’s own checkout where git is too old for a worktree with no commits', async () => {
    oldGit();
    const { client } = await setup();
    const repo = freshRepo('fresh');
    const zone = await client.call('zone.add', { path: repo, ...at });

    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Start it', ...SIZE });

    expect(agent).toMatchObject({ ownsWorktree: false, plainFolder: false, branch: '', worktree: repo, repoRoot: repo });
    expect(hasCommit(repo)).toBe(false);
  });

  it('refuses a base branch, saying it has no commits yet', async () => {
    const { client } = await setup();
    const zone = await client.call('zone.add', { path: freshRepo('fresh'), ...at });

    await expect(client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', baseBranch: 'main', ...SIZE })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: expect.stringMatching(/fresh has no commits yet: .*first commit/),
    });
  });

  it.skipIf(orphanCapable === undefined)('refuses a reviewer of an agent that has made no commit, saying why', async () => {
    newGit();
    const { client } = await setup();
    const zone = await client.call('zone.add', { path: freshRepo('fresh'), ...at });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Start it', ...SIZE });

    await expect(client.call('agent.spawn', { zoneId: zone.id, role: 'reviewer', baseBranch: agent.branch, prompt: 'Review it', ...SIZE })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: 'fresh has no commits yet: there is nothing to start from until it has a first commit',
    });
    await expect(client.call('review.start', { sessionId: agent.sessionId, ...SIZE })).rejects.toMatchObject({
      message: 'fresh has no commits yet: there is nothing to start from until it has a first commit',
    });
  });

  it('refuses a branch by name where git is too old for one with no commits, rather than dropping it', async () => {
    oldGit();
    const { client } = await setup();
    const zone = await client.call('zone.add', { path: freshRepo('fresh'), ...at });

    await expect(client.call('agent.spawn', { zoneId: zone.id, prompt: 'Go', branch: 'mine', ...SIZE })).rejects.toMatchObject({
      message: expect.stringMatching(/^fresh has no commits yet, and this git is too old .* update git/),
    });
  });

  it('runs an orchestrator’s crew member in the repo’s own checkout where git is too old for a worktree with no commits', async () => {
    oldGit();
    const repo = freshRepo('fresh');
    const { connection, token } = await leadIn(repo);

    const crew = await connection.call('orchestrator.spawn', { token, name: 'first', prompt: 'Start it' });

    expect(crew).toMatchObject({ ownsWorktree: false, branch: '', worktree: repo, repoRoot: repo });
    expect(hasCommit(repo)).toBe(false);
  });

  it.skipIf(orphanCapable === undefined)('reviews all of a branch begun with no commits, against the empty tree', async () => {
    newGit();
    const { client, recorder } = await setup();
    const zone = await client.call('zone.add', { path: freshRepo('fresh'), ...at });
    const agent = await client.call('agent.spawn', { zoneId: zone.id, name: 'Coder', prompt: 'Start it', ...SIZE });
    commitWork(agent.worktree);

    const round = await client.call('review.start', { sessionId: agent.sessionId });

    const prompt = (
      await recorder.waitFor(
        (e): e is HookEvent => e.type === 'hook' && e.sessionId === round.reviewer && e.payload.hook_event_name === 'UserPromptSubmit',
      )
    ).payload.prompt as string;
    expect(prompt).toContain(`git diff ${EMPTY_TREE} HEAD`);
    expect(prompt).not.toContain('...HEAD');
    // What it is told to compare with is there to compare with, in its own worktree.
    const reviewer = (await client.call('agent.list')).find((one) => one.sessionId === round.reviewer)!;
    expect(git(reviewer.worktree, 'diff', '--name-only', EMPTY_TREE, 'HEAD')).toBe('work.md');
  });

  it.skipIf(orphanCapable === undefined)('lets an orchestrator start a reviewer from a crew member’s branch begun with no commits', async () => {
    newGit();
    const repo = freshRepo('fresh');
    const { connection, token } = await leadIn(repo);
    const crew = await connection.call('orchestrator.spawn', { token, name: 'first', prompt: 'Start it' });
    commitWork(crew.worktree);

    const reviewer = await connection.call('orchestrator.spawn', { token, name: 'review', role: 'reviewer', baseBranch: crew.branch, prompt: 'Review it' });

    expect(reviewer).toMatchObject({ reviews: { branch: crew.branch, head: git(crew.worktree, 'rev-parse', 'HEAD') } });
    // Project config on such a branch differs from a repo with none, so it is the user's to start.
    commitWork(crew.worktree, '.mcp.json');
    await expect(connection.call('orchestrator.spawn', { token, name: 'review 2', role: 'reviewer', baseBranch: crew.branch, prompt: 'Review it' })).rejects.toMatchObject({
      message: expect.stringContaining('project config differs'),
    });
  });

  it('can be cloned as a new zone, and its agents start there', async () => {
    oldGit();
    const source = freshRepo('empty');
    const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, repos: [{ nameWithOwner: 'acme/empty', description: null, cloneFrom: source }] });
    onTestFinished(github.dispose);
    const daemon = await startTestDaemon({
      dataDir: tempDataDir(),
      worktreesDir: tempDataDir(),
      reposDir: join(tempDataDir(), 'repos'),
      trackers: { github: () => createGitHubTracker({ gh: github.gh }) },
      gh: github.gh,
      agentEnv: fakeHarnessEnv({ scenario: 'waiting', home: tempDataDir() }),
    });
    const client = await connectTestClient(daemon);
    const events = recordEvents(client);

    const zone = await client.call('zone.clone', { repo: 'acme/empty', ...at });
    const cloned = await events.waitFor(
      (event: DaemonEvent): event is ZoneUpdatedEvent => event.type === 'zone.updated' && event.zone.id === zone.id && event.zone.kind === 'repo',
    );
    const agent = await client.call('agent.spawn', { zoneId: zone.id, prompt: 'Start it', ...SIZE });

    expect(basename(cloned.zone.repoRoot!)).toBe('empty');
    expect(agent).toMatchObject({ repoRoot: cloned.zone.repoRoot });
    expect(hasCommit(cloned.zone.repoRoot!)).toBe(false);
  });
});
