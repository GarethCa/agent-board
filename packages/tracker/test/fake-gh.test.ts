import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeGitHub, FAKE_GITHUB_STATE } from '../src/fake-github.ts';

const fakes: { dispose(): void }[] = [];
afterEach(() => fakes.splice(0).forEach((fake) => fake.dispose()));

function fakeGitHub(loggedIn: boolean) {
  const fake = createFakeGitHub({ ...FAKE_GITHUB_STATE, loggedIn });
  fakes.push(fake);
  return fake;
}

describe('fake gh auth', () => {
  it('prints a version', () => {
    expect(execFileSync(fakeGitHub(true).gh, ['--version'], { encoding: 'utf8' })).toMatch(/^gh version \d+\.\d+\.\d+/);
  });

  it('says whether it is logged in, as gh auth status does', () => {
    expect(spawnSync(fakeGitHub(true).gh, ['auth', 'status']).status).toBe(0);
    const out = spawnSync(fakeGitHub(false).gh, ['auth', 'status'], { encoding: 'utf8' });
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/not logged into any GitHub hosts/);
  });

  it('logs in with gh auth login, after which every command works', () => {
    const fake = fakeGitHub(false);
    expect(spawnSync(fake.gh, ['api', 'user']).status).toBe(4);
    const login = spawnSync(fake.gh, ['auth', 'login', '--web'], { encoding: 'utf8' });
    expect(login.status).toBe(0);
    expect(login.stderr).toMatch(/Logged in as octocat/);
    expect(spawnSync(fake.gh, ['auth', 'status']).status).toBe(0);
    expect(JSON.parse(execFileSync(fake.gh, ['api', 'user'], { encoding: 'utf8' }))).toEqual({ login: 'octocat' });
  });
});
