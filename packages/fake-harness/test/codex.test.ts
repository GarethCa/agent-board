import { afterAll, describe, expect, it, onTestFinished } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODEX_HOOK_EVENTS, codexHooksJson } from '../src/index.ts';
import { startEchoHttpServer } from './fixtures/mcp/echo-http-server.ts';
import { readJsonl, removeTempDirs, runFake, sleep, startFake, tempDir, untilStdout, type RunFakeOptions } from './run-fake.ts';

afterAll(removeTempDirs);

const COMMON_FIELDS = ['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'model'];
const TRUST = '--dangerously-bypass-hook-trust';


/** Installs a ~/.codex/hooks.json that logs every event (Codex hooks are command hooks only), then runs the fake. */
async function runWithHooks(options: RunFakeOptions & { codexDir?: (home: string) => string; extraHooks?: object }) {
  const home = options.home ?? tempDir('fake-home-');
  const log = join(tempDir('hook-log-'), 'events.jsonl');
  const codexDir = options.codexDir?.(home) ?? join(home, '.codex');
  mkdirSync(codexDir, { recursive: true });
  const config = codexHooksJson(`{ cat; echo; } >> '${log}'`);
  Object.assign(config.hooks, options.extraHooks);
  writeFileSync(join(codexDir, 'hooks.json'), JSON.stringify(config));
  const result = await runFake('codex', { ...options, home });
  let events: Record<string, unknown>[] = [];
  try {
    events = readJsonl(log);
  } catch {
    // no hook ran
  }
  return { ...result, events, names: events.map((event) => event.hook_event_name) };
}

/** Resolves once `check` holds. */
async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(20);
  }
}

