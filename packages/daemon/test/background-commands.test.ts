import { describe, expect, it } from 'vitest';
import {
  childrenOf,
  createBackgroundCommands,
  liveCommands,
  parseElapsed,
  parseProcessList,
  shellCommandOf,
  type ProcessEntry,
} from '../src/background-commands.ts';

const CLAUDE_WRAPPER = (command: string) =>
  `/bin/zsh -c source /Users/me/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && setopt NO_EXTENDED_GLOB 2>/dev/null || true && eval '${command.replaceAll("'", `'"'"'`).replaceAll('\n', '\\012')}' < /dev/null && pwd -P >| /tmp/claude-ab22-cwd`;

const T0 = Date.parse('2026-01-01T12:00:00.000Z');

describe('parseElapsed', () => {
  it('reads every form ps prints', () => {
    expect(parseElapsed('00:07')).toBe(7_000);
    expect(parseElapsed('12:34')).toBe((12 * 60 + 34) * 1000);
    expect(parseElapsed('01:00:00')).toBe(3_600_000);
    expect(parseElapsed('2-03:04:05')).toBe((((2 * 24 + 3) * 60 + 4) * 60 + 5) * 1000);
    expect(parseElapsed('soon')).toBeNaN();
  });
});

describe('parseProcessList', () => {
  it('keeps each process with its command line, spaces and all', () => {
    expect(parseProcessList('  12     1   01:02 /bin/zsh -c sleep  30\n   bad line\n')).toEqual([
      { pid: 12, ppid: 1, elapsedMs: 62_000, args: '/bin/zsh -c sleep  30' },
    ]);
  });
});

describe('shellCommandOf', () => {
  it("takes Claude Code's wrapper off the command, quotes and all", () => {
    expect(shellCommandOf(CLAUDE_WRAPPER("pnpm check:pr 2>&1 | grep 'chose'"))).toBe("pnpm check:pr 2>&1 | grep 'chose'");
    expect(shellCommandOf(CLAUDE_WRAPPER("cat > a <<'EOF'\nhi\nEOF"))).toBe("cat > a <<'EOF'\nhi\nEOF");
    expect(shellCommandOf(`/bin/zsh -c true && eval 'echo '\\''hi'\\''' < /dev/null && pwd -P >| /tmp/cwd`)).toBe("echo 'hi'");
    // With a heredoc, the wrapper leaves out `< /dev/null`.
    expect(shellCommandOf(`/bin/zsh -c source s.sh && eval 'cat > f <<'"'"'EOF'"'"'\\012hi\\012EOF' && pwd -P >| /tmp/cwd`)).toBe("cat > f <<'EOF'\nhi\nEOF");
  });

  it("reads a Codex shell's script, after its flags", () => {
    expect(shellCommandOf('/bin/zsh -lc pnpm check:pr')).toBe('pnpm check:pr');
    expect(shellCommandOf('/bin/bash -c -l make build')).toBe('make build');
    expect(shellCommandOf('-zsh -c sleep 5')).toBe('sleep 5');
    expect(shellCommandOf('/bin/bash --norc --noprofile -c sleep 5')).toBe('sleep 5');
  });

  it("is nothing for a process that isn't a shell running a command, or for a hook's forwarder", () => {
    expect(shellCommandOf('caffeinate -i -t 300')).toBeUndefined();
    expect(shellCommandOf('node /usr/local/bin/some-mcp-server')).toBeUndefined();
    expect(shellCommandOf('/bin/sh /opt/agent-board mcp')).toBeUndefined();
    expect(shellCommandOf('/bin/zsh -l')).toBeUndefined();
    expect(shellCommandOf('/bin/sh -c "/Users/me/.agent-board/bin/agent-board-hook" codex')).toBeUndefined();
  });
});

