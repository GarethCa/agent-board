import { fakeHarnessEnv, type FakeScenario } from '@agent-board/fake-harness';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Scratch {
  dir: string;
  repo: string;
  /** The env the app (and so its daemon and agents) runs with: the fake claude, a temp home and worktrees dir. */
  env: Record<string, string>;
}

/** A temp repo with one commit and an `apps/web` folder, and an env that runs the fake claude with `scenario`. */
export function scratch(scenario: FakeScenario): Scratch {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-e2e-agents-')));
  const repo = join(dir, 'monorepo');
  mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
  writeFileSync(join(repo, 'apps', 'web', 'index.ts'), 'export {};\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args]);
  git('init', '--quiet');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '-m', 'initial');
  const home = join(dir, 'home');
  mkdirSync(home);
  const fake = fakeHarnessEnv({ scenario, home, stepDelayMs: 100, idleNotifyMs: 300, base: {} });
  const env: Record<string, string> = {
    PATH: `${fake.PATH}:${process.env.PATH}`,
    HOME: home,
    FAKE_HARNESS_SCENARIO: fake.FAKE_HARNESS_SCENARIO!,
    FAKE_HARNESS_STEP_DELAY_MS: fake.FAKE_HARNESS_STEP_DELAY_MS!,
    FAKE_HARNESS_IDLE_NOTIFY_MS: fake.FAKE_HARNESS_IDLE_NOTIFY_MS!,
    AGENT_BOARD_WORKTREES_DIR: join(dir, 'worktrees'),
    AGENT_BOARD_SCRATCH_DIR: join(dir, 'scratch'),
    // Start claude directly, not through the developer's login shell (which would reorder PATH past the fakes).
    AGENT_BOARD_LOGIN_SHELL: '0',
    // The shell an ended agent's pane drops into: never the developer's own, with its rc files.
    SHELL: '/bin/sh',
  };
  return { dir, repo, env };
}
