import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { AgentHostOptions, ZoneRow } from '../src/agents.ts';
import { claudeSettings, codexLaunch, createAgentSpawns, defaultName, harnessLaunch, type LaunchSpec } from '../src/agent-spawns.ts';
import { projectCodexConfig } from '../src/codex-config-guard.ts';
import { CODEX_HOOK_TIMEOUTS, HOOK_TOKEN_ENV, HOOK_URL_ENV } from '../src/hook-forwarder.ts';
import { migrate } from '../src/migrate.ts';
import { AGENT_ERROR, type SessionInfo } from '../src/protocol.ts';
import type { SessionSpec } from '../src/sessions.ts';
import { hashToken } from '../src/tokens.ts';
import { tempDataDir } from './helpers.ts';

const HOOK_URL = 'http://127.0.0.1:4242/hook';
const MCP_URL = 'http://127.0.0.1:4242/mcp';

/** Agent spawns over a fresh database, harnesses in /bin, recording the sessions they start. */
function setup(zone: Partial<ZoneRow> = {}) {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  onTestFinished(() => db.close());
  const started: SessionSpec[] = [];
  const unused = (): never => {
    throw new Error('not used by a launch');
  };
  const spawns = createAgentSpawns({
    db,
    sessions: {
      start(spec) {
        started.push(spec);
        return { id: spec.id } as SessionInfo;
      },
    },
    worktreesDir: '/worktrees',
    scratchDir: '/scratch',
    rememberFolder: unused,
    harnessPaths: {
      path: (harness) => (harness === 'codex' ? '/bin/codex' : '/bin/claude'),
      refresh: unused,
      pending: async () => {},
      launchEnv: (env) => ({ ...env }),
      notFound: (harness) => `${harness} not found`,
    },
    hookShimPath: '/shim/agent-board-hook',
    ensureHookShim() {},
    boardCliPath: '/bin/agent-board',
    env: { PATH: '/bin', CLAUDECODE: '1' },
    shell: '/bin/zsh',
    shellArgs: [],
    hookUrl: () => HOOK_URL,
    boardMcpUrl: () => MCP_URL,
    permissionHoldMs: 60_000,
    trackers: { issue: unused } as AgentHostOptions['trackers'],
    roleTemplates: { body: unused, describe: unused },
    broadcast: unused,
    log() {},
    getRow: unused,
    get: unused,
    rows: unused,
    getZone: () => ({ board_mcp: 1, ...zone }) as ZoneRow,
    repoZoneFor: unused,
    announce: unused,
    watch: unused,
  });
  return { spawns, started };
}

describe("launching an agent's harness", () => {
  const spec = (fields: Partial<LaunchSpec> = {}): LaunchSpec => {
    const cwd = tempDataDir();
    return {
      id: 'a',
      harness: 'claude',
      model: 'opus',
      bypassHookTrust: true,
      zoneId: 'z',
      cwd,
      worktree: cwd,
      task: '-fix it',
      allowProjectCodexConfig: false,
      size: { cols: 100, rows: 30 },
      ...fields,
    };
  };

  it('starts claude on a new conversation with hooks to the daemon, the board MCP server, its model and its task', () => {
    const { spawns, started } = setup();
    const launching = spec();
    expect(spawns.launch(launching)).toBe(false);
    const [session] = started;
    expect(session).toMatchObject({ id: 'a', harness: 'claude', command: '/bin/claude', cwd: launching.cwd, zoneId: 'z', cols: 100, rows: 30 });
    expect(session!.args).toEqual([
      '--session-id',
      'a',
      '--settings',
      JSON.stringify(claudeSettings(HOOK_URL, 60_000)),
      '--mcp-config',
      // Over HTTP to the daemon, with the board token Claude fills in from its own env: no process of its own.
      JSON.stringify({ mcpServers: { 'agent-board': { type: 'http', url: MCP_URL, headers: { Authorization: 'Bearer ${AGENT_BOARD_IDENTITY}' } } } }),
      '--model',
      'opus',
      '--',
      '-fix it',
    ]);
    // A daemon started from inside Claude Code doesn't make its agents think they are nested in it.
    expect(session!.env.CLAUDECODE).toBeUndefined();
    expect(session!.env[HOOK_URL_ENV]).toBe(HOOK_URL);
    expect(session!.hookTokenSha256).toBe(hashToken(session!.env[HOOK_TOKEN_ENV]!));
  });

  it('gives a claude agent the board MCP over HTTP and a codex agent the stdio server', () => {
    const { spawns, started } = setup();
    spawns.launch(spec({ harness: 'claude' }));
    spawns.launch(spec({ harness: 'codex' }));
    const [claude, codex] = started;
    const mcpConfig = JSON.parse(claude!.args[claude!.args.indexOf('--mcp-config') + 1]!);
    expect(mcpConfig.mcpServers['agent-board']).toEqual({ type: 'http', url: MCP_URL, headers: { Authorization: 'Bearer ${AGENT_BOARD_IDENTITY}' } });
    const overrides = codex!.args.filter((_, i) => codex!.args[i - 1] === '-c' && codex!.args[i]!.startsWith('mcp_servers.'));
    expect(overrides).toContain('mcp_servers.agent-board.command="/bin/agent-board"');
    expect(overrides).toContain('mcp_servers.agent-board.args=["mcp"]');
    expect(overrides.some((o) => o.includes('.url='))).toBe(false);
  });

  it('carries on the conversation when resuming, unless it never had one, and leaves the MCP server out when its zone does', () => {
    const { spawns, started } = setup({ board_mcp: 0 });
    spawns.launch(spec({ model: null, task: undefined, resume: { codexSessionId: null } }));
    spawns.launch(spec({ model: null, task: undefined, resume: { codexSessionId: null, claudeConversation: false } }));
    expect(started.map((session) => session.args.filter((arg) => arg !== JSON.stringify(claudeSettings(HOOK_URL, 60_000))))).toEqual([
      ['--resume', 'a', '--settings'],
      ['--session-id', 'a', '--settings'],
    ]);
  });

  it('refuses codex in a worktree with Codex config of its own unless allowed, and then starts it without the bypass flag', () => {
    const { spawns, started } = setup();
    const withConfig = spec({ harness: 'codex' });
    mkdirSync(join(withConfig.worktree, '.codex'));
    expect(() => spawns.launch(withConfig)).toThrow(expect.objectContaining({ code: AGENT_ERROR.projectCodexConfig }));
    expect(started).toEqual([]);
    expect(spawns.launch({ ...withConfig, allowProjectCodexConfig: true })).toBe(false);
    expect(spawns.launch(spec({ harness: 'codex' }))).toBe(true);
    expect(started.map((session) => session.args.includes('--dangerously-bypass-hook-trust'))).toEqual([false, true]);
  });
});

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

  it('runs the board MCP server from the CLI over stdio, passing it the board env, when given the CLI', () => {
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

  it('starts a read-only agent in Codex’s read-only sandbox, before its prompt', () => {
    const cwd = tempDataDir();
    const { args } = codexLaunch({ ...base, cwd, worktree: cwd, readOnly: true, prompt: 'Review' });
    expect(args.slice(-4)).toEqual(['-s', 'read-only', '--', 'Review']);
    expect(codexLaunch({ ...base, cwd, worktree: cwd }).args).not.toContain('read-only');
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
