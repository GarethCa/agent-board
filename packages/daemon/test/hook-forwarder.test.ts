import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import { startHookRecorder } from '@agent-board/fake-harness';
import { externalHookCommand } from '../src/external-hooks.ts';
import {
  CODEX_HOOK_TIMEOUTS,
  HOOK_TOKEN_ENV,
  HOOK_URL_ENV,
  codexHookCommand,
  forwardTimeoutMs,
  readExternalHookFile,
  removeExternalHookFile,
  writeExternalHookFile,
  writeHookShim,
} from '../src/hook-forwarder.ts';
import { TEST_HOOK_FORWARDER, tempDataDir } from './helpers.ts';

const payload = JSON.parse(readFileSync(new URL('../../../fixtures/codex/hooks/PermissionRequest.json', import.meta.url), 'utf8'));

/** Runs the shim as Codex does: its hook command through a shell, the payload on stdin. */
async function runHook(shim: string, env: Record<string, string>, input = JSON.stringify(payload)) {
  const started = Date.now();
  // Not spawnSync: the recorder answering it lives in this process.
  const child = spawn('/bin/sh', ['-c', codexHookCommand(shim)], { env: { PATH: process.env.PATH!, ...env } });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stdin.end(input);
  const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
  return { status, stdout, ms: Date.now() - started };
}

function shim(): string {
  const path = join(tempDataDir(), 'bin', 'agent-board-hook');
  writeHookShim(path, TEST_HOOK_FORWARDER);
  return path;
}

describe('the hook forwarder', () => {
  it('posts the payload to the daemon with the session token and prints its answer', async () => {
    const answer = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } } };
    const recorder = await startHookRecorder(() => answer);
    onTestFinished(() => recorder.close());

    const result = await runHook(shim(), { [HOOK_URL_ENV]: recorder.url, [HOOK_TOKEN_ENV]: 'tok' });

    expect(result.status).toBe(0);
    expect(recorder.events).toEqual([payload]);
    expect(recorder.headers[0]!.authorization).toBe('Bearer tok');
    expect(JSON.parse(result.stdout)).toEqual(answer);
  });

  it('prints nothing for an empty answer, so Codex carries on as if no hook had a say', async () => {
    const recorder = await startHookRecorder();
    onTestFinished(() => recorder.close());
    const result = await runHook(shim(), { [HOOK_URL_ENV]: recorder.url, [HOOK_TOKEN_ENV]: 'tok' });
    expect(result).toMatchObject({ status: 0, stdout: '' });
  });

  it('exits at once with no output when the daemon is unreachable or the session has no hook env', async () => {
    const path = shim();
    for (const env of [{ [HOOK_URL_ENV]: 'http://127.0.0.1:9/hooks', [HOOK_TOKEN_ENV]: 'tok' }, {}] as Record<string, string>[]) {
      const result = await runHook(path, env);
      expect(result).toMatchObject({ status: 0, stdout: '' });
      expect(result.ms).toBeLessThan(3_000);
    }
  });

  it('prints nothing when the daemon refuses the call', async () => {
    const recorder = await startHookRecorder();
    onTestFinished(() => recorder.close());
    const result = await runHook(shim(), { [HOOK_URL_ENV]: recorder.url, [HOOK_TOKEN_ENV]: 'tok' }, 'not json');
    expect(result).toMatchObject({ status: 0, stdout: '' });
  });

  it('writes an executable shim, replacing an older one, with a launcher that survives odd paths', () => {
    const path = join(tempDataDir(), "it's a \"dir\" $HOME", 'agent-board-hook');
    writeHookShim(path, { command: '/old/app', args: [] });
    writeHookShim(path, { command: process.execPath, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))'] });
    expect(statSync(path).mode & 0o777).toBe(0o700);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    const out = execFileSync('/bin/sh', ['-c', codexHookCommand(path)], { encoding: 'utf8' });
    expect(JSON.parse(out)).toEqual(['hook', 'codex']);
  });

  it('quotes the shim path into the command Codex runs, the same way every time', () => {
    expect(codexHookCommand('/Users/me/.agent-board/bin/agent-board-hook')).toBe(
      '"/Users/me/.agent-board/bin/agent-board-hook" codex',
    );
    expect(codexHookCommand("/Users/o'neil/.agent-board/bin/agent-board-hook")).toBe(
      `"/Users/o'neil/.agent-board/bin/agent-board-hook" codex`,
    );
    expect(codexHookCommand("/Users/$o'neil/agent-board-hook")).toBe(`'/Users/$o'\\''neil/agent-board-hook' codex`);
  });

  it('puts back a shim another app rewrote, leaves a current one alone, and tightens a loose folder', () => {
    const dir = join(tempDataDir(), 'bin');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const path = join(dir, 'agent-board-hook');
    writeHookShim(path, TEST_HOOK_FORWARDER);
    const written = readFileSync(path, 'utf8');
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    const { ino } = statSync(path);
    writeHookShim(path, TEST_HOOK_FORWARDER);
    expect(statSync(path).ino).toBe(ino);

    writeFileSync(path, '#!/bin/sh\nexec /some/deleted/checkout hook "$@"\n');
    writeHookShim(path, TEST_HOOK_FORWARDER);
    expect(readFileSync(path, 'utf8')).toBe(written);
  });

  it('gives up on the daemon half a second before Codex gives up on the hook', () => {
    for (const [event, seconds] of Object.entries(CODEX_HOOK_TIMEOUTS)) expect(forwardTimeoutMs(event)).toBe(seconds * 1000 - 500);
    expect(forwardTimeoutMs('SomethingNew')).toBe(4_500);
    expect(forwardTimeoutMs(undefined)).toBe(4_500);
  });
});

