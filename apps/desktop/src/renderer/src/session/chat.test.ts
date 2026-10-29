import { describe, expect, test } from 'vitest';
import type { ChatEntry } from '@agent-board/daemon/protocol';
import { agentAtWork, chatItems, duration, MAX_SHOWN_ENTRIES, mergeChunk, pastedParts, runOpen, toolKind, toolLine, type ToolCall } from './chat';

const call = (id: string, name: string, input: unknown): ChatEntry => ({ kind: 'tool-call', id, name, input });
const result = (id: string, output: string, isError = false): ChatEntry => ({ kind: 'tool-result', id, output, isError });

describe('chat items from transcript entries', () => {
  test('messages stay in order; tool calls in a row are one run, each with its result', () => {
    const items = chatItems([
      { kind: 'user', text: 'Fix it' },
      { kind: 'assistant', text: 'Looking.' },
      call('a', 'Read', { file_path: '/repo/src/cli.ts' }),
      result('a', 'one\ntwo'),
      call('b', 'Bash', { command: 'pnpm test' }),
      { kind: 'assistant', text: 'Done.' },
      result('b', 'ok', true),
    ]);
    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant', 'tools', 'assistant']);
    const tools = items[2] as Extract<(typeof items)[number], { kind: 'tools' }>;
    expect(tools.rows).toEqual([
      { kind: 'call', id: 'a', name: 'Read', input: { file_path: '/repo/src/cli.ts' }, result: { output: 'one\ntwo', isError: false } },
      { kind: 'call', id: 'b', name: 'Bash', input: { command: 'pnpm test' }, result: { output: 'ok', isError: true } },
    ]);
  });

  test("a subagent's messages sit with the calls around them; a result for no call is dropped", () => {
    const items = chatItems([
      call('s', 'spawn_agent', { task_name: 'ping' }),
      { kind: 'subagent-message', from: '/root/ping', to: '/root', text: 'pong' },
      result('s', '{}'),
      result('nobody', 'stray'),
      { kind: 'notice', text: 'Interrupted' },
    ]);
    expect(items).toEqual([
      {
        kind: 'tools',
        key: 'tools-0',
        rows: [
          { kind: 'call', id: 's', name: 'spawn_agent', input: { task_name: 'ping' }, result: { output: '{}', isError: false } },
          { kind: 'subagent-message', key: 'subagent-message-1', from: '/root/ping', to: '/root', text: 'pong' },
        ],
      },
      { kind: 'interrupted', key: 'interrupted-4' },
    ]);
  });

  test('a Claude subagent call keeps the agent it ran', () => {
    const [tools] = chatItems([call('t', 'Agent', { subagent_type: 'Explore' }), { kind: 'tool-result', id: 't', output: 'found', isError: false, agentId: 'a1' }]);
    expect(tools).toMatchObject({ rows: [{ result: { agentId: 'a1' } }] });
  });
});

