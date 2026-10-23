// The commands agents leave running in the background (ADR-0004): named by their hooks, alive only while a process of
// them runs under the agent.
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import type { BackgroundCommand, Harness } from './protocol.ts';

/** How often the process table is read while an agent at its prompt may have a command running. */
const POLL_MS = 5_000;

/** How long `ps` gets to answer. */
const PS_TIMEOUT_MS = 2_000;

/** How long a command its hooks named may go unseen in the process table before it counts as finished. */
const UNSEEN_GRACE_MS = 5_000;

/** The most commands kept per agent from its hooks, so a platform with no process table never grows the list. */
const MAX_RECORDED = 20;

/** The shells harnesses run commands in. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh']);

/** The hooks of a turn under way or ending. */
const TURN_HOOKS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'PreCompact', 'PostCompact', 'Stop', 'StopFailure', 'Interrupt']);

/** The tools that stop a background command, and the fields of their input naming it. */
const STOP_TOOLS = new Set(['KillShell', 'KillBash', 'TaskStop']);
const STOP_ID_FIELDS = ['shell_id', 'bash_id', 'task_id'] as const;

/** A process, as `ps` lists it. */
export interface ProcessEntry {
  pid: number;
  ppid: number;
  /** How long it has run. */
  elapsedMs: number;
  /** Its command line, its arguments joined by spaces. */
  args: string;
}

/** `ps`'s elapsed time, `[[dd-]hh:]mm:ss`, in milliseconds; NaN for anything else. */
export function parseElapsed(etime: string): number {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (match === null) return Number.NaN;
  const [, days = '0', hours = '0', minutes, seconds] = match;
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes!)) * 60 + Number(seconds!)) * 1000;
}

/** The lines of `ps -o pid=,ppid=,etime=,command=`. */
export function parseProcessList(listing: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    const elapsedMs = match === null ? Number.NaN : parseElapsed(match[3]!);
    if (match !== null && !Number.isNaN(elapsedMs)) entries.push({ pid: Number(match[1]), ppid: Number(match[2]), elapsedMs, args: match[4]! });
  }
  return entries;
}

/** Every process on the machine; empty where there is no `ps` (Windows) or it fails. Never throws. */
function listProcesses(): Promise<ProcessEntry[]> {
  if (process.platform === 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,etime=,command='],
      { timeout: PS_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => resolve(error === null ? parseProcessList(stdout) : []),
    );
  });
}

/** The forwarder agent-board's hooks run, which is never a command the agent ran. */
const HOOK_FORWARDER = 'agent-board-hook';

/** The programs Codex runs its commands' shells under on each platform: its sandbox, one level above the shell. */
const SANDBOXES = new Set(['sandbox-exec', 'bwrap', 'codex-linux-sandbox']);

/** A shell's flag before or after `-c`: `-l`, `-i`, `--norc`, `--login`. */
const SHELL_FLAG = /^(?:-[a-z]+|--[a-z][a-z-]*)$/i;

/**
 * Claude Code's wrapper around a command: `… && eval '<command>' < /dev/null && pwd -P …`, without the `< /dev/null`
 * when the command has a heredoc. Inside its single quotes, a quote is closed, given in double quotes and reopened
 * (`'"'"'`), or escaped (`'\''`).
 */
const CLAUDE_WRAPPER = /&& eval '((?:[^']|'"'"'|'\\'')*)'(?: (?:<|\\<) \/dev\/null)? && pwd -P/;

/**
 * The command a shell process runs, from its command line: the script of `<shell> -c <script>` (`-lc`, `--norc -c`…),
 * with Claude Code's wrapper around it taken off. Undefined for any other process, and for a script naming any of `skip`
 * (the hook forwarder, by default): neither is a command the agent ran.
 */
