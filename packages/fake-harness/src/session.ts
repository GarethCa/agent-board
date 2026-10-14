import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { runHooks, permissionDecision, type HooksConfig, type HookRunOptions, type HookOutput } from './hooks.ts';
import { execFile } from 'node:child_process';
import { McpClient, type McpServerConfig, type McpToolResult } from './mcp.ts';
import type { HarnessName } from './paths.ts';

/** One message of a conversation, as a resumed session shows it again. */
export interface ConversationMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** Writes the harness's own transcript JSONL format. */
export interface Transcript {
  readonly path: string;
  /** The conversation so far, read back from the transcript: what a resumed session shows again. */
  history(): ConversationMessage[];
  userPrompt(text: string, turnId: string): void;
  assistantText(text: string): void;
  toolUse(id: string, name: string, input: unknown): void;
  /** A call's result: what the tool returned (a string, or e.g. a shell's `{stdout, stderr}`), as the harness records it. */
  toolResult(id: string, response: unknown, isError: boolean): void;
  /** Writes the subagent's own transcript, started by the call `toolUseId`, and returns its path. */
  subagent(agentId: string, agentType: string, task: string, result: string, toolUseId: string): string;
  turnComplete(turnId: string, lastMessage: string): void;
}

/** A tool's response as text: a shell's stdout and stderr, other objects as JSON. */
export function toolOutput(response: unknown): string {
  if (typeof response === 'string') return response;
  const { stdout, stderr } = (response ?? {}) as { stdout?: unknown; stderr?: unknown };
  if (typeof stdout === 'string') return [stdout, stderr].filter((text) => typeof text === 'string' && text !== '').join('\n');
  return JSON.stringify(response);
}

/** Everything that differs between the fake claude and the fake codex, named for the behaviour it switches. */
export interface Dialect {
  harness: HarnessName;
  displayName: string;
  sessionId: string;
  cwd: string;
  model: string;
  permissionMode: string;
  startSource: string;
  hooks: HooksConfig;
  hookOptions: HookRunOptions;
  transcript: Transcript;
  /** False for `claude -p` and `codex exec`: exit after the scripted turn instead of waiting at the prompt. */
  interactive: boolean;
  /** Fires `Notification` (idle_prompt, permission_prompt). Claude only. */
  notificationEvents: boolean;
  /** Fires `Interrupt` when the user interrupts a turn. Codex only. */
  interruptEvent: boolean;
  /** Fires `StopFailure` when the API call fails. Claude only. */
  stopFailureEvent: boolean;
  /** Adds `model` to every hook input and `turn_id` to turn-scoped ones. Codex only. */
  modelAndTurnIdFields: boolean;
  /** Adds `permission_suggestions` to PermissionRequest. Claude only. */
  permissionSuggestions: boolean;
  /** Events whose input carries `permission_mode`; undefined means every event. */
  permissionModeEvents?: ReadonlySet<string>;
  subagentToolName: string;
  shellToolName: string;
  /** The MCP servers its config names, by name, started on first use. */
  mcpServers: Record<string, McpServerConfig>;
  /** The env the model's shell commands run with: Codex leaves out what its `shell_environment_policy` excludes. */
  shellEnv: NodeJS.ProcessEnv;
  /** Overrides the SessionEnd reason (Codex always reports `other`). */
  sessionEndReason?: string;
  /** Pause between streamed words and tool steps. */
  stepDelayMs: number;
  /** How long the session sits at the prompt before `idle_prompt` fires (real Claude: about 60 s). */
  idleNotifyMs: number;
}

/** What a fake CLI was asked to do: answer at once (its version, its login), or run a session. */
export type Invocation =
  | { reply: string; stream?: 'stdout' | 'stderr'; exitCode?: number }
  | { dialect: Omit<Dialect, 'stepDelayMs' | 'idleNotifyMs'>; prompt: string | undefined; warnings?: string[] };

const MATCH_FIELD: Record<string, string> = {
  PreToolUse: 'tool_name',
  PostToolUse: 'tool_name',
  PermissionRequest: 'tool_name',
  Notification: 'notification_type',
  SessionStart: 'source',
  SessionEnd: 'reason',
  SubagentStart: 'agent_type',
  SubagentStop: 'agent_type',
  StopFailure: 'error',
};

const SESSION_SCOPED = new Set(['SessionStart', 'SessionEnd']);

/** The subagent a hook fires inside: its fields go on every hook it fires. */
export interface SubagentScope {
  agent_id: string;
  agent_type: string;
}

/** How soon a second Ctrl-C at the prompt must follow the first to exit. */
const EXIT_PRESS_WINDOW_MS = 2000;

/** The markers a terminal wraps a bracketed paste in. */
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/** Unwinds a turn the user interrupted (Ctrl-C). */
class TurnInterrupted extends Error {
  constructor() {
    super('turn interrupted');
  }
}

