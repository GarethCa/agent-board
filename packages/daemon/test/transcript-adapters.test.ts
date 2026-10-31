import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { ChatEntry } from '../src/protocol.ts';
import { markSender } from '../src/sender-marker.ts';
import { createTranscriptParser } from '../src/transcript-adapters.ts';

const fixtures = new URL('../../../fixtures/', import.meta.url);

function lines(path: string): string[] {
  return readFileSync(new URL(path, fixtures), 'utf8').split('\n').filter((line) => line !== '');
}

function parse(harness: 'claude' | 'codex', input: string[], options?: { subagent?: boolean }) {
  const parser = createTranscriptParser(harness, options);
  const entries = input.flatMap((line) => parser.push(line));
  return { entries: untimed(entries), unsupported: parser.unsupported };
}

/** The entries without the times their lines were written (and thinking began), which most tests here don't look at. */
function untimed(entries: ChatEntry[]): ChatEntry[] {
  return entries.map((entry) => Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'at' && key !== 'since')) as ChatEntry);
}

describe('the Claude adapter', () => {
  const claude = lines('claude/transcripts/5f0c2a51-7d3e-4b8a-9c11-2e6f0a9b4c7d.jsonl');

  test('reads the conversation from a recorded transcript, leaving out what the TUI hides', () => {
    const { entries, unsupported } = parse('claude', claude);
    expect(unsupported).toBeUndefined();
    expect(entries.map((entry) => entry.kind)).toEqual([
      'user', 'thinking', 'assistant', 'tool-call', 'tool-result', 'tool-call', 'tool-result', 'tool-call', 'tool-result',
      'tool-call', 'tool-result', 'tool-call', 'tool-result', 'assistant', 'turn-ended', 'user', 'assistant', 'notice',
    ]);
    expect(entries[0]).toEqual({ kind: 'user', text: 'Add a --verbose flag to the CLI and test it.' });
    // Claude kept this thinking's text to itself.
    expect(entries[1]).toEqual({ kind: 'thinking', text: '' });
    expect(entries[2]).toEqual({ kind: 'assistant', text: "I'll read the CLI entry point first." });
    expect(entries[3]).toEqual({ kind: 'tool-call', id: 'toolu_01Read000000000000000001', name: 'Read', input: { file_path: '/Users/dev/project/src/cli.ts' } });
    expect(entries.at(-3)).toEqual({ kind: 'user', text: 'now fix the lint error' });
    expect(entries.at(-1)).toEqual({ kind: 'notice', text: 'Interrupted' });
  });

  test('each entry carries when its line was written, so the chat can time thinking, calls and turns', () => {
    const parser = createTranscriptParser('claude');
    const entries = claude.flatMap((line) => parser.push(line));
    expect(entries.slice(0, 4).map((entry) => entry.at)).toEqual(['2026-10-10T21:10:01.000Z', '2026-10-10T21:10:04.000Z', '2026-10-10T21:10:05.000Z', '2026-10-10T21:10:06.000Z']);
    const untimedLine = JSON.stringify({ type: 'user', version: '2.1.0', message: { role: 'user', content: 'hi' } });
    expect(createTranscriptParser('claude').push(untimedLine)).toEqual([{ kind: 'user', text: 'hi' }]);
  });

  test('thinking keeps its text when Claude wrote it, and redacted thinking is thinking with none', () => {
    const assistant = (content: unknown[]) => JSON.stringify({ type: 'assistant', version: '2.1.0', message: { role: 'assistant', content } });
    expect(parse('claude', [assistant([{ type: 'thinking', thinking: '  The totals live in cart.ts.\n', signature: 's' }, { type: 'redacted_thinking', data: 'x' }])]).entries).toEqual([
      { kind: 'thinking', text: 'The totals live in cart.ts.' },
      { kind: 'thinking', text: '' },
    ]);
  });

  test("a compaction is where Claude's compact boundary is, and a turn's end where Claude counts its length; its summary and other system entries are left out", () => {
    const system = (subtype: string, extra: object = {}) => JSON.stringify({ type: 'system', subtype, version: '2.1.301', ...extra });
    const summary = JSON.stringify({ type: 'user', version: '2.1.301', isCompactSummary: true, message: { role: 'user', content: 'This session is being continued…' } });
    expect(parse('claude', [system('compact_boundary', { compactMetadata: { trigger: 'auto' } }), summary, system('stop_hook_summary', { hookCount: 1 }), system('turn_duration', { durationMs: 5_120 })]).entries).toEqual([
      { kind: 'compacted' },
      { kind: 'turn-ended', ms: 5_120 },
    ]);
    expect(parse('claude', [system('compact_boundary', { isSidechain: true }), system('turn_duration', { isSidechain: true, durationMs: 5 })]).entries).toEqual([]);
  });

  test("a background task's notification is an entry of its own, starting a turn the chat doesn't show the prompt of", () => {
    const background = lines('claude/transcripts/background-turn.jsonl');
    const { entries, unsupported } = parse('claude', background);
    expect(unsupported).toBeUndefined();
    expect(entries.map((entry) => entry.kind)).toEqual([
      'user', 'thinking', 'tool-call', 'tool-result', 'assistant', 'turn-ended',
      'notified', 'thinking', 'assistant', 'turn-ended',
      'user', 'tool-call', 'tool-result', 'tool-call', 'tool-result', 'thinking', 'tool-call', 'tool-result', 'notice',
    ]);
  });

  test('thinking carries the latest time a line before it was written, entry or not', () => {
    const parser = createTranscriptParser('claude');
    const thinking = lines('claude/transcripts/background-turn.jsonl')
      .flatMap((line) => parser.push(line))
      .filter((entry) => entry.kind === 'thinking');
    // After its prompt; after the notification's own line, not the reply three hours before; after a five-minute call's result.
    expect(thinking.map((entry) => [entry.since, entry.at])).toEqual([
      ['2026-10-20T10:00:00.000Z', '2026-10-20T10:00:03.000Z'],
      ['2026-10-20T13:15:00.020Z', '2026-10-20T13:15:06.520Z'],
      ['2026-10-20T13:25:00.000Z', '2026-10-20T13:25:04.000Z'],
    ]);
    // A message Claude queued is stamped with when it was queued, earlier than the lines it lands among: it doesn't move the start back.
    const at = (timestamp: string, entry: object) => JSON.stringify({ version: '2.1.312', timestamp, ...entry });
    const queued = createTranscriptParser('claude');
    const think = [
      at('2026-10-20T10:00:10.000Z', { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
      at('2026-10-20T10:00:02.000Z', { type: 'attachment', attachment: { type: 'queued_command', prompt: 'also lint it' } }),
      at('2026-10-20T10:00:13.000Z', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } }),
    ].flatMap((line) => queued.push(line));
    expect(think.at(-1)).toMatchObject({ kind: 'thinking', since: '2026-10-20T10:00:10.000Z' });
    // Nor does Claude's record of its deferred tools, written a moment before or after the thinking.
    const recorded = createTranscriptParser('claude');
    const after = [
      at('2026-10-20T10:00:10.000Z', { type: 'user', message: { role: 'user', content: 'go' } }),
      at('2026-10-20T10:00:18.302Z', { type: 'attachment', attachment: { type: 'deferred_tools_record', entries: [] } }),
      at('2026-10-20T10:00:18.300Z', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] } }),
    ].flatMap((line) => recorded.push(line));
    expect(after.at(-1)).toMatchObject({ kind: 'thinking', since: '2026-10-20T10:00:10.000Z' });
  });

  test('an interrupt says when it was for a tool call the user turned down or stopped', () => {
    const user = (text: string) => JSON.stringify({ type: 'user', version: '2.1.312', message: { role: 'user', content: [{ type: 'text', text }] } });
    expect(parse('claude', [user('[Request interrupted by user for tool use]'), user('[Request interrupted by user]')]).entries).toEqual([
      { kind: 'notice', text: 'Interrupted', forToolUse: true },
      { kind: 'notice', text: 'Interrupted' },
    ]);
  });

  test('a message another agent sent says who from, typed or queued mid-turn; one the user typed says nothing', () => {
    const user = (text: string) => JSON.stringify({ type: 'user', version: '2.1.312', message: { role: 'user', content: [{ type: 'text', text }] } });
    const queued = (prompt: string) => JSON.stringify({ type: 'attachment', version: '2.1.312', attachment: { type: 'queued_command', prompt } });
    const sent = markSender('send', 'Captain', 'agent:944e1234', 'Fix the login test');
    expect(parse('claude', [user(sent), queued(markSender('reply', 'lead', 'agent:ab12cd34', 'Yes')), user('Fix the login test')]).entries).toEqual([
      { kind: 'user', text: 'Fix the login test', from: { ref: 'agent:944e1234', name: 'Captain', kind: 'send' } },
      { kind: 'user', text: 'Yes', from: { ref: 'agent:ab12cd34', name: 'lead', kind: 'reply' } },
      { kind: 'user', text: 'Fix the login test' },
    ]);
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

  test("a message the user sent mid-turn is read where Claude took it, as a queued command; a subagent's report and a task's are not", () => {
    const { entries, unsupported } = parse('claude', lines('claude/transcripts/queued-mid-turn.jsonl'));
    expect(unsupported).toBeUndefined();
    expect(entries).toEqual([
      { kind: 'user', text: 'Run the tests and fix what fails.' },
      { kind: 'tool-call', id: 'toolu_01Bash0000000000000000Q1', name: 'Bash', input: { command: 'pnpm test', description: 'Run the tests' } },
      { kind: 'tool-result', id: 'toolu_01Bash0000000000000000Q1', output: '12 passed', isError: false },
      { kind: 'user', text: 'Also update the changelog.' },
      { kind: 'assistant', text: 'The tests pass, and the changelog is updated.' },
    ]);
  });

  test('a queued command with no mode is a prompt; one in a mode it does not know, or with no text, is skipped', () => {
    const queued = (attachment: Record<string, unknown>) => JSON.stringify({ type: 'attachment', version: '2.1.296', isSidechain: false, attachment: { type: 'queued_command', ...attachment } });
    const { entries, unsupported } = parse('claude', [
      queued({ prompt: 'carry on' }),
      queued({ prompt: 'compact it', commandMode: 'bash' }),
      queued({ prompt: ['not', 'text'], commandMode: 'prompt' }),
      queued({ prompt: '<system-reminder>hidden</system-reminder>', commandMode: 'prompt' }),
    ]);
    expect(unsupported).toBeUndefined();
    expect(entries).toEqual([{ kind: 'user', text: 'carry on' }]);
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
      'user', 'thinking', 'assistant', 'tool-call', 'tool-result', 'tool-call', 'tool-result', 'subagent-message', 'tool-call',
      'tool-result', 'subagent-message', 'assistant', 'user', 'tool-call', 'tool-result', 'notice', 'compacted',
    ]);
    expect(entries[0]).toEqual({ kind: 'user', text: 'Create x.txt containing hi with a shell command, then ask a subagent to reply pong.' });
    // Its reasoning, encrypted, with no summary.
    expect(entries[1]).toEqual({ kind: 'thinking', text: '' });
    expect(entries[3]).toMatchObject({ kind: 'tool-call', id: 'call_45347b3d1b0b4cea93d967c578955260', name: 'exec' });
    expect(entries[4]).toEqual({
      kind: 'tool-result',
      id: 'call_45347b3d1b0b4cea93d967c578955260',
      output: 'Script completed\nWall time 0.1 seconds\nOutput:\n\nexit_code=0',
      isError: false,
    });
    expect(entries[5]).toEqual({
      kind: 'tool-call',
      id: 'call_da8944d9f5b942e1bd236db67f661526',
      name: 'spawn_agent',
      input: { task_name: 'ping', message: 'REDACTED' },
    });
    expect(entries.at(-2)).toEqual({ kind: 'notice', text: 'Interrupted' });
    expect(entries.at(-1)).toEqual({ kind: 'compacted' });
  });

  test("a call says it failed when its script failed, the user stopped it, or its exit code wasn't 0", () => {
    const results = parse('codex', codex).entries.filter((entry) => entry.kind === 'tool-result');
    expect(results.map((entry) => entry.isError)).toEqual([false, false, false, true]);
    const output = (call_id: string, text: string) =>
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id, output: text } });
    const failed = parse('codex', [codex[0]!, output('a', 'Script failed\nOutput:\n'), output('b', 'Script completed\nexit_code=2'), output('c', '{"output":"","metadata":{"exit_code":1}}')]);
    expect(failed.entries.map((entry) => (entry as { isError: boolean }).isError)).toEqual([true, true, true]);
  });

  test('a message another agent sent says who from', () => {
    const user = (text: string) =>
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } });
    expect(parse('codex', [codex[0]!, user(markSender('hand-off', 'impl', 'agent:ab12cd34', 'Hand-off from impl (its final message): Done.'))]).entries).toEqual([
      { kind: 'user', text: 'Hand-off from impl (its final message): Done.', from: { ref: 'agent:ab12cd34', name: 'impl', kind: 'hand-off', payload: 'final message' } },
    ]);
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