export function shellCommandOf(args: string, skip: readonly string[] = [HOOK_FORWARDER]): string | undefined {
  const words = args.split(' ');
  if (!SHELLS.has(basename(words[0] ?? '').replace(/^-/, ''))) return undefined;
  const isC = (word: string) => /^-[a-z]*c[a-z]*$/i.test(word);
  let at = 1;
  while (at < words.length && SHELL_FLAG.test(words[at]!) && !isC(words[at]!)) at += 1;
  if (at >= words.length || !isC(words[at]!)) return undefined;
  at += 1;
  while (at < words.length && SHELL_FLAG.test(words[at]!)) at += 1;
  const script = words.slice(at).join(' ').trim();
  if (script === '' || skip.some((word) => script.includes(word))) return undefined;
  // `ps` writes a newline in an argument as `\012`.
  const unescaped = script.replaceAll('\\012', '\n');
  const wrapped = CLAUDE_WRAPPER.exec(unescaped);
  return wrapped === null ? unescaped : wrapped[1]!.replaceAll(`'"'"'`, `'`).replaceAll(`'\\''`, `'`);
}

/** A command its hooks say the agent started in the background. */
export interface RecordedCommand {
  /** The tool call that started it. */
  toolUseId: string | null;
  /** The harness's id for it (Claude's `backgroundTaskId`), once its call returned. */
  taskId: string | null;
  command: string;
  startedAt: number;
}

