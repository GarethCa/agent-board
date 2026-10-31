import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { runHooks, runStatusLine, permissionDecision, type HooksConfig, type HookRunOptions, type HookOutput } from './hooks.ts';
import { execFile, spawnSync } from 'node:child_process';
import { McpClient, type McpServerConfig, type McpToolResult } from './mcp.ts';
import type { HarnessName } from './paths.ts';
import { CODEX_START_SCREENS, codexComposer, codexLoadingComposer, codexStartScreen, isCodexStartScreen } from './codex-screens.ts';
import * as demo from './demo.ts';
import { drawRateLimitMenu, rateLimitMenuRows, RATE_LIMIT_CONTINUE, RATE_LIMIT_STOP_ROW } from './rate-limit-menu.ts';
import { SPINNER_LINE, drawPromptBox, drawTrustScreen } from './trust-screen.ts';

/**
 * Stops the terminal echoing what is typed while the session runs, as the real TUIs (which read their keys raw) don't
 * echo it: a demo's screen shows each prompt once, as its own `>` line, and not the board's typing of it, paste
 * markers and all. Lines are still read whole. Echo comes back as the process exits, for the shell its pane drops into.
 */
function quietTerminal(): void {
  if (!process.stdin.isTTY) return;
  const stty = (setting: string) => spawnSync('stty', [setting], { stdio: [process.stdin, 'ignore', 'ignore'] });
  stty('-echo');
  process.once('exit', () => stty('echo'));
}

/**
 * Takes keys as they come rather than a line at a time, as the real TUIs (which read raw) do: a terminal's line
 * discipline holds at most 1 KiB of a line (`MAX_CANON` on macOS), so a longer one would never arrive whole. Ctrl-C
 * still interrupts, as a signal. Line editing comes back as the process exits, for the shell its pane drops into.
 */
function keysAsTheyCome(): void {
  if (!process.stdin.isTTY) return;
  const stty = (setting: string) => spawnSync('stty', [setting], { stdio: [process.stdin, 'ignore', 'ignore'] });
  stty('-icanon');
  process.once('exit', () => stty('icanon'));
}

/**
 * Hands Ctrl-U to the session rather than to the terminal's line discipline, as the real TUIs (which read raw) get it:
 * it clears what sits at the prompt, the text of a lost Enter too (`afterClearKey`). The terminal's own comes back as
 * the process exits, for the shell its pane drops into.
 */
function ownClearKey(): void {
  if (!process.stdin.isTTY) return;
  const stty = (...settings: string[]) => spawnSync('stty', settings, { stdio: [process.stdin, 'ignore', 'ignore'] });
  stty('kill', 'undef');
  process.once('exit', () => stty('kill', '^U'));
}

/** Ctrl-U: clears the prompt's line up to the cursor. */
const CLEAR_KEY = '\x15';

/** What is left at the prompt of `line` once each Ctrl-U in it cleared what came before it. */
const afterClearKey = (line: string) => line.slice(line.lastIndexOf(CLEAR_KEY) + 1);

/** How many bytes of a long line typed at Claude reach it in one read of its terminal. */
const TERMINAL_READ = 1024;

/**
 * What Claude keeps of `line` typed at its prompt with no bracketed paste around it: a line longer than one read of its
 * terminal keeps only the bytes after its last whole read, as Claude 2.1.312 did with typed messages of 2,700
 * characters, whose transcripts held their last 700 or so. A character the cut goes through is lost with it.
 */
function keptOfTypedLine(line: string): string {
  const bytes = Buffer.from(line);
  if (bytes.length <= TERMINAL_READ) return line;
  return bytes.subarray(Math.floor((bytes.length - 1) / TERMINAL_READ) * TERMINAL_READ).toString().replace(/^\uFFFD+/, '');
}

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
  /** The model thinking, its text kept (Claude's `thinking` block); a harness that keeps none writes nothing. */
  thinking?(text: string): void;
  toolUse(id: string, name: string, input: unknown): void;
  /** A call's result: what the tool returned (a string, or e.g. a shell's `{stdout, stderr}`), as the harness records it. */
  toolResult(id: string, response: unknown, isError: boolean): void;
  /** Writes the subagent's own transcript, started by the call `toolUseId`, and returns its path. */
  subagent(agentId: string, agentType: string, task: string, result: string, toolUseId: string): string;
  turnComplete(turnId: string, lastMessage: string): void;
  /** A message the user typed while a turn ran, taken at one of its steps (Claude's `queued_command`). */
  queuedPrompt?(text: string): void;
}