describe('fake codex', () => {
  it('says how it is logged in for login status, and that it is not with FAKE_HARNESS_LOGGED_OUT', async () => {
    const signedIn = await runFake('codex', { scenario: 'output', args: ['login', 'status'] });
    expect(signedIn.code).toBe(0);
    expect(signedIn.stderr).toMatch(/^Logged in using/);

    const signedOut = await runFake('codex', { scenario: 'output', args: ['login', 'status'], env: { FAKE_HARNESS_LOGGED_OUT: '1' } });
    expect(signedOut.code).toBe(1);
    expect(signedOut.stderr).toMatch(/^Not logged in/);
  });

  it('runs hooks.json command hooks for a full turn with Codex field names', async () => {
    const result = await runWithHooks({ scenario: 'output', args: [TRUST, 'fix the tests'] });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('All tests pass.');
    expect(result.names).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']);
    for (const event of result.events) for (const field of COMMON_FIELDS) expect(event).toHaveProperty(field);
    const [start, prompt, pre, post, stop, end] = result.events;
    expect(start).toMatchObject({ source: 'startup' });
    expect(start).not.toHaveProperty('turn_id');
    expect(prompt).toMatchObject({ prompt: 'fix the tests', turn_id: expect.any(String) });
    for (const event of [pre, post, stop]) expect(event!.turn_id).toBe(prompt!.turn_id);
    expect(pre).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: expect.any(String) });
    expect(post).toHaveProperty('tool_response');
    expect(stop).toMatchObject({ stop_hook_active: false, last_assistant_message: 'All tests pass.' });
    expect(end).toMatchObject({ reason: 'other' });
  });

  it('writes a rollout JSONL under ~/.codex/sessions at transcript_path', async () => {
    const result = await runWithHooks({ scenario: 'output', args: [TRUST, 'fix the tests'] });

    const transcriptPath = result.events[0]!.transcript_path as string;
    expect(transcriptPath).toMatch(new RegExp(`^${result.home}/\\.codex/sessions/\\d{4}/\\d{2}/\\d{2}/rollout-.+\\.jsonl$`));
    const lines = readJsonl(transcriptPath);
    expect(lines[0]).toMatchObject({ type: 'session_meta', payload: { id: result.events[0]!.session_id, cwd: result.cwd } });
    expect(lines).toContainEqual(expect.objectContaining({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the tests' }] },
    }));
    expect(lines).toContainEqual(expect.objectContaining({ type: 'response_item', payload: expect.objectContaining({ type: 'custom_tool_call', name: 'exec' }) }));
    expect(lines).toContainEqual(expect.objectContaining({
      type: 'response_item',
      payload: expect.objectContaining({ type: 'custom_tool_call_output', output: [expect.objectContaining({ text: expect.stringContaining('12 passed') }), { type: 'input_text', text: 'exit_code=0' }] }),
    }));
    expect(lines).toContainEqual(expect.objectContaining({ type: 'event_msg', payload: { type: 'agent_message', message: 'All tests pass.' } }));
  });

  it('skips untrusted hooks unless --dangerously-bypass-hook-trust is passed', async () => {
    const result = await runWithHooks({ scenario: 'output', args: ['fix the tests'] });

    expect(result.code).toBe(0);
    expect(result.events).toEqual([]);
    expect(result.stderr).toContain('untrusted');
  });

  it('reads hooks from $CODEX_HOME and from .codex/ at the git root, even when started in a subfolder', async () => {
    const codexHome = tempDir('codex-home-');
    const viaCodexHome = await runWithHooks({
      scenario: 'output',
      args: [TRUST, 'go'],
      codexDir: () => codexHome,
      env: { CODEX_HOME: codexHome },
    });
    expect(viaCodexHome.names).toContain('Stop');

    const repo = tempDir('repo-');
    mkdirSync(join(repo, '.git'));
    mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
    const viaRepo = await runWithHooks({ scenario: 'output', cwd: join(repo, 'apps', 'web'), args: [TRUST, 'go'], codexDir: () => join(repo, '.codex') });
    expect(viaRepo.names).toContain('Stop');
  });

  it('accepts the exec subcommand', async () => {
    const result = await runWithHooks({ scenario: 'output', args: ['exec', TRUST, 'fix the tests'] });

    expect(result.events[1]).toMatchObject({ hook_event_name: 'UserPromptSubmit', prompt: 'fix the tests' });
  });

  it('waiting: stops and takes the next prompt from stdin; Codex has no Notification event', async () => {
    const result = await runWithHooks({ scenario: 'waiting', args: [TRUST, 'set up storage'], input: ['SQLite'] });

    expect(result.stdout).toContain('Going with SQLite.');
    expect(result.names).toEqual([
      'SessionStart', 'UserPromptSubmit', 'Stop', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd',
    ]);
  });

  it('takes ESC CR (Alt+Enter, as Shift+Enter in the app sends it) as a new line in the prompt, not its end', async () => {
    const result = await runWithHooks({ scenario: 'waiting', args: [TRUST, 'set up storage'], input: ['line one\x1b\rline two'] });

    expect(result.events.filter((event) => event.hook_event_name === 'UserPromptSubmit').at(-1)).toMatchObject({ prompt: 'line one\nline two' });
  });

  it('loses the first Enters after text with FAKE_HARNESS_LOSE_ENTERS, as a slow TUI does: the next one submits it', async () => {
    const result = await runWithHooks({
      scenario: 'waiting',
      args: [TRUST, 'set up storage'],
      input: ['SQLite', '', ''],
      env: { FAKE_HARNESS_LOSE_ENTERS: '2' },
    });

    expect(result.events.filter((event) => event.hook_event_name === 'UserPromptSubmit').map((event) => event.prompt)).toEqual([
      'set up storage',
      'SQLite',
    ]);
  });

  it('permission: a PermissionRequest hook decision allows the tool', async () => {
    const allow = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    const result = await runWithHooks({
      scenario: 'permission',
      args: [TRUST, 'clean up'],
      extraHooks: { PermissionRequest: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: `cat > /dev/null; echo '${allow}'` }] }] },
    });

    expect(result.stdout).toContain('Removed dist.');
    expect(result.stdout).not.toContain('(y/n)');
  });

  it('permission: with no decision it prompts and reads y/n from stdin', async () => {
    const result = await runWithHooks({ scenario: 'permission', args: [TRUST, 'clean up'], input: ['n'] });

    expect(result.stdout).toContain('(y/n)');
    expect(result.stdout).toContain('Okay, I left dist alone.');
    expect(result.names).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Stop', 'SessionEnd']);
    expect(result.events[3]).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'rm -rf dist' }, turn_id: expect.any(String) });
  });

  it('subagent: fires SubagentStart and SubagentStop with agent_id and agent_type', async () => {
    const result = await runWithHooks({ scenario: 'subagent', args: [TRUST, 'map the code'] });

    expect(result.names).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SubagentStart', 'SubagentStop', 'PostToolUse', 'Stop', 'SessionEnd']);
    const start = result.events[3]!;
    expect(start).toMatchObject({ agent_type: 'Explore', agent_id: expect.any(String), turn_id: expect.any(String) });
    expect(result.events[4]).toMatchObject({ agent_id: start.agent_id, agent_transcript_path: expect.any(String), last_assistant_message: expect.any(String) });
  });

  it('crash: exits non-zero mid-turn without Stop or SessionEnd', async () => {
    const result = await runWithHooks({ scenario: 'crash', args: [TRUST, 'do it'] });

    expect(result.code).toBe(1);
    expect(result.names).toEqual(['SessionStart', 'UserPromptSubmit']);
  });

  it('sends permission_mode only on the events Codex documents it for (not SessionEnd)', async () => {
    const result = await runWithHooks({ scenario: 'output', args: [TRUST, 'go'] });

    for (const event of result.events) {
      if (event.hook_event_name === 'SessionEnd') expect(event).not.toHaveProperty('permission_mode');
      else expect(event).toHaveProperty('permission_mode');
    }
  });

  it('interactive: keeps taking turns from stdin until EOF; exec exits after one turn', async () => {
    const interactive = await runWithHooks({ scenario: 'output', args: [TRUST, 'go'], input: ['more'] });
    expect(interactive.names).toEqual([
      'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'UserPromptSubmit', 'Stop', 'SessionEnd',
    ]);

    const exec = await runWithHooks({ scenario: 'output', args: ['exec', TRUST, 'go'], input: ['ignored'] });
    expect(exec.names.filter((name) => name === 'UserPromptSubmit')).toHaveLength(1);
  });

  it('fires no hook before its first prompt, as the real TUI fires SessionStart only with it, and draws its composer with its status line', async () => {
    const home = tempDir('fake-home-');
    const cwd = tempDir('fake-cwd-');
    const log = join(tempDir('hook-log-'), 'events.jsonl');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify(codexHooksJson(`{ cat; echo; } >> '${log}'`)));
    const { child, done } = startFake('codex', { scenario: 'output', args: [TRUST, '-m', 'gpt-5.5'], home, cwd });

    await untilStdout(child, `gpt-5.5 default · ${cwd}`);
    await sleep(200);
    expect(existsSync(log)).toBe(false);
    child.stdin.end('fix the tests\n');
    await done;

    expect(readJsonl(log).map((event) => event.hook_event_name)).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']);
    expect(readJsonl(log)[0]).toMatchObject({ source: 'startup' });
  });

  it('keeps its composer and status line drawn under each prompt it takes, as the real TUI does through a turn', async () => {
    const cwd = tempDir('fake-cwd-');
    const result = await runFake('codex', { scenario: 'output', args: [TRUST], cwd, input: ['fix the tests', 'and the docs'] });

    for (const prompt of ['> fix the tests', '> and the docs']) {
      const after = result.stdout.slice(result.stdout.indexOf(prompt));
      expect(after.indexOf('› Ask Codex to do anything')).toBeLessThan(after.indexOf(`default · ${cwd}`));
      expect(after.indexOf('› Ask Codex to do anything')).toBeGreaterThan(0);
    }
  });

  it.each(['folder-trust', 'hooks-review'])('with FAKE_HARNESS_START_SCREEN=%s draws its composer, then that screen over it, and its status line only once Enter answers it', async (screen) => {
    const cwd = tempDir('fake-cwd-');
    const { child, done } = startFake('codex', { scenario: 'output', args: [TRUST], cwd, env: { FAKE_HARNESS_START_SCREEN: screen } });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));

    await untilStdout(child, screen === 'folder-trust' ? '1. Trust and continue' : '2. Trust all and continue');
    expect(stdout).toContain('› Ask Codex to do anything');
    await sleep(200);
    expect(stdout).not.toContain(' · ' + cwd);
    child.stdin.write('\n');
    await untilStdout(child, `default · ${cwd}`);
    child.stdin.end();
    expect((await done).code).toBe(0);
  });

  it('SIGINT (Ctrl-C) interrupts the turn: an Interrupt hook and no Stop, then the next prompt', async () => {
    const home = tempDir('fake-home-');
    const log = join(tempDir('hook-log-'), 'events.jsonl');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify(codexHooksJson(`{ cat; echo; } >> '${log}'`)));
    const names = () => {
      try {
        return readJsonl(log).map((event) => event.hook_event_name);
      } catch {
        return []; // not written yet, or a hook is mid-write
      }
    };
    const { child, done } = startFake('codex', {
      scenario: 'output',
      args: [TRUST, 'go'],
      home,
      env: { FAKE_HARNESS_STEP_DELAY_MS: '100' },
    });

    await until(() => names().includes('UserPromptSubmit'));
    child.kill('SIGINT');
    await until(() => names().includes('Interrupt'));
    child.stdin.end('more\n');
    const result = await done;

    expect(result.code).toBe(0);
    expect(names()).toEqual(['SessionStart', 'UserPromptSubmit', 'Interrupt', 'UserPromptSubmit', 'Stop', 'SessionEnd']);
    const interrupt = readJsonl(log)[2]!;
    expect(interrupt).toMatchObject({ turn_id: readJsonl(log)[1]!.turn_id, permission_mode: expect.any(String) });
  });

  it('resume <id> continues that session', async () => {
    const home = tempDir('fake-home-');
    const cwd = tempDir('fake-cwd-');
    const first = await runWithHooks({ scenario: 'output', home, cwd, args: ['exec', TRUST, 'fix the tests'] });
    const sessionId = first.events[0]!.session_id as string;

    const result = await runWithHooks({ scenario: 'output', home, cwd, args: ['resume', sessionId, TRUST, 'go on'] });

    expect(result.events[0]).toMatchObject({ source: 'resume', session_id: sessionId });
    expect(result.events[1]).toMatchObject({ prompt: 'go on' });
  });

  it('resume <id> fails, as Codex does, when it has no saved session by that id', async () => {
    const result = await runWithHooks({ scenario: 'output', args: ['resume', 'sess-123', TRUST, 'go on'] });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('no saved session sess-123');
    expect(result.events).toEqual([]);
  });

  it('resume <id> replays that session, then waits at the prompt for a plain turn', async () => {
    const home = tempDir('fake-home-');
    const cwd = tempDir('fake-cwd-');
    const first = await runWithHooks({ scenario: 'output', home, cwd, args: ['exec', TRUST, 'fix the tests'] });
    const sessionId = first.events[0]!.session_id as string;

    const resumed = await runWithHooks({ scenario: 'output', home, cwd, args: ['resume', sessionId, TRUST], input: ['and the docs'] });

    expect(resumed.stdout.indexOf('> fix the tests')).toBeLessThan(resumed.stdout.indexOf('All tests pass.'));
    expect(resumed.stdout).toContain('Done: and the docs.');
    expect(resumed.names).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd']);
    expect(resumed.events[0]).toMatchObject({ source: 'resume', session_id: sessionId });
  });

  it.each([
    ['an invalid matcher regex', { Stop: [{ matcher: '(', hooks: [{ type: 'command', command: 'true' }] }] }, []],
    ['an unknown option', undefined, ['--no-such-flag']],
  ])('exits 2 with a clear message on %s', async (_, extraHooks, args) => {
    const result = await runWithHooks({ scenario: 'output', args: [TRUST, ...args, 'go'], extraHooks });

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/^codex: /);
    expect(result.stderr).not.toContain('    at ');
  });
});

