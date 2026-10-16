import { afterAll, afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeHookSettings, startHookRecorder, type HookRecorder } from '../src/index.ts';
import { startEchoHttpServer } from './fixtures/mcp/echo-http-server.ts';
import { readJsonl, removeTempDirs, runFake, sleep, startFake, tempDir, untilEvents, untilStdout } from './run-fake.ts';

afterAll(removeTempDirs);

const COMMON_FIELDS = ['session_id', 'transcript_path', 'cwd', 'permission_mode', 'hook_event_name'];


describe('fake claude', () => {
  let recorder: HookRecorder;

  beforeEach(async () => {
    recorder = await startHookRecorder();
  });

  afterEach(async () => {
    await recorder.close();
  });

  function settings(): string {
    return JSON.stringify(claudeHookSettings(recorder.url));
  }

  it('streams scripted output for a prompt and exits cleanly', async () => {
    const result = await runFake('claude', { scenario: 'output', args: ['fix the tests'] });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('All tests pass.');
  });

  it('posts the hook events of a full turn to --settings http hooks, with documented fields', async () => {
    const result = await runFake('claude', {
      scenario: 'output',
      args: ['-p', '--settings', settings(), '--session-id', '11111111-2222-3333-4444-555555555555', 'fix the tests'],
    });

    expect(result.code).toBe(0);
    expect(recorder.events.map((event) => event.hook_event_name)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'PreToolUse',
      'PostToolUse',
      'Stop',
      'SessionEnd',
    ]);
    for (const event of recorder.events) {
      for (const field of COMMON_FIELDS) expect(event).toHaveProperty(field);
      expect(event.session_id).toBe('11111111-2222-3333-4444-555555555555');
      expect(event.cwd).toBe(result.cwd);
    }
    const [start, prompt, pre, post, stop, end] = recorder.events;
    expect(start).toMatchObject({ source: 'startup' });
    expect(prompt).toMatchObject({ prompt: 'fix the tests' });
    expect(pre).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'npm test' } });
    expect(pre!.tool_use_id).toEqual(post!.tool_use_id);
    expect(post).toHaveProperty('tool_response');
    expect(stop).toMatchObject({ stop_hook_active: false, last_assistant_message: 'All tests pass.' });
    expect(end).toHaveProperty('reason');
  });

  it('writes the transcript JSONL under ~/.claude/projects at transcript_path', async () => {
    const result = await runFake('claude', { scenario: 'output', args: ['-p', '--settings', settings(), 'fix the tests'] });

    const transcriptPath = recorder.events[0]!.transcript_path as string;
    expect(transcriptPath.startsWith(`${result.home}/.claude/projects/`)).toBe(true);
    expect(existsSync(transcriptPath)).toBe(true);
    const entries = readJsonl(transcriptPath);
    expect(entries[0]).toMatchObject({ type: 'user', message: { role: 'user', content: 'fix the tests' } });
    expect(entries.at(-1)).toMatchObject({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'All tests pass.' }] },
    });
    for (const entry of entries) expect(entry).toMatchObject({ sessionId: recorder.events[0]!.session_id, cwd: result.cwd });
  });

  it('waiting: stops, raises an idle_prompt notification and takes the next prompt from stdin', async () => {
    const result = await runFake('claude', { scenario: 'waiting', args: ['--settings', settings(), 'set up storage'], input: ['SQLite'] });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Going with SQLite.');
    expect(recorder.events.map((event) => event.hook_event_name)).toEqual([
      'SessionStart', 'UserPromptSubmit', 'Stop', 'Notification', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop',
      'Notification', 'SessionEnd',
    ]);
    expect(recorder.events[2]).toMatchObject({ last_assistant_message: 'Which database should I use, Postgres or SQLite?' });
    expect(recorder.events[3]).toMatchObject({ notification_type: 'idle_prompt', message: expect.any(String) });
    expect(recorder.events[4]).toMatchObject({ prompt: 'SQLite' });
  });

  it('takes ESC CR (Shift+Enter in the app, Option+Enter in a terminal) as a new line in the prompt, not its end', async () => {
    const result = await runFake('claude', { scenario: 'waiting', args: ['--settings', settings(), 'set up storage'], input: ['line one\x1b\rline two'] });

    expect(result.code).toBe(0);
    expect(recorder.events.filter((event) => event.hook_event_name === 'UserPromptSubmit').at(-1)).toMatchObject({ prompt: 'line one\nline two' });
  });

  it('waiting: exits when stdin closes at the prompt', async () => {
    const result = await runFake('claude', { scenario: 'waiting', args: ['--settings', settings(), 'set up storage'] });

    expect(result.code).toBe(0);
    expect(recorder.events.at(-1)).toMatchObject({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
  });

  it('permission: a PermissionRequest hook that answers allow lets the tool run without prompting', async () => {
    await recorder.close();
    recorder = await startHookRecorder((event) =>
      event.hook_event_name === 'PermissionRequest'
        ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
        : undefined,
    );

    const result = await runFake('claude', { scenario: 'permission', args: ['-p', '--settings', settings(), 'clean up'] });

    expect(result.stdout).toContain('Removed dist.');
    const names = recorder.events.map((event) => event.hook_event_name);
    expect(names).toEqual(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop', 'SessionEnd']);
    expect(recorder.events[3]).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'rm -rf dist' }, permission_suggestions: [] });
  });

  it('permission: a deny decision skips the tool', async () => {
    await recorder.close();
    recorder = await startHookRecorder((event) =>
      event.hook_event_name === 'PermissionRequest'
        ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'no' } } }
        : undefined,
    );

    const result = await runFake('claude', { scenario: 'permission', args: ['-p', '--settings', settings(), 'clean up'] });

    expect(result.stdout).toContain('Okay, I left dist alone.');
    expect(recorder.events.map((event) => event.hook_event_name)).not.toContain('PostToolUse');
  });

  it('permission: with no hook decision it shows a prompt, notifies permission_prompt and reads y/n from stdin', async () => {
    const result = await runFake('claude', { scenario: 'permission', args: ['-p', '--settings', settings(), 'clean up'], input: ['y'] });

    expect(result.stdout).toContain('Do you want to allow Bash? (y/n)');
    expect(result.stdout).toContain('Removed dist.');
    const names = recorder.events.map((event) => event.hook_event_name);
    expect(names).toEqual([
      'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'Notification', 'PostToolUse', 'Stop', 'SessionEnd',
    ]);
    expect(recorder.events[4]).toMatchObject({ notification_type: 'permission_prompt' });
  });

  it('subagent: spawns a subagent through the Agent tool with SubagentStart/SubagentStop and its own transcript', async () => {
    const result = await runFake('claude', { scenario: 'subagent', args: ['-p', '--settings', settings(), 'map the code'] });

    expect(result.code).toBe(0);
    const names = recorder.events.map((event) => event.hook_event_name);
    expect(names).toEqual([
      'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'SubagentStart', 'SubagentStop', 'PostToolUse', 'Stop', 'SessionEnd',
    ]);
    const [, , pre, start, stop] = recorder.events;
    expect(pre).toMatchObject({ tool_name: 'Agent', tool_input: { subagent_type: 'Explore' } });
    expect(start).toMatchObject({ agent_type: 'Explore', agent_id: expect.any(String) });
    expect(stop).toMatchObject({ agent_id: start!.agent_id, agent_type: 'Explore', stop_hook_active: false, last_assistant_message: expect.any(String) });
    const subagentTranscript = readJsonl(stop!.agent_transcript_path as string);
    expect(subagentTranscript.every((entry) => entry.isSidechain === true)).toBe(true);
  });

  it('subagents-working: three subagents start together and each stops with its own agent_id', async () => {
    const result = await runFake('claude', { scenario: 'subagents-working', args: ['-p', '--settings', settings(), 'split the work'] });
    expect(result.code).toBe(0);
    const starts = recorder.events.filter((event) => event.hook_event_name === 'SubagentStart');
    const stops = recorder.events.filter((event) => event.hook_event_name === 'SubagentStop');
    expect(starts.map((event) => event.agent_type).sort()).toEqual(['Explore', 'general-purpose', 'general-purpose']);
    expect(new Set(stops.map((event) => event.agent_id)).size).toBe(3);
  });

  it('subagent-permission: two subagents ask permission at once, each with its own agent_id, and each decision settles its own', async () => {
    await recorder.close();
    // Hold every PermissionRequest until both are in, so they are provably in flight together.
    const held: (() => void)[] = [];
    recorder = await startHookRecorder((event) => {
      if (event.hook_event_name !== 'PermissionRequest') return undefined;
      return new Promise((resolve) => {
        const behavior = (event.tool_input as { command: string }).command === 'rm -rf dist' ? 'allow' : 'deny';
        held.push(() => resolve({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior } } }));
        if (held.length === 2) for (const release of held) release();
      });
    });

    const result = await runFake('claude', { scenario: 'subagent-permission', args: ['-p', '--settings', settings(), 'clean up'] });

    expect(result.code).toBe(0);
    // The two subagents run at once, so their requests may arrive in either order.
    const commandOf = (event: Record<string, unknown>) => (event.tool_input as { command: string }).command;
    const requests = recorder.events.filter((event) => event.hook_event_name === 'PermissionRequest');
    expect(requests.map(commandOf).sort()).toEqual(['rm -rf build', 'rm -rf dist']);
    for (const request of requests) expect(request).toMatchObject({ agent_id: expect.any(String), agent_type: 'general-purpose' });
    expect(requests[0]!.agent_id).not.toBe(requests[1]!.agent_id);
    const dist = requests.find((event) => commandOf(event) === 'rm -rf dist')!;
    const ran = recorder.events.filter((event) => event.hook_event_name === 'PostToolUse' && event.tool_name === 'Bash');
    expect(ran).toEqual([expect.objectContaining({ agent_id: dist.agent_id, tool_input: expect.objectContaining({ command: 'rm -rf dist' }) })]);
    expect(result.stdout).toContain('Removed dist.');
    expect(result.stdout).toContain('Left build alone.');
    const names = recorder.events.map((event) => event.hook_event_name);
    expect(names.filter((name) => name === 'SubagentStop')).toHaveLength(2);
  });

  it('subagent-ask: a scout works while one cleaner asks permission for one fixed command', async () => {
    await recorder.close();
    recorder = await startHookRecorder((event) =>
      event.hook_event_name === 'PermissionRequest'
        ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
        : undefined,
    );

    const result = await runFake('claude', { scenario: 'subagent-ask', args: ['-p', '--settings', settings(), 'clean up'] });

    expect(result.code).toBe(0);
    const requests = recorder.events.filter((event) => event.hook_event_name === 'PermissionRequest');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ agent_type: 'general-purpose', tool_input: { command: 'rm -rf build' } });
    const starts = recorder.events.filter((event) => event.hook_event_name === 'SubagentStart');
    expect(starts.map((event) => event.agent_type).sort()).toEqual(['Explore', 'general-purpose']);
    expect(result.stdout).toContain('Removed build.');
  });

  it('review: a review prompt ends on a review doc, changes requested in round 1 and approved after', async () => {
    const first = await runFake('claude', { scenario: 'review', args: ['-p', '--settings', settings(), 'You are the reviewer for round 1 of the work'] });
    const later = await runFake('claude', { scenario: 'review', args: ['-p', '--settings', settings(), 'You are the reviewer for round 2 of the work'] });
    const other = await runFake('claude', { scenario: 'review', args: ['-p', '--settings', settings(), 'fix the tests'] });

    expect([first.code, later.code, other.code]).toEqual([0, 0, 0]);
    const finals = recorder.events.filter((event) => event.hook_event_name === 'Stop').map((event) => event.last_assistant_message);
    expect(finals[0]).toMatch(/^# .+\n\nVerdict: Changes requested\n/);
    expect(finals[0]).toContain('## Blocker\n- **');
    expect(finals[1]).toMatch(/Verdict: Approve/);
    expect(finals[1]).toContain('~~');
    expect(finals[2]).toBe('All tests pass.');
  });

  it('crash: exits non-zero mid-turn without Stop or SessionEnd', async () => {
    const result = await runFake('claude', { scenario: 'crash', args: ['-p', '--settings', settings(), 'do it'] });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('simulated crash');
    expect(recorder.events.map((event) => event.hook_event_name)).toEqual(['SessionStart', 'UserPromptSubmit']);
  });

  it('rate-limit: fires StopFailure with error rate_limit', async () => {
    await runFake('claude', { scenario: 'rate-limit', args: ['-p', '--settings', settings(), 'do it'] });

    expect(recorder.events.find((event) => event.hook_event_name === 'StopFailure')).toMatchObject({
      error: 'rate_limit',
      error_details: '429 Too Many Requests',
      last_assistant_message: expect.stringContaining('API Error'),
    });
    expect(recorder.events.map((event) => event.hook_event_name)).not.toContain('Stop');
  });

  it('runs command hooks with the event JSON on stdin', async () => {
    const log = `${tempDir('hook-log-')}/events.jsonl`;
    const hooks = { hooks: { Stop: [{ hooks: [{ type: 'command', command: `{ cat; echo; } >> '${log}'` }] }] } };

    await runFake('claude', { scenario: 'output', args: ['-p', '--settings', JSON.stringify(hooks), 'fix the tests'] });

    expect(readJsonl(log)).toEqual([expect.objectContaining({ hook_event_name: 'Stop', last_assistant_message: 'All tests pass.' })]);
  });

  it('reads --settings from a file path and honours matchers', async () => {
    const dir = tempDir('settings-');
    const hooks = { hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'http', url: recorder.url }] }, { matcher: 'Bash', hooks: [{ type: 'http', url: recorder.url }] }] } };
    writeFileSync(`${dir}/settings.json`, JSON.stringify(hooks));

    await runFake('claude', { scenario: 'output', args: ['-p', '--settings', `${dir}/settings.json`, 'fix the tests'] });

    expect(recorder.events).toHaveLength(1);
    expect(recorder.events[0]).toMatchObject({ hook_event_name: 'PreToolUse', tool_name: 'Bash' });
  });

  it('interpolates only allowedEnvVars into http hook headers', async () => {
    const withHeaders = claudeHookSettings(recorder.url, {
      headers: { Authorization: 'Bearer $AGENT_BOARD_TOKEN', 'X-Leak': '${SECRET}' },
      allowedEnvVars: ['AGENT_BOARD_TOKEN'],
    });

    await runFake('claude', {
      scenario: 'output',
      args: ['-p', '--settings', JSON.stringify(withHeaders), 'fix the tests'],
      env: { AGENT_BOARD_TOKEN: 'tok-123', SECRET: 'nope' },
    });

    expect(recorder.headers[0]).toMatchObject({ authorization: 'Bearer tok-123', 'x-leak': '' });
  });

  it('also loads hooks from ~/.claude/settings.json (how external sessions are seen)', async () => {
    const home = tempDir('fake-home-');
    mkdirSync(`${home}/.claude`);
    writeFileSync(`${home}/.claude/settings.json`, JSON.stringify(claudeHookSettings(recorder.url)));

    await runFake('claude', { scenario: 'output', home, args: ['-p', 'fix the tests'] });

    expect(recorder.events.map((event) => event.hook_event_name)).toContain('Stop');
  });

  it('reports resume as the SessionStart source for --resume', async () => {
    await runFake('claude', { scenario: 'output', args: ['-p', '--settings', settings(), '--resume', 'abc', 'go'] });

    expect(recorder.events[0]).toMatchObject({ source: 'resume', session_id: 'abc' });
  });

  it('replays the conversation it resumes, then waits at the prompt rather than replaying the scenario', async () => {
    const home = tempDir('fake-home-');
    const cwd = tempDir('fake-cwd-');
    await runFake('claude', { scenario: 'waiting', home, cwd, args: ['-p', '--session-id', 'abc', 'pick a database'] });

    const resumed = await runFake('claude', { scenario: 'waiting', home, cwd, args: ['--settings', settings(), '--resume', 'abc'], input: ['and the docs'] });

    expect(resumed.stdout.indexOf('> pick a database')).toBeLessThan(resumed.stdout.indexOf('Which database should I use, Postgres or SQLite?'));
    expect(resumed.stdout).toContain('Done: and the docs.');
    expect(recorder.events.map((event) => event.hook_event_name)).toEqual(['SessionStart', 'Notification', 'UserPromptSubmit', 'Stop', 'Notification', 'SessionEnd']);
    expect(recorder.events[0]).toMatchObject({ source: 'resume', session_id: 'abc' });
  });

  it('takes the first prompt from stdin when none is given on the command line', async () => {
    await runFake('claude', { scenario: 'output', args: ['--settings', settings()], input: ['typed prompt'] });

    expect(recorder.events[1]).toMatchObject({ hook_event_name: 'UserPromptSubmit', prompt: 'typed prompt' });
  });

  it('rejects an unknown scenario', async () => {
    const result = await runFake('claude', { scenario: 'nope' as never, args: ['go'] });

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown FAKE_HARNESS_SCENARIO');
  });

  it('interactive: stays alive at the prompt after Stop, runs each new stdin line as a turn, and exits on EOF', async () => {
    const { child, done } = startFake('claude', { scenario: 'output', args: ['--settings', settings(), 'fix the tests'] });

    await untilEvents(recorder, 'Stop');
    await sleep(300);
    expect(child.exitCode).toBeNull();

    child.stdin.write('and the docs\n');
    await untilEvents(recorder, 'Stop', 2);
    expect(recorder.events.filter((event) => event.hook_event_name === 'UserPromptSubmit').at(-1)).toMatchObject({ prompt: 'and the docs' });
    expect(child.exitCode).toBeNull();

    child.stdin.end();
    const result = await done;
    expect(result.code).toBe(0);
    expect(recorder.events.at(-1)).toMatchObject({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
  });

  it('interactive with FAKE_HARNESS_REPEAT: replays the scenario for each new stdin line', async () => {
    await recorder.close();
    recorder = await startHookRecorder((event) =>
      event.hook_event_name === 'PermissionRequest'
        ? { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
        : undefined,
    );
    const { child, done } = startFake('claude', {
      scenario: 'permission',
      args: ['--settings', settings(), 'clean up'],
      env: { FAKE_HARNESS_REPEAT: '1' },
    });

    await untilEvents(recorder, 'Stop');
    child.stdin.write('clean up again\n');
    await untilEvents(recorder, 'Stop', 2);

    const requests = recorder.events.filter((event) => event.hook_event_name === 'PermissionRequest');
    expect(requests).toHaveLength(2);
    expect(recorder.events.filter((event) => event.hook_event_name === 'UserPromptSubmit').at(-1)).toMatchObject({ prompt: 'clean up again' });
    child.stdin.end();
    expect((await done).code).toBe(0);
  });

  it('SIGINT (Ctrl-C) interrupts the turn with no Stop, then takes the next prompt', async () => {
    const { child, done } = startFake('claude', {
      scenario: 'output',
      args: ['--settings', settings(), 'fix the tests'],
      env: { FAKE_HARNESS_STEP_DELAY_MS: '100' },
    });

    await untilEvents(recorder, 'UserPromptSubmit');
    child.kill('SIGINT');
    await untilStdout(child, 'Interrupted');
    expect(child.exitCode).toBeNull();

    child.stdin.write('try again\n');
    await untilEvents(recorder, 'Stop');
    child.stdin.end();
    const result = await done;

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('All tests pass.');
    expect(recorder.events.map((event) => event.hook_event_name)).not.toContain('Interrupt');
    const stops = recorder.events.filter((event) => event.hook_event_name === 'Stop');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toMatchObject({ last_assistant_message: 'Done: try again.' });
  });

  it('SIGINT interrupts a turn waiting on a y/n permission answer', async () => {
    const { child, done } = startFake('claude', { scenario: 'permission', args: ['--settings', settings(), 'clean up'] });

    await untilEvents(recorder, 'Notification');
    child.kill('SIGINT');
    await untilStdout(child, 'Interrupted');
    child.stdin.end();
    const result = await done;

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('Okay, I left dist alone.');
  });

  it('SIGINT at the prompt only warns; a second one soon after exits', async () => {
    const { child, done } = startFake('claude', { scenario: 'output', args: ['--settings', settings(), 'fix the tests'] });

    await untilEvents(recorder, 'Stop');
    child.kill('SIGINT');
    await untilStdout(child, 'Press Ctrl-C again to exit');
    expect(child.exitCode).toBeNull();
    child.kill('SIGINT');
    const result = await done;

    expect(result.code).toBe(0);
    expect(recorder.events.at(-1)).toMatchObject({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' });
  });

  it('print mode (-p) exits after one turn even with stdin open', async () => {
    const { done } = startFake('claude', { scenario: 'output', args: ['-p', '--settings', settings(), 'fix the tests'] });

    const result = await done;

    expect(result.code).toBe(0);
    expect(recorder.events.at(-1)).toMatchObject({ hook_event_name: 'SessionEnd', reason: 'other' });
  });

  it('fires idle_prompt only once the session has sat idle for FAKE_HARNESS_IDLE_NOTIFY_MS', async () => {
    const { child, done } = startFake('claude', {
      scenario: 'output',
      args: ['--settings', settings(), 'fix the tests'],
      env: { FAKE_HARNESS_IDLE_NOTIFY_MS: '400' },
    });

    await untilEvents(recorder, 'Stop');
    await sleep(100);
    expect(recorder.events.map((event) => event.hook_event_name)).not.toContain('Notification');
    const [idle] = await untilEvents(recorder, 'Notification');
    expect(idle).toMatchObject({ notification_type: 'idle_prompt' });

    child.stdin.end();
    await done;
  });

  it('kills a command hook that outlives its timeout, children included', async () => {
    const hooks = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'true; sleep 8', timeout: 1 }] }] } };
    const started = Date.now();

    const result = await runFake('claude', { scenario: 'output', args: ['-p', '--settings', JSON.stringify(hooks), 'go'] });

    expect(result.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it.each([
    ['malformed --settings JSON', ['--settings', '{bad']],
    ['a missing --settings file', ['--settings', '/nope/settings.json']],
    ['an unknown option', ['--no-such-flag']],
  ])('exits 2 with a clear message on %s', async (_, args) => {
    const result = await runFake('claude', { scenario: 'output', args: [...args, 'go'] });

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/^claude: /);
    expect(result.stderr).not.toContain('    at ');
  });

  it('does not swallow the values of valued flags into the prompt', async () => {
    await runFake('claude', { scenario: 'output', args: ['-p', '--settings', settings(), '--fallback-model', 'sonnet', '--max-turns', '3', 'do it'] });

    expect(recorder.events[1]).toMatchObject({ prompt: 'do it' });
  });

  it('prints a version for --version', async () => {
    const result = await runFake('claude', { scenario: 'output', args: ['--version'] });

    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+ \(Claude Code\)/);
  });

  it('says it is signed in for auth status, and signed out with FAKE_HARNESS_LOGGED_OUT', async () => {
    const signedIn = await runFake('claude', { scenario: 'output', args: ['auth', 'status'] });
    expect(signedIn.code).toBe(0);
    expect(JSON.parse(signedIn.stdout)).toMatchObject({ loggedIn: true });

    const signedOut = await runFake('claude', { scenario: 'output', args: ['auth', 'status', '--json'], env: { FAKE_HARNESS_LOGGED_OUT: '1' } });
    expect(signedOut.code).toBe(1);
    expect(JSON.parse(signedOut.stdout)).toMatchObject({ loggedIn: false });
  });

  it('waits for a slow delayed idle_prompt hook before ending the session', async () => {
    const dir = tempDir('hook-log-');
    const log = `${dir}/order.log`;
    const started = `${dir}/notifying`;
    const hooks = {
      hooks: {
        Notification: [{ hooks: [{ type: 'command', command: `touch '${started}'; sleep 1; echo notified >> '${log}'` }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: `echo end >> '${log}'` }] }],
      },
    };
    const { child, done } = startFake('claude', {
      scenario: 'output',
      args: ['--settings', JSON.stringify(hooks), 'go'],
      env: { FAKE_HARNESS_IDLE_NOTIFY_MS: '300' },
    });

    // Close stdin once the notification hook is under way, however long the turn took to get there.
    for (let waited = 0; !existsSync(started); waited += 20) {
      if (waited > 5000) throw new Error('the idle_prompt hook never started');
      await sleep(20);
    }
    child.stdin.end();
    await done;

    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['notified', 'end']);
  });
});

