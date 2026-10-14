import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { DaemonRpcError } from '../src/client.ts';
import { RPC_ERROR } from '../src/protocol.ts';
import { connectTestClient, startTestDaemon, tempDataDir } from './helpers.ts';

/** A fresh git repo named `name` with an `apps/web` folder, removed when the test ends. */
function tempRepo(name = 'monorepo'): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'ab-repo-')));
  onTestFinished(() => rmSync(parent, { recursive: true, force: true }));
  const repo = join(parent, name);
  mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
  execFileSync('git', ['init', '--quiet', repo]);
  return repo;
}

function tempPlainFolder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-plain-')));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const at = { x: 40, y: 80 };

describe('zones over the socket', () => {
  it('adds a git root as a repo zone named after the repo', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const repo = tempRepo('monorepo');

    const zone = await client.call('zone.add', { path: repo, ...at });

    expect(zone).toMatchObject({ kind: 'repo', repoRoot: repo, folder: '', name: 'monorepo', x: 40, y: 80 });
    expect(zone.width).toBeGreaterThan(0);
    expect(zone.height).toBeGreaterThan(0);
    expect(zone.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(await client.call('zone.list')).toEqual([zone]);
  });

  it('adds a folder inside a repo as a folder zone tied to that repo', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const repo = tempRepo('monorepo');

    const zone = await client.call('zone.add', { path: join(repo, 'apps', 'web'), ...at });

    expect(zone).toMatchObject({ kind: 'folder', repoRoot: repo, folder: 'apps/web', name: 'monorepo/apps/web' });
  });

  it('resolves a picked path through symlinks to the repo it lives in', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const repo = tempRepo();
    const link = join(tempPlainFolder(), 'link');
    execFileSync('ln', ['-s', join(repo, 'apps'), link]);

    const zone = await client.call('zone.add', { path: link, ...at });

    expect(zone).toMatchObject({ kind: 'folder', repoRoot: repo, folder: 'apps' });
  });

  it('rejects a folder that is not in a git repo, with a message saying so', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const plain = tempPlainFolder();

    const error = await client.call('zone.add', { path: plain, ...at }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DaemonRpcError);
    expect(error).toMatchObject({ code: RPC_ERROR.invalidParams });
    expect((error as Error).message).toBe(`${plain} is not inside a git repository`);
    expect(await client.call('zone.list')).toEqual([]);
  });

  it('rejects a path that is missing or is not a folder', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const repo = tempRepo();
    writeFileSync(join(repo, 'README.md'), '');

    await expect(client.call('zone.add', { path: join(repo, 'nope'), ...at })).rejects.toThrow(/is not a folder/);
    await expect(client.call('zone.add', { path: join(repo, 'README.md'), ...at })).rejects.toThrow(
      /is not a folder/,
    );
  });

  it('rejects malformed params', async () => {
    const client = await connectTestClient(await startTestDaemon());

    await expect(client.call('zone.add', { path: 'relative/path', ...at })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
    await expect(client.call('zone.add', { path: tempRepo(), x: 'left' } as never)).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
  });

  it('allows two zones on the same repo, each its own zone with its own colour', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const repo = tempRepo();

    const whole = await client.call('zone.add', { path: repo, ...at });
    const web = await client.call('zone.add', { path: join(repo, 'apps', 'web'), x: 900, y: 80 });
    const again = await client.call('zone.add', { path: repo, x: 0, y: 900 });

    expect(new Set([whole.id, web.id, again.id]).size).toBe(3);
    expect(web.color).not.toBe(whole.color);
    expect((await client.call('zone.list')).map((zone) => zone.id)).toEqual([whole.id, web.id, again.id]);
  });

  it('moves and resizes a zone', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const zone = await client.call('zone.add', { path: tempRepo(), ...at });

    const moved = await client.call('zone.update', { id: zone.id, x: -120.5, y: 300, width: 800, height: 500 });

    expect(moved).toEqual({ ...zone, x: -120.5, y: 300, width: 800, height: 500 });
    expect(await client.call('zone.list')).toEqual([moved]);
  });

  it("turns Codex's hook-trust bypass off and on for a zone: on by default", async () => {
    const client = await connectTestClient(await startTestDaemon());
    const zone = await client.call('zone.add', { path: tempRepo(), ...at });
    expect(zone.codexBypassHookTrust).toBe(true);

    const off = await client.call('zone.configure', { id: zone.id, codexBypassHookTrust: false });

    expect(off).toEqual({ ...zone, codexBypassHookTrust: false });
    expect(await client.call('zone.list')).toEqual([off]);
    expect(await client.call('zone.configure', { id: zone.id, codexBypassHookTrust: true })).toEqual(zone);
    await expect(client.call('zone.configure', { id: zone.id, codexBypassHookTrust: 'no' as never })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
    await expect(client.call('zone.configure', { id: 'missing', codexBypassHookTrust: true })).rejects.toThrow(/no zone missing/);
  });

  it('renames and recolours a zone, either alone', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const zone = await client.call('zone.addUnbound', { name: 'Ideas', ...at });

    const renamed = await client.call('zone.setLook', { id: zone.id, name: '  Strays ' });
    expect(renamed).toEqual({ ...zone, name: 'Strays' });
    const recoloured = await client.call('zone.setLook', { id: zone.id, color: '#12B886' });
    expect(recoloured).toEqual({ ...renamed, color: '#12b886' });
    expect(await client.call('zone.list')).toEqual([recoloured]);

    await expect(client.call('zone.setLook', { id: zone.id, name: ' ' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await expect(client.call('zone.setLook', { id: zone.id, color: 'red' })).rejects.toMatchObject({ code: RPC_ERROR.invalidParams });
    await expect(client.call('zone.setLook', { id: 'missing', name: 'x' })).rejects.toThrow(/no zone missing/);
  });

  it('refuses to shrink a zone below the minimum size, or to update a zone that does not exist', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const zone = await client.call('zone.add', { path: tempRepo(), ...at });

    await expect(client.call('zone.update', { id: zone.id, x: 0, y: 0, width: 0, height: 500 })).rejects.toMatchObject(
      { code: RPC_ERROR.invalidParams },
    );
    await expect(client.call('zone.update', { id: 'missing', x: 0, y: 0, width: 800, height: 500 })).rejects.toThrow(
      /no zone missing/,
    );
  });

  it('removes a zone', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const zone = await client.call('zone.add', { path: tempRepo(), ...at });

    await client.call('zone.remove', { id: zone.id });

    expect(await client.call('zone.list')).toEqual([]);
  });

  it('refuses to remove a zone that does not exist, as update does', async () => {
    const client = await connectTestClient(await startTestDaemon());

    await expect(client.call('zone.remove', { id: 'missing' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: 'no zone missing',
    });
  });

  it('keeps zones and their layout across a daemon restart', async () => {
    const dataDir = tempDataDir();
    const repo = tempRepo();
    const first = await startTestDaemon({ dataDir });
    const before = await connectTestClient(first);
    const whole = await before.call('zone.add', { path: repo, ...at });
    const web = await before.call('zone.add', { path: join(repo, 'apps', 'web'), x: 900, y: 80 });
    const moved = await before.call('zone.update', { id: web.id, x: 1000, y: 200, width: 640, height: 420 });
    before.close();
    await first.stop();

    const after = await connectTestClient(await startTestDaemon({ dataDir }));

    expect(await after.call('zone.list')).toEqual([whole, moved]);
  });
});

