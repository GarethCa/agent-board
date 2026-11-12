import { mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The shell e2e apps run: /bin/sh on macOS, where that is bash in POSIX mode. Linux's is often dash, which reports no
 * command status, so there it is bash run under the name `sh`, which behaves the same and reads no rc files.
 */
function testShell(): string {
  if (process.platform === 'darwin') return '/bin/sh';
  const dir = join(tmpdir(), 'agent-board-e2e-shell');
  mkdirSync(dir, { recursive: true });
  const shell = join(dir, 'sh');
  try {
    symlinkSync('/bin/bash', shell);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return shell;
}

export const TEST_SHELL = testShell();