describe('thinking, compaction and interruptions', () => {
  test('thinking is timed from when the transcript last heard from it, not from the entry before it, and keeps its text when there is any', () => {
    const items = chatItems([
      { kind: 'user', text: 'Go', at: '2026-10-10T07:00:00.000Z' },
      { kind: 'thinking', text: '', since: '2026-10-10T10:00:00.000Z', at: '2026-10-10T10:00:12.000Z' },
      { kind: 'assistant', text: 'Looking.' },
      { kind: 'thinking', text: 'Totals live in cart.ts.' },
    ]);
    expect(items.filter((item) => item.kind === 'thinking')).toEqual([
      { kind: 'thinking', key: 'thinking-1', text: '', ms: 12_000, at: '2026-10-10T10:00:12.000Z' },
      { kind: 'thinking', key: 'thinking-3', text: 'Totals live in cart.ts.' },
    ]);
  });

  test('a compaction is its own item; an interruption names the call it cut short', () => {
    const items = chatItems([call('a', 'Bash', { command: 'npm run e2e' }), { kind: 'notice', text: 'Interrupted' }, { kind: 'compacted' }, { kind: 'notice', text: 'Interrupted' }]);
    expect(items.map((item) => item.kind)).toEqual(['tools', 'interrupted', 'compacted', 'interrupted']);
    expect(items[1]).toMatchObject({ kind: 'interrupted', stopped: { id: 'a', name: 'Bash' } });
    expect(items[3]).not.toHaveProperty('stopped');
  });

  test('a call the user turned down or interrupted is stopped, though Claude wrote its result as an error', () => {
    const items = chatItems([
      call('a', 'Bash', { command: 'pnpm test' }),
      { kind: 'tool-result', id: 'a', output: '412 passed', isError: false },
      call('b', 'Bash', { command: 'git push' }),
      { kind: 'tool-result', id: 'b', output: "The user doesn't want to proceed with this tool use.", isError: true },
      { kind: 'notice', text: 'Interrupted', forToolUse: true },
    ]);
    expect(items[1]).toMatchObject({ kind: 'interrupted', stopped: { id: 'b', stopped: true } });
    expect(items[0]).toMatchObject({ rows: [{ id: 'a' }, { id: 'b', stopped: true }] });
    expect((items[0] as { rows: object[] }).rows[0]).not.toHaveProperty('stopped');
  });

  test('blocks of thinking in a row are one thought, for as long as all of them, with all their text', () => {
    const items = chatItems([
      { kind: 'user', text: 'Go', at: '2026-10-10T10:00:00.000Z' },
      { kind: 'thinking', text: 'Totals live in cart.ts.', since: '2026-10-10T10:00:00.000Z', at: '2026-10-10T10:00:03.000Z' },
      { kind: 'thinking', text: '', since: '2026-10-10T10:00:03.000Z', at: '2026-10-10T10:00:03.020Z' },
      { kind: 'thinking', text: 'Tax is added last.', since: '2026-10-10T10:00:03.020Z', at: '2026-10-10T10:00:04.000Z' },
      { kind: 'assistant', text: 'Found it.' },
      { kind: 'thinking', text: '', since: '2026-10-10T10:00:05.000Z', at: '2026-10-10T10:00:06.000Z' },
    ]);
    expect(items.filter((item) => item.kind === 'thinking')).toEqual([
      { kind: 'thinking', key: 'thinking-1', text: 'Totals live in cart.ts.\n\nTax is added last.', ms: 4_000, at: '2026-10-10T10:00:04.000Z' },
      { kind: 'thinking', key: 'thinking-5', text: '', ms: 1_000, at: '2026-10-10T10:00:06.000Z' },
    ]);
  });

  test('a call that failed before an interrupt not for it stays failed', () => {
    const items = chatItems([
      call('a', 'Bash', { command: 'pnpm test' }),
      { kind: 'tool-result', id: 'a', output: 'exit 1', isError: true },
      { kind: 'notice', text: 'Interrupted' },
    ]);
    expect(items[1]).not.toHaveProperty('stopped');
    expect((items[0] as { rows: object[] }).rows[0]).not.toHaveProperty('stopped');
  });

  test('a background task notification and the end of a turn draw nothing', () => {
    expect(chatItems([{ kind: 'notified' }, { kind: 'assistant', text: 'Passed.' }, { kind: 'turn-ended', ms: 8_000 }]).map((item) => item.kind)).toEqual(['assistant']);
  });
});

