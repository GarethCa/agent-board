import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const main = join(import.meta.dirname, 'main.ts');
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-lockmain-'));
  file = join(dir, 'e2e.lock');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[]): { done: Promise<{ code: number | null; out: string }>; child: ReturnType<typeof spawn> } {
  const child = spawn(process.execPath, [main, ...args], { env: { ...process.env, AGENT_BOARD_E2E_LOCK: file }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  child.stderr!.on('data', (d) => (out += d));
  return { child, done: new Promise((resolve) => child.on('close', (code) => resolve({ code, out }))) };
}

describe('main.ts', () => {
  it('passes the command\'s exit status through and releases the lock', async () => {
    expect((await run(['e2e', '--', 'sh', '-c', 'exit 3']).done).code).toBe(3);
    expect(existsSync(file)).toBe(false);
    expect((await run(['e2e', '--', 'true']).done).code).toBe(0);
  });

  it('stops the command it started, then releases the lock, when it is terminated', async () => {
    const { child, done } = run(['e2e', '--', 'sh', '-c', 'echo up; exec sleep 60']);
    await new Promise((r) => child.stdout!.once('data', r));
    const start = Date.now();
    child.kill('SIGTERM');
    await done;
    expect(Date.now() - start).toBeLessThan(10_000);
    expect(existsSync(file)).toBe(false);
  });
});
