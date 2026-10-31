import type { Agent, AgentState, ChatEntry, MessageSender, TranscriptChunk } from '@agent-board/daemon/protocol';

/** The most entries the chat view shows: the latest. Earlier ones are only in the terminal. */
export const MAX_SHOWN_ENTRIES = 500;

/**
 * What the chat view has of an agent's transcript: its latest entries from the daemon's latest generation of it, the
 * first of them entry number `first`; `earlier` when there are entries before it the chat doesn't have.
 */
export type Transcript = Omit<TranscriptChunk, 'from'> & { first: number };

/**
 * A tool call in the chat, with its result once it has one; `at` and the result's `at` are when each was written.
 * `stopped` when the user interrupted it, or turned it down, whatever its result says.
 */
export interface ToolCall {
  kind: 'call';
  id: string;
  name: string;
  input: unknown;
  at?: string;
  stopped?: true;
  result?: { output: string; isError: boolean; agentId?: string; at?: string };
}

/** A message between Codex agents, shown with the calls around it. */
export interface SubagentMessage {
  kind: 'subagent-message';
  key: string;
  from: string;
  to: string;
  text: string;
}

/**
 * One thing the chat view draws: a message, the model thinking (for `ms` when the transcript says how long), the
 * conversation compacted, the turn interrupted (`stopped` naming the call it cut short), or the tool calls (and agents'
 * messages) between two messages. `at` is when the transcript wrote it.
 */
export type ChatItem =
  | { kind: 'assistant' | 'notice'; key: string; text: string; at?: string }
  /** `from` names the agent a message came from (ADR-0023); a message without one is the user's. */
  | { kind: 'user'; key: string; text: string; from?: MessageSender; at?: string }
  | { kind: 'thinking'; key: string; text: string; ms?: number; at?: string }
  | { kind: 'compacted'; key: string; at?: string }
  | { kind: 'interrupted'; key: string; stopped?: ToolCall; at?: string }
  | { kind: 'tools'; key: string; rows: (ToolCall | SubagentMessage)[]; at?: string }
  /** A run of `count` agents' messages the chat leaves out while it shows only the user's own (`foldAgentMessages`). */
  | { kind: 'agents-hidden'; key: string; count: number };

/** The notice both harnesses' adapters make of a turn the user interrupted. */
const INTERRUPTED = 'Interrupted';

/**
 * The transcript as the chat draws it: messages in order, and each run of tool calls as one item, results joined on.
 * Thinking is timed from its `since` to where it is written, and blocks of it in a row are one thought. A background task's notification and a turn's end draw
 * nothing: the live state reads them from the entries.
 */
