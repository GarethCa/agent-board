import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { cloneRepo, parseCloneProgress, type CloneProgress } from '../src/clone.ts';
import { GhError } from '../src/gh.ts';
import { createFakeGitHub, FAKE_GITHUB_STATE, type FakeGitHubState } from '../src/testing.ts';

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-clone-')));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A git repo with one commit, to clone from. */
function sourceRepo(): string {
  const repo = join(tempDir(), 'source');
  mkdirSync(repo);
  writeFileSync(join(repo, 'README.md'), '# app\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial');
  return repo;
}

function fakeGitHub(state: Partial<FakeGitHubState>) {
  const github = createFakeGitHub({ ...FAKE_GITHUB_STATE, ...state });
  onTestFinished(github.dispose);
  return github;
}

describe('cloneRepo', () => {
  it("clones a repo through gh into a new folder, reporting git's progress", async () => {
    const from = sourceRepo();
    const github = fakeGitHub({ repos: [{ nameWithOwner: 'acme/app', description: null, cloneFrom: from }] });
    const dir = join(tempDir(), 'acme', 'app');
    const progress: CloneProgress[] = [];

    await cloneRepo('acme/app', dir, { gh: github.gh, onProgress: (p) => progress.push(p) });

    expect(existsSync(join(dir, 'README.md'))).toBe(true);
    expect(github.calls().map((call) => call.args)).toEqual([['repo', 'clone', 'acme/app', dir, '--', '--progress']]);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => p.percent === null || (p.percent >= 0 && p.percent <= 100))).toBe(true);
  });

  it('fails with what gh said for a repo it cannot clone', async () => {
    const github = fakeGitHub({});
    const dir = join(tempDir(), 'nope');

    const error = await cloneRepo('acme/nope', dir, { gh: github.gh }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GhError);
    expect((error as GhError).message).toContain("Could not resolve to a Repository with the name 'acme/nope'");
  });

  it('stops the clone when cancelled, and rejects with an AbortError', async () => {
    const from = sourceRepo();
    const github = fakeGitHub({
      repos: [{ nameWithOwner: 'acme/app', description: null, cloneFrom: from }],
      cloneDelayMs: 30_000,
    });
    const dir = join(tempDir(), 'app');
    const controller = new AbortController();
    const started = Date.now();

    const cloning = cloneRepo('acme/app', dir, {
      gh: github.gh,
      signal: controller.signal,
      // The fake reports progress before it waits: cancel once the clone is under way.
      onProgress: () => controller.abort(),
    });

    await expect(cloning).rejects.toMatchObject({ name: 'AbortError' });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(existsSync(join(dir, 'README.md'))).toBe(false);
  });

  it('rejects at once for a signal already aborted, without running gh', async () => {
    const github = fakeGitHub({});
    const controller = new AbortController();
    controller.abort();
    await expect(cloneRepo('acme/app', join(tempDir(), 'app'), { gh: github.gh, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(github.calls()).toEqual([]);
  });
});

describe('parseCloneProgress', () => {
  it("reads git's progress lines", () => {
    expect(parseCloneProgress('Receiving objects:  64% (2817/4402), 38.21 MiB | 9.4 MiB/s')).toEqual({
      phase: 'Receiving objects',
      percent: 64,
    });
    expect(parseCloneProgress('remote: Counting objects: 100% (12/12), done.')).toEqual({
      phase: 'Counting objects',
      percent: 100,
    });
    expect(parseCloneProgress("Cloning into '/tmp/app'...")).toEqual({ phase: 'Cloning', percent: null });
    expect(parseCloneProgress('')).toBeUndefined();
  });
});
