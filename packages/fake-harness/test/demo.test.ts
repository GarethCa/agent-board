import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeHookSettings, codexHooksJson, startHookRecorder, type HookRecorder } from '../src/index.ts';
import { assistantText, modelName, permissionPrompt, shownPath, toolHeading, toolResult, welcome } from '../src/demo.ts';
import { readJsonl, removeTempDirs, runFake, startFake, tempDir, untilEvents } from './run-fake.ts';

afterAll(removeTempDirs);

// eslint-disable-next-line no-control-regex -- the colour and line-clearing codes the demo draws with
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*[mK]/g, '');

describe('demo renderer', () => {
  it('draws a box whose every line is as wide as its border', () => {
    const lines = welcome('claude', { cwd: '/home/dev/code/storefront', home: '/home/dev', model: 'claude-opus-5', version: '2.1.0' }).map(plain);

    expect(lines[0]).toMatch(/^╭─── Claude Code v2\.1\.0 ─+╮$/);
    expect(lines.slice(1, -1).map((line) => line.slice(1, -1).trim())).toEqual(['', 'Welcome back!', '', '▐▛███▜▌', '▝▜█████▛▘', '▘▘ ▝▝', '', 'Opus 5', '~/code/storefront', '']);
    expect(new Set(lines.map((line) => line.length)).size).toBe(1);
  });

  it('names a model as Claude Code does', () => {
    expect(modelName('claude-opus-5')).toBe('Opus 5');
    expect(modelName('claude-sonnet-5-5')).toBe('Sonnet 5.5');
    expect(modelName('gpt-5-codex')).toBe('gpt-5-codex');
  });

  it("draws the model's Markdown as the TUI does: headings and bold bold, struck text struck, code coloured, items bulleted", () => {
    const lines = assistantText('claude', '# Review\n\n## Blocker\n- ~~**Fixed**~~ `a.ts:8`\n- **Open** item');

    expect(lines.map(plain)).toEqual(['⏺ Review', '', '  Blocker', '  • Fixed a.ts:8', '  • Open item']);
    expect(lines[3]).toBe('  • \x1b[9m\x1b[1mFixed\x1b[22m\x1b[29m \x1b[38;2;177;185;249ma.ts:8\x1b[39m');
    expect(lines[0]).toBe('⏺ \x1b[1mReview\x1b[22m');
  });

  it('shows a path under the home folder as ~, and others as they are', () => {
    expect(shownPath('/home/dev/code', '/home/dev')).toBe('~/code');
    expect(shownPath('/home/gx', '/home/g')).toBe('/home/gx');
    expect(shownPath('/srv/app', undefined)).toBe('/srv/app');
  });

  it('heads a tool call with its command or its file, relative to where it runs', () => {
    expect(plain(toolHeading('claude', 'Bash', { command: 'npm test' }, '/r'))).toBe('⏺ Bash(npm test)');
    expect(plain(toolHeading('claude', 'Edit', { file_path: '/r/src/a.ts' }, '/r'))).toBe('⏺ Update(src/a.ts)');
    expect(plain(toolHeading('claude', 'mcp__board__whoami', {}, '/r'))).toBe('⏺ board - whoami (MCP)()');
    expect(plain(toolHeading('codex', 'Bash', { command: 'npm test' }, '/r'))).toBe('• Ran npm test');
  });

  it('folds long output after four lines, and says when there is none', () => {
    const long = toolResult('claude', 'Bash', {}, { stdout: 'a\nb\nc\nd\ne\nf' }, '/r').map(plain);
    expect(long).toEqual(['  ⎿  a', '     b', '     c', '     d', '     … +2 lines']);
    expect(toolResult('codex', 'Bash', {}, { stdout: '' }, '/r').map(plain)).toEqual(['  └ (No content)']);
  });

  it('draws a patch with numbered lines, removed ones red and added ones green', () => {
    const lines = toolResult('claude', 'Edit', { file_path: '/r/a.ts' }, { structuredPatch: [{ oldStart: 3, newStart: 3, lines: [' keep', '-old', '+new', '+more'] }] }, '/r');

    expect(plain(lines[0]!)).toBe('  ⎿  Updated a.ts with 2 additions and 1 removal');
    expect(lines.slice(1).map(plain)).toEqual(['        3   keep', '        4 - old', '        4 + new', '        5 + more']);
    expect(lines[2]).toContain('48;2;122;41;54');
    expect(lines[3]).toContain('48;2;34;92;43');
  });

  it('marks done, current and waiting todos apart', () => {
    const todos = [
      { content: 'one', status: 'completed' },
      { content: 'two', status: 'in_progress' },
      { content: 'three', status: 'pending' },
    ];
    expect(toolResult('claude', 'TodoWrite', { todos }, {}, '/r').map(plain)).toEqual(['  ⎿  ☒ one', '     ☐ two', '     ☐ three']);
    expect(toolResult('codex', 'update_plan', { plan: todos.map(({ content, status }) => ({ step: content, status })) }, {}, '/r').map(plain)).toEqual(['  └ ✔ one', '    □ two', '    □ three']);
  });

  it('asks permission in a box naming the command', () => {
    const box = permissionPrompt('claude', { command: 'rm -rf dist', description: 'Remove the stale build' }, '/r').map(plain);
    expect(box).toEqual(expect.arrayContaining([expect.stringContaining('rm -rf dist'), expect.stringContaining('Do you want to proceed?'), expect.stringContaining('❯ 1. Yes')]));
  });
});