/** Everything that differs between the fake claude and the fake codex, named for the behaviour it switches. */
export interface Dialect {
  harness: HarnessName;
  displayName: string;
  /** The version it reports, which a demo's welcome box shows. */
  version: string;
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
  /** Fires `SessionStart` with its first prompt, not as it starts, as Codex's TUI does. Codex only. */
  sessionStartWithFirstPrompt: boolean;
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
  /**
   * Its shell tool takes `run_in_background` and answers with a `backgroundTaskId` (Claude). Codex has no such flag:
   * its command simply goes on running after the call returns.
   */
  backgroundFlag: boolean;
  /** The MCP servers its config names, by name, started on first use. */
  mcpServers: Record<string, McpServerConfig>;
  /** The env the model's shell commands run with: Codex leaves out what its `shell_environment_policy` excludes. */
  shellEnv: NodeJS.ProcessEnv;
  /** The status line command its settings give, run after each turn with what it is passed on stdin. Claude only. */
  statusLine?: { command: string; input: Record<string, unknown> };
  /** Overrides the SessionEnd reason (Codex always reports `other`). */
  sessionEndReason?: string;
  /** Pause between streamed words and tool steps. */
  stepDelayMs: number;
  /** With more than 0, text streams a character at a time, this long apart, instead of a word at a time. */
  typeMs: number;
  /** Draws its terminal as the real TUI looks (`demo.ts`), for the `demo-*` scenarios; plain lines otherwise. */
  demo: boolean;
  /** How long the session sits at the prompt before `idle_prompt` fires (real Claude: about 60 s). */
  idleNotifyMs: number;
}

/** What a fake CLI was asked to do: answer at once (its version, its login), or run a session. */
export type Invocation =
  | { reply: string; stream?: 'stdout' | 'stderr'; exitCode?: number }
  | { dialect: Omit<Dialect, 'stepDelayMs' | 'idleNotifyMs' | 'typeMs' | 'demo'>; prompt: string | undefined; warnings?: string[] };

const MATCH_FIELD: Record<string, string> = {
  PreToolUse: 'tool_name',
  PostToolUse: 'tool_name',
  PermissionRequest: 'tool_name',
  Notification: 'notification_type',
  SessionStart: 'source',
  SessionEnd: 'reason',
  PreCompact: 'trigger',
  SubagentStart: 'agent_type',
  SubagentStop: 'agent_type',
  StopFailure: 'error',
};

const SESSION_SCOPED = new Set(['SessionStart', 'SessionEnd']);

