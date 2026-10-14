import type { Agent, AgentState, ChatEntry, TranscriptChunk } from '@agent-board/daemon/protocol';

/** The most entries the chat view shows: the latest. Earlier ones are only in the terminal. */
export const MAX_SHOWN_ENTRIES = 500;

/**
 * What the chat view has of an agent's transcript: its latest entries from the daemon's latest generation of it, the
 * first of them entry number `first`; `earlier` when there are entries before it the chat doesn't have.
 */
export type Transcript = Omit<TranscriptChunk, 'from'> & { first: number };

/** A tool call in the chat, with its result once it has one. */
export interface ToolCall {
  kind: 'call';
  id: string;
  name: string;
  input: unknown;
  result?: { output: string; isError: boolean; agentId?: string };
}

/** A message between Codex agents, shown with the calls around it. */
export interface SubagentMessage {
  kind: 'subagent-message';
  key: string;
  from: string;
  to: string;
  text: string;
}

/** One thing the chat view draws: a message, or the tool calls (and agents' messages) between two messages. */
export type ChatItem =
  | { kind: 'user' | 'assistant' | 'notice'; key: string; text: string }
  | { kind: 'tools'; key: string; rows: (ToolCall | SubagentMessage)[] };

/** The transcript as the chat draws it: messages in order, and each run of tool calls as one item, results joined on. */
export function chatItems(entries: readonly ChatEntry[]): ChatItem[] {
  const items: ChatItem[] = [];
  const calls = new Map<string, ToolCall>();
  const runAt = (index: number) => {
    const last = items.at(-1);
    if (last?.kind === 'tools') return last.rows;
    const rows: (ToolCall | SubagentMessage)[] = [];
    items.push({ kind: 'tools', key: `tools-${index}`, rows });
    return rows;
  };
  entries.forEach((entry, index) => {
    switch (entry.kind) {
      case 'tool-call': {
        const row: ToolCall = { kind: 'call', id: entry.id, name: entry.name, input: entry.input };
        calls.set(entry.id, row);
        runAt(index).push(row);
        break;
      }
      case 'tool-result': {
        // A result comes after its call, maybe after a message in between; one for no call is dropped.
        const row = calls.get(entry.id);
        if (row) row.result = { output: entry.output, isError: entry.isError, ...(entry.agentId === undefined ? {} : { agentId: entry.agentId }) };
        break;
      }
      case 'subagent-message':
        runAt(index).push({ kind: 'subagent-message', key: `subagent-message-${index}`, from: entry.from, to: entry.to, text: entry.text });
        break;
      default:
        items.push({ kind: entry.kind, key: `${entry.kind}-${index}`, text: entry.text });
    }
  });
  return items;
}

/** A run of tool calls as its one row sums it up: what ran, which call is running now, and whether one failed. */
export interface ToolRun {
  /** "6 tool calls · Read ×3, Bash ×2, Edit", and how many messages between agents it holds. */
  summary: string;
  /**
   * While the run is still going, the name of its latest call with no result yet (with calls in parallel, not
   * necessarily the latest call).
   */
  running?: string;
  failed: boolean;
}

/**
 * Sums up a run of `rows`. `going` when it can still be running: it is the conversation's latest item, and its agent
 * is at work (`agentAtWork`). A call an agent that ended or stopped never got a result for is not running.
 */
export function toolRun(rows: readonly (ToolCall | SubagentMessage)[], going: boolean): ToolRun {
  const calls = rows.filter((row): row is ToolCall => row.kind === 'call');
  const counts = new Map<string, number>();
  for (const { name } of calls) counts.set(name, (counts.get(name) ?? 0) + 1);
  // Most used first; a Map keeps the order names came in, and the sort is stable, so ties keep it.
  const names = [...counts].sort(([, a], [, b]) => b - a).map(([name, count]) => (count === 1 ? name : `${name} ×${count}`));
  const messages = rows.length - calls.length;
  const parts = [`${calls.length} tool ${calls.length === 1 ? 'call' : 'calls'}`];
  if (names.length > 0) parts.push(names.join(', '));
  if (messages > 0) parts.push(`${messages} ${messages === 1 ? 'message' : 'messages'}`);
  const pending = going ? calls.findLast((call) => call.result === undefined) : undefined;
  return { summary: parts.join(' · '), running: pending?.name, failed: calls.some((call) => call.result?.isError === true) };
}

/** The states of a live agent in the middle of a turn, whose latest tool call may still be running. */
const AT_WORK: ReadonlySet<AgentState> = new Set(['running', 'thinking', 'needs-permission']);

/** Whether the agent is live and in a turn, so its newest run of tool calls can still be running. */
export function agentAtWork(agent: Pick<Agent, 'endedAt' | 'state'>): boolean {
  return agent.endedAt === null && AT_WORK.has(agent.state);
}

/**
 * How the chat opens its runs of tool calls: on their own (collapsed, but for the newest while it runs), or all
 * expanded or collapsed by Expand all and Collapse all.
 */
export type RunsMode = 'auto' | 'expanded' | 'collapsed';

/** The mode as Expand all or Collapse all was last pressed: `at` counts the presses, so pressing one again clears the runs clicked since. */
export interface RunsChoice {
  mode: RunsMode;
  at: number;
}

/** Whether a run is open: as a click left it since Expand all or Collapse all was last pressed, else as `mode` has it. */
export function runOpen(mode: RunsMode, toggled: boolean | undefined, running: boolean): boolean {
  return toggled ?? (mode === 'expanded' || (mode === 'auto' && running));
}

