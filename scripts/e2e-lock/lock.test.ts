import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock, processStart, type Holder } from './lock.ts';

let dir: string;
let file: string;
const children: ChildProcess[] = [];
const opts = (step: string, extra: object = {}) => ({ file, step, worktree: '/wt', pollMs: 20, log: () => {}, ...extra });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ab-lock-test-'));
  file = join(dir, 'e2e.lock');
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

describe('acquireLock', () => {
  it('serialises two contenders: the second waits until the first releases, and says who holds it', async () => {
    const first = await acquireLock(opts('e2e'));
    const told: string[] = [];
    let second = false;
    const waiting = acquireLock(opts('visual', { log: (m: string) => told.push(m) })).then((lock) => {
      second = true;
      return lock;
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(second).toBe(false);
    expect(told[0]).toContain('e2e in /wt');
    expect(told[0]).toContain(`pid ${process.pid}`);
    first.release();
    const lock = await waiting;
    expect(second).toBe(true);
    lock.release();
    expect(existsSync(file)).toBe(false);
  });

  it('recovers a stale lock whose holder is dead', async () => {
    const dead = spawn('sleep', ['0.01']);
    const pid = dead.pid!;
    const started = processStart(pid) ?? 'x';
    await new Promise((r) => dead.on('close', r));
    const holder: Holder = { pid, started, worktree: '/gone', step: 'e2e', since: 'then' };
    writeFileSync(file, JSON.stringify(holder));
    const lock = await acquireLock(opts('e2e', { maxWaitMs: 2_000 }));
    expect(JSON.parse(readFileSync(file, 'utf8')).pid).toBe(process.pid);
    lock.release();
  });

  it('treats a live PID with another start time as a recycled one, so stale', async () => {
    writeFileSync(file, JSON.stringify({ pid: process.pid, started: 'not my start', worktree: '/x', step: 'e2e', since: 'then' }));
    const lock = await acquireLock(opts('e2e', { maxWaitMs: 2_000 }));
    lock.release();
  });

  it('recovers from a holder that is killed with SIGKILL', async () => {
    const script = `import { acquireLock } from ${JSON.stringify(join(import.meta.dirname, 'lock.ts'))};
      await acquireLock({ file: ${JSON.stringify(file)}, step: 'e2e', worktree: '/child', log() {} });
      console.log('held'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    children.push(child);
    await new Promise((r) => child.stdout!.once('data', r));
    expect(existsSync(file)).toBe(true);
    child.kill('SIGKILL');
    await new Promise((r) => child.on('close', r));
    const lock = await acquireLock(opts('e2e', { maxWaitMs: 2_000 }));
    lock.release();
  });

  it('gives up after the max wait, naming the holder and the file', async () => {
    const first = await acquireLock(opts('e2e'));
    await expect(acquireLock(opts('visual', { maxWaitMs: 100 }))).rejects.toThrow(/gave up.*e2e in \/wt.*e2e\.lock/s);
    first.release();
  });

  it('reads the same start time under any TZ, so a live holder is never judged stale', () => {
    const here = processStart(process.pid);
    const saved = process.env.TZ;
    process.env.TZ = 'Pacific/Auckland';
    try {
      expect(processStart(process.pid)).toBe(here);
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
  });

  it('keeps polling, and honours the max wait, when a stale lock\'s reclaim guard is held', async () => {
    writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 1, started: 'gone', worktree: '/gone', step: 'e2e', since: 'then' }));
    mkdirSync(`${file}.reclaim`);
    const began = Date.now();
    await expect(acquireLock(opts('e2e', { maxWaitMs: 300 }))).rejects.toThrow(/gave up/);
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  it('lets exactly one of several waiters take a stale lock', async () => {
    writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 1, started: 'gone', worktree: '/gone', step: 'e2e', since: 'then' }));
    const held: string[] = [];
    let active = 0;
    let overlapped = false;
    await Promise.all(
      ['a', 'b', 'c', 'd'].map(async (name) => {
        const lock = await acquireLock(opts(name));
        active++;
        overlapped ||= active > 1;
        held.push(name);
        await new Promise((r) => setTimeout(r, 30));
        active--;
        lock.release();
      }),
    );
    expect(held).toHaveLength(4);
    expect(overlapped).toBe(false);
  });
});
