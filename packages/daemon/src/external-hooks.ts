// The opt-in global hooks that report sessions started outside the app (ADR-0004, external sessions): a `command`
// hook on every event in `~/.claude/settings.json` and `~/.codex/hooks.json`, merged in beside the user's own hooks
// and taken out again without touching them.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CLAUDE_HOOK_EVENTS } from './claude-state.ts';
import { CODEX_HOOK_TIMEOUTS, shimCommand } from './hook-forwarder.ts';
import { isObject } from './json.ts';
import { invalidParams, paramsObject } from './params.ts';
import type { DaemonMethods, ExternalHooksStatus, Harness } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';

/** Longest any external hook may hold its harness: it only reports, it never answers. */
const EXTERNAL_HOOK_TIMEOUT = 5;

/** Each harness's global hook file: `~/.claude/settings.json` and `~/.codex/hooks.json`, or their env overrides. */
export function externalHookFiles(env: NodeJS.ProcessEnv): Record<Harness, string> {
  const home = env.HOME || homedir();
  return {
    claude: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json'),
    codex: join(env.CODEX_HOME || join(home, '.codex'), 'hooks.json'),
  };
}

/** The command a global hook runs: the shim, which forwards it to the running daemon (`agent-board hook external`). */
export function externalHookCommand(shimPath: string, harness: Harness): string {
  return shimCommand(shimPath, `external ${harness}`);
}

/** Any agent-board external hook for `harness`, whatever shim path it was installed with. */
function isExternalHook(handler: unknown, harness: Harness): boolean {
  const command = (handler as { command?: unknown } | null)?.command;
  return typeof command === 'string' && new RegExp(`agent-board-hook['"]? external ${harness}$`).test(command);
}

/** Each event the harness's external hooks listen to, with its timeout in seconds. */
function externalHookEvents(harness: Harness): [string, number][] {
  if (harness === 'claude') return CLAUDE_HOOK_EVENTS.map((event) => [event, EXTERNAL_HOOK_TIMEOUT]);
  return Object.entries(CODEX_HOOK_TIMEOUTS).map(([event, timeout]) => [event, Math.min(timeout, EXTERNAL_HOOK_TIMEOUT)]);
}

type MatcherGroup = { hooks?: unknown[] } & Record<string, unknown>;
type HooksFile = { hooks?: Record<string, MatcherGroup[]> } & Record<string, unknown>;

/** A hook file as read: where it really lives, its settings, and how it was laid out, to write it back the same way. */
interface ReadHooksFile {
  /** The file itself: `path` with symlinks resolved, so writing it keeps a dotfile manager's link. */
  target: string;
  file: HooksFile;
  /** `JSON.stringify`'s indent: the file's own, '' for a one-line file, two spaces for a new one. */
  indent: string;
  trailingNewline: boolean;
}

/**
 * Adds a matcher group running agent-board's external hook to each event, after the user's own groups. Any earlier
 * agent-board hooks (e.g. for a shim that has since moved) are replaced. Creates the file if missing. Throws, leaving
 * the file alone, if it isn't a JSON object with an object `hooks`.
 */
export function installExternalHooks(path: string, harness: Harness, shimPath: string): void {
  const read = readHooksFile(path);
  const { file } = read;
  const hooks = withoutExternalHooks(file.hooks ?? {}, harness);
  const command = externalHookCommand(shimPath, harness);
  for (const [event, timeout] of externalHookEvents(harness)) {
    hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: 'command', command, timeout }] }];
  }
  writeHooksFile(read, { ...file, hooks });
}

/**
 * Takes agent-board's external hooks for `harness` out of the file, and with them any matcher group, event or `hooks`
 * key that only they had filled. Everything else stays as it is, laid out as before: a file the user wrote with an
 * ordinary indent comes back byte for byte, except that an empty `hooks` object is dropped. A missing file is left
 * missing.
 */
export function uninstallExternalHooks(path: string, harness: Harness): void {
  const read = readHooksFile(path);
  const { file } = read;
  if (file.hooks === undefined) return;
  const hooks = withoutExternalHooks(file.hooks, harness);
  if (JSON.stringify(hooks) === JSON.stringify(file.hooks)) return;
  if (Object.keys(hooks).length > 0) return writeHooksFile(read, { ...file, hooks });
  const rest = { ...file };
  delete rest.hooks;
  writeHooksFile(read, rest);
}

/** Whether every event has agent-board's external hook for `harness`, running the shim at `shimPath`. */
export function externalHooksInstalled(path: string, harness: Harness, shimPath: string): boolean {
  let file: HooksFile;
  try {
    ({ file } = readHooksFile(path));
  } catch {
    return false;
  }
  const command = externalHookCommand(shimPath, harness);
  return externalHookEvents(harness).every(([event]) =>
    (file.hooks?.[event] ?? []).some(
      (group) =>
        isObject(group) &&
        Array.isArray(group.hooks) &&
        group.hooks.some((handler) => (handler as { command?: unknown } | null)?.command === command),
    ),
  );
}