describe('demo scenarios on the fake claude', () => {
  let recorder: HookRecorder;

  beforeEach(async () => {
    recorder = await startHookRecorder();
  });

  afterEach(async () => {
    await recorder.close();
  });

  const settings = () => JSON.stringify(claudeHookSettings(recorder.url));
  const names = () => recorder.events.map((event) => event.hook_event_name);
  const finals = () => recorder.events.filter((event) => event.hook_event_name === 'Stop').map((event) => event.last_assistant_message as string);

  it('demo-plan: looks like Claude Code, writes plan.md for real and records its text plain', async () => {
    const result = await runFake('claude', { scenario: 'demo-plan', args: ['-p', '--settings', settings(), 'Plan ACME-12'] });

    expect(result.code).toBe(0);
    const screen = plain(result.stdout);
    for (const part of ['Claude Code v2.1.0', 'Welcome back!', '· Thinking…', '⏺ Read(src/cart/total.ts)', '⏺ Update Todos', '☐ Add applyDiscount()', '⏺ Write(plan.md)']) expect(screen).toContain(part);
    expect(readFileSync(join(result.cwd, 'plan.md'), 'utf8')).toMatch(/^# ACME-12: /);
    // SessionStart reached the recorder through its command hook: Claude runs no http one for it.
    expect(names()).toEqual(['SessionStart', 'UserPromptSubmit', ...Array(4).fill(['PreToolUse', 'PostToolUse']).flat(), 'Stop', 'SessionEnd']);
    expect(finals()).toEqual(['The plan is in plan.md: three steps, discount before tax, one code per cart.']);
    const transcript = readJsonl(recorder.events[0]!.transcript_path as string);
    expect(JSON.stringify(transcript)).not.toContain('\\u001b');
  });

  it('demo-implement: tests (12 passed), asks permission for rm -rf dist, opens a PR and writes its handover; a later prompt fixes the review', async () => {
    const { child, done } = startFake('claude', { scenario: 'demo-implement', args: ['--settings', settings(), 'Implement ACME-12'] });

    const [ask] = await untilEvents(recorder, 'Notification', 1);
    expect(ask).toMatchObject({ notification_type: 'permission_prompt' });
    const permission = recorder.events.find((event) => event.hook_event_name === 'PermissionRequest');
    expect(permission).toMatchObject({ tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } });
    child.stdin.write('1\n');
    await untilEvents(recorder, 'Stop', 1);
    child.stdin.write('Fix the review: An expired code still applies\n');
    await untilEvents(recorder, 'Stop', 2);
    child.stdin.end();
    const result = await done;

    expect(result.code).toBe(0);
    const screen = plain(result.stdout);
    for (const part of ['⏺ Explore(Find every caller of cartTotal)', '⏺ Update(src/cart/total.ts)', '+   return withTax(discounted, cart.region);', '⏺ Bash(npm test)', '⎿  12 passed', '⎿  13 passed', 'https://github.com/acme/storefront/pull/12']) {
      expect(screen).toContain(part);
    }
    expect(screen).toContain('⏺ Bash(npm run build)');
    expect(names()).toContain('SubagentStart');
    expect(readFileSync(join(result.cwd, '.agent-board/handover.md'), 'utf8')).toContain('## Round 2');
    expect(finals()[0]).toBe('Opened #12: discount codes come off the total before tax, and all 12 tests pass.');
  });

  it('demo-review: round 1 asks for changes and round 2 approves, as review docs the board reads', async () => {
    const { child, done } = startFake('claude', { scenario: 'demo-review', args: ['--settings', settings(), 'You are the reviewer for round 1 of ACME-12'] });

    await untilEvents(recorder, 'Stop', 1);
    child.stdin.end('Look again\n');
    const result = await done;

    expect(result.code).toBe(0);
    const [first, second] = finals();
    expect(first).toMatch(/^# .+\n\nVerdict: Changes requested\n/);
    expect(first).toContain('## Blocker\n- **An expired code still applies** `src/cart/discount.ts:8`');
    expect(second).toMatch(/Verdict: Approve/);
    expect(second).toContain('- ~~**An expired code still applies**~~');
    const screen = plain(result.stdout);
    expect(screen).toContain('⏺ Review of ACME-12: discount codes\n\n  Verdict: Changes requested');
    expect(screen).toContain('  • An expired code still applies src/cart/discount.ts:8\n');
    expect(screen).not.toMatch(/~~|\*\*|## /);
    expect(result.stdout).toContain('\x1b[9m\x1b[1mAn expired code still applies\x1b[22m\x1b[29m');
  });

  it('demo-review: takes the round its prompt names', async () => {
    await runFake('claude', { scenario: 'demo-review', args: ['-p', '--settings', settings(), 'You are the reviewer for round 2 of ACME-12'] });

    expect(finals()[0]).toMatch(/Verdict: Approve/);
  });

  it('types a character at a time with FAKE_HARNESS_TYPE_MS, each one written on its own', async () => {
    const typed = async (env: Record<string, string>) => {
      const { child, done } = startFake('claude', { scenario: 'output', args: ['-p', 'fix the tests'], env });
      const chunks: string[] = [];
      child.stdout.on('data', (chunk: string) => chunks.push(chunk));
      child.stdin.end();
      expect((await done).code).toBe(0);
      return chunks.filter((chunk) => /^\S$/.test(chunk)).length;
    };

    // Its two messages have 38 letters and marks: 10 ms apart, each reaches the pipe on its own (a loaded machine may join a few).
    expect(await typed({ FAKE_HARNESS_TYPE_MS: '10' })).toBeGreaterThanOrEqual(30);
    // A word a step, as without the knob, writes no lone letters.
    expect(await typed({ FAKE_HARNESS_STEP_DELAY_MS: '10' })).toBe(0);
  });

  it('demo-implement: answering No at the permission box skips rm -rf dist and the build', async () => {
    const result = await runFake('claude', { scenario: 'demo-implement', args: ['-p', '--settings', settings(), 'Implement ACME-12'], input: ['3'] });

    expect(result.code).toBe(0);
    const screen = plain(result.stdout);
    expect(screen).toContain('⏺ Bash(rm -rf dist)');
    expect(screen).toContain('⎿  User rejected the tool call');
    expect(screen).not.toContain('npm run build');
    const ran = recorder.events.filter((event) => event.hook_event_name === 'PostToolUse').map((event) => (event.tool_input as { command?: string }).command);
    expect(ran).not.toContain('rm -rf dist');
  });

  it('leaves every other scenario plain', async () => {
    const result = await runFake('claude', { scenario: 'output', args: ['-p', 'fix the tests'] });

    expect(result.stdout).toContain('● Bash({"command":"npm test","description":"Run test suite"})');
    expect(result.stdout).not.toContain('Welcome');
    expect(result.stdout).not.toContain('\x1b');
  });
});

describe('demo scenarios on the fake codex', () => {
  /** Runs `demo-codex` with its hooks logged, answering its permission box with `answer`. */
  async function runCodexDemo(answer: string) {
    const home = tempDir('fake-home-');
    const log = join(tempDir('hook-log-'), 'events.jsonl');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(join(home, '.codex', 'hooks.json'), JSON.stringify(codexHooksJson(`{ cat; echo; } >> '${log}'`)));
    const result = await runFake('codex', { scenario: 'demo-codex', home, args: ['--dangerously-bypass-hook-trust', 'Add idempotency keys'], input: [answer] });
    return { ...result, screen: plain(result.stdout), events: readJsonl(log) };
  }

  it('demo-codex: looks like Codex, with its permission ask', async () => {
    const result = await runCodexDemo('1');

    expect(result.code).toBe(0);
    const screen = result.screen;
    for (const part of ['>_ OpenAI Codex (v', '• Updated Plan', '• Ran npm test', '└ 8 passed', '• Edited src/refunds/create.ts', 'Allow command?', '$ npm run migrate']) expect(screen).toContain(part);
    expect(screen).not.toContain('Claude Code v');
    expect(screen).not.toContain('User rejected');
    expect(result.events.find((event) => event.hook_event_name === 'PermissionRequest')).toMatchObject({ tool_input: { command: 'npm run migrate' } });
    expect(result.events.at(-1)).toMatchObject({ hook_event_name: 'SessionEnd' });
  });

  it('demo-codex: its second row, No, denies the migration', async () => {
    const result = await runCodexDemo('2');

    expect(result.code).toBe(0);
    expect(result.screen).toContain('└ User rejected the tool call');
    expect(result.screen).not.toContain('migrated');
    const ran = result.events.filter((event) => event.hook_event_name === 'PostToolUse').map((event) => (event.tool_input as { command?: string }).command);
    expect(ran).not.toContain('npm run migrate');
  });
});