describe('one line per tool call', () => {
  const line = (name: string, input: unknown, output?: string, isError = false) =>
    toolLine({ kind: 'call', id: 'x', name, input, result: output === undefined ? undefined : { output, isError } } satisfies ToolCall);

  test('says what it worked on', () => {
    expect(line('Read', { file_path: '/repo/src/main/keychain.ts' }).detail).toBe('src/main/keychain.ts');
    expect(line('Bash', { command: 'pnpm vitest run keychain.test.ts' }).detail).toBe('pnpm vitest run keychain.test.ts');
    expect(line('shell', { command: ['bash', '-lc', 'ls -la'] }).detail).toBe('bash -lc ls -la');
    expect(line('exec', 'const r = await tools.exec_command({cmd:"printf \'hi\' > x.txt"});\ntext(r.output);').detail).toBe("printf 'hi' > x.txt");
    expect(line('Agent', { description: 'Write the tests', subagent_type: 'test-writer' })).toMatchObject({ label: 'test-writer', detail: 'Write the tests' });
    expect(line('Agent', { description: 'Write the tests' })).toMatchObject({ label: 'Agent', detail: 'Write the tests' });
    expect(line('spawn_agent', { task_name: 'ping', message: 'REDACTED' }).detail).toBe('ping');
    expect(line('Grep', { pattern: 'TODO', path: '/repo' }).detail).toBe('TODO');
    expect(line('mcp__linear__get_issue', { id: 'ACME-41' }).detail).toBe('get_issue ACME-41');
    expect(line('mcp__linear__list_teams', {}).detail).toBe('list_teams');
    expect(line('WebFetch', { url: 'https://stripe.com/docs/api/coupons', prompt: 'p' }).detail).toBe('stripe.com/docs/api/coupons');
    expect(line('mcp__agent-board__present_plan', { title: 'Apply discount codes', body: '…' }).detail).toBe('Apply discount codes');
    expect(line('mcp__agent-board__ask', { question: 'Stack codes?', options: ['Yes'] }).detail).toBe('Stack codes?');
    expect(line('AskUserQuestion', { questions: [{ question: 'Which cache?', options: [] }] }).detail).toBe('Which cache?');
    expect(line('Mystery', { count: 3 }).detail).toBe('');
  });

  test('and how it went', () => {
    expect(line('Bash', { command: 'x' }).outcome).toEqual({ text: 'running…', tone: 'pending' });
    expect(line('Bash', { command: 'x' }, 'boom', true).outcome).toEqual({ text: 'failed', tone: 'bad' });
    expect(line('Bash', { command: 'x' }, 'Test Files 1 passed\n      Tests  14 passed (14)\n\n').outcome).toEqual({ text: 'Tests  14 passed (14)', tone: 'muted' });
    expect(line('Edit', { file_path: 'a.ts', old_string: 'a\nb', new_string: 'a\nb\nc\nd' }, 'ok').outcome).toEqual({ text: '+4 −2', tone: 'diff' });
    expect(line('Write', { file_path: 'a.ts', content: 'x\ny\n' }, 'ok').outcome).toEqual({ text: '+2', tone: 'diff' });
    expect(line('Read', { file_path: 'a.ts' }, '1\ta\n2\tb\n3\tc').outcome).toEqual({ text: '3 lines', tone: 'muted' });
    expect(line('Read', { file_path: 'a.ts' }, '1\ta').outcome).toEqual({ text: '1 line', tone: 'muted' });
    expect(line('Agent', { description: 'd' }, 'found it').outcome).toEqual({ text: 'done', tone: 'muted' });
    expect(line('Grep', { pattern: 'applyCoupon' }, 'Found 3 files\na.ts\nb.ts\nc.ts').outcome).toEqual({ text: '3 files', tone: 'muted' });
    expect(line('mcp__linear__get_issue', { id: 'ACME-41' }, '{}').outcome).toEqual({ text: '✓', tone: 'ok' });
    expect(line('WebFetch', { url: 'https://x.dev' }, 'page').outcome).toEqual({ text: '✓', tone: 'ok' });
  });

  test('names an MCP call by its server, plainly, and agent-board\'s as the board', () => {
    expect(line('mcp__linear__get_issue', {}).label).toBe('linear');
    expect(line('mcp__agent-board__read', {}).label).toBe('board');
    expect(line('Bash', {}).label).toBe('Bash');
  });

  test('a shell call says how long it took, from when its call and its result were written', () => {
    const timed: ToolCall = { kind: 'call', id: 'x', name: 'Bash', input: { command: 'npm test' }, at: '2026-10-10T10:00:00.000Z', result: { output: '12 passed', isError: false, at: '2026-10-10T10:00:04.150Z' } };
    expect(toolLine(timed).outcome).toEqual({ text: '12 passed · 4.1s', tone: 'muted' });
  });

  test('spans of time read as the chat shows them', () => {
    expect([4_150, 12_400, 252_000, 3_900_000].map(duration)).toEqual(['4.1s', '12s', '4m 12s', '1h 5m']);
  });

  test("and how a Codex exec script went, from its report's output, not its header", () => {
    expect(line('exec', 'script', 'Script completed\nWall time 0.1 seconds\nOutput:\n12 passed\n\nexit_code=0').outcome).toEqual({ text: '12 passed', tone: 'muted' });
    expect(line('exec', 'script', 'Script completed\nWall time 0.1 seconds\nOutput:\n\nexit_code=0').outcome).toEqual({ text: 'done', tone: 'muted' });
    expect(line('exec', 'script', 'aborted by user after 1.3s', true).outcome).toEqual({ text: 'failed', tone: 'bad' });
  });

  test('every tool name has one kind, shared by its icon and its line', () => {
    expect(['Bash', 'shell', 'exec', 'exec_command'].map(toolKind)).toEqual(['shell', 'shell', 'shell', 'shell']);
    expect(['Agent', 'Task', 'spawn_agent'].map(toolKind)).toEqual(['subagent', 'subagent', 'subagent']);
    expect(['Read', 'Edit', 'Write', 'Grep', 'Mystery'].map(toolKind)).toEqual(['read', 'edit', 'write', 'search', 'other']);
    expect(['WebFetch', 'mcp__linear__get_issue', 'ExitPlanMode', 'mcp__agent-board__present_plan', 'AskUserQuestion', 'mcp__agent-board__ask'].map(toolKind)).toEqual(['web', 'mcp', 'plan', 'plan', 'ask', 'ask']);
  });
});

