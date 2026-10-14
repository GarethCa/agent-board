import childProcess from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fakeBinDir, HARNESS_NAMES } from './paths.ts';

const fakeBinReal = realpathSync(fakeBinDir);
const GUARD_DIR_ENV = 'AGENT_BOARD_HARNESS_GUARD_DIR';
/** What execvp and sh fall back to when the environment has no PATH. */
const DEFAULT_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

export interface HarnessGuard {
  /** Directory of tripwire binaries now first on PATH. */
  tripwireDir: string;
  /** Every tripwire hit, one line each. */
  hits(): string[];
  /** Throws if any tripwire was hit. Removes the tripwire dir either way. */
  assertClean(): void;
}

/**
 * Layer 1, for a whole test run (Vitest and Playwright globalSetup): puts `claude` and `codex` tripwires first on
 * PATH. Anything that finds a harness through PATH and is not using the fakes hits a tripwire, which logs the hit
 * and exits 127; `assertClean()` at teardown then fails the run even if the caller swallowed the error.
 */
export function installHarnessGuard(env: NodeJS.ProcessEnv = process.env): HarnessGuard {
  const tripwireDir = realpathSync(mkdtempSync(join(tmpdir(), 'agent-board-harness-guard-')));
  const log = join(tripwireDir, 'hits.log');
  writeFileSync(log, '');
  for (const name of HARNESS_NAMES) {
    const path = join(tripwireDir, name);
    writeFileSync(
      path,
      [
        '#!/bin/sh',
        `# agent-board test guard: tests must use the fake ${name} (packages/fake-harness), never the real one.`,
        `echo "${name} $*" >> '${log}'`,
        `echo "agent-board harness guard: refused to run the real ${name}; use fakeHarnessEnv() from @agent-board/fake-harness" >&2`,
        'exit 127',
        '',
      ].join('\n'),
    );
    chmodSync(path, 0o755);
  }
  env.PATH = [tripwireDir, env.PATH].filter(Boolean).join(delimiter);
  env[GUARD_DIR_ENV] = tripwireDir;

  const hits = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return {
    tripwireDir,
    hits,
    assertClean() {
      const found = hits();
      rmSync(tripwireDir, { recursive: true, force: true });
      if (found.length > 0) {
        throw new Error(`agent-board harness guard: tests tried to run a real harness:\n  ${found.join('\n  ')}`);
      }
    },
  };
}

/** Vitest/Playwright globalSetup body: install the guard, and fail the run at teardown if it was tripped. */
export function harnessGuardGlobalSetup(): () => void {
  const guard = installHarnessGuard();
  return () => guard.assertClean();
}

