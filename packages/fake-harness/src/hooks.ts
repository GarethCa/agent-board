import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/** Bad input from the caller (flags, settings, hook config). The CLI reports it and exits 2, never like a crash. */
export class ConfigError extends Error {}

/** One handler inside a matcher group, in the shape Claude Code and Codex both read. */
export interface HookHandler {
  /** `command` or `http`; anything else is ignored, as the real CLIs do for types they don't run. */
  type: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  /** Seconds. */
  timeout?: number;
}

export interface MatcherGroup {
  matcher?: string;
  hooks: HookHandler[];
}

export type HooksConfig = Partial<Record<string, MatcherGroup[]>>;

export type MatcherSyntax = 'claude' | 'regex';

export interface HookRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  supportsHttp: boolean;
  matcherSyntax: MatcherSyntax;
  defaultTimeoutSeconds: number;
  /** Per-event default and cap, e.g. Codex runs SessionEnd hooks for 1 s by default and at most 3 s. */
  eventTimeouts?: Partial<Record<string, { defaultSeconds: number; maxSeconds: number }>>;
}

/** Parsed JSON a hook printed (command) or returned (http). */
export type HookOutput = Record<string, unknown>;

/** Reads the `hooks` key of a settings or hooks.json file; a missing file has no hooks. */
export function readHooksFile(path: string): HooksConfig | undefined {
  if (!existsSync(path)) return undefined;
  return parseHooksJson(readFileSync(path, 'utf8'), path);
}

export function parseHooksJson(text: string, source: string): HooksConfig | undefined {
  try {
    return (JSON.parse(text) as { hooks?: HooksConfig }).hooks;
  } catch (error) {
    throw new ConfigError(`invalid JSON in ${source}: ${(error as Error).message}`);
  }
}

/** Fails early on matchers the harness could not compile, instead of crashing mid-session. */
export function validateMatchers(config: HooksConfig, syntax: MatcherSyntax): void {
  for (const [event, groups] of Object.entries(config)) {
    for (const group of groups ?? []) {
      try {
        matches(group.matcher, '', syntax);
      } catch (error) {
        throw new ConfigError(`invalid ${event} matcher ${JSON.stringify(group.matcher)}: ${(error as Error).message}`);
      }
    }
  }
}

export function mergeHooks(...configs: (HooksConfig | undefined)[]): HooksConfig {
  const merged: HooksConfig = {};
  for (const config of configs) {
    for (const [event, groups] of Object.entries(config ?? {})) {
      merged[event] = [...(merged[event] ?? []), ...(groups ?? [])];
    }
  }
  return merged;
}

/**
 * Claude: `*`, empty or missing matches all; plain words are an exact list split on `|` or `,`;
 * anything else is an unanchored regex. Codex: always a regex.
 */
function matches(matcher: string | undefined, value: string | undefined, syntax: MatcherSyntax): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  // Events without matcher support ignore the matcher.
  if (value === undefined) return true;
  if (syntax === 'claude' && /^[A-Za-z0-9_\- ,|]+$/.test(matcher)) {
    return matcher.split(/[|,]/).map((part) => part.trim()).includes(value);
  }
  return new RegExp(matcher).test(value);
}

/** Runs every hook for `event` whose matcher accepts `matchValue`, in parallel, and returns their JSON outputs. */
export async function runHooks(
  config: HooksConfig,
  event: string,
  matchValue: string | undefined,
  payload: Record<string, unknown>,
  options: HookRunOptions,
): Promise<HookOutput[]> {
  const handlers = (config[event] ?? [])
    .filter((group) => matches(group.matcher, matchValue, options.matcherSyntax))
    .flatMap((group) => group.hooks);
  const body = JSON.stringify(payload);
  const limits = options.eventTimeouts?.[event];
  const outputs = await Promise.all(
    handlers.map((handler) => {
      const seconds = handler.timeout ?? limits?.defaultSeconds ?? options.defaultTimeoutSeconds;
      const timeoutMs = Math.min(seconds, limits?.maxSeconds ?? Infinity) * 1000;
      if (handler.type === 'command' && handler.command) return runCommand(handler, body, timeoutMs, options);
      if (handler.type === 'http' && handler.url && options.supportsHttp) return runHttp(handler, body, timeoutMs, options);
      return Promise.resolve(undefined);
    }),
  );
  return outputs.filter((output): output is HookOutput => output !== undefined);
}

/**
 * Runs in its own process group so a timeout kills everything the hook started (`a | b`, `x; sleep`), not just the
 * shell; a surviving grandchild would otherwise hold stdout open and block the session. Exit code 2 (blocking) is
 * not modelled: no scenario needs a hook to block a tool, a prompt or a stop yet.
 */
function runCommand(handler: HookHandler, body: string, timeoutMs: number, options: HookRunOptions): Promise<HookOutput | undefined> {
  const spawnOptions = { cwd: options.cwd, env: options.env, detached: true };
  const child = handler.args
    ? spawn(handler.command!, handler.args, spawnOptions)
    : spawn('bash', ['-c', handler.command!], spawnOptions);
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.stdin.end(body);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
      resolve(undefined);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? parseJsonObject(stdout) : undefined);
    });
  });
}

async function runHttp(handler: HookHandler, body: string, timeoutMs: number, options: HookRunOptions): Promise<HookOutput | undefined> {
  const allowed = new Set(handler.allowedEnvVars ?? []);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  for (const [name, value] of Object.entries(handler.headers ?? {})) {
    headers[name] = value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, braced: string | undefined, bare: string | undefined) => {
      const variable = (braced ?? bare)!;
      return allowed.has(variable) ? (options.env[variable] ?? '') : '';
    });
  }
  try {
    const response = await fetch(handler.url!, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return undefined;
    return parseJsonObject(await response.text());
  } catch {
    return undefined;
  }
}

function parseJsonObject(text: string): HookOutput | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return JSON.parse(trimmed) as HookOutput;
  } catch {
    return undefined;
  }
}

export type PermissionDecision = 'allow' | 'deny' | undefined;

/** Any deny wins; otherwise any allow; otherwise nobody decided and the TUI asks the user. */
export function permissionDecision(outputs: HookOutput[]): PermissionDecision {
  const behaviours = outputs.map((output) => {
    const specific = output.hookSpecificOutput as { decision?: { behavior?: string } } | undefined;
    return specific?.decision?.behavior;
  });
  if (behaviours.includes('deny')) return 'deny';
  if (behaviours.includes('allow')) return 'allow';
  return undefined;
}