export function chatItems(entries: readonly ChatEntry[]): ChatItem[] {
  const items: ChatItem[] = [];
  const calls = new Map<string, ToolCall>();
  const runAt = (index: number, at: string | undefined) => {
    const last = items.at(-1);
    if (last?.kind === 'tools') return last.rows;
    const rows: (ToolCall | SubagentMessage)[] = [];
    items.push({ kind: 'tools', key: `tools-${index}`, rows, ...stamp(at) });
    return rows;
  };
  entries.forEach((entry, index) => {
    switch (entry.kind) {
      case 'tool-call': {
        const row: ToolCall = { kind: 'call', id: entry.id, name: entry.name, input: entry.input, ...stamp(entry.at) };
        calls.set(entry.id, row);
        runAt(index, entry.at).push(row);
        break;
      }
      case 'tool-result': {
        // A result comes after its call, maybe after a message in between; one for no call is dropped.
        const row = calls.get(entry.id);
        if (row) row.result = { output: entry.output, isError: entry.isError, ...(entry.agentId === undefined ? {} : { agentId: entry.agentId }), ...stamp(entry.at) };
        break;
      }
      case 'subagent-message':
        runAt(index, entry.at).push({ kind: 'subagent-message', key: `subagent-message-${index}`, from: entry.from, to: entry.to, text: entry.text });
        break;
      case 'thinking': {
        const ms = msBetween(entry.since, entry.at);
        // Claude writes one turn of thought as several blocks in a row: they are one thought, for as long as all of them.
        const last = items.at(-1);
        if (last?.kind === 'thinking' && entries[index - 1]?.kind === 'thinking') {
          items[items.length - 1] = {
            ...last,
            text: [last.text, entry.text].filter((text) => text !== '').join('\n\n'),
            ...(last.ms === undefined && ms === undefined ? {} : { ms: (last.ms ?? 0) + (ms ?? 0) }),
            ...stamp(entry.at ?? last.at),
          };
          break;
        }
        items.push({ kind: 'thinking', key: `thinking-${index}`, text: entry.text, ...(ms === undefined ? {} : { ms }), ...stamp(entry.at) });
        break;
      }
      case 'compacted':
        items.push({ kind: 'compacted', key: `compacted-${index}`, ...stamp(entry.at) });
        break;
      case 'notified':
      case 'turn-ended':
        break;
      default: {
        if (entry.kind === 'notice' && entry.text === INTERRUPTED) {
          // Claude writes a call the user turned down or stopped with an error result, just before its notice for it.
          const previous = entries[index - 1];
          const last = items.at(-1);
          const stopped =
            entry.forToolUse && previous?.kind === 'tool-result' && previous.isError
              ? calls.get(previous.id)
              : last?.kind === 'tools'
                ? last.rows.findLast((row): row is ToolCall => row.kind === 'call' && row.result === undefined)
                : undefined;
          if (stopped !== undefined) stopped.stopped = true;
          items.push({ kind: 'interrupted', key: `interrupted-${index}`, ...(stopped === undefined ? {} : { stopped }), ...stamp(entry.at) });
          break;
        }
        if (entry.kind === 'user') {
          items.push({ kind: 'user', key: `user-${index}`, text: entry.text, ...(entry.from === undefined ? {} : { from: entry.from }), ...stamp(entry.at) });
          break;
        }
        items.push({ kind: entry.kind, key: `${entry.kind}-${index}`, text: entry.text, ...stamp(entry.at) });
      }
    }
  });
  return items;
}

/** How long from one time the transcript wrote to a later one, if it wrote both. */
export function msBetween(from: string | undefined, to: string | undefined): number | undefined {
  if (from === undefined || to === undefined) return undefined;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

function stamp(at: string | undefined): { at?: string } {
  return at === undefined ? {} : { at };
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
  tone: 'pending' | 'ok' | 'bad' | 'diff' | 'muted';
}

/** A tool call's one line: who it is named for (an MCP call by its server), what it worked on, and how it went. */
export function toolLine(call: ToolCall): { label: string; detail: string; outcome: ToolOutcome } {
  // A Claude subagent goes by its type, `Explore`, its task beside it.
  const type = call.name === 'spawn_agent' || toolKind(call.name) !== 'subagent' || !isRecord(call.input) ? undefined : stringField(call.input, 'subagent_type');
  if (type !== undefined) return { label: type, detail: stringField(call.input as Record<string, unknown>, 'description') ?? '', outcome: toolOutcome(call) };
  return { label: toolLabel(call.name), detail: toolDetail(call.name, call.input), outcome: toolOutcome(call) };
}

/** What a tool does, as the chat draws and sums it up. */
export type ToolKind = 'read' | 'edit' | 'write' | 'shell' | 'subagent' | 'search' | 'web' | 'mcp' | 'plan' | 'ask' | 'other';

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
  WebFetch: 'web',
  WebSearch: 'web',
  ExitPlanMode: 'plan',
  AskUserQuestion: 'ask',
  // agent-board's own MCP tools for presenting a plan and asking the user.
  'mcp__agent-board__present_plan': 'plan',
  'mcp__agent-board__ask': 'ask',
};

/** An MCP tool's name as the harness gives it: `mcp__<server>__<tool>`. */
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;

export function toolKind(name: string): ToolKind {
  if (Object.hasOwn(TOOL_KINDS, name)) return TOOL_KINDS[name]!;
  return MCP_TOOL.test(name) ? 'mcp' : 'other';
}

