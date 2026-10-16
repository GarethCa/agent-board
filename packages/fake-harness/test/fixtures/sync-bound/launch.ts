/**
 * Run by guard.test.ts with node, not Vitest: installs the guard as a worker's setup file does, then makes blocking
 * sync launches through `node:child_process` and prints how each one ended and after how long, as JSON.
 */
import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { guardChildProcess } from '../../../src/guard.ts';

guardChildProcess();

function ended(launch: () => unknown): { code: string; ms: number } {
  const started = Date.now();
  let code = 'returned';
  try {
    const result = launch() as { error?: { code?: string } } | undefined;
    if (result?.error?.code) code = result.error.code;
  } catch (error) {
    code = (error as { code?: string }).code ?? 'threw';
  }
  return { code, ms: Date.now() - started };
}

console.log(JSON.stringify({
  execFileSync: ended(() => execFileSync('sleep', ['30'])),
  execSync: ended(() => execSync('sleep 30')),
  execSyncNoOptions: ended(() => execSync('sleep 30', undefined)),
  spawnSync: ended(() => spawnSync('sleep', ['30'])),
  ownTimeout: ended(() => execFileSync('sleep', ['30'], { timeout: 1500 })),
  unbounded: ended(() => spawnSync('sleep', ['1'], { timeout: 0 })),
}));
