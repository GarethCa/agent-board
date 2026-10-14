import { execFile } from 'node:child_process';

/** How long `ps` gets to answer. */
const PS_TIMEOUT_MS = 2_000;

/**
 * Whether the shell `pid` is running something: its terminal's foreground process group is not the shell's own, as
 * while a command runs in it. False if it can't be told (the shell has exited, or `ps` fails). Never throws. On
 * Windows, which has no `ps` or process groups, it is always false, so a restart there never asks first.
 */
export async function isRunningSomething(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    // tpgid: the foreground process group of the process's terminal. A shell at its prompt is its own group's leader.
    execFile('ps', ['-o', 'tpgid=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS }, (error, stdout) => {
      const foreground = Number.parseInt(stdout.trim(), 10);
      resolve(error === null && foreground > 0 && foreground !== pid);
    });
  });
}
