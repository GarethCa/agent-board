import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_HOOK_EVENTS } from '../src/claude-state.ts';
import {
  externalHookCommand,
  externalHookFiles,
  externalHooksInstalled,
  installExternalHooks,
  uninstallExternalHooks,
} from '../src/external-hooks.ts';
import { CODEX_HOOK_TIMEOUTS } from '../src/hook-forwarder.ts';
import { tempDataDir } from './helpers.ts';

const SHIM = '/Users/me/.agent-board/bin/agent-board-hook';

/** A user's own settings, with hooks of their own on some of the events agent-board uses. */
const USER_SETTINGS = {
  model: 'opus',
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/bin/check-bash', timeout: 30 }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: 'echo compact' }] }],
  },
};

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { hooks?: Record<string, unknown[]> };
const write = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

function settingsFile(content?: unknown): string {
  const path = join(tempDataDir(), '.claude', 'settings.json');
  if (content !== undefined) {
    mkdirSync(join(path, '..'), { recursive: true });
    write(path, content);
  }
  return path;
}

describe('external hook files', () => {
  it('are ~/.claude/settings.json and ~/.codex/hooks.json, or under CLAUDE_CONFIG_DIR and CODEX_HOME', () => {
    expect(externalHookFiles({ HOME: '/h' })).toEqual({ claude: '/h/.claude/settings.json', codex: '/h/.codex/hooks.json' });
    expect(externalHookFiles({ HOME: '/h', CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x' })).toEqual({
      claude: '/c/settings.json',
      codex: '/x/hooks.json',
    });
  });
});

describe('installing the external hooks', () => {
  it('creates a missing settings file with a command hook on every Claude event', () => {
    const path = settingsFile();
    installExternalHooks(path, 'claude', SHIM);
    const { hooks } = read(path);
    expect(Object.keys(hooks!).sort()).toEqual([...CLAUDE_HOOK_EVENTS].sort());
    expect(hooks!.Stop).toEqual([{ hooks: [{ type: 'command', command: externalHookCommand(SHIM, 'claude'), timeout: 5 }] }]);
    expect(externalHooksInstalled(path, 'claude', SHIM)).toBe(true);
  });

  it("adds its own matcher groups after the user's, keeping every other setting and hook", () => {
    const path = settingsFile(USER_SETTINGS);
    installExternalHooks(path, 'claude', SHIM);
    const settings = read(path) as typeof USER_SETTINGS & { hooks: Record<string, unknown[]> };
    expect(settings.model).toBe('opus');
    expect(settings.permissions).toEqual(USER_SETTINGS.permissions);
    expect(settings.hooks.Stop![0]).toEqual(USER_SETTINGS.hooks.Stop[0]);
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(settings.hooks.PreToolUse![0]).toEqual(USER_SETTINGS.hooks.PreToolUse[0]);
    // An event agent-board doesn't use stays as it was.
    expect(settings.hooks.PreCompact).toEqual(USER_SETTINGS.hooks.PreCompact);
  });

  it('is idempotent, and replaces hooks pointing at an older shim', () => {
    const path = settingsFile(USER_SETTINGS);
    installExternalHooks(path, 'claude', '/old/agent-board-hook');
    installExternalHooks(path, 'claude', SHIM);
    installExternalHooks(path, 'claude', SHIM);
    const { hooks } = read(path);
    expect(hooks!.Stop).toHaveLength(2);
    expect(JSON.stringify(hooks)).not.toContain('/old/');
  });

  it('gives Codex its 12 events, none held longer than 5 s', () => {
    const path = join(tempDataDir(), '.codex', 'hooks.json');
    installExternalHooks(path, 'codex', SHIM);
    const { hooks } = read(path) as { hooks: Record<string, { hooks: { command: string; timeout: number }[] }[]> };
    expect(Object.keys(hooks).sort()).toEqual(Object.keys(CODEX_HOOK_TIMEOUTS).sort());
    expect(hooks.PermissionRequest![0]!.hooks[0]).toEqual({ type: 'command', command: externalHookCommand(SHIM, 'codex'), timeout: 5 });
    expect(hooks.SessionEnd![0]!.hooks[0]!.timeout).toBe(3);
  });

  it('refuses a settings file that is not a JSON object, leaving it alone', () => {
    for (const content of ['{ "hooks": ', '[]', '{"hooks": []}']) {
      const path = settingsFile();
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content);
      expect(() => installExternalHooks(path, 'claude', SHIM)).toThrow(path);
      expect(readFileSync(path, 'utf8')).toBe(content);
    }
  });

  it('leaves groups in shapes it does not know alone', () => {
    const odd = { hooks: { Stop: [null, 'say done', { matcher: 'x' }] } };
    const path = settingsFile(odd);
    installExternalHooks(path, 'claude', SHIM);
    expect(externalHooksInstalled(path, 'claude', SHIM)).toBe(true);
    uninstallExternalHooks(path, 'claude');
    expect(read(path)).toEqual(odd);
  });

  it("keeps the file's permissions", () => {
    const path = settingsFile(USER_SETTINGS);
    chmodSync(path, 0o600);
    installExternalHooks(path, 'claude', SHIM);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('the hook file as the user keeps it', () => {
  it('edits a symlinked file through its link, leaving the link in place (dotfile managers)', () => {
    const home = tempDataDir();
    const target = join(home, 'dotfiles', 'claude-settings.json');
    mkdirSync(join(home, 'dotfiles'));
    write(target, USER_SETTINGS);
    mkdirSync(join(home, '.claude'));
    const link = join(home, '.claude', 'settings.json');
    symlinkSync('../dotfiles/claude-settings.json', link);

    installExternalHooks(link, 'claude', SHIM);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe('../dotfiles/claude-settings.json');
    expect(externalHooksInstalled(target, 'claude', SHIM)).toBe(true);

    uninstallExternalHooks(link, 'claude');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(read(target)).toEqual(USER_SETTINGS);
  });

  it('creates the file a dangling symlink points at', () => {
    const home = tempDataDir();
    const link = join(home, 'settings.json');
    symlinkSync(join(home, 'dotfiles', 'settings.json'), link);
    installExternalHooks(link, 'claude', SHIM);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(externalHooksInstalled(join(home, 'dotfiles', 'settings.json'), 'claude', SHIM)).toBe(true);
  });

  it('comes back byte for byte after install and uninstall, whatever its indentation', () => {
    for (const text of [
      `${JSON.stringify(USER_SETTINGS, null, '\t')}\n`,
      JSON.stringify(USER_SETTINGS),
      `${JSON.stringify(USER_SETTINGS, null, 4)}`,
      `${JSON.stringify({ model: 'opus' }, null, 2)}\n`,
    ]) {
      const path = settingsFile();
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, text);
      installExternalHooks(path, 'claude', SHIM);
      uninstallExternalHooks(path, 'claude');
      expect(readFileSync(path, 'utf8')).toBe(text);
    }
  });

  it('takes an empty file as no settings', () => {
    const path = settingsFile();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '  \n');
    installExternalHooks(path, 'claude', SHIM);
    expect(externalHooksInstalled(path, 'claude', SHIM)).toBe(true);
  });
});

describe('uninstalling the external hooks', () => {
  it("leaves the user's settings exactly as they were before installing", () => {
    const path = settingsFile(USER_SETTINGS);
    installExternalHooks(path, 'claude', SHIM);
    uninstallExternalHooks(path, 'claude');
    expect(read(path)).toEqual(USER_SETTINGS);
    expect(externalHooksInstalled(path, 'claude', SHIM)).toBe(false);
  });

  it('removes the hooks key it created, and hooks for an older shim', () => {
    const path = settingsFile({ model: 'opus' });
    installExternalHooks(path, 'claude', '/old/agent-board-hook');
    uninstallExternalHooks(path, 'claude');
    expect(read(path)).toEqual({ model: 'opus' });
  });

  it("removes only agent-board's handler from a group the user added to", () => {
    const path = settingsFile(USER_SETTINGS);
    installExternalHooks(path, 'claude', SHIM);
    const settings = read(path) as { hooks: Record<string, { hooks: unknown[] }[]> };
    settings.hooks.Stop![1]!.hooks.push({ type: 'command', command: 'afplay ding.aiff' });
    write(path, settings);
    uninstallExternalHooks(path, 'claude');
    expect(read(path).hooks!.Stop).toEqual([
      USER_SETTINGS.hooks.Stop[0],
      { hooks: [{ type: 'command', command: 'afplay ding.aiff' }] },
    ]);
  });

  it("does nothing to a missing file, and never touches the other harness's hooks", () => {
    const path = settingsFile();
    uninstallExternalHooks(path, 'claude');
    expect(existsSync(path)).toBe(false);
    const codex = join(tempDataDir(), 'hooks.json');
    installExternalHooks(codex, 'codex', SHIM);
    uninstallExternalHooks(codex, 'claude');
    expect(externalHooksInstalled(codex, 'codex', SHIM)).toBe(true);
  });
});