/** Resolves `command` the way spawn would: as a path if it has a slash, else through PATH. */
function resolveCommand(command: string, env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  if (command.includes('/')) {
    const path = isAbsolute(command) ? command : resolve(cwd, command);
    return existsSync(path) ? path : undefined;
  }
  for (const dir of (env.PATH ?? DEFAULT_PATH).split(delimiter)) {
    if (!dir) continue;
    const path = join(dir, command);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

/** The harness name if `command` would launch a `claude`/`codex` that is not one of the fakes. */
export function realHarnessFor(command: string, env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const name = basename(command);
  if (!(HARNESS_NAMES as readonly string[]).includes(name)) return undefined;
  const resolved = resolveCommand(command, env, cwd);
  if (resolved === undefined) return undefined;
  return dirname(realpathSync(resolved)) === fakeBinReal ? undefined : name;
}

/**
 * Splits shell text into simple commands (lists of words), honouring quotes and backslashes. Separators are
 * newline ; & | ( ) ` and $( . Good enough to find what a script launches; not a full shell parser.
 */
function simpleCommands(script: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: string | undefined;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < script.length) {
      word += script[++i];
      inWord = true;
    } else if (c === '\n' || ';&|()`'.includes(c)) {
      endCommand();
    } else if (c === '$' && script[i + 1] === '(') {
      endCommand();
      i++;
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const PREFIX_WORDS = new Set(['exec', 'nohup', 'time', '{', '!', 'then', 'do', 'else', 'if', 'elif', 'while', 'until']);

/**
 * The program a simple command launches and the PATH it is looked up on: skips `VAR=value` prefixes (a `PATH=` one
 * replaces the PATH), `exec`/`nohup`/`time` and shell keywords, and sees through `env [-opts] [VAR=value…]` and
 * `command`. `command -v`/`-V` only looks a name up, so it launches nothing.
 */
function launchedBy(words: string[], path: string | undefined): { command: string; path: string | undefined } | undefined {
  let i = 0;
  for (;;) {
    while (i < words.length && ASSIGNMENT.test(words[i]!)) {
      if (words[i]!.startsWith('PATH=')) path = words[i]!.slice('PATH='.length);
      i++;
    }
    const word = words[i];
    if (word === undefined) return undefined;
    const name = basename(word);
    if (name === 'env') {
      i++;
      while (i < words.length && words[i]!.startsWith('-')) {
        if (words[i] === '-i' || words[i] === '-') path = undefined;
        i++;
      }
    } else if (name === 'command') {
      if (words[i + 1] === '-v' || words[i + 1] === '-V') return undefined;
      i++;
      if (words[i] === '-p') i++;
    } else if (PREFIX_WORDS.has(word)) {
      i++;
    } else {
      return { command: word, path };
    }
  }
}

/**
 * The tripwire dir first on PATH, unless the caller put the fakes on PATH, in which case the fakes come first and
 * the tripwire right after them. Keeps the tripwire in place when a test or the code under test builds its own env.
 */
function guardedPath(path: string | undefined): string | undefined {
  const tripwireDir = process.env[GUARD_DIR_ENV];
  if (!tripwireDir) return path;
  const dirs = (path ?? DEFAULT_PATH).split(delimiter).filter((dir) => dir && dir !== tripwireDir);
  const fakeIndex = dirs.findIndex((dir) => dir === fakeBinDir || dir === fakeBinReal);
  if (fakeIndex >= 0) dirs.splice(fakeIndex + 1, 0, tripwireDir);
  else dirs.unshift(tripwireDir);
  return dirs.join(delimiter);
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

interface Launch {
  command: string;
  args: string[];
  options: Record<string, unknown>;
  /** The whole command is shell text (exec/execSync, or `shell: true`). */
  isShellText: boolean;
}

function refuse(real: string, what: string): never {
  throw new Error(
    `agent-board harness guard: refused to run the real ${real} (${what}). Spawn it with fakeHarnessEnv() from @agent-board/fake-harness.`,
  );
}

function check(launch: Launch): void {
  const env = (launch.options.env as NodeJS.ProcessEnv | undefined) ?? process.env;
  const cwd = launch.options.cwd instanceof URL ? launch.options.cwd.pathname : String(launch.options.cwd ?? process.cwd());
  let commands: string[][];
  if (launch.isShellText) {
    commands = simpleCommands([launch.command, ...launch.args].join(' '));
  } else {
    const cIndex = launch.args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    const script = SHELLS.has(basename(launch.command)) && cIndex >= 0 ? launch.args[cIndex + 1] : undefined;
    commands = script === undefined ? [[launch.command, ...launch.args]] : simpleCommands(script);
  }
  for (const words of commands) {
    const launched = launchedBy(words, env.PATH);
    if (!launched) continue;
    const real = realHarnessFor(launched.command, { ...env, PATH: launched.path }, cwd);
    if (real) refuse(real, words.join(' '));
  }
}

function isOptions(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Splits spawn-style arguments `(command, args?, options?, ...rest)`. */
function spawnStyle(args: unknown[]): { launch: Launch; rebuild: (options: Record<string, unknown>) => unknown[] } {
  const command = String(args[0]);
  const hasArgs = Array.isArray(args[1]);
  const list = hasArgs ? (args[1] as unknown[]).map(String) : [];
  const optionsIndex = hasArgs ? 2 : 1;
  const options = isOptions(args[optionsIndex]) ? args[optionsIndex] : {};
  const rest = args.slice(isOptions(args[optionsIndex]) ? optionsIndex + 1 : optionsIndex);
  return {
    launch: { command, args: list, options, isShellText: Boolean(options.shell) },
    rebuild: (newOptions) => [command, list, newOptions, ...rest],
  };
}

/** Splits exec-style arguments `(commandText, options?, callback?)`. */
function execStyle(args: unknown[]): { launch: Launch; rebuild: (options: Record<string, unknown>) => unknown[] } {
  const command = String(args[0]);
  const options = isOptions(args[1]) ? args[1] : {};
  const rest = args.slice(isOptions(args[1]) ? 2 : 1);
  return {
    launch: { command, args: [], options, isShellText: true },
    rebuild: (newOptions) => [command, newOptions, ...rest],
  };
}

let patched = false;

/**
 * Layer 2, per test worker (Vitest setupFiles). Every `node:child_process` launcher:
 * - throws if it would start a real `claude`/`codex`: by name on PATH, by absolute path, through a PATH given in the
 *   spawn's own `env`, or named in a `sh -c` script, `shell: true` command or exec string;
 * - re-inserts the tripwire into a caller-built `env.PATH`, so whatever that child runs later still hits it.
 * Covers both `import { spawn }` and `childProcess.spawn` call styles.
 */
export function guardChildProcess(): void {
  if (patched) return;
  patched = true;
  const cp = childProcess as unknown as Record<string, (...args: unknown[]) => unknown>;
  const wrap = (name: string, split: typeof spawnStyle) => {
    const original = cp[name]!;
    cp[name] = function guarded(this: unknown, ...args: unknown[]) {
      if (typeof args[0] !== 'string') return original.apply(this, args);
      const { launch, rebuild } = split(args);
      const baseEnv = (launch.options.env as NodeJS.ProcessEnv | undefined) ?? process.env;
      const env = { ...baseEnv, PATH: guardedPath(baseEnv.PATH) };
      check({ ...launch, options: { ...launch.options, env } });
      return original.apply(this, rebuild({ ...launch.options, env }));
    };
  };
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) wrap(name, spawnStyle);
  for (const name of ['exec', 'execSync']) wrap(name, execStyle);
  syncBuiltinESMExports();
}
