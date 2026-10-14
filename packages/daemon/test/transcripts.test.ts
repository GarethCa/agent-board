import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createTranscriptReader, MAX_CHUNK_ENTRIES, MAX_KEPT_ENTRIES, TAIL_START_BYTES } from '../src/transcripts.ts';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const CLAUDE_SESSION = '5f0c2a51-7d3e-4b8a-9c11-2e6f0a9b4c7d';
const claudeLines = readFileSync(join(fixtures, `claude/transcripts/${CLAUDE_SESSION}.jsonl`), 'utf8').split('\n').filter(Boolean);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'transcripts-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('reading a transcript as it grows', () => {
  test('none until the file exists; then its entries, and later only the new ones', async () => {
    const reader = createTranscriptReader();
    const path = join(dir, 'session.jsonl');
    expect(await reader.read('a', 'claude', null, 0)).toMatchObject({ status: 'none', entries: [] });
    expect(await reader.read('a', 'claude', path, 0)).toMatchObject({ status: 'none', entries: [] });

    writeFileSync(path, `${claudeLines.slice(0, 7).join('\n')}\n`);
    const first = await reader.read('a', 'claude', path, 0);
    expect(first).toMatchObject({ status: 'ok', from: 0 });
    expect(first.entries.map((entry) => entry.kind)).toEqual(['user', 'assistant']);

    appendFileSync(path, `${claudeLines.slice(7, 9).join('\n')}\n`);
    const next = await reader.read('a', 'claude', path, 2, first.generation);
    expect(next).toMatchObject({ status: 'ok', generation: first.generation, from: 2 });
    expect(next.entries.map((entry) => entry.kind)).toEqual(['tool-call', 'tool-result']);
    expect((await reader.read('a', 'claude', path, 4, first.generation)).entries).toEqual([]);
  });

  test('a line still being written waits for its line break, even split inside a character', async () => {
    const reader = createTranscriptReader();
    const path = join(dir, 'session.jsonl');
    const line = JSON.stringify({ type: 'user', version: '2.1.0', message: { role: 'user', content: 'café ✓' } });
    const bytes = Buffer.from(`${line}\n`);
    const cut = bytes.indexOf(Buffer.from('✓')) + 1;
    writeFileSync(path, bytes.subarray(0, cut));
    expect((await reader.read('a', 'claude', path, 0)).entries).toEqual([]);
    appendFileSync(path, bytes.subarray(cut));
    expect((await reader.read('a', 'claude', path, 0)).entries).toEqual([{ kind: 'user', text: 'café ✓' }]);
  });

  test('a transcript cut short, or another file, starts over in a new generation', async () => {
    const reader = createTranscriptReader();
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, `${claudeLines.slice(0, 9).join('\n')}\n`);
    const first = await reader.read('a', 'claude', path, 0);
    expect(first.entries).toHaveLength(4);

    writeFileSync(path, `${claudeLines[2]}\n`);
    const shorter = await reader.read('a', 'claude', path, 4, first.generation);
    expect(shorter.generation).not.toBe(first.generation);
    expect(shorter).toMatchObject({ from: 0, entries: [{ kind: 'user' }] });

    const other = join(dir, 'other.jsonl');
    writeFileSync(other, `${claudeLines[6]}\n`);
    const moved = await reader.read('a', 'claude', other, 1, shorter.generation);
    expect(moved.generation).not.toBe(shorter.generation);
    expect(moved).toMatchObject({ from: 0, entries: [{ kind: 'assistant' }] });
  });

  test('a long transcript sends only its latest entries, and keeps only its latest', async () => {
    const reader = createTranscriptReader();
    const path = join(dir, 'session.jsonl');
    const prompt = (n: number) => JSON.stringify({ type: 'user', version: '2.1.0', message: { role: 'user', content: `prompt ${n}` } });
    writeFileSync(path, `${Array.from({ length: MAX_KEPT_ENTRIES + 100 }, (_, n) => prompt(n)).join('\n')}\n`);
    const first = await reader.read('a', 'claude', path, 0);
    expect(first.entries).toHaveLength(MAX_CHUNK_ENTRIES);
    expect(first).toMatchObject({ from: MAX_KEPT_ENTRIES + 100 - MAX_CHUNK_ENTRIES, earlier: true });
    expect(first.entries.at(-1)).toEqual({ kind: 'user', text: `prompt ${MAX_KEPT_ENTRIES + 99}` });
    // A client far behind gets no more than the latest either; one asking from before what is kept, from what is.
    expect((await reader.read('a', 'claude', path, 0, first.generation)).from).toBe(first.from);
    appendFileSync(path, `${prompt(9999)}\n`);
    const next = await reader.read('a', 'claude', path, first.from + first.entries.length, first.generation);
    expect(next).toMatchObject({ from: MAX_KEPT_ENTRIES + 100, entries: [{ kind: 'user', text: 'prompt 9999' }] });
  });

  test('a huge transcript is read from near its end, after its first line', async () => {
    const reader = createTranscriptReader();
    const path = join(dir, 'rollout.jsonl');
    const codex = readFileSync(join(fixtures, 'codex/rollouts/rollout-2026-10-08T22-58-07-01a11d86-0ed1-79b0-b5f7-5bf941eadee1.jsonl'), 'utf8').split('\n');
    const filler = JSON.stringify({ timestamp: 't', type: 'event_msg', payload: { type: 'token_count', pad: 'z'.repeat(10_000) } });
    const fillerLines = Math.ceil((TAIL_START_BYTES * 1.5) / filler.length);
    writeFileSync(path, `${codex[0]}\n${Array.from({ length: fillerLines }, () => filler).join('\n')}\n${codex.slice(1).join('\n')}`);
    const chunk = await reader.read('a', 'codex', path, 0);
    expect(chunk.status).toBe('ok');
    expect(chunk.earlier).toBe(true);
    expect(chunk.entries[0]).toMatchObject({ kind: 'user' });
    expect(chunk.entries).toHaveLength(15);

    // Its first line still says which version wrote it.
    const future = join(dir, 'future.jsonl');
    writeFileSync(future, `${codex[0]!.replace('0.162.0-alpha.2', '1.0.0')}\n${Array.from({ length: fillerLines }, () => filler).join('\n')}\n`);
    expect(await reader.read('b', 'codex', future, 0)).toMatchObject({ status: 'unsupported', reason: 'Codex 1.0.0 rollouts are not supported yet' });
  });

  test('a generation is never one a reader of an earlier daemon gave', async () => {
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, `${claudeLines[2]}\n`);
    const before = await createTranscriptReader().read('a', 'claude', path, 0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const after = await createTranscriptReader().read('a', 'claude', path, 1, before.generation);
    expect(after.generation).not.toBe(before.generation);
    expect(after.entries).toHaveLength(1);
  });

  test('an unreadable format is unsupported, saying why', async () => {
    const reader = createTranscriptReader();
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, 'not a transcript\n');
    expect(await reader.read('a', 'claude', path, 0)).toMatchObject({ status: 'unsupported', reason: 'the transcript has a line that is not JSON', entries: [] });
  });

  test('forgetting a session drops what was read', async () => {
    const reader = createTranscriptReader();
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, `${claudeLines[2]}\n`);
    const first = await reader.read('a', 'claude', path, 0);
    reader.forget('a');
    const again = await reader.read('a', 'claude', path, 1, first.generation);
    expect(again.generation).not.toBe(first.generation);
    expect(again.entries).toHaveLength(1);
  });
});

