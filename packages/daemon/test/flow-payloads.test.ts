import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPayloadPath, MAX_PAYLOAD_BYTES, payloadName, readPayload } from '../src/flow-payloads.ts';
import { tempDataDir } from './helpers.ts';

/** A worktree holding `files`, by path relative to it. */
function worktree(files: Record<string, string> = {}): string {
  const dir = tempDataDir();
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

describe('checkPayloadPath', () => {
  it('takes a path inside the worktree, tidied', () => {
    expect(checkPayloadPath('plan.md')).toBe('plan.md');
    expect(checkPayloadPath(' ./docs//plan.md ')).toBe('docs/plan.md');
  });

  it('refuses an empty path, an absolute one, and one that climbs out of the worktree', () => {
    for (const path of ['', '  ', '/etc/passwd', '../other/plan.md', 'docs/../../plan.md', '.']) {
      expect(() => checkPayloadPath(path), path).toThrow();
    }
  });
});

describe('payloadName', () => {
  it("names a final message, and a file by its own name, as an edge's label does", () => {
    expect(payloadName('final-message', null)).toBe('final message');
    expect(payloadName('handover', 'docs/plan.md')).toBe('plan.md');
    expect(payloadName('json', 'out/result.json')).toBe('result.json');
  });
});

describe('readPayload', () => {
  it('carries the final message as it is', async () => {
    expect(await readPayload({ payload: 'final-message', path: null, worktree: worktree(), finalMessage: 'Done.' })).toEqual({
      name: 'final message',
      text: 'Done.',
      shown: 'Done.',
      bytes: 5,
    });
  });

  it('says so when there is no final message yet', async () => {
    expect(await readPayload({ payload: 'final-message', path: null, worktree: worktree(), finalMessage: undefined })).toEqual({
      name: 'final message',
      problem: expect.stringContaining('no final message'),
    });
  });

  it("carries a markdown file from the agent's worktree, as it is now", async () => {
    const plan = '# Plan\n\n1. Add zoneId.\n2. Drag tiles.\n';
    expect(await readPayload({ payload: 'handover', path: 'docs/plan.md', worktree: worktree({ 'docs/plan.md': plan }), finalMessage: 'x' })).toEqual({
      name: 'plan.md',
      text: plan,
      shown: plan,
      bytes: Buffer.byteLength(plan),
    });
  });

  it('carries JSON on one line, shows it indented, and refuses a file that is not JSON', async () => {
    const result = '{ "verdict": "approve",\n  "findings": [] }';
    const tree = worktree({ 'result.json': result, 'bad.json': '{ verdict: ' });
    expect(await readPayload({ payload: 'json', path: 'result.json', worktree: tree, finalMessage: undefined })).toEqual({
      name: 'result.json',
      text: '{"verdict":"approve","findings":[]}',
      shown: '{\n  "verdict": "approve",\n  "findings": []\n}',
      bytes: Buffer.byteLength(result),
    });
    expect(await readPayload({ payload: 'json', path: 'bad.json', worktree: tree, finalMessage: undefined })).toEqual({
      name: 'bad.json',
      problem: expect.stringMatching(/^bad\.json is not JSON: /),
    });
  });

  it('says why it cannot carry a missing file, a folder, or one too big to type', async () => {
    const tree = worktree({ 'docs/readme.md': 'x', 'big.md': 'x'.repeat(MAX_PAYLOAD_BYTES + 1) });
    const read = (path: string) => readPayload({ payload: 'handover', path, worktree: tree, finalMessage: undefined });
    expect(await read('plan.md')).toEqual({ name: 'plan.md', problem: "there is no plan.md in its worktree" });
    expect(await read('docs')).toEqual({ name: 'docs', problem: 'docs is not a file' });
    expect(await read('big.md')).toEqual({ name: 'big.md', problem: expect.stringMatching(/^big\.md is over 64 KB/) });
  });

  it('never reads outside the worktree, even through a symbolic link', async () => {
    const outside = worktree({ 'secret.md': 'keys' });
    const tree = worktree();
    symlinkSync(join(outside, 'secret.md'), join(tree, 'plan.md'));
    expect(await readPayload({ payload: 'handover', path: 'plan.md', worktree: tree, finalMessage: undefined })).toEqual({
      name: 'plan.md',
      problem: 'plan.md leads out of its worktree',
    });
  });
});
