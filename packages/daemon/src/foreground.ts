import { execFile } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import type { Harness } from './protocol.ts';

/** How long `ps` gets to answer. */
const PS_TIMEOUT_MS = 2_000;

/**
 * How long `lsof` and the `ps` after it get to name the program. A read that times out says nothing is a harness, and
 * nothing re-reads it until the shell next prints, so a busy machine gets longer than for the rest.
 */
const PROGRAM_TIMEOUT_MS = 10_000;

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

/** The executable a foreground process group's leader runs, and its arguments as it can say them. */
export interface ForegroundProgram {
  /** The executable's real path, from the kernel (`lsof`, `/proc`), never from the argv the process can rewrite. */
  exe: string;
  /** Its arguments after the program: `node /path/to/claude --flag` has `/path/to/claude` first. */
  args: string[];
}

/** What a shell's terminal is running: whether a command is in the foreground, and the TCP ports it listens on. */
export interface Foreground {
  busy: boolean;
  /** Ascending, without repeats; empty when nothing listens or it can't be told. */
  ports: number[];
  /** The foreground group leader's program, when it could be told. */
  program?: ForegroundProgram | null;
  /** The agent harness that program is (`harnessOfProgram`), set by whoever knows where the harnesses are. */
  harness?: Harness | null;
}

const realpathOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/** The interpreter a script's `#!` line names (`#!/usr/bin/env node` is `node`), else null. */
function shebangInterpreter(file: string): string | null {
  try {
    const first = readFileSync(file, { encoding: 'utf8' }).split('\n', 1)[0] ?? '';
    if (!first.startsWith('#!')) return null;
    const [program, ...rest] = first.slice(2).trim().split(/\s+/);
    const word = basename(program ?? '') === 'env' ? rest.find((each) => !each.startsWith('-')) : program;
    return word === undefined ? null : basename(word);
  } catch {
    return null;
  }
}

/** Node's flags that run code given on the command line, and never load the script named after them. */
const EVAL_FLAG = /^(-e|-p|-pe|-ep|--eval|--print|-)(=|$)/;

/**
 * The harness `program` is: its executable's real path is the harness's own (kernel-told, so a rename, a copy or an
 * editor opened on it does not count), or it is the interpreter the harness script's `#!` line names, run on that
 * script by absolute path. The script path comes from the process's argv, which the process can rewrite
 * (`process.title`), and no kernel source says what a node process loaded: so a node-script harness (an npm install)
 * can be faked, bar `--eval` and `--print`, which are refused. That is fine for what this decides, which is only what the
 * tile shows, Restart waiting and Shift+Enter in the terminal; it grants nothing. Words are re-joined to match a script
 * path with spaces in it. `pathOf` is where each harness is.
 */
export function harnessOfProgram(program: ForegroundProgram | null | undefined, pathOf: (harness: Harness) => string | undefined): Harness | null {
  if (program === null || program === undefined) return null;
  const exe = realpathOrNull(program.exe);
  if (exe === null) return null;
  const first = program.args.findIndex((word) => !word.startsWith('-'));
  const evaluates = program.args.slice(0, first === -1 ? undefined : first).some((word) => EVAL_FLAG.test(word));
  for (const harness of ['claude', 'codex'] as const) {
    const path = pathOf(harness);
    const real = path === undefined ? null : realpathOrNull(path);
    if (real === null) continue;
    if (exe === real) return harness;
    if (evaluates || first === -1 || shebangInterpreter(real) !== basename(exe)) continue;
    for (let end = first + 1; end <= program.args.length; end++) {
      const script = program.args.slice(first, end).join(' ');
      if (isAbsolute(script) && realpathOrNull(script) === real) return harness;
    }
  }
  return null;
}

/** The executable of process `pid`, from the kernel: `/proc/<pid>/exe` on Linux, else the first `txt` mapping `lsof` lists. */
async function executableOf(pid: number): Promise<string | null> {
  const proc = realpathOrNull(`/proc/${pid}/exe`);
  if (proc !== null) return proc;
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', '-p', String(pid), '-a', '-d', 'txt', '-Fn'], { timeout: PROGRAM_TIMEOUT_MS }, (_error, stdout) =>
      resolve(/^n(\/.*)$/m.exec(stdout ?? '')?.[1] ?? null),
    );
  });
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
  if (group === undefined) return { busy: false, ports: [], program: null };
  // The group leader's program: its pid is the group's id.
  const exe = await executableOf(group);
  const program = await new Promise<ForegroundProgram | null>((resolve) => {
    if (exe === null) return resolve(null);
    execFile('ps', ['-o', 'args=', '-p', String(group)], { timeout: PROGRAM_TIMEOUT_MS }, (error, stdout) =>
      resolve({ exe, args: error === null ? (stdout ?? '').trim().split(/\s+/).slice(1) : [] }),
    );
  });
  const ports = await new Promise<number[]>((resolve) => {
    // -a: listening TCP sockets AND of that process group; -F n: one `n<address>:<port>` line each.
    execFile('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-g', String(group), '-Fn'], { timeout: PS_TIMEOUT_MS }, (_error, stdout) =>
      resolve(listeningPorts(stdout ?? '')),
    );
  });
  return { busy: true, ports, program };
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
