import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileCacheGlobalSetup } from '../src/compile-cache.ts';
import { startFake } from './run-fake.ts';

/** The cache entries under `dir`, which also holds a version dir as soon as the cache is on, entries or not. */
const entries = (dir: string): string[] => {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

describe('the compile cache', () => {
  const dirs: string[] = [];
  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'ab-compile-cache-'));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('is set for this run, and a child Node process uses it', () => {
    const dir = process.env.NODE_COMPILE_CACHE;
    expect(dir).toBeTruthy();
    const used = execFileSync(process.execPath, ['-e', "console.log(require('node:module').getCompileCacheDir())"], { encoding: 'utf8' }).trim();
    expect(used.startsWith(dir!)).toBe(true);
  });

  it('points a run at one shared dir, and keeps a dir already set', () => {
    const env: NodeJS.ProcessEnv = {};
    compileCacheGlobalSetup(env);
    expect(env.NODE_COMPILE_CACHE).toBe(join(tmpdir(), 'agent-board-compile-cache'));
    const set: NodeJS.ProcessEnv = { NODE_COMPILE_CACHE: '/elsewhere' };
    compileCacheGlobalSetup(set);
    expect(set.NODE_COMPILE_CACHE).toBe('/elsewhere');
  });

  it('gets entries from a process that exits cleanly', () => {
    const dir = tempDir();
    const script = join(dir, 'script.mjs');
    writeFileSync(script, 'export {};\n');
    execFileSync(process.execPath, [script], { env: { ...process.env, NODE_COMPILE_CACHE: join(dir, 'cache') } });
    expect(entries(join(dir, 'cache'))).not.toEqual([]);
  });

  it('gets entries from a fake harness before it exits, as most tests end theirs by a signal', async () => {
    const cache = join(tempDir(), 'cache');
    const { child, done } = startFake('claude', { scenario: 'waiting', env: { NODE_COMPILE_CACHE: cache } });
    // The flush writes entries one at a time, so a kill at the first entry could leave few. Seen here, before any exit.
    await expect.poll(() => entries(cache).length, { timeout: 10_000 }).toBeGreaterThan(10);
    child.kill('SIGKILL');
    await done;
  });
});
