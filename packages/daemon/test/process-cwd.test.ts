import { spawn } from 'node:child_process';
import { describe, expect, it, onTestFinished } from 'vitest';
import { processCwd } from '../src/process-cwd.ts';
import { tempDataDir } from './helpers.ts';

describe('processCwd', () => {
  it.skipIf(process.platform === 'win32')("finds a running process's working directory", async () => {
    const dir = tempDataDir();
    const child = spawn('/bin/sh', ['-c', 'sleep 30'], { cwd: dir, stdio: 'ignore' });
    onTestFinished(() => void child.kill('SIGKILL'));

    expect(await processCwd(child.pid!)).toBe(dir);
  });

  it('gives undefined for a process that is not there', async () => {
    expect(await processCwd(2 ** 22 + 12_345)).toBeUndefined();
  });
});
