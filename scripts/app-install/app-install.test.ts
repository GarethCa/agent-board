import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { appRunning, installApp, installBuilt, shouldInstall, stageApp, swapIn, type InstallBuiltOptions } from './app-install.ts';

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ab-install-')));
  onTestFinished(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function fakeApp(path: string, version: string): string {
  mkdirSync(join(path, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(path, 'Contents', 'MacOS', 'agent-board'), version);
  return path;
}

const version = (installDir: string) => readFileSync(join(installDir, 'agent-board.app', 'Contents', 'MacOS', 'agent-board'), 'utf8');

describe('installApp', () => {
  it('installs into a new Applications dir', () => {
    const installDir = join(tempDir(), 'Applications');
    installApp(fakeApp(join(tempDir(), 'built.app'), 'new'), installDir);
    expect(version(installDir)).toBe('new');
  });

  it('replaces the old app and leaves nothing else behind', () => {
    const installDir = tempDir();
    fakeApp(join(installDir, 'agent-board.app'), 'old');
    installApp(fakeApp(join(tempDir(), 'built.app'), 'new'), installDir);
    expect(version(installDir)).toBe('new');
    expect(readdirSync(installDir, { encoding: 'utf8' })).toEqual(['agent-board.app']);
  });

  it('keeps the old app when the build to copy is missing', () => {
    const installDir = tempDir();
    fakeApp(join(installDir, 'agent-board.app'), 'old');
    expect(() => installApp(join(tempDir(), 'missing.app'), installDir)).toThrow();
    expect(version(installDir)).toBe('old');
    expect(readdirSync(installDir, { encoding: 'utf8' })).toEqual(['agent-board.app']);
  });
});

describe('installBuilt', () => {
  function setup(running: number, overrides: Partial<InstallBuiltOptions> = {}) {
    const calls: string[] = [];
    const logs: string[] = [];
    let polls = running;
    const installDir = tempDir();
    const options: InstallBuiltOptions = {
      builtApp: fakeApp(join(tempDir(), 'built.app'), 'new'),
      installDir,
      open: false,
      confirm: async (question) => (calls.push(`ask: ${question}`), true),
      log: (message) => logs.push(message),
      ...overrides,
    };
    const app = {
      running: () => polls-- > 0,
      quit: () => void calls.push('quit'),
      open: (path: string) => void calls.push(`open ${path}`),
      sleep: async () => {},
    };
    return { options, app, calls, logs, installDir };
  }

  it('installs without quitting or opening an app that is not running', async () => {
    const { options, app, calls, logs, installDir } = setup(0);
    await installBuilt(options, app);
    expect(version(installDir)).toBe('new');
    expect(calls).toEqual([]);
    expect(logs).toEqual([`Installed ${join(installDir, 'agent-board.app')}.`]);
  });

  it('quits a running app, replaces it, and reopens it when asked and told yes', async () => {
    const { options, app, calls, logs, installDir } = setup(3);
    fakeApp(join(installDir, 'agent-board.app'), 'old');
    await installBuilt(options, app);
    expect(version(installDir)).toBe('new');
    expect(calls).toEqual(['quit', 'ask: agent-board was running. Reopen it?', `open ${join(installDir, 'agent-board.app')}`]);
    expect(logs.join('\n')).toContain('the old copy is gone');
  });

  it('leaves the app closed when told not to reopen it', async () => {
    const { options, app, calls, logs } = setup(2, { confirm: async () => false });
    await installBuilt(options, app);
    expect(calls).toEqual(['quit']);
    expect(logs.at(-1)).toContain('Left agent-board closed');
  });

  it('never asks or reopens with noOpen set', async () => {
    const { options, app, calls } = setup(2, { noOpen: true });
    await installBuilt(options, app);
    expect(calls).toEqual(['quit']);
  });

  it('opens the app without asking with open set', async () => {
    const { options, app, calls, installDir } = setup(0, { open: true });
    await installBuilt(options, app);
    expect(calls).toEqual([`open ${join(installDir, 'agent-board.app')}`]);
  });

  it('copies before it quits, so a failed copy leaves the running app alone', async () => {
    const { options, app, calls, installDir } = setup(2);
    fakeApp(join(installDir, 'agent-board.app'), 'old');
    await expect(installBuilt({ ...options, builtApp: join(tempDir(), 'missing.app') }, app)).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(version(installDir)).toBe('old');
    expect(existsSync(join(installDir, '.agent-board.app.installing'))).toBe(false);
  });
});

/** A stand-in .app with an executable and a framework symlink, as electron-builder leaves one. */
function richApp(app: string, version: string): string {
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  mkdirSync(join(app, 'Contents', 'Frameworks', 'Versions', 'A'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'MacOS', 'agent-board'), `#!/bin/sh\necho ${version}\n`);
  chmodSync(join(app, 'Contents', 'MacOS', 'agent-board'), 0o755);
  symlinkSync('Versions/A', join(app, 'Contents', 'Frameworks', 'Current'));
  return app;
}

describe('installApp with an electron-builder .app', () => {
  const builtApp = (version: string) => richApp(join(tempDir(), 'agent-board.app'), version);

  it('installs the app, keeping its symlinks and executable bits', () => {
    const installDir = join(tempDir(), 'Applications');

    const installed = installApp(builtApp('v1'), installDir);

    expect(installed).toBe(join(installDir, 'agent-board.app'));
    const executable = join(installed, 'Contents', 'MacOS', 'agent-board');
    expect(statSync(executable).mode & 0o111).not.toBe(0);
    const link = join(installed, 'Contents', 'Frameworks', 'Current');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('Versions/A');
  });

  it('replaces the previous build in place, leaving nothing else behind', () => {
    const installDir = tempDir();
    installApp(builtApp('v1'), installDir);
    writeFileSync(join(installDir, 'agent-board.app', 'Contents', 'left-over'), '');

    const installed = installApp(builtApp('v2'), installDir);

    expect(readFileSync(join(installed, 'Contents', 'MacOS', 'agent-board'), 'utf8')).toContain('v2');
    expect(existsSync(join(installed, 'Contents', 'left-over'))).toBe(false);
    expect(readdirSync(installDir)).toEqual(['agent-board.app']);
  });
});

describe('appRunning', () => {
  it.runIf(process.platform === 'darwin')('is false for an app LaunchServices has never seen, as on a fresh Mac', () => {
    expect(appRunning(`io.example.never-installed-${process.pid}`)).toBe(false);
  });
});


describe('a crashed install', () => {
  it('is recovered from: the app set aside by a run that died mid-swap is put back, not deleted', () => {
    const installDir = tempDir();
    fakeApp(join(installDir, '.agent-board.app.previous'), 'old');

    stageApp(fakeApp(join(tempDir(), 'built.app'), 'new'), installDir);

    expect(version(installDir)).toBe('old');
  });

  it('drops a stale set-aside copy when the installed app is there', () => {
    const installDir = tempDir();
    fakeApp(join(installDir, 'agent-board.app'), 'current');
    fakeApp(join(installDir, '.agent-board.app.previous'), 'stale');

    installApp(fakeApp(join(tempDir(), 'built.app'), 'new'), installDir);

    expect(version(installDir)).toBe('new');
    expect(readdirSync(installDir, { encoding: 'utf8' })).toEqual(['agent-board.app']);
  });

  it('puts the old app back when the swap fails after setting it aside', () => {
    const installDir = tempDir();
    fakeApp(join(installDir, 'agent-board.app'), 'old');

    expect(() => swapIn(installDir)).toThrow(); // nothing staged: the second rename fails after the first

    expect(version(installDir)).toBe('old');
    expect(readdirSync(installDir, { encoding: 'utf8' })).toEqual(['agent-board.app']);
  });
});

describe('shouldInstall', () => {
  it('installs by default, and with --opt-in only when --install is given; --no-install always wins', () => {
    expect(shouldInstall({ noInstall: false, install: false, optIn: false })).toBe(true);
    expect(shouldInstall({ noInstall: false, install: false, optIn: true })).toBe(false);
    expect(shouldInstall({ noInstall: false, install: true, optIn: true })).toBe(true);
    expect(shouldInstall({ noInstall: true, install: true, optIn: false })).toBe(false);
  });
});

describe('appRunning', () => {
  it.runIf(process.platform === 'darwin')('is false for an app LaunchServices has never seen, as on a fresh Mac', () => {
    expect(appRunning(`io.example.never-installed-${process.pid}`)).toBe(false);
  });
});
