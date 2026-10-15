import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { codexLaunch, defaultName, harnessLaunch } from '../src/agents.ts';
import { projectCodexConfig } from '../src/codex-config-guard.ts';
import { CODEX_HOOK_TIMEOUTS } from '../src/hook-forwarder.ts';
import { tempDataDir } from './helpers.ts';

describe('launching a harness', () => {
  it('runs it directly when sessions use no login shell', () => {
    expect(harnessLaunch('/bin/zsh', [], '/repo', 'claude', ['--', 'fix it'])).toEqual({ command: 'claude', args: ['--', 'fix it'] });
  });

  it('runs it through a POSIX login shell in its directory, passing every argument through untouched', () => {
    const cwd = tempDataDir();
    const launch = harnessLaunch('/bin/sh', ['-l'], cwd, 'sh', ['-c', 'printf "[%s]" "$PWD" "$@"', 'x', `it's "quoted" $HOME`, '--']);
    expect(launch.command).toBe('/bin/sh');
    // Run it from elsewhere and without -l, so the test doesn't depend on the profile: the script is what matters.
    const args = launch.args.filter((arg) => arg !== '-l');
    expect(execFileSync(launch.command, args, { encoding: 'utf8', cwd: '/' })).toBe(`[${realpathSync(cwd)}][it's "quoted" $HOME][--]`);
  });

  it('uses fish syntax for fish', () => {
    expect(harnessLaunch('/opt/homebrew/bin/fish', ['-l'], '/repo', 'claude', ['x'])).toEqual({
      command: '/opt/homebrew/bin/fish',
      args: ['-l', '-c', 'cd $argv[1]; and exec $argv[2..-1]', '/repo', 'claude', 'x'],
    });
  });

  it('starts it directly for a login shell whose syntax it does not know', () => {
    expect(harnessLaunch('/usr/local/bin/nu', ['-l'], '/repo', 'claude', ['x'])).toEqual({ command: 'claude', args: ['x'] });
  });
});

describe('default agent names', () => {
  it('uses a short prompt as it is, first line only', () => {
    expect(defaultName('Fix the flaky tests\nThey fail on CI')).toBe('Fix the flaky tests');
  });

  it('cuts a long prompt at a word boundary', () => {
    expect(defaultName('Rewrite the session daemon so that it survives every kind of crash')).toBe(
      'Rewrite the session daemon so that it…',
    );
  });
});

describe('launching codex', () => {
  const base = { command: 'codex', hookShimPath: '/Users/me/.agent-board/bin/agent-board-hook', prompt: '-fix it', zoneBypassHookTrust: true };

  it('passes every hook as a -c override running the shim, hides the hook env from tool shells, and bypasses trust', () => {
    const cwd = tempDataDir();
    const { command, args, projectConfig } = codexLaunch({ ...base, cwd, worktree: cwd });

    expect(command).toBe('codex');
    expect(projectConfig).toBeUndefined();
    const overrides = args.filter((_, i) => args[i - 1] === '-c');
    expect(overrides).toContain(
      'hooks.PermissionRequest=[{hooks=[{type="command",command="\\"/Users/me/.agent-board/bin/agent-board-hook\\" codex",timeout=600}]}]',
    );
    expect(overrides.filter((o) => o.startsWith('hooks.')).map((o) => o.slice(6, o.indexOf('=')))).toEqual(Object.keys(CODEX_HOOK_TIMEOUTS));
    expect(overrides).toContain('hooks.SessionEnd=[{hooks=[{type="command",command="\\"/Users/me/.agent-board/bin/agent-board-hook\\" codex",timeout=3}]}]');
    expect(overrides).toContain('shell_environment_policy.exclude=["AGENT_BOARD_HOOK_*"]');
    expect(overrides.some((o) => o.startsWith('mcp_servers.'))).toBe(false);
    // The prompt comes last, after `--`, so one starting with a dash is not read as a flag.
    expect(args.slice(-3)).toEqual(['--dangerously-bypass-hook-trust', '--', '-fix it']);
  });

  it('runs the board MCP server from the CLI, passing it the board env, when given the CLI', () => {
    const cwd = tempDataDir();
    const { args } = codexLaunch({ ...base, cwd, worktree: cwd, boardCli: '/Users/me/.agent-board/bin/agent-board' });
    const overrides = args.filter((_, i) => args[i - 1] === '-c');
    expect(overrides.filter((o) => o.startsWith('mcp_servers.'))).toEqual([
      'mcp_servers.agent-board.command="/Users/me/.agent-board/bin/agent-board"',
      'mcp_servers.agent-board.args=["mcp"]',
      'mcp_servers.agent-board.env_vars=["AGENT_BOARD_SOCKET","AGENT_BOARD_IDENTITY","AGENT_BOARD_SESSION_ID","AGENT_BOARD_ZONE_ID"]',
      // A question or plan waits up to 4 hours for the user.
      'mcp_servers.agent-board.tool_timeout_sec=14460',
    ]);
  });

  it('leaves out the bypass flag when the zone turns it off', () => {
    const cwd = tempDataDir();
    expect(codexLaunch({ ...base, zoneBypassHookTrust: false, cwd, worktree: cwd }).args).not.toContain('--dangerously-bypass-hook-trust');
  });

  it('finds .codex from the start directory up to the worktree root, and nowhere else', () => {
    const outside = tempDataDir();
    const worktree = join(outside, 'wt');
    mkdirSync(join(worktree, 'apps', 'web', 'src'), { recursive: true });
    mkdirSync(join(outside, '.codex'));
    expect(projectCodexConfig(join(worktree, 'apps', 'web'), worktree)).toBeUndefined();
    mkdirSync(join(worktree, 'apps', 'web', 'src', '.codex'));
    expect(projectCodexConfig(join(worktree, 'apps', 'web'), worktree)).toBeUndefined();
    writeFileSync(join(worktree, '.codex'), '');
    expect(projectCodexConfig(join(worktree, 'apps', 'web'), worktree)).toBe(join(worktree, '.codex'));
    mkdirSync(join(worktree, 'apps', '.codex'));
    expect(projectCodexConfig(join(worktree, 'apps', 'web'), worktree)).toBe(join(worktree, 'apps', '.codex'));
  });

  it('counts a .codex symlink, even a dangling one whose target the agent could fill in later', () => {
    const worktree = tempDataDir();
    symlinkSync(join(worktree, '.cache', 'cx'), join(worktree, '.codex'));
    expect(projectCodexConfig(worktree, worktree)).toBe(join(worktree, '.codex'));

    const other = tempDataDir();
    mkdirSync(join(other, 'real'));
    symlinkSync(join(other, 'real'), join(other, '.codex'));
    expect(projectCodexConfig(other, other)).toBe(join(other, '.codex'));
  });

  // Root can look into any folder, so there's no folder it can't look into to test with.
  it.skipIf(process.getuid?.() === 0)('fails closed: a folder it cannot look into counts as having .codex', () => {
    const worktree = tempDataDir();
    mkdirSync(join(worktree, 'locked', 'web'), { recursive: true });
    chmodSync(join(worktree, 'locked'), 0o000);
    onTestFinished(() => chmodSync(join(worktree, 'locked'), 0o755));
    expect(projectCodexConfig(join(worktree, 'locked', 'web'), worktree)).toBe(join(worktree, 'locked', 'web', '.codex'));
  });
});
