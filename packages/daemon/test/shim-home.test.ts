import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { externalHooksHandlers } from '../src/external-hooks.ts';
import { defaultHookShimPath, isScratchBuild } from '../src/live-home.ts';
import { TEST_CLI_LAUNCHER, TEST_HOOK_FORWARDER, startTestDaemon, tempDataDir } from './helpers.ts';

/** The installed app's launcher, from a folder that is neither a temp one nor a worktree. */
const INSTALLED = { command: '/Applications/agent-board.app/Contents/MacOS/agent-board', args: [] };

describe("where a daemon writes its launchers when it isn't told", () => {
  it("is the user's own ~/.agent-board/bin only for the installed app; any other run keeps them in its data dir", () => {
    expect(defaultHookShimPath({ installedApp: true, dataDir: '/data', home: '/home/user' })).toBe('/home/user/.agent-board/bin/agent-board-hook');
    expect(defaultHookShimPath({ installedApp: false, dataDir: '/data', home: '/home/user' })).toBe('/data/bin/agent-board-hook');
  });

  it('counts a build run from a temp folder or a worktree as no installed app, packaged or not', () => {
    expect(isScratchBuild('/Applications/agent-board.app/Contents/MacOS/agent-board', ['/tmp'])).toBe(false);
    expect(isScratchBuild('/tmp/pack/agent-board.app/Contents/MacOS/agent-board', ['/tmp'])).toBe(true);
    expect(isScratchBuild('/Users/me/.agent-board/worktrees/x/apps/desktop/dist/mac/agent-board.app/Contents/MacOS/agent-board', ['/tmp'])).toBe(true);
  });

  it('leaves the home folder alone for a dev or test daemon, and writes both launchers in its data dir', async () => {
    const home = tempDataDir();
    const dataDir = tempDataDir();
    await startTestDaemon({ dataDir, homeDir: home, hookShimPath: undefined, externalHookFile: undefined, testOverrides: true });
    expect(existsSync(join(home, '.agent-board'))).toBe(false);
    expect(readFileSync(join(dataDir, 'bin', 'agent-board-hook'), 'utf8')).toContain('hook');
    expect(readFileSync(join(dataDir, 'bin', 'agent-board'), 'utf8')).toContain('ELECTRON_RUN_AS_NODE=1');
  });

  it('writes both launchers in ~/.agent-board/bin for the installed app', async () => {
    const home = tempDataDir();
    const dataDir = tempDataDir();
    const launchers = { hookForwarder: { ...TEST_HOOK_FORWARDER, command: INSTALLED.command }, cli: { ...TEST_CLI_LAUNCHER, command: INSTALLED.command } };
    await startTestDaemon({ dataDir, homeDir: home, hookShimPath: undefined, externalHookFile: undefined, testOverrides: false, ...launchers });
    expect(existsSync(join(home, '.agent-board', 'bin', 'agent-board-hook'))).toBe(true);
    expect(existsSync(join(home, '.agent-board', 'bin', 'agent-board'))).toBe(true);
    expect(existsSync(join(dataDir, 'bin'))).toBe(false);
  });

  it('keeps an installed-app build run from a worktree out of the home folder', async () => {
    const home = tempDataDir();
    const dataDir = tempDataDir();
    const command = '/Users/me/.agent-board/worktrees/x/dist/agent-board';
    const launchers = { hookForwarder: { ...TEST_HOOK_FORWARDER, command }, cli: { ...TEST_CLI_LAUNCHER, command } };
    await startTestDaemon({ dataDir, homeDir: home, hookShimPath: undefined, externalHookFile: undefined, testOverrides: false, ...launchers });
    expect(existsSync(join(home, '.agent-board'))).toBe(false);
    expect(existsSync(join(dataDir, 'bin', 'agent-board-hook'))).toBe(true);
  });
});

describe("a dev or test build and the user's global hooks", () => {
  /** Global hook files in `usersHome`, as the real ones are in the user's own home. */
  function handlers(installedApp: boolean) {
    const usersHome = tempDataDir();
    const files = { claude: join(usersHome, '.claude', 'settings.json'), codex: join(usersHome, '.codex', 'hooks.json') };
    const hooks = externalHooksHandlers({ files, shimPath: '/data/bin/agent-board-hook', ensureHookShim: () => {}, installedApp, usersHome });
    return { hooks, files };
  }

  it("won't turn them on or off in the user's own home, and leaves the files as they were", () => {
    const { hooks, files } = handlers(false);
    for (const enabled of [true, false]) {
      expect(() => hooks['externalHooks.setEnabled']({ enabled }, undefined)).toThrow(/only the installed agent-board app changes/);
    }
    expect(existsSync(files.claude) || existsSync(files.codex)).toBe(false);
  });

  it('turns them on for the installed app', () => {
    const { hooks, files } = handlers(true);
    expect(hooks['externalHooks.setEnabled']({ enabled: true }, undefined)).toMatchObject({ enabled: true });
    expect(readFileSync(files.claude, 'utf8')).toContain('/data/bin/agent-board-hook');
  });
});
