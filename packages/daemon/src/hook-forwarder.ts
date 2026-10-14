// The forwarder for harnesses without `http` hooks (Codex, ADR-0004): a `command` hook that posts its stdin to the
// daemon's hook ingress. Kept free of the daemon's own imports, since it starts once per hook call.
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** What the hook env vars start with, which Codex keeps from the model's shell commands. */
export const HOOK_ENV_PREFIX = 'AGENT_BOARD_HOOK_';

/** The env var that carries an agent's hook token, so it never appears on its command line. */
export const HOOK_TOKEN_ENV = `${HOOK_ENV_PREFIX}TOKEN`;

/** The env var that tells the forwarder where the hook ingress listens. */
export const HOOK_URL_ENV = `${HOOK_ENV_PREFIX}URL`;

/** The env var the shim sets to tell the external forwarder where the running daemon left its address. */
const EXTERNAL_HOOK_FILE_ENV = 'AGENT_BOARD_EXTERNAL_HOOK_FILE';

/** How long an external hook waits for the daemon. It only reports, so it never holds its harness for long. */
const EXTERNAL_FORWARD_TIMEOUT_MS = 2_000;

/** How to run `agent-board …`: the app's executable as Node, and its entry script. */
export interface CliLauncher {
  command: string;
  args: string[];
}

/**
 * The Codex hook events the daemon listens to (ADR-0004), each with the timeout in seconds Codex gives its hook: long
 * for `PermissionRequest` (an inbox answer may be held), Codex's cap for `SessionEnd`/`Interrupt`. Part of the hook
 * definition Codex's trust covers, so changing one means re-trusting.
 */
export const CODEX_HOOK_TIMEOUTS = {
  SessionStart: 5,
  SessionEnd: 3,
  UserPromptSubmit: 5,
  PreToolUse: 5,
  PermissionRequest: 600,
  PostToolUse: 5,
  SubagentStart: 5,
  SubagentStop: 5,
  Stop: 5,
  Interrupt: 3,
  PreCompact: 5,
  PostCompact: 5,
} as const;

/** How long the forwarder waits for the daemon: half a second under Codex's timeout, so it answers before Codex gives up. */
export function forwardTimeoutMs(event: unknown): number {
  const seconds = (CODEX_HOOK_TIMEOUTS as Record<string, number>)[typeof event === 'string' ? event : ''] ?? 5;
  return seconds * 1000 - 500;
}

/**
 * Posts one hook payload to the daemon and returns what the hook should print: the daemon's answer, or nothing when
 * it has none, refuses the call or can't be reached (the agent must never stall on a missing daemon).
 */
async function forwardHook(input: string, env: NodeJS.ProcessEnv): Promise<string> {
  const url = env[HOOK_URL_ENV];
  const token = env[HOOK_TOKEN_ENV];
  if (!url || !token) return '';
  let event: unknown;
  try {
    event = (JSON.parse(input) as { hook_event_name?: unknown }).hook_event_name;
  } catch {
    // Let the daemon refuse it.
  }
  return postHook(url, token, input, forwardTimeoutMs(event));
}

/**
 * Posts a hook payload to the daemon and resolves with its answer: the body of a 2xx, else ''. Never rejects: no
 * daemon, a refusal or a timeout all come out as ''.
 */
async function postHook(url: string, token: string, input: string, timeoutMs: number): Promise<string> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: input,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    return response.ok ? body : '';
  } catch {
    return '';
  }
}

/** Where the running daemon takes external sessions' hooks, and the token it takes them with. */
export interface ExternalHookAddress {
  /** `http://127.0.0.1:<port>/external`; each harness posts to `<url>/<harness>`. */
  url: string;
  token: string;
}

/**
 * Posts a global hook's payload (a session agent-board did not spawn) to the daemon named in the external hook file,
 * if one is running. Prints nothing, whatever the daemon says: an external session is only watched, never steered.
 * A session agent-board spawned also runs the global hooks, but its own hooks report it, so it is skipped.
 */
async function forwardExternalHook(input: string, harness: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (env[HOOK_TOKEN_ENV]) return;
  const file = env[EXTERNAL_HOOK_FILE_ENV];
  const address = file ? readExternalHookFile(file) : undefined;
  // No daemon, or a stale file: the session carries on unreported. Whatever the daemon says is dropped.
  if (address !== undefined) await postHook(`${address.url}/${harness}`, address.token, input, EXTERNAL_FORWARD_TIMEOUT_MS);
}