function toolUseId(): string {
  return `toolu_fake_${randomUUID().slice(0, 8)}`;
}

/** The surface scenarios are scripted against; each call emits the hooks and transcript lines the real CLI would. */
export class FakeSession {
  private turnId = '';
  private lastAssistantMessage = '';
  private readonly lines: AsyncIterator<string>;
  /** The line being waited for, kept across an interrupt so the next read still gets it. */
  private nextLine: Promise<IteratorResult<string>> | undefined;
  private readonly dialect: Dialect;
  /** Between a prompt and the turn's end: Ctrl-C interrupts the turn rather than warning about exit. */
  private inTurn = false;
  private interrupted = false;
  /** Rejects whatever the turn is waiting on, once it is interrupted. */
  private wake: (() => void) | undefined;
  private lastExitPress = 0;
  /** The MCP servers started so far. */
  private readonly mcpClients: Record<string, McpClient> = {};

  constructor(dialect: Dialect) {
    this.dialect = dialect;
    this.lines = createInterface({ input: process.stdin, terminal: false })[Symbol.asyncIterator]();
    // Like the real TUIs: Ctrl-C (SIGINT, or \x03 through a PTY) interrupts a turn; twice at the prompt exits.
    // Print and exec modes keep the default and die.
    if (dialect.interactive) process.on('SIGINT', () => this.onCtrlC());
  }

  get interactive(): boolean {
    return this.dialect.interactive;
  }

  get shellTool(): string {
    return this.dialect.shellToolName;
  }

  /** Whether it resumes a conversation (`--resume`, `codex resume`). */
  get resumed(): boolean {
    return this.dialect.startSource === 'resume';
  }

  /** Starts the session. A resumed one shows its conversation so far first, as the real TUIs do. */
  async start(): Promise<void> {
    if (this.resumed) {
      for (const { role, text } of this.dialect.transcript.history()) this.print(role === 'user' ? `> ${text}\n` : `${text}\n`);
    }
    await this.fire('SessionStart', { source: this.dialect.startSource, model: this.dialect.model });
  }

  async submit(prompt: string): Promise<void> {
    this.inTurn = true;
    this.interrupted = false;
    this.turnId = randomUUID();
    this.print(`> ${prompt}\n`);
    this.dialect.transcript.userPrompt(prompt, this.turnId);
    await this.fire('UserPromptSubmit', { prompt });
  }

  /** Streams text to the terminal word by word, then records it as one assistant message. */
  async say(text: string): Promise<void> {
    for (const word of text.split(/(?<= )/)) {
      this.print(word);
      await this.pause();
    }
    this.print('\n');
    this.dialect.transcript.assistantText(text);
    this.lastAssistantMessage = text;
  }

  /**
   * Runs one tool call; asks for permission first when `needsPermission`. Returns whether it ran. Inside a subagent
   * (`inside`), its hooks carry the subagent's fields and it stays out of the main transcript.
   */
  async runTool(
    name: string,
    input: Record<string, unknown>,
    response: unknown,
    needsPermission = false,
    inside?: SubagentScope,
  ): Promise<boolean> {
    const id = toolUseId();
    if (!inside) this.dialect.transcript.toolUse(id, name, input);
    this.print(`● ${name}(${JSON.stringify(input)})\n`);
    await this.fire('PreToolUse', { ...inside, tool_name: name, tool_input: input, tool_use_id: id });

    if (needsPermission && !(await this.askPermission(name, input, inside))) {
      if (!inside) this.dialect.transcript.toolResult(id, 'The user denied this tool call.', true);
      this.print('  ⎿ Denied\n');
      return false;
    }

    await this.pause();
    if (!inside) this.dialect.transcript.toolResult(id, response, false);
    await this.fire('PostToolUse', { ...inside, tool_name: name, tool_input: input, tool_response: response, tool_use_id: id });
    return true;
  }

  /**
   * Runs `command` for real in the model's shell (`sh -c`, in its folder, with `shellEnv`) as a shell tool call, and
   * returns its stdout. Scenarios use it to run the CLIs a session is given.
   */
  async runShell(command: string): Promise<string> {
    const { stdout, stderr } = await this.untilInterrupted(
      new Promise<{ stdout: string; stderr: string }>((resolve) => {
        execFile('/bin/sh', ['-c', command], { cwd: this.dialect.cwd, env: this.dialect.shellEnv }, (_error, stdout, stderr) =>
          resolve({ stdout, stderr }),
        );
      }),
    );
    await this.runTool(this.shellTool, { command, description: command }, { stdout, stderr, interrupted: false });
    this.print(`${stdout}${stderr}`);
    return stdout;
  }