describe('merging what the daemon read into what the view has', () => {
  const a: ChatEntry = { kind: 'user', text: 'a' };
  const b: ChatEntry = { kind: 'assistant', text: 'b' };

  const ok = (generation: number, from: number, entries: ChatEntry[], earlier = from > 0) =>
    ({ status: 'ok', generation, from, earlier, entries }) as const;

  test('appends new entries of the same generation; takes a new generation whole', () => {
    const first = mergeChunk(undefined, ok(1, 0, [a]));
    expect(first).toEqual({ status: 'ok', generation: 1, first: 0, earlier: false, entries: [a] });
    expect(mergeChunk(first, ok(1, 1, [b]))).toEqual({ status: 'ok', generation: 1, first: 0, earlier: false, entries: [a, b] });
    expect(mergeChunk(first, ok(1, 1, []))).toBe(first);
    expect(mergeChunk(first, ok(2, 0, [b]))).toEqual({ status: 'ok', generation: 2, first: 0, earlier: false, entries: [b] });
  });

  test('starts again from a chunk that leaves a gap, saying earlier entries are not shown', () => {
    const first = mergeChunk(undefined, ok(1, 0, [a]));
    expect(mergeChunk(first, ok(1, 300, [b]))).toEqual({ status: 'ok', generation: 1, first: 300, earlier: true, entries: [b] });
  });

  test(`shows at most the latest ${MAX_SHOWN_ENTRIES}`, () => {
    const many = Array.from({ length: MAX_SHOWN_ENTRIES }, (_, n): ChatEntry => ({ kind: 'user', text: `${n}` }));
    const full = mergeChunk(undefined, ok(1, 0, many));
    const more = mergeChunk(full, ok(1, MAX_SHOWN_ENTRIES, [b]));
    expect(more.entries).toHaveLength(MAX_SHOWN_ENTRIES);
    expect(more).toMatchObject({ first: 1, earlier: true });
    expect(more.entries.at(-1)).toBe(b);
  });

  test('keeps the reason a transcript is unsupported', () => {
    expect(mergeChunk(undefined, { status: 'unsupported', reason: 'why', generation: 1, from: 0, earlier: false, entries: [] })).toEqual({
      status: 'unsupported',
      reason: 'why',
      generation: 1,
      first: 0,
      earlier: false,
      entries: [],
    });
  });
});

