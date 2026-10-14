import { describe, expect, test } from 'vitest';
import type { ChatEntry } from '@agent-board/daemon/protocol';
import { agentAtWork, chatItems, MAX_SHOWN_ENTRIES, mergeChunk, runOpen, toolKind, toolLine, toolRun, type ToolCall } from './chat';

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
      { kind: 'notice', key: 'notice-4', text: 'Interrupted' },
    ]);
  });

  test('a Claude subagent call keeps the agent it ran', () => {
    const [tools] = chatItems([call('t', 'Agent', { subagent_type: 'Explore' }), { kind: 'tool-result', id: 't', output: 'found', isError: false, agentId: 'a1' }]);
    expect(tools).toMatchObject({ rows: [{ result: { agentId: 'a1' } }] });
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
    expect(line('Agent', { description: 'Write the tests', subagent_type: 'test-writer' }).detail).toBe('test-writer · Write the tests');
    expect(line('spawn_agent', { task_name: 'ping', message: 'REDACTED' }).detail).toBe('ping');
    expect(line('Grep', { pattern: 'TODO', path: '/repo' }).detail).toBe('TODO');
    expect(line('mcp__linear__get_issue', { id: 'ACME-41' }).detail).toBe('ACME-41');
    expect(line('Mystery', { count: 3 }).detail).toBe('');
  });

  test('and how it went', () => {
    expect(line('Bash', { command: 'x' }).outcome).toEqual({ text: 'running…', tone: 'pending' });
    expect(line('Bash', { command: 'x' }, 'boom', true).outcome).toEqual({ text: 'failed', tone: 'bad' });
    expect(line('Bash', { command: 'x' }, 'Test Files 1 passed\n      Tests  14 passed (14)\n\n').outcome).toEqual({ text: 'Tests  14 passed (14)', tone: 'muted' });
    expect(line('Edit', { file_path: 'a.ts', old_string: 'a\nb', new_string: 'a\nb\nc\nd' }, 'ok').outcome).toEqual({ text: '+4 −2', tone: 'diff' });
    expect(line('Write', { file_path: 'a.ts', content: 'x\ny\n' }, 'ok').outcome).toEqual({ text: '+2', tone: 'diff' });
    expect(line('Read', { file_path: 'a.ts' }, '1\ta\n2\tb\n3\tc').outcome).toEqual({ text: '3 lines', tone: 'muted' });
    expect(line('Agent', { description: 'd' }, 'found it').outcome).toEqual({ text: 'done', tone: 'muted' });
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

describe('a run of tool calls, as its one row sums it up', () => {
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

  test('counts its calls, by name, most used first and ties in the order they came', () => {
    const [run] = tools([
      call('1', 'Edit', {}),
      call('2', 'Read', {}),
      call('3', 'Bash', {}),
      call('4', 'Read', {}),
      call('5', 'Bash', {}),
      call('6', 'Read', {}),
      ...['1', '2', '3', '4', '5', '6'].map((id) => result(id, '')),
    ]);
    expect(toolRun(run!.rows, false)).toEqual({ summary: '6 tool calls · Read ×3, Bash ×2, Edit', running: undefined, failed: false });
  });

  test('one call says so in the singular; a message between agents is counted apart', () => {
    const [run] = tools([call('s', 'spawn_agent', {}), { kind: 'subagent-message', from: '/root/a', to: '/root', text: 'hi' }, result('s', '')]);
    expect(toolRun(run!.rows, false).summary).toBe('1 tool call · spawn_agent · 1 message');
  });

  test('is flagged when a call in it failed', () => {
    const [run] = tools([call('a', 'Bash', {}), result('a', 'boom', true), call('b', 'Read', {}), result('b', '')]);
    expect(toolRun(run!.rows, true)).toMatchObject({ failed: true, running: undefined });
  });

  test('the newest run still running names its latest call; an older one with no result is not running', () => {
    const [run] = tools([call('a', 'Read', {}), result('a', ''), call('b', 'Bash', { command: 'pnpm test' })]);
    expect(toolRun(run!.rows, true).running).toBe('Bash');
    expect(toolRun(run!.rows, false).running).toBeUndefined();
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