/** How long a session answered on its trust screen with `slow-prompt` shows a line of its own before its prompt. */
const SLOW_PROMPT_MS = 1_000;
/** How long a session answered on its trust screen with `slow-redraw` leaves it drawn after Enter. */
const SLOW_REDRAW_MS = 600;

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
  /** Whether its `SessionStart` waits for its first prompt (`sessionStartWithFirstPrompt`) and has yet to fire. */
  private sessionStartDue = false;
  /**
   * How many more Enters after text are lost, as a slow TUI loses one that lands before it has taken in the text:
   * `FAKE_HARNESS_LOSE_ENTERS`, 0 by default.
   */
  private entersToLose = Number(process.env.FAKE_HARNESS_LOSE_ENTERS ?? 0);
  /** How many more lines typed at it with text lose no Enter first: `FAKE_HARNESS_LOSE_ENTERS_AFTER`, 0 by default. */
  private linesKept = Number(process.env.FAKE_HARNESS_LOSE_ENTERS_AFTER ?? 0);
  /**
   * How many more prompts typed at it (not given on the command line) fire no `UserPromptSubmit`, as a hook that timed
   * out on a loaded machine: `FAKE_HARNESS_LOSE_PROMPT_HOOKS`, 0 by default.
   */
  private promptHooksToLose = Number(process.env.FAKE_HARNESS_LOSE_PROMPT_HOOKS ?? 0);
  /**
   * Whether it takes keys as they come (`keysAsTheyCome`), so a line of any length arrives, and a Claude session keeps of
   * a long typed line only what Claude does (`keptOfTypedLine`): `FAKE_HARNESS_RAW_INPUT=1`.
   */
  private readonly rawInput = process.env.FAKE_HARNESS_RAW_INPUT === '1';
  /** How many turns still to end with no `Stop` hook (`FAKE_HARNESS_LOSE_STOP_HOOKS`): the turn ends all the same. */
  private stopHooksToLose = Number(process.env.FAKE_HARNESS_LOSE_STOP_HOOKS ?? 0);
  /** Whether the prompt about to be submitted was typed at it. */
  private promptTyped = false;
  /** Whether a message typed mid-turn is taken at the turn's next step: `FAKE_HARNESS_QUEUE_MID_TURN`. */
  private readonly queueMidTurn = process.env.FAKE_HARNESS_QUEUE_MID_TURN === '1';
  /** Keys a menu read raw, which the line reader holds as the start of its next line (`readKeys`). */
  private heldKeys = '';
  /** What it put at its prompt itself, as Claude puts `continue` there after a rate limit: Enter submits it. */
  private prefilled = '';
  /** The MCP servers started so far. */
  private readonly mcpClients: Record<string, McpClient> = {};

  /** The permission mode it was started in (`--permission-mode`), `default` without. */
  get permissionMode(): string {
    return this.dialect.permissionMode;
  }

  constructor(dialect: Dialect) {
    this.dialect = dialect;
    if (this.rawInput) keysAsTheyCome();
    ownClearKey();
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

  /**
   * Starts the session. A resumed one shows its conversation so far first, as the real TUIs do. With
   * `FAKE_HARNESS_NO_SESSION_START=1` it fires no `SessionStart`; with `FAKE_HARNESS_START_SOURCE`, its `SessionStart`
   * names that source instead of its own (`compact`, as Claude's after a compaction). With `FAKE_HARNESS_TRUST_SCREEN=1`
   * a Claude session shows its folder-trust screen first, firing nothing until it is answered (`trustScreen`); with
   * `late-start`, its `SessionStart` then waits for the first keys typed at its prompt; with `slow-prompt`, its prompt
   * is drawn `SLOW_PROMPT_MS` after a line of its own; with `slow-redraw`, the trust screen stays drawn `SLOW_REDRAW_MS`
   * after Enter picks its yes row; with `stuck-pointer`, Down never moves its pointer. A Codex TUI draws its composer as it loads, then the startup
   * screen `FAKE_HARNESS_START_SCREEN` names (until Enter answers it), then its composer with its status line, and fires
   * its `SessionStart` with its first prompt.
   */
  async start(): Promise<void> {
    const { harness, cwd, model, version, shellEnv } = this.dialect;
    if (this.dialect.demo) {
      quietTerminal();
      this.printLines(demo.welcome(harness, { cwd, model, version, home: shellEnv.HOME }));
    }
    if (this.resumed) {
      for (const { role, text } of this.dialect.transcript.history()) this.print(role === 'user' ? `> ${text}\n` : `${text}\n`);
    }
    const trust = process.env.FAKE_HARNESS_TRUST_SCREEN ?? '';
    let redrawing: NodeJS.Timeout | undefined;
    if ((trust === '1' || trust === 'late-start' || trust === 'slow-prompt' || trust === 'slow-redraw' || trust === 'stuck-pointer') && harness === 'claude' && !this.resumed) {
      await this.trustScreen();
      // Its prompt drawn well before its `SessionStart`, which lands as the first keys typed at it are, read raw (the
      // line reader still gets them) and the screen redrawn until it has, so it lands before the Enter after them.
      if (trust === 'late-start' && process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        const keys = await new Promise<Buffer | string>((resolve) => process.stdin.once('data', resolve));
        this.print(keys.toString());
        redrawing = setInterval(() => this.print('\x1b[0m'), 20);
      }
    }
    if (harness === 'codex' && this.dialect.interactive) await this.codexStartup();
    if (this.dialect.sessionStartWithFirstPrompt) this.sessionStartDue = true;
    else {
      try {
        await this.fireSessionStart();
      } finally {
        if (redrawing !== undefined) {
          clearInterval(redrawing);
          process.stdin.setRawMode(false);
        }
      }
    }
  }

  /** The Codex TUI's start: its composer as it loads, a startup screen to answer if any, then its composer up. */
  private async codexStartup(): Promise<void> {
    const screen = process.env.FAKE_HARNESS_START_SCREEN ?? '';
    if (screen !== '') {
      if (!isCodexStartScreen(screen)) this.crash(`unknown FAKE_HARNESS_START_SCREEN "${screen}" (expected one of ${CODEX_START_SCREENS.join(', ')})`);
      this.printLines(codexLoadingComposer());
      this.printLines(codexStartScreen(screen, this.dialect.cwd));
      if ((await this.readTypedLine()) === undefined) return;
    }
    this.printLines(codexComposer(this.dialect.model, this.dialect.cwd));
  }

  private async fireSessionStart(): Promise<void> {
    this.sessionStartDue = false;
    if (process.env.FAKE_HARNESS_NO_SESSION_START === '1') return;
    await this.fire('SessionStart', { source: process.env.FAKE_HARNESS_START_SOURCE || this.dialect.startSource, model: this.dialect.model });
  }

  async submit(prompt: string): Promise<void> {
    if (this.sessionStartDue) await this.fireSessionStart();
    this.inTurn = true;
    this.interrupted = false;
    this.turnId = randomUUID();
    if (this.dialect.demo) this.printLines(demo.userPrompt(this.dialect.harness, prompt));
    else this.print(`> ${prompt}\n`);
    // The Codex TUI keeps its composer and status line drawn through a turn, under what the turn prints.
    if (this.dialect.harness === 'codex' && this.dialect.interactive && !this.dialect.demo) this.printLines(codexComposer(this.dialect.model, this.dialect.cwd));
    this.dialect.transcript.userPrompt(prompt, this.turnId);
    const lost = this.promptTyped && this.promptHooksToLose > 0;
    this.promptTyped = false;
    if (lost) this.promptHooksToLose -= 1;
    else await this.fire('UserPromptSubmit', { prompt });
  }

  /**
   * Takes up a turn of its own, with no prompt: as Claude does when a command it left running in the background
   * reports back. No `UserPromptSubmit` fires.
   */
  resume(): void {
    this.inTurn = true;
    this.interrupted = false;
    this.turnId = randomUUID();
  }

  /** How long a session sits at its prompt before its `idle_prompt` (`FAKE_HARNESS_IDLE_NOTIFY_MS`). */
  get idleNotifyMs(): number {
    return this.dialect.idleNotifyMs;
  }

  /** Fires the `idle_prompt` notification that a session sitting at its prompt raises (Claude only). */
  async idlePrompt(): Promise<void> {
    if (this.dialect.notificationEvents) {
      await this.fire('Notification', { message: `${this.dialect.displayName} is waiting for your input`, notification_type: 'idle_prompt' });
    }
  }

  /**
   * Streams text to the terminal word by word (a character at a time with `typeMs`), then records it as one assistant
   * message. `atOnce` prints it whole, after one step, for text whose length is not the scenario's to pace (what a
   * server sent).
   */
  async say(text: string, atOnce = false): Promise<void> {
    const shown = this.dialect.demo ? demo.assistantText(this.dialect.harness, text).join('\n') : text;
    if (!atOnce && this.dialect.typeMs > 0) {
      // A colour code goes out whole, with the character after it: only what shows is typed. A character, not a UTF-16
      // unit (the `u`), so an emoji is never sent as two halves.
      // eslint-disable-next-line no-control-regex -- the demo's colour codes
      for (const [character] of shown.matchAll(/(?:\x1b\[[0-9;]*m)*[^]/gu)) {
        this.print(character);
        await this.sleep(this.dialect.typeMs);
      }
    } else {
      for (const word of atOnce ? [shown] : shown.split(/(?<= )/)) {
        this.print(word);
        await this.pause();
      }
    }
    this.print('\n');
    this.dialect.transcript.assistantText(text);
    this.lastAssistantMessage = text;
  }

  /** Thinks for a step (its spinner, in a demo) and records the thinking with its text, as Claude's `thinking` block. */
  async recordThought(text: string): Promise<void> {
    await this.think();
    await this.pause();
    this.dialect.transcript.thinking?.(text);
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
    const { harness, cwd } = this.dialect;
    if (!inside) this.dialect.transcript.toolUse(id, name, input);
    if (this.dialect.demo) this.printLines([demo.toolHeading(harness, name, input, cwd)]);
    else this.print(`● ${name}(${JSON.stringify(input)})\n`);
    await this.fire('PreToolUse', { ...inside, tool_name: name, tool_input: input, tool_use_id: id });
    if (process.env.FAKE_HARNESS_HANG_TOOL === '1' && this.dialect.harness === 'claude') {
      this.drawPromptBox();
      await this.untilInterrupted(new Promise<never>(() => {}));
    }

    if (needsPermission && !(await this.askPermission(name, input, inside))) {
      if (!inside) this.dialect.transcript.toolResult(id, 'The user denied this tool call.', true);
      if (this.dialect.demo) this.printLines(demo.toolDenied(harness));
      else this.print('  ⎿ Denied\n');
      return false;
    }

    await this.pause();
    if (this.dialect.demo) this.printLines(demo.toolResult(harness, name, input, response, cwd));
    if (!inside) this.dialect.transcript.toolResult(id, response, false);
    await this.fire('PostToolUse', { ...inside, tool_name: name, tool_input: input, tool_response: response, tool_use_id: id });
    if (!inside) await this.takeQueued();
    return true;
  }

  /**
   * Takes the messages typed while the turn ran, as Claude takes them at the step after a tool call: each written to
   * the transcript as it took it (`queuedPrompt`), with no `UserPromptSubmit`. Only with `queueMidTurn`.
   */
  private async takeQueued(): Promise<void> {
    const write = this.dialect.transcript.queuedPrompt?.bind(this.dialect.transcript);
    if (!this.queueMidTurn || write === undefined) return;
    while (await this.lineWaiting()) {
      const line = await this.readLine();
      if (line === undefined) return;
      if (line.trim() !== '') write(line);
    }
  }

  /** Whether a line typed at it is there to read now, without waiting for one. */
  private async lineWaiting(): Promise<boolean> {
    this.nextLine ??= this.lines.next();
    let ready = false;
    void this.nextLine.then(() => (ready = true));
    await new Promise((resolve) => setImmediate(resolve));
    return ready;
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
    // A demo's tool call shows its output already.
    if (!this.dialect.demo) this.print(`${stdout}${stderr}`);
    return stdout;
  }

  /**
   * Starts `command` for real in the model's shell (`sh -c`, a child of this process) as a shell tool call that returns
   * at once, leaving it running in the background: with `run_in_background` for Claude, which answers with its task id.
   * Resolves, once the call has returned, with `ended`: the command's end, which never rejects.
   */
  async runInBackground(command: string): Promise<{ ended: Promise<void> }> {
    const child = execFile('/bin/sh', ['-c', command], { cwd: this.dialect.cwd, env: this.dialect.shellEnv });
    const ended = new Promise<void>((resolve) => child.once('close', () => resolve()));
    // An ending session takes its commands with it, so none outlives a test.
    const kill = () => child.kill();
    process.once('exit', kill);
    void ended.then(() => process.off('exit', kill));
    const taskId = `b${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const input = this.dialect.backgroundFlag ? { command, description: command, run_in_background: true } : { command, description: command };
    const response = this.dialect.backgroundFlag
      ? { stdout: '', stderr: '', interrupted: false, isImage: false, backgroundTaskId: taskId }
      : { stdout: '', stderr: '', interrupted: false };
    await this.runTool(this.shellTool, input, response);
    return { ended };
  }

  /** Whether a command left running in the background reports back when it ends, starting a turn (Claude). */
  get takesUpBackgroundResults(): boolean {
    return this.dialect.backgroundFlag;
  }

  /**
   * Calls an MCP server's tool as the model would, starting the server the first time: a tool call named
   * `mcp__<server>__<tool>`, its result's text printed. Undefined when the config names no such server.
   */
  async callMcpTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    { giveUpMs }: { giveUpMs?: number } = {},
  ): Promise<McpToolResult | undefined> {
    const config = this.dialect.mcpServers[server];
    if (config === undefined) return undefined;
    this.mcpClients[server] ??= new McpClient(config, this.dialect.cwd);
    // The server is started and has listed its tools before the call goes out, as in a harness, so a tool timeout
    // counts from the call itself: one that also counted the server's start could give up before the call was sent.
    await this.untilInterrupted(this.mcpClients[server].listTools());
    const cancel = new AbortController();
    const call = this.mcpClients[server].callTool(tool, args, cancel.signal);
    call.catch(() => {});
    // With `giveUpMs`, a harness whose own tool timeout passes first: it drops the call, sending no cancel, and the
    // model reads that the tool timed out.
    const timedOut: McpToolResult = { text: `MCP tool ${tool} timed out`, isError: true };
    const raced =
      giveUpMs === undefined ? call : Promise.race([call, new Promise<McpToolResult>((resolve) => setTimeout(() => resolve(timedOut), giveUpMs))]);
    let result: McpToolResult;
    try {
      result = await this.untilInterrupted(raced);
    } catch (error) {
      // An interrupted turn cancels the call it was in, as the real CLIs are expected to (unless told to drop it).
      if (process.env.FAKE_HARNESS_MCP_CANCEL !== '0') cancel.abort();
      throw error;
    }
    await this.runTool(`mcp__${server}__${tool}`, args, { content: [{ type: 'text', text: result.text }], isError: result.isError });
    if (!this.dialect.demo) this.print(`${result.text}\n`);
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
    if (this.dialect.demo) this.printLines([demo.toolHeading(this.dialect.harness, agentType, { description: task }, this.dialect.cwd)]);
    else this.print(`● ${this.dialect.subagentToolName}(${agentType}: ${task})\n`);
    await this.fire('PreToolUse', { tool_name: this.dialect.subagentToolName, tool_input: input, tool_use_id: id });
    await this.fire('SubagentStart', { agent_id: agentId, agent_type: agentType });
    await this.pause();
    if (typeof result === 'function') {
      result = await result({ agent_id: agentId, agent_type: agentType });
      if (!this.dialect.demo) this.print(`${result}\n`);
    }
    if (this.dialect.demo) this.printLines(demo.toolResult(this.dialect.harness, agentType, {}, result, this.dialect.cwd));
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

  /**
   * The spinner a TUI shows while the model thinks, `frames` frames a step apart, then cleared. With no step delay it
   * shows one frame, so a test's output stays short. Demo only: elsewhere it does nothing.
   */
  async think(frames = 6): Promise<void> {
    if (!this.dialect.demo) return;
    const shown = this.dialect.stepDelayMs > 0 ? frames : 1;
    for (let frame = 0; frame < shown; frame++) {
      this.print(`\r\x1b[2K${demo.spinner(this.dialect.harness, frame)}`);
      await this.pause();
    }
    this.print('\r\x1b[2K');
  }

  /** Updates its todo list with the harness's own tool: Claude's `TodoWrite`, Codex's `update_plan`. */
  async updateTodos(todos: demo.Todo[]): Promise<void> {
    if (this.dialect.harness === 'codex') {
      await this.runTool('update_plan', { plan: todos.map(({ content, status }) => ({ step: content, status })) }, 'Plan updated');
      return;
    }
    const input = { todos: todos.map((todo) => ({ ...todo, activeForm: todo.content })) };
    await this.runTool('TodoWrite', input, { oldTodos: [], newTodos: input.todos });
  }

  /** Writes `text` to `path` (relative to its folder) for real, as a file-writing tool call: Claude's `Write`, Codex's `apply_patch`. */
  async writeFile(path: string, text: string): Promise<void> {
    const file = resolve(this.dialect.cwd, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    if (this.dialect.harness === 'codex') await this.runTool('apply_patch', { path: file, content: text }, 'Success');
    else await this.runTool('Write', { file_path: file, content: text }, { type: 'create', filePath: file, content: text });
  }

  /**
   * An edit of `path` shown as its diff, one hunk: Claude's `Edit` tool (its `structuredPatch` answer), Codex's
   * `apply_patch`. The file is not touched: a demo's repo need not have it.
   */
  async edit(path: string, hunk: demo.PatchHunk): Promise<void> {
    const file = resolve(this.dialect.cwd, path);
    const side = (mark: string) => hunk.lines.filter((line) => line[0] !== mark).map((line) => line.slice(1)).join('\n');
    const [oldString, newString] = [side('+'), side('-')];
    const response = { filePath: file, oldString, newString, structuredPatch: [{ ...hunk, oldLines: oldString.split('\n').length, newLines: newString.split('\n').length }] };
    if (this.dialect.harness === 'codex') await this.runTool('apply_patch', { path: file }, response);
    else await this.runTool('Edit', { file_path: file, old_string: oldString, new_string: newString }, response);
  }

  /** Ends the turn. */
  async stop(): Promise<void> {
    this.dialect.transcript.turnComplete(this.turnId, this.lastAssistantMessage);
    if (this.stopHooksToLose > 0) this.stopHooksToLose -= 1;
    else await this.fire('Stop', { stop_hook_active: false, last_assistant_message: this.lastAssistantMessage });
    this.inTurn = false;
    // Claude draws its status line again as the turn ends; what it prints isn't drawn here.
    const { statusLine } = this.dialect;
    if (statusLine !== undefined) await runStatusLine(statusLine.command, { session_id: this.dialect.sessionId, ...statusLine.input }, this.dialect.hookOptions);
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
   * Sits at the input prompt until the user types a line; undefined means stdin closed. Claude fires `idle_prompt` once
   * it has sat idle for `idleNotifyMs` (immediately when 0). With `FAKE_HARNESS_PROMPT_BOX` Claude draws its prompt box
   * there first (`drawPromptBox`); with `FAKE_HARNESS_IDLE_COMPACT_MS`, it compacts its conversation once it has sat idle that long, as
   * Claude's idle compaction does: `PreCompact`, then a `SessionStart` from `compact`, and no turn. With
   * `FAKE_HARNESS_IDLE_NEEDS_INPUT_MS`, once it has sat idle that long it says another session needs your input
   * (`agent_needs_input`), as Claude does of the background sessions it tracks, or what
   * `FAKE_HARNESS_IDLE_NEEDS_INPUT_MESSAGE` says instead (a dialog of Claude's own, by its text). With
   * `FAKE_HARNESS_DIALOG_CLOSE_MS`, that dialog is closed in its terminal that long after: its prompt box is drawn
   * again, and no hook fires, as acknowledging Claude's notice starts no turn.
   */
  async waitForInput(): Promise<string | undefined> {
    if (!this.dialect.notificationEvents) return this.readPrompt();
    this.drawPromptBox();
    // Hooks fire in order: one already under way finishes before the next, the next turn or SessionEnd.
    let firing: Promise<unknown> = Promise.resolve();
    const after = (ms: number, hooks: () => Promise<unknown>) => setTimeout(() => (firing = firing.then(hooks)), ms);
    const idle = () =>
      this.fire('Notification', { message: `${this.dialect.displayName} is waiting for your input`, notification_type: 'idle_prompt' });
    const timers: NodeJS.Timeout[] = [];
    if (this.dialect.idleNotifyMs <= 0) await idle();
    else timers.push(after(this.dialect.idleNotifyMs, idle));
    const compactMs = Number(process.env.FAKE_HARNESS_IDLE_COMPACT_MS ?? 0);
    if (compactMs > 0) {
      timers.push(
        after(compactMs, async () => {
          await this.fire('PreCompact', { trigger: 'auto', custom_instructions: '' });
          await this.fire('SessionStart', { source: 'compact', model: this.dialect.model });
        }),
      );
    }
    const needsInputMs = Number(process.env.FAKE_HARNESS_IDLE_NEEDS_INPUT_MS ?? 0);
    if (needsInputMs > 0) {
      timers.push(
        after(needsInputMs, () =>
          this.fire('Notification', {
            message: process.env.FAKE_HARNESS_IDLE_NEEDS_INPUT_MESSAGE || 'Docs pass needs your input: which branch?',
            notification_type: 'agent_needs_input',
          }),
        ),
      );
      const closeMs = Number(process.env.FAKE_HARNESS_DIALOG_CLOSE_MS ?? 0);
      if (closeMs > 0) timers.push(after(needsInputMs + closeMs, async () => this.printLines(drawPromptBox())));
    }
    const line = await this.readPrompt();
    for (const timer of timers) clearTimeout(timer);
    await firing;
    return line;
  }

  /**
   * The API call behind the turn failed (Claude's StopFailure). Then Claude shows a rate limit's screen
   * (`rateLimitScreen`).
   */
  async failTurn(error: string, details: string): Promise<void> {
    const message = `API Error: ${details}`;
    this.print(`${message}\n`);
    if (this.dialect.stopFailureEvent) {
      await this.fire('StopFailure', { error, error_details: details, last_assistant_message: message });
    }
    this.inTurn = false;
    if (error === 'rate_limit' && this.dialect.stopFailureEvent) await this.rateLimitScreen();
  }

  /**
   * What Claude shows once a turn hit its usage limit, by `FAKE_HARNESS_RATE_LIMIT_SCREEN` (`rate-limit-menu.ts`):
   * `prompt` puts `continue` at its prompt, for Enter to submit; `menu` (or `menu-credits-first`, its rows in the other
   * order) opens its menu, reads the arrows and Enter of one pick, and closes it, saying what the pick did: the stop
   * row leaves an empty prompt, any other row opens a page and leaves it too. None by default: just the error.
   */
  private async rateLimitScreen(): Promise<void> {
    const screen = process.env.FAKE_HARNESS_RATE_LIMIT_SCREEN ?? '';
    if (screen === 'prompt') {
      this.prefilled = RATE_LIMIT_CONTINUE;
      this.print(`> ${RATE_LIMIT_CONTINUE}\n`);
      return;
    }
    if (screen !== 'menu' && screen !== 'menu-credits-first') return;
    const rows = rateLimitMenuRows(screen === 'menu' ? 'stop-first' : 'credits-first');
    this.print(`${drawRateLimitMenu(rows).join('\n')}\n`);
    const keys = await this.readKeys();
    // Ink draws over the menu as it closes: here the screen is cleared.
    this.print('\x1b[2J\x1b[H');
    // Escape is its cancel: it picks no row, and leaves an empty prompt (Claude puts `continue` there only while its own
    // continue at the reset is armed).
    // eslint-disable-next-line no-control-regex -- a lone Escape, not the start of an arrow key's sequence
    if (/\x1b(?!\[)/.test(keys)) {
      this.print('> \n');
      return;
    }
    let picked = 0;
    // eslint-disable-next-line no-control-regex -- the arrow keys' escape sequences
    for (const [arrow] of keys.matchAll(/\x1b\[[AB]/g)) picked = Math.min(rows.length - 1, Math.max(0, picked + (arrow.endsWith('B') ? 1 : -1)));
    if (rows[picked] !== RATE_LIMIT_STOP_ROW) this.print(`Picked ${rows[picked]}: opened its page in your browser\n`);
    this.print('> \n');
  }

  /**
   * Claude's folder-trust screen for its folder (`trust-screen.ts`): Up and Down move its pointer, which starts on
   * `No, exit`, and Enter picks the row it is on. `No, exit` exits, as Claude does; the other row draws Claude's empty
   * prompt, and the session goes on.
   */
  private async trustScreen(): Promise<void> {
    let on: 'no' | 'yes' = 'no';
    this.printLines(drawTrustScreen(this.dialect.cwd, on));
    let held = '';
    for (;;) {
      const keys = await this.readKeys();
      held += keys.replace(/[\r\n]/g, '');
      if (process.env.FAKE_HARNESS_TRUST_SCREEN !== 'stuck-pointer') {
        // eslint-disable-next-line no-control-regex -- the arrow keys' escape sequences
        for (const [arrow] of keys.matchAll(/\x1b\[[AB]/g)) on = arrow.endsWith('B') ? 'yes' : 'no';
      }
      if (/[\r\n]/.test(keys)) break;
      this.print('\x1b[2J\x1b[H');
      this.printLines(drawTrustScreen(this.dialect.cwd, on));
    }
    // Every key it read reaches the line reader too: the line they end is the screen's.
    this.heldKeys = held;
    if (on === 'yes' && process.env.FAKE_HARNESS_TRUST_SCREEN === 'slow-redraw') await this.sleep(SLOW_REDRAW_MS);
    this.print('\x1b[2J\x1b[H');
    if (on === 'no') process.exit(1);
    // Claude still drawing: a line of its own a while before its prompt.
    if (process.env.FAKE_HARNESS_TRUST_SCREEN === 'slow-prompt') {
      this.print('Starting Claude Code…\n');
      await this.sleep(SLOW_PROMPT_MS);
    }
    this.printLines(drawPromptBox());
  }

  /**
   * The keys of one pick in a menu, as a TUI reads them: under a terminal, raw, so a lone Escape arrives as typed;
   * piped, a line. Each key also reaches the line reader, which holds them until the next line: that line drops them.
   */
  private async readKeys(): Promise<string> {
    const input = process.stdin;
    if (!input.isTTY) return (await this.readRawLine()) ?? '';
    input.setRawMode(true);
    const keys = await new Promise<string>((resolve) => input.once('data', (chunk: Buffer | string) => resolve(chunk.toString())));
    input.setRawMode(false);
    this.heldKeys = keys.replace(/[\r\n]/g, '');
    return keys;
  }

  /**
   * Fires `SessionEnd` and exits: `FAKE_HARNESS_SESSION_END_EXIT_MS` after it, as a slow machine's Claude may take, still
   * reading what is typed meanwhile.
   */
  async end(reason: string): Promise<never> {
    await this.fire('SessionEnd', { reason: this.dialect.sessionEndReason ?? reason });
    await this.sleep(Number(process.env.FAKE_HARNESS_SESSION_END_EXIT_MS ?? 0));
    process.exit(0);
  }

  /** Dies mid-turn: no Stop, no SessionEnd. */
  crash(message: string): never {
    process.stderr.write(`${this.dialect.harness}: ${message}\n`);
    process.exit(1);
  }

  /** The next prompt the user typed: like the real TUIs, Enter at an empty prompt submits nothing. */
  async readPrompt(): Promise<string | undefined> {
    for (;;) {
      const line = await this.readLine();
      this.promptTyped = line !== undefined;
      // What it put there itself goes up on Enter, or goes as the user types over it.
      const prefilled = this.prefilled;
      this.prefilled = '';
      if (line === '' && prefilled !== '') return prefilled;
      if (line === undefined || line.trim() !== '') return line;
    }
  }

  /**
   * The next line the user typed. Like the real TUIs, ESC CR (Alt+Enter, which the app sends for Shift+Enter) is a
   * new line within it rather than its end; and a bracketed paste of several lines (the app's composer sends one, as a
   * terminal pastes) is one prompt, its line breaks kept and its markers dropped. Ctrl-U clears what came before it.
   */
  async readLine(): Promise<string | undefined> {
    let line = await this.readMessage();
    if (line !== undefined && line !== '' && this.linesKept > 0) {
      this.linesKept -= 1;
      return afterClearKey(line);
    }
    // A lost Enter leaves the text at the prompt until the next one, and whatever is typed before it joins it: a Ctrl-U
    // typed meanwhile clears it.
    while (line !== undefined && line !== '' && this.entersToLose > 0) {
      this.entersToLose -= 1;
      const more = await this.readMessage();
      if (more === undefined) break;
      line = `${line}${more}`;
    }
    return line === undefined ? line : afterClearKey(line);
  }

  /** The next prompt or paste as it ended at an Enter. */
  private async readMessage(): Promise<string | undefined> {
    let line = await this.readTypedLine();
    if (line === undefined) return line;
    if (!line.startsWith(PASTE_START)) return this.rawInput && this.dialect.harness === 'claude' ? keptOfTypedLine(line) : line;
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
    if (next.done) return undefined;
    // A menu's keys, read raw, start the line after them: they were the menu's.
    const held = this.heldKeys;
    this.heldKeys = '';
    return held !== '' && next.value.startsWith(held) ? next.value.slice(held.length) : next.value;
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

    if (this.dialect.demo) this.printLines(demo.permissionPrompt(this.dialect.harness, input, this.dialect.cwd));
    else this.print(`Do you want to allow ${name}? (y/n) `);
    if (this.dialect.notificationEvents) {
      await this.fire('Notification', {
        message: `${this.dialect.displayName} needs your permission to use ${name}`,
        title: 'Permission needed',
        notification_type: 'permission_prompt',
      });
    }
    const answer = await this.readLine();
    if (answer === undefined) return false;
    return this.dialect.demo ? demo.allowsInDemo(this.dialect.harness, answer) : /^y(es)?$/i.test(answer.trim());
  }

  /**
   * Claude's prompt box, with `FAKE_HARNESS_PROMPT_BOX` (`1`), under its spinner line with `spinner`; nothing without it,
   * or under Codex.
   */
  private drawPromptBox(): void {
    const box = process.env.FAKE_HARNESS_PROMPT_BOX ?? '';
    if (this.dialect.harness !== 'claude' || (box !== '1' && box !== 'spinner')) return;
    this.printLines(box === 'spinner' ? [SPINNER_LINE, '', ...drawPromptBox()] : drawPromptBox());
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

  private printLines(lines: string[]): void {
    this.print(`${lines.join('\n')}\n`);
  }

  private pause(): Promise<void> {
    return this.sleep(this.dialect.stepDelayMs);
  }

  private sleep(ms: number): Promise<void> {
    return this.untilInterrupted(ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
  }
}
