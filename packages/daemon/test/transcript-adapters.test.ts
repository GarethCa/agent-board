import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { ChatEntry } from '../src/protocol.ts';
import { createTranscriptParser } from '../src/transcript-adapters.ts';

const fixtures = new URL('../../../fixtures/', import.meta.url);

function lines(path: string): string[] {
  return readFileSync(new URL(path, fixtures), 'utf8').split('\n').filter((line) => line !== '');
}

function parse(harness: 'claude' | 'codex', input: string[], options?: { subagent?: boolean }) {
  const parser = createTranscriptParser(harness, options);
  const entries: ChatEntry[] = input.flatMap((line) => parser.push(line));
  return { entries, unsupported: parser.unsupported };
}

describe('the Claude adapter', () => {
  const claude = lines('claude/transcripts/5f0c2a51-7d3e-4b8a-9c11-2e6f0a9b4c7d.jsonl');

  test('reads the conversation from a recorded transcript, leaving out what the TUI hides', () => {
    const { entries, unsupported } = parse('claude', claude);
    expect(unsupported).toBeUndefined();
    expect(entries.map((entry) => entry.kind)).toEqual([
      'user', 'assistant', 'tool-call', 'tool-result', 'tool-call', 'tool-result', 'tool-call', 'tool-result', 'tool-call',
      'tool-result', 'tool-call', 'tool-result', 'assistant', 'user', 'assistant', 'notice',
    ]);
    expect(entries[0]).toEqual({ kind: 'user', text: 'Add a --verbose flag to the CLI and test it.' });
    expect(entries[1]).toEqual({ kind: 'assistant', text: "I'll read the CLI entry point first." });
    expect(entries[2]).toEqual({ kind: 'tool-call', id: 'toolu_01Read000000000000000001', name: 'Read', input: { file_path: '/Users/dev/project/src/cli.ts' } });
    expect(entries.at(-3)).toEqual({ kind: 'user', text: 'now fix the lint error' });
    expect(entries.at(-1)).toEqual({ kind: 'notice', text: 'Interrupted' });
  });

  test('a subagent call carries its agent; a failed call says so', () => {
    const { entries } = parse('claude', claude);
    const agent = entries.find((entry) => entry.kind === 'tool-call' && entry.name === 'Agent');
    expect(agent).toMatchObject({ input: { subagent_type: 'test-writer' } });
    expect(entries.find((entry) => entry.kind === 'tool-result' && entry.id === 'toolu_01Agent00000000000000003')).toEqual({
      kind: 'tool-result',
      id: 'toolu_01Agent00000000000000003',
      output: 'Added test/cli.test.ts with one passing test for --verbose.',
      isError: false,
      agentId: 'a88af6cf82bf325bc',
    });
    expect(entries.find((entry) => entry.kind === 'tool-result' && entry.id === 'toolu_01Bash000000000000000005')).toMatchObject({ isError: true });
  });

  test("reads a subagent's own transcript, whose entries are all on its sidechain", () => {
    const { entries } = parse('claude', lines('claude/transcripts/5f0c2a51-7d3e-4b8a-9c11-2e6f0a9b4c7d/subagents/agent-a88af6cf82bf325bc.jsonl'), { subagent: true });
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'tool-call', 'tool-result', 'assistant']);
  });

  test('a sidechain entry in the main transcript is left out', () => {
    const sidechain = JSON.stringify({ type: 'user', isSidechain: true, version: '2.1.0', message: { role: 'user', content: 'aside' } });
    expect(parse('claude', [sidechain]).entries).toEqual([]);
  });

  test('a version it does not know, or a line that is not a transcript entry, makes it unsupported, and it stays so', () => {
    const future = JSON.stringify({ type: 'user', version: '3.0.0', message: { role: 'user', content: 'hi' } });
    expect(parse('claude', [future]).unsupported).toBe('Claude Code 3.0.0 transcripts are not supported yet');
    const garbage = parse('claude', ['not json', claude[2]!]);
    expect(garbage.unsupported).toBe('the transcript has a line that is not JSON');
    expect(garbage.entries).toEqual([]);
    expect(parse('claude', ['[1,2]']).unsupported).toBe('the transcript has an entry it does not recognise');
  });

  test('a newer version later in the file, as a session resumed under a newer release writes, makes it unsupported', () => {
    const resumed = JSON.stringify({ type: 'user', version: '3.0.1', message: { role: 'user', content: 'again' } });
    expect(parse('claude', [claude[2]!, resumed])).toEqual({
      entries: [{ kind: 'user', text: 'Add a --verbose flag to the CLI and test it.' }],
      unsupported: 'Claude Code 3.0.1 transcripts are not supported yet',
    });
  });

  test('a message entry without its version or its message object is a format it does not know', () => {
    const versionless = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } });
    expect(parse('claude', [versionless]).unsupported).toBe('a message entry has no Claude Code version');
    const reshaped = JSON.stringify({ type: 'assistant', version: '2.1.0', content: [{ type: 'text', text: 'hi' }] });
    expect(parse('claude', [reshaped]).unsupported).toBe('a message entry has no message object');
  });

  test('a long input is kept as clipped text', () => {
    const input = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${index}`, 'y'.repeat(3000)]));
    const call = JSON.stringify({ type: 'assistant', version: '2.1.0', message: { content: [{ type: 'tool_use', id: 't', name: 'Big', input }] } });
    const [entry] = parse('claude', [call]).entries;
    expect(typeof (entry as { input: unknown }).input).toBe('string');
    expect(((entry as { input: string }).input).length).toBeLessThan(5000);
  });

  test('an entry type it does not know is skipped', () => {
    const later = JSON.stringify({ type: 'hologram', version: '2.9.0', payload: {} });
    expect(parse('claude', [later, claude[2]!])).toEqual({ entries: [{ kind: 'user', text: 'Add a --verbose flag to the CLI and test it.' }], unsupported: undefined });
  });

  test('long output is cut short', () => {
    const result = JSON.stringify({
      type: 'user',
      version: '2.1.0',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(20_000) }] },
    });
    const [entry] = parse('claude', [result]).entries;
    expect(entry).toMatchObject({ kind: 'tool-result', isError: false });
    expect((entry as { output: string }).output.length).toBeLessThan(5000);
    expect((entry as { output: string }).output.endsWith('…')).toBe(true);
  });
});

describe('the Codex adapter', () => {
  const codex = lines('codex/rollouts/rollout-2026-10-08T22-58-07-01a11d86-0ed1-79b0-b5f7-5bf941eadee1.jsonl');

  test('reads the conversation from a recorded rollout, leaving out instructions and context', () => {
    const { entries, unsupported } = parse('codex', codex);
    expect(unsupported).toBeUndefined();
    expect(entries.map((entry) => entry.kind)).toEqual([
      'user', 'assistant', 'tool-call', 'tool-result', 'tool-call', 'tool-result', 'subagent-message', 'tool-call', 'tool-result',
      'subagent-message', 'assistant', 'user', 'tool-call', 'tool-result', 'notice',
    ]);
    expect(entries[0]).toEqual({ kind: 'user', text: 'Create x.txt containing hi with a shell command, then ask a subagent to reply pong.' });
    expect(entries[2]).toMatchObject({ kind: 'tool-call', id: 'call_45347b3d1b0b4cea93d967c578955260', name: 'exec' });
    expect(entries[3]).toEqual({
      kind: 'tool-result',
      id: 'call_45347b3d1b0b4cea93d967c578955260',
      output: 'Script completed\nWall time 0.1 seconds\nOutput:\n\nexit_code=0',
      isError: false,
    });
    expect(entries[4]).toEqual({
      kind: 'tool-call',
      id: 'call_da8944d9f5b942e1bd236db67f661526',
      name: 'spawn_agent',
      input: { task_name: 'ping', message: 'REDACTED' },
    });
    expect(entries.at(-1)).toEqual({ kind: 'notice', text: 'Interrupted' });
  });

  test("a call says it failed when its script failed, the user stopped it, or its exit code wasn't 0", () => {
    const results = parse('codex', codex).entries.filter((entry) => entry.kind === 'tool-result');
    expect(results.map((entry) => entry.isError)).toEqual([false, false, false, true]);
    const output = (call_id: string, text: string) =>
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id, output: text } });
    const failed = parse('codex', [codex[0]!, output('a', 'Script failed\nOutput:\n'), output('b', 'Script completed\nexit_code=2'), output('c', '{"output":"","metadata":{"exit_code":1}}')]);
    expect(failed.entries.map((entry) => (entry as { isError: boolean }).isError)).toEqual([true, true, true]);
  });

  test('messages between agents are kept with who sent them', () => {
    const messages = parse('codex', codex).entries.filter((entry) => entry.kind === 'subagent-message');
    expect(messages).toEqual([
      { kind: 'subagent-message', from: '/root', to: '/root/ping', text: '' },
      { kind: 'subagent-message', from: '/root/ping', to: '/root', text: 'pong' },
    ]);
  });

  test('a version it does not know, or a rollout without its session line, makes it unsupported', () => {
    const meta = JSON.parse(codex[0]!) as { payload: Record<string, unknown> };
    const future = JSON.stringify({ ...meta, payload: { ...meta.payload, cli_version: '1.0.0' } });
    expect(parse('codex', [future, ...codex.slice(1)])).toEqual({ entries: [], unsupported: 'Codex 1.0.0 rollouts are not supported yet' });
    expect(parse('codex', codex.slice(1)).unsupported).toBe('the rollout does not start with its session line');
  });
});