/** How a tool call went, as its line shows it. */
export interface ToolOutcome {
  text: string;
  tone: 'pending' | 'bad' | 'diff' | 'muted';
}

/** A tool call's one line: what it worked on, and how it went. */
export function toolLine(call: ToolCall): { detail: string; outcome: ToolOutcome } {
  return { detail: toolDetail(call.name, call.input), outcome: toolOutcome(call) };
}

/** What a tool does, as the chat draws and sums it up. */
export type ToolKind = 'read' | 'edit' | 'write' | 'shell' | 'subagent' | 'search' | 'other';

/** Each harness's tool names by kind: Claude's, and Codex's (`exec` runs a script of shell commands, 0.162 on). */
const TOOL_KINDS: Record<string, ToolKind> = {
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'write',
  Bash: 'shell',
  shell: 'shell',
  local_shell: 'shell',
  exec: 'shell',
  exec_command: 'shell',
  Agent: 'subagent',
  Task: 'subagent',
  spawn_agent: 'subagent',
  Grep: 'search',
  Glob: 'search',
};

export function toolKind(name: string): ToolKind {
  return Object.hasOwn(TOOL_KINDS, name) ? TOOL_KINDS[name]! : 'other';
}

function toolDetail(name: string, input: unknown): string {
  if (typeof input === 'string') return name === 'exec' ? execCommand(input) : firstLine(input);
  const fields = isRecord(input) ? input : {};
  const kind = toolKind(name);
  if (kind === 'read' || kind === 'edit' || kind === 'write') return shortPath(stringField(fields, 'file_path') ?? stringField(fields, 'notebook_path') ?? '');
  if (kind === 'shell') {
    const command = fields.command ?? fields.cmd;
    return Array.isArray(command) ? command.join(' ') : typeof command === 'string' ? firstLine(command) : '';
  }
  if (name === 'spawn_agent') return stringField(fields, 'task_name') ?? stringField(fields, 'subagent_type') ?? '';
  if (kind === 'subagent') return [stringField(fields, 'subagent_type'), stringField(fields, 'description')].filter(Boolean).join(' · ');
  // Otherwise its first short text argument: a pattern, a URL, an issue id.
  const text = Object.values(fields).find((value): value is string => typeof value === 'string' && value.length <= 200);
  return text === undefined ? '' : firstLine(text);
}

/** The command a Codex `exec` script runs, if it runs one; else its first line. */
function execCommand(script: string): string {
  const match = /exec_command\(\{\s*cmd:\s*("(?:[^"\\]|\\.)*")/.exec(script);
  if (match) {
    try {
      return JSON.parse(match[1]!) as string;
    } catch {
      // Not a plain string after all.
    }
  }
  return firstLine(script);
}

function toolOutcome({ name, input, result }: ToolCall): ToolOutcome {
  if (result === undefined) return { text: 'running…', tone: 'pending' };
  if (result.isError) return { text: 'failed', tone: 'bad' };
  const fields = isRecord(input) ? input : {};
  const kind = toolKind(name);
  if (kind === 'edit' && name !== 'NotebookEdit') {
    const edits = Array.isArray(fields.edits) ? fields.edits.filter(isRecord) : [fields];
    const added = edits.reduce((sum, edit) => sum + lineCount(stringField(edit, 'new_string')), 0);
    const removed = edits.reduce((sum, edit) => sum + lineCount(stringField(edit, 'old_string')), 0);
    return { text: `+${added} −${removed}`, tone: 'diff' };
  }
  if (kind === 'write') return { text: `+${lineCount(stringField(fields, 'content'))}`, tone: 'diff' };
  if (name === 'Read') return { text: `${lineCount(result.output)} lines`, tone: 'muted' };
  if (kind === 'shell') {
    const last = shellOutput(result.output).split('\n').map((line) => line.trim()).filter(Boolean).at(-1);
    if (last !== undefined) return { text: last.length > 48 ? `${last.slice(0, 47)}…` : last, tone: 'muted' };
  }
  return { text: 'done', tone: 'muted' };
}

/** What a shell command printed: from a Codex `exec` script's report, the part after its header, less its exit code. */
function shellOutput(output: string): string {
  const report = /^Script completed\n(?:.*\n)*?Output:\n/.exec(output);
  const printed = report ? output.slice(report[0].length) : output;
  return printed.replace(/^exit_code=0$/m, '');
}

/**
 * The entries the view has with what the daemon just read merged in: appended when they carry on from the last, or
 * taken whole for a new generation or after a gap. It keeps the latest `MAX_SHOWN_ENTRIES`.
 */
export function mergeChunk(current: Transcript | undefined, chunk: TranscriptChunk): Transcript {
  const { from, ...rest } = chunk;
  const end = current ? current.first + current.entries.length : 0;
  const carriesOn = current && chunk.generation === current.generation && chunk.status === current.status && from >= current.first && from <= end;
  if (carriesOn && chunk.entries.length === 0) return current;
  const next: Transcript = carriesOn
    ? { ...current, entries: [...current.entries.slice(0, from - current.first), ...chunk.entries] }
    : { ...rest, first: from };
  const over = next.entries.length - MAX_SHOWN_ENTRIES;
  return over > 0 ? { ...next, first: next.first + over, earlier: true, entries: next.entries.slice(over) } : next;
}

/** The last three parts of a path: enough to tell files apart without the worktree in front. */
function shortPath(path: string): string {
  return path.split('/').filter(Boolean).slice(-3).join('/');
}

function lineCount(text: string | undefined): number {
  if (text === undefined || text === '') return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? '';
}

function stringField(fields: Record<string, unknown>, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