describe('the external hook forwarder', () => {
  /** A shim whose external hooks find the daemon through `file`. */
  function externalShim(file: string): string {
    const path = join(tempDataDir(), 'bin', 'agent-board-hook');
    writeHookShim(path, TEST_HOOK_FORWARDER, file);
    return path;
  }

  /** Runs the shim as a global hook: its command through a shell, the payload on stdin. */
  async function runExternalHook(shimPath: string, env: Record<string, string> = {}) {
    const started = Date.now();
    const child = spawn('/bin/sh', ['-c', externalHookCommand(shimPath, 'claude')], { env: { PATH: process.env.PATH!, ...env } });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stdin.end(JSON.stringify(payload));
    const status = await new Promise<number | null>((resolve) => child.on('close', resolve));
    return { status, stdout, ms: Date.now() - started };
  }

  it('posts the payload to the daemon the external hook file names, with its token, and prints nothing', async () => {
    const recorder = await startHookRecorder(() => ({ decision: 'ignored' }));
    onTestFinished(() => recorder.close());
    const file = join(tempDataDir(), 'external-hook.json');
    writeExternalHookFile(file, { url: recorder.url, token: 'ext' });

    const result = await runExternalHook(externalShim(file));

    expect(result).toMatchObject({ status: 0, stdout: '' });
    expect(recorder.events).toEqual([payload]);
    expect(recorder.headers[0]!.authorization).toBe('Bearer ext');
  });

  it("skips sessions agent-board spawned: their own hooks report them", async () => {
    const recorder = await startHookRecorder();
    onTestFinished(() => recorder.close());
    const file = join(tempDataDir(), 'external-hook.json');
    writeExternalHookFile(file, { url: recorder.url, token: 'ext' });

    const result = await runExternalHook(externalShim(file), { [HOOK_TOKEN_ENV]: 'agent-token' });

    expect(result).toMatchObject({ status: 0, stdout: '' });
    expect(recorder.events).toEqual([]);
  });

  it('exits at once with no output when no daemon runs, or the one named is gone', async () => {
    const dir = tempDataDir();
    const missing = await runExternalHook(externalShim(join(dir, 'none.json')));
    expect(missing).toMatchObject({ status: 0, stdout: '' });

    const stale = join(dir, 'stale.json');
    writeExternalHookFile(stale, { url: 'http://127.0.0.1:9/external/claude', token: 'ext' });
    const result = await runExternalHook(externalShim(stale));
    expect(result).toMatchObject({ status: 0, stdout: '' });
    expect(result.ms).toBeLessThan(3_000);
  });

  it("writes the daemon's file for the user alone, and removes it only for the daemon that wrote it", () => {
    const file = join(tempDataDir(), 'external-hook.json');
    writeExternalHookFile(file, { url: 'http://127.0.0.1:1/external', token: 'first' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    writeExternalHookFile(file, { url: 'http://127.0.0.1:2/external', token: 'second' });

    removeExternalHookFile(file, 'first');
    expect(readExternalHookFile(file)).toEqual({ url: 'http://127.0.0.1:2/external', token: 'second' });
    removeExternalHookFile(file, 'second');
    expect(readExternalHookFile(file)).toBeUndefined();
  });
});