  /**
   * Calls an MCP server's tool as the model would, starting the server the first time: a tool call named
   * `mcp__<server>__<tool>`, its result's text printed. Undefined when the config names no such server.
   */
  async callMcpTool(server: string, tool: string, args: Record<string, unknown>): Promise<McpToolResult | undefined> {
    const config = this.dialect.mcpServers[server];
    if (config === undefined) return undefined;
    this.mcpClients[server] ??= new McpClient(config, this.dialect.cwd);
    const result = await this.untilInterrupted(this.mcpClients[server].callTool(tool, args));
    await this.runTool(`mcp__${server}__${tool}`, args, { content: [{ type: 'text', text: result.text }], isError: result.isError });
    this.print(`${result.text}\n`);
    return result;
  }

  /** The instructions `server` gives as it starts, or undefined for no such server. */
  async mcpInstructions(server: string): Promise<string | undefined> {
    const config = this.dialect.mcpServers[server];
    if (config === undefined) return undefined;
    this.mcpClients[server] ??= new McpClient(config, this.dialect.cwd);
    return (await this.untilInterrupted(this.mcpClients[server].initialize())).instructions;
  }

  /**
   * Hands `task` to a subagent. Its result is `result`, or what `work` (run inside it, e.g. tool calls) returns; a
   * string result is also printed.
   */
  async spawnSubagent(agentType: string, task: string, result: string | ((inside: SubagentScope) => Promise<string>)): Promise<void> {
    const id = toolUseId();
    const agentId = randomUUID().replaceAll('-', '').slice(0, 17);
    const input = { description: task, prompt: task, subagent_type: agentType };
    this.dialect.transcript.toolUse(id, this.dialect.subagentToolName, input);
    this.print(`● ${this.dialect.subagentToolName}(${agentType}: ${task})\n`);
    await this.fire('PreToolUse', { tool_name: this.dialect.subagentToolName, tool_input: input, tool_use_id: id });
    await this.fire('SubagentStart', { agent_id: agentId, agent_type: agentType });
    await this.pause();
    if (typeof result === 'function') {
      result = await result({ agent_id: agentId, agent_type: agentType });
      this.print(`${result}\n`);
    }
    const agentTranscriptPath = this.dialect.transcript.subagent(agentId, agentType, task, result, id);
    await this.fire('SubagentStop', {
      stop_hook_active: false,
      agent_id: agentId,
      agent_type: agentType,
      agent_transcript_path: agentTranscriptPath,
      last_assistant_message: result,
    });
    this.dialect.transcript.toolResult(id, result, false);
    await this.fire('PostToolUse', {
      tool_name: this.dialect.subagentToolName,
      tool_input: input,
      tool_response: { content: [{ type: 'text', text: result }] },
      tool_use_id: id,
    });
  }

  /** Ends the turn. */
  async stop(): Promise<void> {
    this.dialect.transcript.turnComplete(this.turnId, this.lastAssistantMessage);
    await this.fire('Stop', { stop_hook_active: false, last_assistant_message: this.lastAssistantMessage });
    this.inTurn = false;
  }

  /**
   * Runs `turn`, and if the user interrupts it, ends it there as the real CLIs do: no `Stop` (Codex fires
   * `Interrupt` instead), back at the prompt.
   */
  async interruptible(turn: () => Promise<void>): Promise<void> {
    try {
      await turn();
    } catch (error) {
      if (!(error instanceof TurnInterrupted)) throw error;
      this.inTurn = false;
      this.print(`\nInterrupted · What should ${this.dialect.displayName} do instead?\n`);
      if (this.dialect.interruptEvent) await this.fire('Interrupt', {});
    }
  }

  /**
   * Sits at the input prompt until the user types a line; undefined means stdin closed. Claude fires
   * `idle_prompt` once it has sat idle for `idleNotifyMs` (immediately when 0).
   */
  async waitForInput(): Promise<string | undefined> {
    if (!this.dialect.notificationEvents) return this.readLine();
    const idle = () =>
      this.fire('Notification', { message: `${this.dialect.displayName} is waiting for your input`, notification_type: 'idle_prompt' });
    if (this.dialect.idleNotifyMs <= 0) {
      await idle();
      return this.readLine();
    }
    // Hooks fire in order: a notification already under way finishes before the next turn or SessionEnd.
    let notifying: Promise<unknown> | undefined;
    const timer = setTimeout(() => (notifying = idle()), this.dialect.idleNotifyMs);
    const line = await this.readLine();
    clearTimeout(timer);
    await notifying;
    return line;
  }

  /** The API call behind the turn failed (Claude's StopFailure). */
  async failTurn(error: string, details: string): Promise<void> {
    const message = `API Error: ${details}`;
    this.print(`${message}\n`);
    if (this.dialect.stopFailureEvent) {
      await this.fire('StopFailure', { error, error_details: details, last_assistant_message: message });
    }
    this.inTurn = false;
  }

