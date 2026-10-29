import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ancestors, daemonLaunchEnv, runsUnderDaemon } from '../src/daemon-launch.ts';
import { daemonPaths } from '../src/paths.ts';
import { tempDataDir } from './helpers.ts';

describe('daemonLaunchEnv', () => {
  it("keeps the user's env and settings but drops the caller's board, pnpm script, Claude session and shell vars and node_modules/.bin", () => {
    const env = daemonLaunchEnv({
      HOME: '/Users/me',
      LANG: 'en_GB.UTF-8',
      CLAUDE_CODE_USE_BEDROCK: '1',
      PNPM_HOME: '/Users/me/Library/pnpm',
      NPM_TOKEN: 'npm-token',
      CLAUDECODE: '1',
      CLAUDE_PID: '123',
      CLAUDE_CODE_SESSION_ID: 'other-session',
      CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/claude.sock',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      OLDPWD: '/repo',
      SHLVL: '2',
      _: '/usr/bin/pnpm',
      PATH: '/repo/node_modules/.bin:/repo/apps/desktop/node_modules/.bin/:/opt/homebrew/bin:/usr/bin',
      AGENT_BOARD_SOCKET: '/tmp/board.sock',
      AGENT_BOARD_HOOK_TOKEN: 'secret',
      AGENT_BOARD_WORKTREES_DIR: '/tmp/worktrees',
      AGENT_BOARD_HARNESS_DIRS: '/tmp/fakes',
      npm_lifecycle_event: 'update:app',
      npm_config_user_agent: 'pnpm/11',
      PNPM_PACKAGE_NAME: 'agent-board',
      INIT_CWD: '/repo',
    });

    expect(env).toEqual({
      HOME: '/Users/me',
      LANG: 'en_GB.UTF-8',
      CLAUDE_CODE_USE_BEDROCK: '1',
      PNPM_HOME: '/Users/me/Library/pnpm',
      NPM_TOKEN: 'npm-token',
      PATH: '/opt/homebrew/bin:/usr/bin',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });
});

describe('runsUnderDaemon', () => {
  const lockedBy = (pid: number) => {
    const dataDir = tempDataDir();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(daemonPaths(dataDir).lock, String(pid));
    return dataDir;
  };

  it("is true when the data dir's daemon is an ancestor of this process, as for a board shell's or agent's command", () => {
    expect(ancestors(process.pid)).toContain(process.ppid);
    expect(runsUnderDaemon(lockedBy(process.ppid))).toBe(true);
  });

  it('is false for a daemon that is not an ancestor, or no daemon at all', () => {
    expect(runsUnderDaemon(lockedBy(process.pid))).toBe(false);
    expect(runsUnderDaemon(tempDataDir())).toBe(false);
  });
});