describe('fake codex -c overrides', () => {
  /** `-c hooks.<Event>=…` for every event, as the daemon passes them, logging each payload to a file. */
  function hookOverrides(log: string): string[] {
    const command = JSON.stringify(`{ cat; echo; } >> '${log}'`);
    return CODEX_HOOK_EVENTS.flatMap((event) => ['-c', `hooks.${event}=[{hooks=[{type="command",command=${command},timeout=5}]}]`]);
  }

  it('runs hooks passed as -c overrides, alongside hooks.json, once trust is bypassed', async () => {
    const log = join(tempDir('hook-log-'), 'events.jsonl');
    const result = await runWithHooks({ scenario: 'output', args: [...hookOverrides(log), TRUST, '--', 'fix the tests'] });

    expect(result.code).toBe(0);
    expect(readJsonl(log).map((event) => event.hook_event_name)).toEqual(result.names);
    expect(result.names).toContain('Stop');
  });

  it('skips -c hooks as untrusted without the bypass flag', async () => {
    const log = join(tempDir('hook-log-'), 'events.jsonl');
    const result = await runFake('codex', { scenario: 'output', args: [...hookOverrides(log), 'fix the tests'] });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain('untrusted hook group(s)');
    expect(existsSync(log)).toBe(false);
  });

  it('accepts other -c overrides it has no use for, and rejects one that is not key=value', async () => {
    const ok = await runFake('codex', { scenario: 'output', args: ['-c', 'shell_environment_policy.exclude=["AGENT_BOARD_*"]', 'hi'] });
    expect(ok.code).toBe(0);
    const bad = await runFake('codex', { scenario: 'output', args: ['-c', 'hooks.Stop', 'hi'] });
    expect(bad.code).toBe(2);
    const badHooks = await runFake('codex', { scenario: 'output', args: ['-c', 'hooks.Stop=[{hooks=1}]', 'hi'] });
    expect(badHooks.code).toBe(2);
  });
});

