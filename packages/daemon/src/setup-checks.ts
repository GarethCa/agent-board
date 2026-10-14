// The first-run checks of the CLIs agent-board runs (onboarding's Connect step): whether each is on PATH, its version,
// and whether it is signed in. Each is asked the way a user would ask it in a terminal; nothing here spends tokens.
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { invalidParams, paramsObject, stringParam } from './params.ts';
import { SETUP_TOOLS, type DaemonMethods, type SetupTool, type ToolCheck } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';

/** How long one probe may take: a CLI that hangs is found, with a problem. */
const PROBE_TIMEOUT_MS = 10_000;

/** How each tool says whether it is signed in: the arguments, and how to read the answer. */
const SIGN_IN_PROBES: Record<SetupTool, { args: string[]; signedIn(run: ProbeRun): boolean | undefined }> = {
  // Prints JSON (`loggedIn`), and exits 1 when signed out.
  claude: { args: ['auth', 'status', '--json'], signedIn: (run) => jsonLoggedIn(run.stdout) },
  // Exits 0 when logged in, 1 when not; says which on stderr.
  codex: { args: ['login', 'status'], signedIn: (run) => run.code === 0 },
  gh: { args: ['auth', 'status'], signedIn: (run) => run.code === 0 },
};

export interface CheckToolOptions {
  /** The environment to look the CLI up in and run it with. */
  env: NodeJS.ProcessEnv;
  /** The GitHub CLI: a path, or a name looked up on PATH. `gh` by default. */
  gh?: string;
  /** How long each probe may take: `PROBE_TIMEOUT_MS` by default. */
  timeoutMs?: number;
}

/** Whether `tool` is installed (on `env`'s PATH), its version, and whether it is signed in. */
export async function checkTool(tool: SetupTool, options: CheckToolOptions): Promise<ToolCheck> {
  const command = tool === 'gh' ? (options.gh ?? 'gh') : tool;
  const path = findExecutable(command, options.env.PATH);
  if (path === undefined) return { tool, found: false };
  const probe = SIGN_IN_PROBES[tool];
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const [version, signIn] = await Promise.all([run(path, ['--version'], options.env, timeoutMs), run(path, probe.args, options.env, timeoutMs)]);
  const check: ToolCheck = { tool, found: true, path };
  const parsed = version.code === 0 ? parseVersion(version.stdout) : undefined;
  if (parsed !== undefined) check.version = parsed;
  // A CLI that hangs, can't start or is killed said nothing about its login: never read that as signed in or out.
  const failed = [version, signIn].find((probed) => probed.timedOut || probed.code === null);
  if (failed !== undefined) {
    check.problem = failed.timedOut ? 'did not answer in time' : 'could not be run';
    return check;
  }
  const signedIn = probe.signedIn(signIn);
  if (signedIn !== undefined) check.signedIn = signedIn;
  return check;
}

/** The first `1.2.3` (with any `-pre.release` suffix) in a CLI's `--version` output. */
export function parseVersion(output: string): string | undefined {
  return /\d+\.\d+\.\d+(?:-[\w.]+)?/.exec(output)?.[0];
}

/** `command` itself when it is a path, else the first executable file of that name on `path`. */
function findExecutable(command: string, path: string | undefined): string | undefined {
  const candidates = isAbsolute(command) ? [command] : (path ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, command));
  return candidates.find(isExecutableFile);
}

function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

function jsonLoggedIn(stdout: string): boolean | undefined {
  try {
    const loggedIn = (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn;
    return typeof loggedIn === 'boolean' ? loggedIn : undefined;
  } catch {
    return undefined;
  }
}

interface ProbeRun {
  code: number | null;
  stdout: string;
  timedOut: boolean;
}

/** Runs a probe with no input. Never rejects: a CLI that can't start or fails says so through its code. */
function run(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<ProbeRun> {
  return new Promise((resolve) => {
    const child = execFile(command, args, { env, timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout) => {
      const timedOut = (error as { killed?: boolean } | null)?.killed === true;
      resolve({ code: error === null ? 0 : (child.exitCode ?? null), stdout, timedOut });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end();
  });
}

type SetupMethods = Pick<DaemonMethods, 'setup.check'>;

/** The `setup.check` RPC handler. */
export function setupHandlers<Context>(options: { harnessEnv: NodeJS.ProcessEnv; gh: string }): RpcHandlers<SetupMethods, Context> {
  return {
    'setup.check': (params) => {
      const tool = stringParam(paramsObject(params), 'tool');
      if (!(SETUP_TOOLS as readonly string[]).includes(tool)) throw invalidParams(`tool must be one of ${SETUP_TOOLS.join(', ')}`);
      // The harnesses are found as agents' spawns find them; gh as the daemon's trackers run it.
      const env = tool === 'gh' ? process.env : options.harnessEnv;
      return checkTool(tool as SetupTool, { env, gh: options.gh });
    },
  };
}
