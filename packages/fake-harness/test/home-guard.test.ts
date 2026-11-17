import { afterAll, describe, expect, it, onTestFinished } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import { REAL_CONFIG_DIRS_ENV, REAL_HOME_ENV, realConfigDirs, refuseRealConfigDir, useTempHome } from '../src/home-guard.ts';
import type { HarnessName } from '../src/index.ts';
import { GUARD_DIR_PREFIX } from '../src/paths.ts';
import { removeTempDirs, runFake, tempDir } from './run-fake.ts';

afterAll(removeTempDirs);

/** A stand-in for the user's own home, with a settings file whose hook would mark the file it names if it ever ran. */
function pretendRealHome(): { home: string; ran: string } {
  const home = tempDir('pretend-real-home-');
  const ran = join(home, 'hook-ran');
  const hooks = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch '${ran}'` }] }] } };
  for (const dir of ['.claude', '.codex']) mkdirSync(join(home, dir));
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(hooks));
  writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify(hooks));
  return { home, ran };
}

/** A tripwire dir of the test's own, so the hit it expects doesn't fail the whole run. */
function ownTripwireLog(): { dir: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), GUARD_DIR_PREFIX));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'hits.log');
  writeFileSync(log, '');
  return { dir, log };
}

describe('real home guard', () => {
  it("always counts the account's own home, whatever $HOME says, and adds the named one", () => {
    expect(realConfigDirs({ HOME: '/tmp/elsewhere' }, '/Users/dev')).toEqual(['/Users/dev/.claude', '/Users/dev/.codex']);
    expect(realConfigDirs({ [REAL_HOME_ENV]: '/tmp/also' }, '/Users/dev')).toEqual([
      '/Users/dev/.claude',
      '/Users/dev/.codex',
      '/tmp/also/.claude',
      '/tmp/also/.codex',
    ]);
    expect(realConfigDirs({ [REAL_CONFIG_DIRS_ENV]: `/cfg/claude${delimiter}/cfg/codex` }, '/Users/dev')).toEqual([
      '/Users/dev/.claude',
      '/Users/dev/.codex',
      '/cfg/claude',
      '/cfg/codex',
    ]);
  });

  it('refuses the real config dirs and anything in them, and nothing else', () => {
    const real = realConfigDirs({}, '/Users/dev');
    const refuse = (dir: string) => () => refuseRealConfigDir('claude', dir, {}, real);

    expect(refuse('/Users/dev/.claude')).toThrow(/refused to read the user's real \/Users\/dev\/.claude/);
    expect(refuse('/Users/dev/.codex/')).toThrow(/real/);
    expect(refuse('/Users/dev/x/../.claude/projects')).toThrow(/real/);
    expect(refuse('/Users/dev/.claude-test')).not.toThrow();
    expect(refuse('/Users/dev/work/.claude')).not.toThrow();
    expect(refuse('/tmp/elsewhere/.claude')).not.toThrow();
  });

  it.each<HarnessName>(['claude', 'codex'])('stops a fake %s run in the real home before any of its hooks, and logs the hit', async (harness) => {
    const { home, ran } = pretendRealHome();
    const tripwire = ownTripwireLog();

    const result = await runFake(harness, {
      scenario: 'output',
      args: harness === 'claude' ? ['-p', 'hi'] : ['exec', 'hi'],
      home,
      env: { [REAL_HOME_ENV]: home, AGENT_BOARD_HARNESS_GUARD_DIR: tripwire.dir },
    });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(`refused to read the user's real ${join(home, `.${harness}`)}`);
    expect(readFileSync(tripwire.log, 'utf8')).toContain(`${harness} config ${join(home, `.${harness}`)}`);
    expect(() => readFileSync(ran)).toThrow();
  });

  it('refuses a CLAUDE_CONFIG_DIR or CODEX_HOME in the real home too', async () => {
    const { home } = pretendRealHome();
    const tripwire = ownTripwireLog();
    const env = { [REAL_HOME_ENV]: home, AGENT_BOARD_HARNESS_GUARD_DIR: tripwire.dir };

    const claude = await runFake('claude', { scenario: 'output', args: ['-p', 'hi'], env: { ...env, CLAUDE_CONFIG_DIR: join(home, '.claude') } });
    const codex = await runFake('codex', { scenario: 'output', args: ['exec', 'hi'], env: { ...env, CODEX_HOME: join(home, '.codex') } });

    expect([claude.code, codex.code]).toEqual([2, 2]);
  });

  it('logs the hit in the tripwire dir found on PATH when the env lost its name', () => {
    const tripwire = ownTripwireLog();
    const env = { PATH: ['/usr/local/bin', tripwire.dir, '/usr/bin'].join(delimiter) };

    expect(() => refuseRealConfigDir('codex', '/Users/dev/.codex', env, realConfigDirs({}, '/Users/dev'))).toThrow(/real/);
    expect(readFileSync(tripwire.log, 'utf8')).toContain('codex config /Users/dev/.codex');
  });

  it('lets a run in a temp home start as usual', async () => {
    const result = await runFake('claude', { scenario: 'output', args: ['-p', 'hi'] });

    expect(result.code).toBe(0);
  });
});

describe("the run's temp home", () => {
  it('is where every test, and all it starts, finds its home: never the real one, and no config dir pointing back', () => {
    expect(process.env.HOME).toBeDefined();
    expect(process.env.HOME).not.toBe(userInfo().homedir);
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(process.env.CODEX_HOME).toBeUndefined();
    expect(execFileSync('sh', ['-c', 'printf %s "$HOME"'], { encoding: 'utf8' })).toBe(process.env.HOME);
  });

  it('gives git a neutral author and main as the first branch, and puts the env back after', () => {
    const env: NodeJS.ProcessEnv = { HOME: '/somewhere', CLAUDE_CONFIG_DIR: '/somewhere/.claude' };
    const { home, restore } = useTempHome(env);

    // The user's own config dir is unset, and kept for the fakes to refuse.
    expect(env).toEqual({ HOME: home, [REAL_CONFIG_DIRS_ENV]: '/somewhere/.claude' });
    expect(realpathSync(home)).toBe(home);
    const repo = tempDir('temp-home-repo-');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('commit', '--quiet', '--allow-empty', '-m', 'first');
    expect(git('log', '--format=%an <%ae> %D')).toBe('Test <test@example.com> HEAD -> main');

    restore();
    expect(env).toEqual({ HOME: '/somewhere', CLAUDE_CONFIG_DIR: '/somewhere/.claude' });
    expect(existsSync(home)).toBe(false);
  });
});