describe('claude MCP servers', () => {
  it('starts a --mcp-config server with its own env plus the server’s, and calls its tools', async () => {
    const server = join(import.meta.dirname, 'fixtures', 'mcp', 'echo-server.mjs');
    const config = { mcpServers: { 'agent-board': { type: 'stdio', command: process.execPath, args: [server], env: { SECRET: 'set-by-config' } } } };
    const result = await runFake('claude', {
      scenario: 'board',
      args: ['--mcp-config', JSON.stringify(config), 'Map the board'],
      env: { BOARD_VISIBLE: 'yes' },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('The board says: You are on the echo board.');
    expect(result.stdout).toContain('whoami {} env:yes|set-by-config');
    expect(result.stdout).toContain('set_status {"summary":"Map the board","progress":10} env:yes|set-by-config');
  });

  it('posts to an http --mcp-config server, its headers filled in from its own env, and starts nothing', async () => {
    const server = await startEchoHttpServer();
    onTestFinished(server.close);
    const config = { mcpServers: { 'agent-board': { type: 'http', url: server.url, headers: { Authorization: 'Bearer ${BOARD_SECRET}' } } } };
    const result = await runFake('claude', {
      scenario: 'board',
      args: ['--mcp-config', JSON.stringify(config), 'Map the board'],
      env: { BOARD_SECRET: 'from-env' },
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('The board says: You are on the echo board.');
    expect(result.stdout).toContain('whoami {} auth:Bearer from-env');
    expect(result.stdout).toContain('set_status {"summary":"Map the board","progress":10} auth:Bearer from-env');
  });
});