describe('a run of tool calls', () => {
  const tools = (entries: ChatEntry[]) => chatItems(entries).filter((item) => item.kind === 'tools');

  test('a run ends at assistant text: the calls on either side are two runs', () => {
    const runs = tools([
      call('a', 'Read', {}),
      result('a', ''),
      { kind: 'assistant', text: 'Now the tests.' },
      call('b', 'Bash', {}),
      result('b', ''),
      call('c', 'Bash', {}),
      result('c', ''),
    ]);
    expect(runs.map((run) => run.rows.length)).toEqual([1, 2]);
  });

  test('only a live agent in a turn has a run still going: one that ended or waits never got the result', () => {
    expect(agentAtWork({ endedAt: null, state: 'running' })).toBe(true);
    expect(agentAtWork({ endedAt: null, state: 'needs-permission' })).toBe(true);
    expect(agentAtWork({ endedAt: null, state: 'idle' })).toBe(false);
    expect(agentAtWork({ endedAt: '2026-10-13T00:00:00Z', state: 'failed' })).toBe(false);
    expect(agentAtWork({ endedAt: '2026-10-13T00:00:00Z', state: 'stopped-by-restart' })).toBe(false);
  });

  test('runs start collapsed but for the newest while it runs; Expand all and Collapse all win, and a click wins over both', () => {
    expect(runOpen('auto', undefined, false)).toBe(false);
    expect(runOpen('auto', undefined, true)).toBe(true);
    expect(runOpen('expanded', undefined, false)).toBe(true);
    expect(runOpen('collapsed', undefined, true)).toBe(false);
    expect(runOpen('collapsed', true, false)).toBe(true);
    expect(runOpen('expanded', false, true)).toBe(false);
  });
});

describe('a message with pasted text in it', () => {
  test('a wrapper whose two tags share an id is a block of its exact content, with no tag text left', () => {
    const pasted = 'line one\n  line two\n\nline four';
    const parts = pastedParts(`Look at this:\n<pasted_content id="7d1">\n${pasted}\n</pasted_content id="7d1">\nThanks`);
    expect(parts).toEqual([
      { kind: 'text', text: 'Look at this:\n' },
      { kind: 'pasted', text: pasted, lines: 4 },
      { kind: 'text', text: '\nThanks' },
    ]);
    expect(parts.map((part) => part.text).join('')).not.toContain('pasted_content');
  });

  test('several blocks, and a tag closed by another id or never closed, stay as typed', () => {
    expect(pastedParts('<pasted_content id="a">x</pasted_content id="a"><pasted_content id="b">y\nz</pasted_content id="b">')).toEqual([
      { kind: 'pasted', text: 'x', lines: 1 },
      { kind: 'pasted', text: 'y\nz', lines: 2 },
    ]);
    const mismatched = '<pasted_content id="a">x</pasted_content id="b">';
    expect(pastedParts(mismatched)).toEqual([{ kind: 'text', text: mismatched }]);
    expect(pastedParts('<pasted_content id="a">never closed')).toEqual([{ kind: 'text', text: '<pasted_content id="a">never closed' }]);
    expect(pastedParts('Plain')).toEqual([{ kind: 'text', text: 'Plain' }]);
  });
});