/** A command line with quoting, escapes and runs of spaces taken out, so a command matches the shell running it. */
const normalized = (command: string) => command.replace(/['"\\]/g, '').replace(/\s+/g, ' ').trim();

/** The process table by parent: each process's children. Made once per read, for every agent looked at. */
export function childrenOf(processes: readonly ProcessEntry[]): Map<number, ProcessEntry[]> {
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of processes) {
    const siblings = children.get(entry.ppid);
    if (siblings === undefined) children.set(entry.ppid, [entry]);
    else siblings.push(entry);
  }
  return children;
}

/**
 * The commands still running under the harness process `pid`, longest-running first: each shell the harness itself
 * runs a command in, or Codex's sandbox runs for it, one level down, or the same under a child named `codex` (npm's
 * wrapper runs the real Codex as its child). Nothing deeper counts: a shell under an MCP server
 * (`npx` runs its server in `sh -c`) or inside a command is not one the agent ran. A shell takes its name and start
 * from the command its hooks recorded that it runs, exactly, each record naming one shell at most; else from its own
 * command line and how long it has run.
 */
export function liveCommands(
  children: ReadonlyMap<number, readonly ProcessEntry[]>,
  pid: number,
  recorded: readonly RecordedCommand[],
  now: number,
  skip?: readonly string[],
): BackgroundCommand[] {
  const shells: { entry: ProcessEntry; command: string }[] = [];
  const visit = (parent: number, wrapped: boolean) => {
    for (const child of children.get(parent) ?? []) {
      const command = shellCommandOf(child.args, skip);
      const program = basename(child.args.split(' ')[0] ?? '');
      if (command !== undefined) shells.push({ entry: child, command });
      else if (SANDBOXES.has(program)) {
        for (const inside of children.get(child.pid) ?? []) {
          const sandboxed = shellCommandOf(inside.args, skip);
          if (sandboxed !== undefined) shells.push({ entry: inside, command: sandboxed });
        }
      } else if (!wrapped && program === 'codex') visit(child.pid, true);
    }
  };
  // Codex installed from npm is a node wrapper running the real `codex` as its child: one step through it.
  visit(pid, false);
  const unclaimed = [...recorded];
  const found = shells.map(({ entry, command }) => {
    const own = normalized(command);
    const at = own === '' ? -1 : unclaimed.findIndex((each) => normalized(each.command) === own);
    if (at < 0) return { command, startedAt: now - entry.elapsedMs };
    const [named] = unclaimed.splice(at, 1);
    return { command: named!.command, startedAt: named!.startedAt };
  });
  return found.sort((a, b) => a.startedAt - b.startedAt).map(({ command, startedAt }) => ({ command, startedAt: new Date(startedAt).toISOString() }));
}

/** Whether the hook is a tool call starting a command in the background: Claude's `Bash` with `run_in_background`. */
function backgroundStart(payload: Record<string, unknown>): { command: string; toolUseId: string | null } | undefined {
  const input = payload.tool_input as Record<string, unknown> | undefined;
  if (payload.hook_event_name !== 'PreToolUse' || input?.run_in_background !== true || typeof input.command !== 'string') return undefined;
  return { command: input.command, toolUseId: typeof payload.tool_use_id === 'string' ? payload.tool_use_id : null };
}

export interface BackgroundCommandsOptions {
  /** The live agents at their prompt, asking nothing: those a command running under them leaves `on-command`. */
  atPrompt(): { sessionId: string; harness: Harness }[];
  /** The pid of the agent's harness process, while it runs. */
  pidOf(sessionId: string): number | undefined;
  /** What the agent shows changed: its commands. */
  changed(sessionId: string): void;
  /** The process table; `ps` by default. */
  list?: () => Promise<ProcessEntry[]>;
  now?: () => number;
  /** How often to look again while any agent at its prompt may have a command running; 5 s by default. */
  pollMs?: number;
  log?: (message: string) => void;
  /** Where the hook forwarder's launcher is, when not where its name gives it away: its runs are not commands. */
  hookShimPath?: string;
}

/**
 * The commands agents left running in the background. Claude's hooks name each (`Bash` with `run_in_background`); the
 * process table says which still run, and finds Codex's, which no hook names. Only an agent at its prompt is looked
 * at, as a command running in a turn may be the turn's own: once its turn ends, every command still under it was left
 * running. An agent whose commands have all ended has none, whatever its status says.
 */
export function createBackgroundCommands(options: BackgroundCommandsOptions) {
  const list = options.list ?? listProcesses;
  const skip = [HOOK_FORWARDER, ...(options.hookShimPath === undefined ? [] : [options.hookShimPath])];
  const now = options.now ?? Date.now;
  const recorded = new Map<string, RecordedCommand[]>();
  const found = new Map<string, BackgroundCommand[]>();
  /**
   * Agents whose own turn just ended, until the process table is next read, with the commands their hooks named in
   * that turn moments ago: they count as running till then, so the tile doesn't flash idle in between. An older one
   * may have ended in the turn, so waits for the read: it would flash on a command instead.
   */
  const unread = new Map<string, BackgroundCommand[]>();
  /** The commands each agent's hooks named since its turn last ended. */
  const thisTurn = new Map<string, RecordedCommand[]>();
  let reading: Promise<void> | undefined;
  let again = false;

  const same = (a: readonly BackgroundCommand[], b: readonly BackgroundCommand[]) =>
    a.length === b.length && a.every((each, at) => each.command === b[at]!.command && each.startedAt === b[at]!.startedAt);

  const of = (sessionId: string): readonly BackgroundCommand[] => {
    return unread.get(sessionId) ?? found.get(sessionId) ?? [];
  };

  const setFound = (sessionId: string, next: BackgroundCommand[], announce: boolean) => {
    const before = of(sessionId);
    unread.delete(sessionId);
    if (next.length === 0) found.delete(sessionId);
    else found.set(sessionId, next);
    if (announce && !same(before, next)) options.changed(sessionId);
  };

  const readOnce = async () => {
    const atPrompt = options.atPrompt();
    const watched = new Set(atPrompt.map((each) => each.sessionId));
    // Mid-turn or ended, an agent shows none: its next turn's end looks again.
    for (const sessionId of found.keys()) if (!watched.has(sessionId)) setFound(sessionId, [], false);
    const looks = atPrompt.filter(({ sessionId, harness }) => recorded.has(sessionId) || found.has(sessionId) || harness === 'codex');
    for (const sessionId of unread.keys()) if (!looks.some((each) => each.sessionId === sessionId)) unread.delete(sessionId);
    if (looks.length === 0) return;
    const children = childrenOf(await list());
    if (closed) return;
    const at = now();
    for (const { sessionId } of looks) {
      const pid = options.pidOf(sessionId);
      const mine = recorded.get(sessionId) ?? [];
      const live = pid === undefined ? [] : liveCommands(children, pid, mine, at, skip);
      // A command its hooks named that no process runs any more has finished, once it has had time to start.
      const kept = mine.filter((each) => at - each.startedAt < UNSEEN_GRACE_MS || live.some((one) => one.command === each.command));
      if (kept.length === 0) recorded.delete(sessionId);
      else recorded.set(sessionId, kept);
      setFound(sessionId, live, true);
    }
  };

  let closed = false;

  /** Reads the process table, or again once the read under way has finished. */
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (reading !== undefined) {
      again = true;
      return reading;
    }
    reading = (async () => {
      try {
        do {
          again = false;
          await readOnce();
        } while (again && !closed);
      } catch (error) {
        // The next read tries again.
        if (!closed) options.log?.(`could not look for agents' background commands: ${(error as Error).message}`);
      } finally {
        reading = undefined;
      }
    })();
    return reading;
  };

  const timer = setInterval(() => void refresh(), options.pollMs ?? POLL_MS);
  timer.unref();

  return {
    /** The agent's commands still running, as last read (or as its hooks named them, until then): none while it works. */
    of,

    /**
     * Notes a background command a hook says the agent started or stopped, before the hook moves the agent on. Its own
     * turn ending looks at once, after that.
     */
    onHook(sessionId: string, payload: Record<string, unknown>) {
      const started = backgroundStart(payload);
      // It is working, or ended a turn: what was found running at its prompt may have ended since, so is read again.
      // Not on a notification: its idle prompt changes nothing it runs.
      if (payload.agent_id === undefined && TURN_HOOKS.has(payload.hook_event_name as string)) found.delete(sessionId);
      const mine = recorded.get(sessionId) ?? [];
      if (started !== undefined) {
        const command = { ...started, taskId: null, startedAt: now() };
        recorded.set(sessionId, [...mine, command].slice(-MAX_RECORDED));
        thisTurn.set(sessionId, [...(thisTurn.get(sessionId) ?? []), command]);
      } else if (payload.hook_event_name === 'PostToolUse') {
        const response = payload.tool_response as Record<string, unknown> | undefined;
        const input = payload.tool_input as Record<string, unknown> | undefined;
        const taskId = response?.backgroundTaskId;
        if (typeof taskId === 'string') {
          for (const each of mine) if (each.toolUseId !== null && each.toolUseId === payload.tool_use_id) each.taskId = taskId;
        }
        if (STOP_TOOLS.has(payload.tool_name as string)) {
          const ids = STOP_ID_FIELDS.map((field) => input?.[field]).filter((id) => typeof id === 'string');
          const kept = mine.filter((each) => each.taskId === null || !ids.includes(each.taskId));
          if (kept.length === 0) recorded.delete(sessionId);
          else recorded.set(sessionId, kept);
        }
      }
      if (payload.hook_event_name === 'Stop' && payload.agent_id === undefined) {
        const named = (thisTurn.get(sessionId) ?? []).filter(
          (each) => recorded.get(sessionId)?.includes(each) && now() - each.startedAt < UNSEEN_GRACE_MS,
        );
        thisTurn.delete(sessionId);
        if (named.length > 0) {
          const running = named.map(({ command, startedAt }) => ({ command, startedAt: new Date(startedAt).toISOString() }));
          unread.set(sessionId, running);
        }
        // Once the hook has moved the agent to its prompt.
        queueMicrotask(() => void refresh());
      }
    },

    /** Reads the process table now, and tells of each agent whose commands changed. */
    refresh,

    /** The agent's process ended, or the agent was deleted: none of its commands are told of again. */
    forget(sessionId: string) {
      unread.delete(sessionId);
      thisTurn.delete(sessionId);
      recorded.delete(sessionId);
      found.delete(sessionId);
    },

    /** Stops looking. */
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