/** A tool's name as the chat shows it: an MCP call's server, named plainly (agent-board's as the board). */
function toolLabel(name: string): string {
  const server = MCP_TOOL.exec(name)?.[1];
  if (server === undefined) return name;
  return server === 'agent-board' ? 'board' : server;
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
  if (kind === 'web') {
    const url = stringField(fields, 'url');
    return url === undefined ? firstLine(stringField(fields, 'query') ?? '') : url.replace(/^https?:\/\//, '');
  }
  if (kind === 'plan') return firstLine(stringField(fields, 'title') ?? stringField(fields, 'path') ?? stringField(fields, 'plan') ?? '');
  if (name === 'AskUserQuestion') {
    const first = Array.isArray(fields.questions) ? fields.questions.find(isRecord) : undefined;
    return first ? firstLine(stringField(first, 'question') ?? '') : '';
  }
  const text = firstText(fields);
  const tool = MCP_TOOL.exec(name)?.[2];
  // An MCP call names its tool, then its first short argument: `get_issue ACME-12`. An ask, its question alone.
  if (tool === undefined || kind === 'ask') return text;
  return text === '' ? tool : `${tool} ${text}`;
}

/** A call's first short text argument: a pattern, a URL, an issue id. */
function firstText(fields: Record<string, unknown>): string {
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

function toolOutcome({ name, input, at, result }: ToolCall): ToolOutcome {
  if (result === undefined) return { text: 'running…', tone: 'pending' };
  if (result.isError) return { text: 'failed', tone: 'bad' };
  const fields = isRecord(input) ? input : {};
  const kind = toolKind(name);
  if (kind === 'edit' && name !== 'NotebookEdit') {
    const { added, removed } = editCounts(input);
    return { text: `+${added} −${removed}`, tone: 'diff' };
  }
  if (kind === 'write') return { text: `+${lineCount(stringField(fields, 'content'))}`, tone: 'diff' };
  if (name === 'Read') {
    const lines = lineCount(result.output);
    return { text: `${lines} ${lines === 1 ? 'line' : 'lines'}`, tone: 'muted' };
  }
  if (kind === 'search') {
    const files = /^Found (\d+) files?\b/.exec(result.output)?.[1];
    if (files !== undefined) return { text: `${files} ${files === '1' ? 'file' : 'files'}`, tone: 'muted' };
  }
  if (kind === 'shell') {
    const last = shellOutput(result.output).split('\n').map((line) => line.trim()).filter(Boolean).at(-1);
    const ms = msBetween(at, result.at);
    const took = ms === undefined ? '' : ` · ${duration(ms)}`;
    if (last !== undefined) return { text: `${last.length > 48 ? `${last.slice(0, 47)}…` : last}${took}`, tone: 'muted' };
    if (took !== '') return { text: `done${took}`, tone: 'muted' };
  }
  if (kind === 'web' || kind === 'mcp') return { text: '✓', tone: 'ok' };
  return { text: 'done', tone: 'muted' };
}

/** The lines an Edit (or a MultiEdit's edits) took out and put in. */
export function editCounts(input: unknown): { added: number; removed: number } {
  const fields = isRecord(input) ? input : {};
  const edits = Array.isArray(fields.edits) ? fields.edits.filter(isRecord) : [fields];
  return {
    added: edits.reduce((sum, edit) => sum + lineCount(stringField(edit, 'new_string')), 0),
    removed: edits.reduce((sum, edit) => sum + lineCount(stringField(edit, 'old_string')), 0),
  };
}

/** A span of time as the chat shows it: `4.1s` under ten seconds, `12s`, `4m 12s`, `1h 5m`. */
export function duration(ms: number): string {
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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

/** A piece of a message as the chat draws it: text as typed, or a block of pasted text, folded to its line count. */
export type MessagePart = { kind: 'text'; text: string } | { kind: 'pasted'; text: string; lines: number };

/**
 * Claude Code's wrapper round a block of pasted text: an opening and a closing tag with the same id. The line break
 * after the opening tag and before the closing one are the wrapper's, not the paste's.
 */
const PASTED = /<pasted_content id="([^"<>]*)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">/g;

/** A message split into what was typed and each block pasted into it, the blocks' wrappers gone. */
export function pastedParts(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let at = 0;
  for (const match of text.matchAll(PASTED)) {
    if (match.index > at) parts.push({ kind: 'text', text: text.slice(at, match.index) });
    const pasted = match[2]!;
    parts.push({ kind: 'pasted', text: pasted, lines: pasted.split('\n').length });
    at = match.index + match[0].length;
  }
  if (at < text.length || parts.length === 0) parts.push({ kind: 'text', text: text.slice(at) });
  return parts;
}