/** `hooks` without agent-board's external hooks for `harness`, dropping the groups and events they alone filled. */
function withoutExternalHooks(hooks: Record<string, MatcherGroup[]>, harness: Harness): Record<string, MatcherGroup[]> {
  const kept: Record<string, MatcherGroup[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const keptGroups = groups.flatMap((group) => {
      // A group in a shape agent-board doesn't know is the user's to keep.
      if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
      const handlers = group.hooks;
      const keptHandlers = handlers.filter((handler) => !isExternalHook(handler, harness));
      if (keptHandlers.length === handlers.length) return [group];
      return keptHandlers.length === 0 ? [] : [{ ...group, hooks: keptHandlers }];
    });
    if (keptGroups.length > 0 || groups.length === 0) kept[event] = keptGroups;
  }
  return kept;
}

/** Reads a hook file through any symlink. Missing or blank is no settings; anything but a JSON object throws. */
function readHooksFile(path: string): ReadHooksFile {
  const target = linkTarget(path);
  const text = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (text.trim() === '') return { target, file: {}, indent: '  ', trailingNewline: true };
  let file: unknown;
  try {
    file = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`, { cause: error });
  }
  if (!isObject(file)) throw new Error(`${path} is not a JSON object`);
  const hooks = file.hooks;
  if (hooks !== undefined && !(isObject(hooks) && Object.values(hooks).every(Array.isArray))) {
    throw new Error(`${path} has a "hooks" setting that is not an object of event lists`);
  }
  const indent = text.trim().includes('\n') ? (/\n([ \t]+)\S/.exec(text)?.[1] ?? '  ') : '';
  return { target, file: file as HooksFile, indent, trailingNewline: text.endsWith('\n') };
}

/**
 * The file `path` names, following symlinks: a dotfile manager's link must be edited through, never replaced. A
 * dangling link names the file to create.
 */
function linkTarget(path: string): string {
  let target = path;
  // Bounded, in case of a loop: realpath settles anything that exists; this only walks dangling links.
  for (let hops = 0; hops < 40; hops++) {
    try {
      return realpathSync(target);
    } catch {
      // Missing: a dangling link, or no file at all.
    }
    let link: boolean;
    try {
      link = lstatSync(target).isSymbolicLink();
    } catch {
      return target;
    }
    if (!link) return target;
    target = resolve(dirname(target), readlinkSync(target));
  }
  throw new Error(`${path} is a symlink loop`);
}

/** Replaces the file atomically, so the harness never reads half of it, keeping its permissions and layout. */
function writeHooksFile({ target, indent, trailingNewline }: ReadHooksFile, file: HooksFile): void {
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : undefined;
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.agent-board-${process.pid}.tmp`;
  const text = `${JSON.stringify(file, null, indent)}${trailingNewline ? '\n' : ''}`;
  writeFileSync(temp, text, mode === undefined ? undefined : { mode });
  if (mode !== undefined) chmodSync(temp, mode);
  renameSync(temp, target);
}

export interface ExternalHooksOptions {
  /** Each harness's global hook file (`externalHookFiles`). */
  files: Record<Harness, string>;
  /** The shim the hooks run. */
  shimPath: string;
  /** Makes sure the shim is there and runs this app; throws if it can't be written. */
  ensureHookShim(): void;
}

const HARNESSES: readonly Harness[] = ['claude', 'codex'];

/** The `externalHooks.*` RPC handlers: the one opt-in setting, for both harnesses at once. */
export function externalHooksHandlers<Context>(
  hooks: ExternalHooksOptions,
): RpcHandlers<Pick<DaemonMethods, Extract<keyof DaemonMethods, `externalHooks.${string}`>>, Context> {
  const status = (): ExternalHooksStatus => {
    const harnesses = Object.fromEntries(
      HARNESSES.map((harness) => [
        harness,
        { installed: externalHooksInstalled(hooks.files[harness], harness, hooks.shimPath), path: hooks.files[harness] },
      ]),
    ) as ExternalHooksStatus['harnesses'];
    return { enabled: HARNESSES.every((harness) => harnesses[harness].installed), harnesses };
  };

  return {
    'externalHooks.status': () => status(),
    'externalHooks.setEnabled': (params) => {
      const enabled = paramsObject(params).enabled;
      if (typeof enabled !== 'boolean') throw invalidParams('enabled must be a boolean');
      try {
        if (enabled) {
          hooks.ensureHookShim();
          const done: Harness[] = [];
          try {
            for (const harness of HARNESSES) {
              installExternalHooks(hooks.files[harness], harness, hooks.shimPath);
              done.push(harness);
            }
          } catch (error) {
            // All or nothing: one harness reporting and not the other would be a surprise.
            for (const harness of done) uninstallExternalHooks(hooks.files[harness], harness);
            throw error;
          }
        } else {
          for (const harness of HARNESSES) uninstallExternalHooks(hooks.files[harness], harness);
        }
      } catch (error) {
        throw invalidParams((error as Error).message);
      }
      return status();
    },
  };
}
