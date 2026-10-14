import { execFile } from 'node:child_process';
import { readlink } from 'node:fs/promises';

/** How long `lsof` gets to answer. */
const LSOF_TIMEOUT_MS = 2_000;

/**
 * The working directory of process `pid`, or undefined if it can't be found (it has exited, or the platform has no way
 * to ask): `/proc/<pid>/cwd` on Linux, `lsof` on macOS. Never throws.
 */
export async function processCwd(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') return readlink(`/proc/${pid}/cwd`).catch(() => undefined);
  if (process.platform !== 'darwin') return undefined;
  return new Promise((resolve) => {
    // -a ANDs the selections: only process pid's cwd. -Fn prints it as a line starting with `n`.
    execFile('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: LSOF_TIMEOUT_MS }, (error, stdout) => {
      if (error) return resolve(undefined);
      const line = stdout.split('\n').find((candidate) => candidate.startsWith('n/'));
      resolve(line?.slice(1));
    });
  });
}
