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

/** What a shell's terminal is running: whether a command is in the foreground, and the TCP ports it listens on. */
export interface Foreground {
  busy: boolean;
  /** Ascending, without repeats; empty when nothing listens or it can't be told. */
  ports: number[];
}

/**
 * What the shell `pid` is running: as `isRunningSomething`, and while it runs something, the ports its
 * foreground process group listens on (a dev server's), from `lsof`. Never throws.
 */
export async function foregroundOf(pid: number): Promise<Foreground> {
  const group = await new Promise<number | undefined>((resolve) => {
    execFile('ps', ['-o', 'tpgid=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS }, (error, stdout) => {
      const foreground = Number.parseInt(stdout.trim(), 10);
      resolve(error === null && foreground > 0 && foreground !== pid ? foreground : undefined);
    });
  });
  if (group === undefined) return { busy: false, ports: [] };
  const ports = await new Promise<number[]>((resolve) => {
    // -a: listening TCP sockets AND of that process group; -F n: one `n<address>:<port>` line each.
    execFile('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-g', String(group), '-Fn'], { timeout: PS_TIMEOUT_MS }, (_error, stdout) =>
      resolve(listeningPorts(stdout ?? '')),
    );
  });
  return { busy: true, ports };
}

/** The ports in `lsof -Fn` output, ascending and once each. */
export function listeningPorts(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split('\n')) {
    const port = /^n.*:(\d+)$/.exec(line.trim())?.[1];
    if (port !== undefined) ports.add(Number(port));
  }
  return [...ports].sort((a, b) => a - b);
}