/**
 * `agent-board hook codex` forwards an agent's hook on stdin and prints the answer; `agent-board hook external
 * <harness>` reports an external session's hook. Always exits 0.
 */
export async function runHookCommand(args: string[]): Promise<number> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const input = Buffer.concat(chunks).toString('utf8');
  if (args[0] === 'external') {
    await forwardExternalHook(input, args[1] ?? '', process.env);
    return 0;
  }
  const answer = await forwardHook(input, process.env);
  if (answer !== '') process.stdout.write(answer);
  return 0;
}

/** Leaves the daemon's address for external hooks: written atomically, readable by the user alone. */
export function writeExternalHookFile(path: string, address: ExternalHookAddress): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(address)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** The address in the external hook file, or undefined if there is none or it can't be read. */
export function readExternalHookFile(path: string): ExternalHookAddress | undefined {
  try {
    const { url, token } = JSON.parse(readFileSync(path, 'utf8')) as Partial<ExternalHookAddress>;
    return typeof url === 'string' && typeof token === 'string' ? { url, token } : undefined;
  } catch {
    return undefined;
  }
}

/** Removes the external hook file if it still holds `token`; another daemon may have taken it over since. */
export function removeExternalHookFile(path: string, token: string): void {
  if (readExternalHookFile(path)?.token === token) rmSync(path, { force: true });
}

/**
 * Makes sure the stable launcher at `path`, which Codex's hook command names, runs `agent-board hook` on the app
 * `launcher` describes, rewriting it if it doesn't (another daemon, say, pointed it at its own app). The command
 * string Codex's hook trust covers never changes when the app moves or updates. Written atomically, so a hook starting
 * meanwhile sees the old or the new shim, never half; the folder and the shim are the user's alone.
 */
export function writeHookShim(path: string, launcher: CliLauncher, externalHookFile?: string): void {
  writeShim(path, hookShimScript(launcher, externalHookFile));
}

/**
 * Makes sure the `agent-board` CLI launcher at `path` (ADR-0010), which every session finds first on its PATH and
 * agents run as their board MCP server, runs the CLI on the app `launcher` describes. Written as the hook shim is.
 */
export function writeCliShim(path: string, launcher: CliLauncher): void {
  const exec = [launcher.command, ...launcher.args].map(shellQuote).join(' ');
  writeShim(path, ['#!/bin/sh', '# Written by the agent-board daemon: the agent-board command line.', `ELECTRON_RUN_AS_NODE=1 exec ${exec} "$@"`, ''].join('\n'));
}

/** Writes `script` to `path` as an executable of the user's alone, atomically, unless it is there already. */
function writeShim(path: string, script: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  if (readOrUndefined(path) === script) {
    chmodSync(path, 0o700);
    return;
  }
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, script, { mode: 0o700 });
  chmodSync(temp, 0o700);
  renameSync(temp, path);
}

/**
 * The shim. With `externalHookFile`, it also tells external hooks where the daemon leaves its address, and when no
 * daemon has left one, exits before starting the app: global hooks run on every event of every session.
 */
function hookShimScript(launcher: CliLauncher, externalHookFile?: string): string {
  const exec = [launcher.command, ...launcher.args].map(shellQuote).join(' ');
  const header = ['#!/bin/sh', '# Written by the agent-board daemon: forwards a harness hook to the running daemon.'];
  if (externalHookFile === undefined) return [...header, `ELECTRON_RUN_AS_NODE=1 exec ${exec} hook "$@"`, ''].join('\n');
  const file = shellQuote(externalHookFile);
  return [
    ...header,
    `if [ "$1" = external ] && [ ! -f ${file} ]; then cat >/dev/null; exit 0; fi`,
    `${EXTERNAL_HOOK_FILE_ENV}=${file} ELECTRON_RUN_AS_NODE=1 exec ${exec} hook "$@"`,
    '',
  ].join('\n');
}

function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** The hook command Codex runs: the shim, double-quoted as ADR-0004 records when the path allows it. */
export function codexHookCommand(shimPath: string): string {
  return shimCommand(shimPath, 'codex');
}

/** A hook command running the shim with `args`, the shim's path double-quoted when the path allows it. */
export function shimCommand(shimPath: string, args: string): string {
  const quoted = /^[^"$`\\!]*$/.test(shimPath) ? `"${shimPath}"` : shellQuote(shimPath);
  return `${quoted} ${args}`;
}

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}