describe('codex MCP servers and the model shell', () => {
  const server = join(import.meta.dirname, 'fixtures', 'mcp', 'echo-server.mjs');

  it('starts a -c mcp_servers server with only the env vars it names, and hides excluded vars from shell commands', async () => {
    const result = await runFake('codex', {
      scenario: 'board',
      args: [
        '-c', `mcp_servers.agent-board.command=${JSON.stringify(process.execPath)}`,
        '-c', `mcp_servers.agent-board.args=[${JSON.stringify(server)}]`,
        '-c', 'mcp_servers.agent-board.env_vars=["BOARD_VISIBLE"]',
        '-c', 'shell_environment_policy.exclude=["AGENT_BOARD_HOOK_*"]',
        'Map the board',
      ],
      env: { BOARD_VISIBLE: 'yes', SECRET: 'hidden', AGENT_BOARD_HOOK_TOKEN: 'hook-secret', AGENT_BOARD_HOOK_URL: 'http://hooks' },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('The board says: You are on the echo board.');
    expect(result.stdout).toContain('whoami {} env:yes|-');
    expect(result.stdout).toContain('set_status {"summary":"Map the board","progress":10} env:yes|-');
    expect(result.stdout).toContain('hook env: none none');
  });

  it('posts to a -c mcp_servers url server with the bearer token from the env var it names', async () => {
    const http = await startEchoHttpServer();
    onTestFinished(http.close);
    const result = await runFake('codex', {
      scenario: 'board',
      args: [
        '-c', `mcp_servers.agent-board.url=${JSON.stringify(http.url)}`,
        '-c', 'mcp_servers.agent-board.bearer_token_env_var="BOARD_SECRET"',
        'Map the board',
      ],
      env: { BOARD_SECRET: 'from-env' },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('The board says: You are on the echo board.');
    expect(result.stdout).toContain('whoami {} auth:Bearer from-env');
    expect(result.stdout).toContain('set_status {"summary":"Map the board","progress":10} auth:Bearer from-env');
  });

  it('keeps vars named like keys, secrets and tokens from shell commands by default, as Codex does', async () => {
    const env = { AGENT_BOARD_HOOK_TOKEN: 'hook-secret', AGENT_BOARD_HOOK_URL: 'http://hooks' };
    expect((await runFake('codex', { scenario: 'board', args: ['Look around'], env })).stdout).toContain('hook env: none http://hooks');

    const ignoring = await runFake('codex', {
      scenario: 'board',
      args: ['-c', 'shell_environment_policy.ignore_default_excludes=true', 'Look around'],
      env,
    });
    expect(ignoring.stdout).toContain('There is no agent-board MCP server here.');
    expect(ignoring.stdout).toContain('hook env: hook-secret http://hooks');
  });
});