describe("reading a Claude subagent's transcript", () => {
  beforeEach(() => cpSync(join(fixtures, 'claude/transcripts'), dir, { recursive: true }));

  test('found by its agent id, or by the call that started it', async () => {
    const reader = createTranscriptReader();
    const path = join(dir, `${CLAUDE_SESSION}.jsonl`);
    const byAgent = await reader.readSubagent('claude', path, 'toolu_unknown', 'a88af6cf82bf325bc');
    expect(byAgent.status).toBe('ok');
    expect(byAgent.entries.map((entry) => entry.kind)).toEqual(['user', 'tool-call', 'tool-result', 'assistant']);
    expect((await reader.readSubagent('claude', path, 'toolu_01Agent00000000000000003')).entries).toEqual(byAgent.entries);
  });

  test("none when it can't be found, or for Codex, whose subagents talk in its own rollout", async () => {
    const reader = createTranscriptReader();
    const path = join(dir, `${CLAUDE_SESSION}.jsonl`);
    expect(await reader.readSubagent('claude', path, 'toolu_unknown')).toMatchObject({ status: 'none', entries: [] });
    expect(await reader.readSubagent('claude', path, 'toolu_x', '../../escape')).toMatchObject({ status: 'none' });
    expect(await reader.readSubagent('codex', path, 'toolu_01Agent00000000000000003')).toMatchObject({ status: 'none' });
  });
});