/** Git's view of `repo`: its top level and the subjects of its commits, newest first. */
function gitLog(repo: string): { toplevel: string; subjects: string[] } {
  const run = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  return { toplevel: realpathSync(run('rev-parse', '--show-toplevel')), subjects: run('log', '--format=%s').split('\n') };
}

/** Writes an executable shell script. */
function script(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/**
 * Points the daemon's git at a temp global config for this test, never the real one. It has hooks from
 * `core.hooksPath` and from `init.templateDir` that fail, and a post-commit hook that leaves `marker` if it ever runs.
 */
function hostileGlobalConfig(): { marker: string } {
  const dir = tempPlainFolder();
  const marker = join(dir, 'post-commit-ran');
  script(join(dir, 'hooks', 'pre-commit'), 'echo "pre-commit: blocked" >&2; exit 1');
  script(join(dir, 'hooks', 'commit-msg'), 'echo "commit-msg: blocked" >&2; exit 1');
  script(join(dir, 'hooks', 'post-commit'), `touch '${marker}'`);
  script(join(dir, 'template', 'hooks', 'pre-commit'), 'exit 1');
  writeFileSync(join(dir, 'template', 'from-template'), '');
  const config = join(dir, 'gitconfig');
  writeFileSync(config, `[core]\n\thooksPath = ${join(dir, 'hooks')}\n[init]\n\ttemplateDir = ${join(dir, 'template')}\n`);
  vi.stubEnv('GIT_CONFIG_GLOBAL', config);
  onTestFinished(() => void vi.unstubAllEnvs());
  return { marker };
}

describe('unbound zones', () => {
  it('adds a zone with only a name and a colour, bound to no repo', async () => {
    const client = await connectTestClient(await startTestDaemon());

    const zone = await client.call('zone.addUnbound', { name: '  Ideas ', color: '#12b886', ...at });

    expect(zone).toMatchObject({ kind: 'unbound', repoRoot: null, folder: '', name: 'Ideas', color: '#12b886', x: 40 });
    expect(await client.call('zone.list')).toEqual([zone]);
  });

  it('picks the least-used colour when none is given, and refuses a blank name or a malformed colour', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const first = await client.call('zone.addUnbound', { name: 'One', ...at });
    const second = await client.call('zone.addUnbound', { name: 'Two', ...at });
    expect(second.color).not.toBe(first.color);

    await expect(client.call('zone.addUnbound', { name: ' ', ...at })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
    await expect(client.call('zone.addUnbound', { name: 'Red', color: 'red', ...at })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
  });

  it('binds as a repo: a git root makes it a repo zone, a folder inside one a folder zone, keeping its name', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const repo = tempRepo('monorepo');
    const ideas = await client.call('zone.addUnbound', { name: 'Ideas', ...at });
    const web = await client.call('zone.addUnbound', { name: 'Web', ...at });

    const boundIdeas = await client.call('zone.bind', { id: ideas.id, as: 'repo', path: repo });
    const boundWeb = await client.call('zone.bind', { id: web.id, as: 'repo', path: join(repo, 'apps', 'web') });

    expect(boundIdeas).toEqual({ ...ideas, kind: 'repo', repoRoot: repo, folder: '' });
    expect(boundWeb).toEqual({ ...web, kind: 'folder', repoRoot: repo, folder: 'apps/web' });
    expect(await client.call('zone.list')).toEqual([boundIdeas, boundWeb]);
  });

  it('refuses to bind to a folder outside git, leaving the zone unbound', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const plain = tempPlainFolder();
    const zone = await client.call('zone.addUnbound', { name: 'Ideas', ...at });

    const error = await client.call('zone.bind', { id: zone.id, as: 'repo', path: plain }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: RPC_ERROR.invalidParams, message: `${plain} is not inside a git repository` });
    expect(await client.call('zone.list')).toEqual([zone]);
  });

  it('opens an empty folder as a new project: a git repo with a first commit, so worktrees work', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const empty = tempPlainFolder();
    const zone = await client.call('zone.addUnbound', { name: 'Ideas', ...at });

    const bound = await client.call('zone.bind', { id: zone.id, as: 'project', path: empty });

    expect(bound).toEqual({ ...zone, kind: 'repo', repoRoot: empty, folder: '' });
    expect(gitLog(empty)).toEqual({ toplevel: empty, subjects: ['Initial commit'] });
  });

  it('opens a folder that does not exist yet as a new project, creating it', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const project = join(tempPlainFolder(), 'new-project');
    const zone = await client.call('zone.addUnbound', { name: 'Ideas', ...at });

    const bound = await client.call('zone.bind', { id: zone.id, as: 'project', path: project });

    expect(bound).toMatchObject({ kind: 'repo', repoRoot: project });
    expect(gitLog(project).subjects).toEqual(['Initial commit']);
  });

  it('refuses to open a folder with files in it as a new project, touching nothing', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const full = tempPlainFolder();
    writeFileSync(join(full, 'notes.md'), '');
    const zone = await client.call('zone.addUnbound', { name: 'Ideas', ...at });

    await expect(client.call('zone.bind', { id: zone.id, as: 'project', path: full })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: `${full} is not empty`,
    });
    expect(await client.call('zone.list')).toEqual([zone]);
    expect(() => execFileSync('git', ['-C', full, 'rev-parse'], { stdio: 'ignore' })).toThrow();
  });

  it("opens a new project without running the user's git hooks or templates", async () => {
    const { marker } = hostileGlobalConfig();
    const client = await connectTestClient(await startTestDaemon());
    const project = join(tempPlainFolder(), 'new-project');
    const zone = await client.call('zone.addUnbound', { name: 'Ideas', ...at });

    const bound = await client.call('zone.bind', { id: zone.id, as: 'project', path: project });

    expect(bound).toMatchObject({ kind: 'repo', repoRoot: project });
    expect(gitLog(project).subjects).toEqual(['Initial commit']);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(project, '.git', 'from-template'))).toBe(false);
  });

  it('leaves nothing behind when it cannot make the first commit: no folder it made, no repo in one it found', async () => {
    // Git refuses to commit with a date it can't read, after it has made the repo.
    vi.stubEnv('GIT_AUTHOR_DATE', 'not a date');
    onTestFinished(() => void vi.unstubAllEnvs());
    const client = await connectTestClient(await startTestDaemon());
    const zone = await client.call('zone.addUnbound', { name: 'Ideas', ...at });
    const missing = join(tempPlainFolder(), 'new-project');
    const empty = tempPlainFolder();

    for (const path of [missing, empty]) {
      await expect(client.call('zone.bind', { id: zone.id, as: 'project', path })).rejects.toMatchObject({
        code: RPC_ERROR.invalidParams,
        message: expect.stringContaining(`can't make a git repo in ${path}`),
      });
    }

    expect(existsSync(missing)).toBe(false);
    expect(readdirSync(empty)).toEqual([]);
    expect(await client.call('zone.list')).toEqual([zone]);
  });

  it('binds to the first of two racing binds, and removes the project the other one made', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const zone = await client.call('zone.addUnbound', { name: 'Ideas', ...at });
    const missing = join(tempPlainFolder(), 'new-project');
    const empty = tempPlainFolder();

    const results = await Promise.allSettled([
      client.call('zone.bind', { id: zone.id, as: 'project', path: missing }),
      client.call('zone.bind', { id: zone.id, as: 'project', path: empty }),
    ]);

    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]!.reason).toMatchObject({ code: RPC_ERROR.invalidParams, message: expect.stringMatching(/is already bound to/) });
    const winner = won[0]!.value.repoRoot!;
    expect(await client.call('zone.list')).toEqual([{ ...zone, kind: 'repo', repoRoot: winner, folder: '' }]);
    expect(gitLog(winner).subjects).toEqual(['Initial commit']);
    if (winner === missing) expect(readdirSync(empty)).toEqual([]);
    else expect(existsSync(missing)).toBe(false);
  });

  it('binds one zone once when two binds race to the same folder, and keeps the repo the winner made', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const zone = await client.call('zone.addUnbound', { name: 'Ideas', ...at });
    const empty = tempPlainFolder();

    const [first, second] = await Promise.allSettled([
      client.call('zone.bind', { id: zone.id, as: 'project', path: empty }),
      client.call('zone.bind', { id: zone.id, as: 'project', path: empty }),
    ]);

    expect(first).toMatchObject({ status: 'fulfilled', value: { kind: 'repo', repoRoot: empty } });
    expect(second).toMatchObject({ status: 'rejected', reason: { message: `zone ${zone.id} is already bound to ${empty}` } });
    expect(gitLog(empty)).toEqual({ toplevel: empty, subjects: ['Initial commit'] });
  });

  it('opens one folder as a project for only one of two zones racing to it, and keeps its repo', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const one = await client.call('zone.addUnbound', { name: 'One', ...at });
    const two = await client.call('zone.addUnbound', { name: 'Two', ...at });
    const empty = tempPlainFolder();

    const [first, second] = await Promise.allSettled([
      client.call('zone.bind', { id: one.id, as: 'project', path: empty }),
      client.call('zone.bind', { id: two.id, as: 'project', path: empty }),
    ]);

    expect(first).toMatchObject({ status: 'fulfilled', value: { repoRoot: empty } });
    expect(second).toMatchObject({ status: 'rejected', reason: { message: `${empty} is not empty` } });
    expect(gitLog(empty)).toEqual({ toplevel: empty, subjects: ['Initial commit'] });
    expect((await client.call('zone.list')).map((zone) => zone.repoRoot)).toEqual([empty, null]);
  });

  it('removes the project it made for a zone that was removed while it was making it', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const zone = await client.call('zone.addUnbound', { name: 'Ideas', ...at });
    const empty = tempPlainFolder();

    const [bind, remove] = await Promise.allSettled([
      client.call('zone.bind', { id: zone.id, as: 'project', path: empty }),
      client.call('zone.remove', { id: zone.id }),
    ]);

    expect(remove.status).toBe('fulfilled');
    expect(bind).toMatchObject({ status: 'rejected', reason: { message: expect.stringMatching(/no zone/) } });
    expect(readdirSync(empty)).toEqual([]);
    expect(await client.call('zone.list')).toEqual([]);
  });

  it('binds only once: a bound zone, an unknown zone and malformed params are refused', async () => {
    const client = await connectTestClient(await startTestDaemon());
    const repo = tempRepo();
    const bound = await client.call('zone.add', { path: repo, ...at });

    await expect(client.call('zone.bind', { id: bound.id, as: 'repo', path: repo })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
      message: `zone ${bound.id} is already bound to ${repo}`,
    });
    await expect(client.call('zone.bind', { id: 'missing', as: 'repo', path: repo })).rejects.toThrow(/no zone missing/);
    const zone = await client.call('zone.addUnbound', { name: 'Ideas', ...at });
    await expect(client.call('zone.bind', { id: zone.id, as: 'nothing' as never, path: repo })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
    await expect(client.call('zone.bind', { id: zone.id, as: 'repo', path: 'relative' })).rejects.toMatchObject({
      code: RPC_ERROR.invalidParams,
    });
  });

  it('keeps unbound zones across a daemon restart', async () => {
    const dataDir = tempDataDir();
    const first = await startTestDaemon({ dataDir });
    const before = await connectTestClient(first);
    const zone = await before.call('zone.addUnbound', { name: 'Ideas', ...at });
    before.close();
    await first.stop();

    const after = await connectTestClient(await startTestDaemon({ dataDir }));

    expect(await after.call('zone.list')).toEqual([zone]);
  });
});