describe('liveCommands', () => {
  const HARNESS = 100;
  const processes: ProcessEntry[] = [
    { pid: HARNESS, ppid: 1, elapsedMs: 3_600_000, args: 'claude --session-id x' },
    { pid: 101, ppid: HARNESS, elapsedMs: 600_000, args: 'caffeinate -i -t 300' },
    { pid: 102, ppid: HARNESS, elapsedMs: 120_000, args: CLAUDE_WRAPPER('pnpm check:pr') },
    // The gate's own shells, under the command: not commands of their own.
    { pid: 103, ppid: 102, elapsedMs: 119_000, args: '/bin/sh -c vitest run' },
    // Codex's sandbox runs the shell, one level down.
    { pid: 104, ppid: HARNESS, elapsedMs: 30_000, args: '/usr/bin/sandbox-exec -p (version 1) -- /bin/zsh -lc npm run dev' },
    { pid: 105, ppid: 104, elapsedMs: 30_000, args: '/bin/zsh -lc npm run dev' },
    // Another agent's.
    { pid: 200, ppid: 1, elapsedMs: 10_000, args: '/bin/zsh -c sleep 99' },
  ];
  const children = childrenOf(processes);

  it('finds each command under the harness, longest-running first, named and timed by its hooks when they named it', () => {
    const recorded = [{ toolUseId: 't1', taskId: 'b1', command: 'pnpm check:pr', startedAt: T0 - 125_000 }];
    expect(liveCommands(children, HARNESS, recorded, T0)).toEqual([
      { command: 'pnpm check:pr', startedAt: new Date(T0 - 125_000).toISOString() },
      { command: 'npm run dev', startedAt: new Date(T0 - 30_000).toISOString() },
    ]);
  });

  it('is none once nothing runs under the harness', () => {
    expect(liveCommands(childrenOf(processes.slice(0, 2)), HARNESS, [], T0)).toEqual([]);
  });

  it('never counts a shell under an MCP server or any other program the harness runs', () => {
    const servers = childrenOf([
      // `npx some-mcp` runs `npm exec`, which runs the server in `sh -c`.
      { pid: 110, ppid: HARNESS, elapsedMs: 3_000_000, args: 'node /usr/local/bin/npm exec some-mcp' },
      { pid: 111, ppid: 110, elapsedMs: 3_000_000, args: '/bin/sh -c some-mcp --stdio' },
      { pid: 112, ppid: HARNESS, elapsedMs: 3_000_000, args: 'node /opt/server.js' },
      { pid: 113, ppid: 112, elapsedMs: 1_000, args: '/bin/sh -c git status' },
    ]);
    expect(liveCommands(servers, HARNESS, [], T0)).toEqual([]);
  });

  it('names a shell only after the command it runs exactly, each command naming one shell', () => {
    const shells = childrenOf([
      { pid: 120, ppid: HARNESS, elapsedMs: 4_000, args: '/bin/sh -c sleep 5' },
      { pid: 121, ppid: HARNESS, elapsedMs: 2_000, args: '/bin/sh -c sleep 5' },
    ]);
    const recorded = [
      { toolUseId: 't1', taskId: null, command: 'sleep 50', startedAt: T0 - 60_000 },
      { toolUseId: 't2', taskId: null, command: 'sleep 5', startedAt: T0 - 3_000 },
    ];
    expect(liveCommands(shells, HARNESS, recorded, T0)).toEqual([
      { command: 'sleep 5', startedAt: new Date(T0 - 3_000).toISOString() },
      { command: 'sleep 5', startedAt: new Date(T0 - 2_000).toISOString() },
    ]);
  });

  it('steps once through the real Codex that npm\'s wrapper runs, but no further', () => {
    const npm = childrenOf([
      { pid: 140, ppid: HARNESS, elapsedMs: 600_000, args: '/opt/homebrew/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/codex/codex' },
      { pid: 141, ppid: 140, elapsedMs: 60_000, args: '/bin/zsh -lc pnpm check:pr' },
      { pid: 142, ppid: 140, elapsedMs: 30_000, args: '/usr/bin/sandbox-exec -p (version 1) -- /bin/zsh -lc make' },
      { pid: 143, ppid: 142, elapsedMs: 30_000, args: '/bin/zsh -lc make' },
      { pid: 144, ppid: 140, elapsedMs: 600_000, args: '/usr/local/bin/codex mcp' },
      { pid: 145, ppid: 144, elapsedMs: 1_000, args: '/bin/sh -c deeper' },
    ]);
    expect(liveCommands(npm, HARNESS, [], T0).map((each) => each.command)).toEqual(['pnpm check:pr', 'make']);
  });

  it("never counts the hook forwarder's runs, wherever its launcher is", () => {
    const hooks = childrenOf([{ pid: 130, ppid: HARNESS, elapsedMs: 100, args: '/bin/sh -c "/tmp/e2e/hook-shim" codex' }]);
    expect(liveCommands(hooks, HARNESS, [], T0, ['/tmp/e2e/hook-shim'])).toEqual([]);
  });
});