  async end(reason: string): Promise<never> {
    await this.fire('SessionEnd', { reason: this.dialect.sessionEndReason ?? reason });
    process.exit(0);
  }

  /** Dies mid-turn: no Stop, no SessionEnd. */
  crash(message: string): never {
    process.stderr.write(`${this.dialect.harness}: ${message}\n`);
    process.exit(1);
  }

  /**
   * The next prompt the user typed. Like the real TUIs, ESC CR (Alt+Enter, which the app sends for Shift+Enter) is a
   * new line within it rather than its end; and a bracketed paste of several lines (the app's composer sends one, as a
   * terminal pastes) is one prompt, its line breaks kept and its markers dropped.
   */
  async readLine(): Promise<string | undefined> {
    let line = await this.readTypedLine();
    if (line === undefined || !line.startsWith(PASTE_START)) return line;
    const lines = [line];
    while (!line.includes(PASTE_END)) {
      line = await this.readTypedLine();
      if (line === undefined) break;
      lines.push(line);
    }
    return lines.join('\n').replace(PASTE_START, '').replace(PASTE_END, '');
  }

  /** A line as typed: one ended by ESC CR goes on with the next. */
  private async readTypedLine(): Promise<string | undefined> {
    let line = await this.readRawLine();
    while (line?.endsWith('\x1b')) {
      const next = await this.readRawLine();
      line = `${line.slice(0, -1)}\n${next ?? ''}`;
      if (next === undefined) break;
    }
    return line;
  }

  /** The next line from stdin as it arrived; undefined once stdin closes. */
  private async readRawLine(): Promise<string | undefined> {
    this.nextLine ??= this.lines.next();
    const next = await this.untilInterrupted(this.nextLine);
    this.nextLine = undefined;
    return next.done ? undefined : next.value;
  }

  private onCtrlC(): void {
    if (this.inTurn) {
      this.interrupted = true;
      this.wake?.();
      return;
    }
    const now = Date.now();
    if (now - this.lastExitPress < EXIT_PRESS_WINDOW_MS) {
      void this.end('prompt_input_exit');
      return;
    }
    this.lastExitPress = now;
    this.print('\nPress Ctrl-C again to exit\n');
  }

  /** `work`, unless the turn is interrupted first: then it throws `TurnInterrupted` and leaves `work` behind. */
  private async untilInterrupted<T>(work: Promise<T>): Promise<T> {
    if (!this.inTurn) return work;
    if (this.interrupted) throw new TurnInterrupted();
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => (this.wake = () => reject(new TurnInterrupted())))]);
    } finally {
      this.wake = undefined;
    }
  }

  private async askPermission(name: string, input: Record<string, unknown>, inside?: SubagentScope): Promise<boolean> {
    const fields: Record<string, unknown> = { ...inside, tool_name: name, tool_input: input };
    if (this.dialect.permissionSuggestions) fields.permission_suggestions = [];
    const decision = permissionDecision(await this.fire('PermissionRequest', fields));
    if (decision) return decision === 'allow';

    this.print(`Do you want to allow ${name}? (y/n) `);
    if (this.dialect.notificationEvents) {
      await this.fire('Notification', {
        message: `${this.dialect.displayName} needs your permission to use ${name}`,
        title: 'Permission needed',
        notification_type: 'permission_prompt',
      });
    }
    const answer = await this.readLine();
    return answer !== undefined && /^y(es)?$/i.test(answer.trim());
  }

  private async fire(event: string, fields: Record<string, unknown>): Promise<HookOutput[]> {
    const payload: Record<string, unknown> = {
      session_id: this.dialect.sessionId,
      transcript_path: this.dialect.transcript.path,
      cwd: this.dialect.cwd,
    };
    if (this.dialect.permissionModeEvents?.has(event) ?? true) payload.permission_mode = this.dialect.permissionMode;
    payload.hook_event_name = event;
    if (this.dialect.modelAndTurnIdFields) {
      payload.model = this.dialect.model;
      if (this.turnId && !SESSION_SCOPED.has(event)) payload.turn_id = this.turnId;
    }
    Object.assign(payload, fields);
    const field = MATCH_FIELD[event];
    const matchValue = field === undefined ? undefined : String(payload[field]);
    return this.untilInterrupted(runHooks(this.dialect.hooks, event, matchValue, payload, this.dialect.hookOptions));
  }

  private print(text: string): void {
    process.stdout.write(text);
  }

  private pause(): Promise<void> {
    return this.untilInterrupted(
      this.dialect.stepDelayMs > 0 ? new Promise((resolve) => setTimeout(resolve, this.dialect.stepDelayMs)) : Promise.resolve(),
    );
  }
}
