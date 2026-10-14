import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { assertCoreConfigUnchanged, coreConfigOf, leakedGitVars, scrubGitEnv } from '../src/index.ts';
import { removeTempDirs, tempDir } from './run-fake.ts';

afterAll(removeTempDirs);

/** A helper as the suites write them: git run in `cwd` with whatever env it is handed. */
function initBare(cwd: string, env: NodeJS.ProcessEnv): void {
  execFileSync('git', ['-C', cwd, 'init', '--quiet', '--bare'], { env, stdio: 'ignore' });
}

function newRepo(): string {
  const repo = tempDir('git-guard-repo-');
  execFileSync('git', ['init', '--quiet', repo], { env: scrubGitEnv({ ...process.env }), stdio: 'ignore' });
  return repo;
}

describe('git guard', () => {
  it('starts the worker with no repo-locating variables', () => {
    expect(leakedGitVars(process.env)).toEqual([]);
  });

  it('refuses a helper that hands git a GIT_DIR, which would turn the dev repo bare', () => {
    const repo = newRepo();
    const elsewhere = tempDir('git-guard-elsewhere-');
    const before = coreConfigOf(repo);

    expect(() => initBare(elsewhere, { ...process.env, GIT_DIR: `${repo}/.git` })).toThrow(/GIT_DIR/);
    expect(() => execFileSync('sh', ['-c', 'git init --bare'], { cwd: elsewhere, env: { ...process.env, GIT_WORK_TREE: elsewhere } })).toThrow(/GIT_WORK_TREE/);

    assertCoreConfigUnchanged(repo, before);
  });

  it('lets the same helper run with a scrubbed env', () => {
    const elsewhere = tempDir('git-guard-scrubbed-');

    expect(() => initBare(elsewhere, scrubGitEnv({ ...process.env, GIT_DIR: '/nowhere/.git' }))).not.toThrow();
  });

  it('fails the run when the repo goes bare behind the guard', () => {
    const repo = newRepo();
    const before = coreConfigOf(repo);
    execFileSync('git', ['-C', repo, 'config', 'core.bare', 'true'], { env: scrubGitEnv({ ...process.env }) });

    expect(() => assertCoreConfigUnchanged(repo, before)).toThrow(/core\.bare true/);
  });

  it('ignores config that is not core, which a concurrent worker legitimately writes', () => {
    const repo = newRepo();
    const before = coreConfigOf(repo);
    execFileSync('git', ['-C', repo, 'config', 'branch.x.remote', 'origin'], { env: scrubGitEnv({ ...process.env }) });

    expect(() => assertCoreConfigUnchanged(repo, before)).not.toThrow();
  });
});