describe('createBackgroundCommands', () => {
  function setup(atPrompt: () => { sessionId: string; harness: 'claude' | 'codex' }[]) {
    let table: ProcessEntry[] = [];
    let now = T0;
    let reads = 0;
    const changes: string[] = [];
    const commands = createBackgroundCommands({
      atPrompt,
      pidOf: (sessionId) => (sessionId === 'claude-agent' ? 100 : sessionId === 'codex-agent' ? 300 : undefined),
      changed: (sessionId) => changes.push(sessionId),
      list: async () => {
        reads += 1;
        return table;
      },
      now: () => now,
      pollMs: 60_000,
    });
    return {
      commands,
      changes,
      reads: () => reads,
      setTable: (next: ProcessEntry[]) => (table = next),
      advance: (ms: number) => (now += ms),
    };
  }

  const backgroundBash = (command: string) => ({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'toolu_1',
    tool_input: { command, run_in_background: true },
  });

  it("finds what a Claude agent's turn left running once the turn ends, until it finishes", async () => {
    const at = setup(() => [{ sessionId: 'claude-agent', harness: 'claude' }]);
    at.commands.onHook('claude-agent', backgroundBash('pnpm check:pr'));
    at.commands.onHook('claude-agent', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_use_id: 'toolu_1',
      tool_response: { stdout: '', backgroundTaskId: 'b1' },
    });
    at.setTable([{ pid: 150, ppid: 100, elapsedMs: 1_000, args: CLAUDE_WRAPPER('pnpm check:pr') }]);
    at.advance(1_000);
    at.commands.onHook('claude-agent', { hook_event_name: 'Stop' });
    // Until the process table is read, the command its hooks named counts: the turn's end already shows it.
    const running = [{ command: 'pnpm check:pr', startedAt: new Date(T0).toISOString() }];
    expect(at.commands.of('claude-agent')).toEqual(running);
    await at.commands.refresh();
    expect(at.commands.of('claude-agent')).toEqual(running);
    // The read found what was already shown: no news.
    expect(at.changes).toEqual([]);

    at.setTable([]);
    at.advance(60_000);
    await at.commands.refresh();
    expect(at.commands.of('claude-agent')).toEqual([]);
    expect(at.changes).toEqual(['claude-agent']);
  });

  it('waits for the read before showing a command its turn started long ago, which may have ended in the turn', async () => {
    const at = setup(() => [{ sessionId: 'claude-agent', harness: 'claude' }]);
    at.commands.onHook('claude-agent', backgroundBash('sleep 20'));
    at.advance(30_000);
    at.commands.onHook('claude-agent', { hook_event_name: 'Stop' });
    expect(at.commands.of('claude-agent')).toEqual([]);
    await at.commands.refresh();
    expect(at.commands.of('claude-agent')).toEqual([]);
    expect(at.changes).toEqual([]);
  });

  it('never reads the process table for a Claude agent its hooks named no command for', async () => {
    const at = setup(() => [{ sessionId: 'claude-agent', harness: 'claude' }]);
    await at.commands.refresh();
    expect(at.reads()).toBe(0);
  });

  it("finds a Codex agent's commands from the process table alone", async () => {
    const at = setup(() => [{ sessionId: 'codex-agent', harness: 'codex' }]);
    at.setTable([{ pid: 301, ppid: 300, elapsedMs: 90_000, args: '/bin/zsh -lc pnpm check:pr' }]);
    await at.commands.refresh();
    expect(at.commands.of('codex-agent')).toEqual([{ command: 'pnpm check:pr', startedAt: new Date(T0 - 90_000).toISOString() }]);
  });

  it('shows none once the agent is mid-turn again, and none for a command its hooks named that never ran', async () => {
    let prompt = true;
    const at = setup(() => (prompt ? [{ sessionId: 'claude-agent', harness: 'claude' }] : []));
    at.commands.onHook('claude-agent', backgroundBash('sleep 600'));
    at.setTable([{ pid: 150, ppid: 100, elapsedMs: 0, args: CLAUDE_WRAPPER('sleep 600') }]);
    await at.commands.refresh();
    expect(at.commands.of('claude-agent')).toHaveLength(1);
    prompt = false;
    await at.commands.refresh();
    expect(at.commands.of('claude-agent')).toEqual([]);

    // A status that says the gate still runs changes nothing: no process runs it.
    prompt = true;
    at.setTable([]);
    at.advance(30 * 60_000);
    await at.commands.refresh();
    expect(at.commands.of('claude-agent')).toEqual([]);
    expect(at.reads()).toBe(2);
    await at.commands.refresh();
    // Its record is gone: nothing more to look for.
    expect(at.reads()).toBe(2);
  });

  it('drops a command its agent stopped', async () => {
    const at = setup(() => [{ sessionId: 'claude-agent', harness: 'claude' }]);
    at.commands.onHook('claude-agent', backgroundBash('sleep 600'));
    at.commands.onHook('claude-agent', { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1', tool_response: { backgroundTaskId: 'b9' } });
    at.commands.onHook('claude-agent', { hook_event_name: 'PostToolUse', tool_name: 'KillShell', tool_input: { shell_id: 'b9' }, tool_response: {} });
    await at.commands.refresh();
    expect(at.reads()).toBe(0);
  });

  it('reads once more when asked while a read is under way', async () => {
    const at = setup(() => [{ sessionId: 'codex-agent', harness: 'codex' }]);
    await Promise.all([at.commands.refresh(), at.commands.refresh(), at.commands.refresh()]);
    expect(at.reads()).toBe(2);
  });
});
