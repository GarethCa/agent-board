import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { hasFlag, listFlag, parseArgs, stringFlag, type FlagSpec } from './args.ts';
import { ConfigError, mergeHooks, readHooksFile, validateMatchers, type HooksConfig, type MatcherGroup } from './hooks.ts';
import { codexMcpServers } from './mcp.ts';
import { parseTomlValue } from './toml.ts';
import { appendJsonl, readJsonlFile } from './jsonl.ts';
import { toolOutput, type ConversationMessage, type Invocation, type Transcript } from './session.ts';

const FLAGS: FlagSpec = {
  valued: new Set([
    '-m', '--model', '-c', '--config', '-C', '--cd', '-p', '--profile', '-s', '--sandbox', '-a',
    '--ask-for-approval', '-i', '--image', '--add-dir', '-o', '--output-last-message', '--output-schema',
    '--color', '--enable', '--disable',
  ]),
  switches: new Set([
    '--dangerously-bypass-hook-trust', '--full-auto', '--dangerously-bypass-approvals-and-sandbox', '--yolo',
    '--skip-git-repo-check', '--json', '--search', '--oss', '--last', '-V', '--version', '-h', '--help',
  ]),
};

const CODEX_VERSION = '0.46.0';

/** Events Codex sends `permission_mode` on (not SessionEnd, PreCompact or PostCompact). */
const PERMISSION_MODE_EVENTS = new Set([
  'SessionStart', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'UserPromptSubmit',
  'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt',
]);

/**
 * Reads the same inputs the real `codex` reads: its flags, the `exec` and `resume <id>` subcommands, `hooks.json`
 * from `$CODEX_HOME` (default `~/.codex`) and `.codex/` at the git root, and `-c hooks.<Event>=[…]` overrides. Like
 * Codex, non-managed hooks only run once trusted; the fake has no `/hooks` review, so they run only with
 * `--dangerously-bypass-hook-trust`. `config.toml` hooks are not read.
 */
export function codexInvocation(argv: string[], env: NodeJS.ProcessEnv, processCwd: string): Invocation {
  const args = parseArgs(argv, FLAGS);
  if (hasFlag(args, '-V', '--version')) return { reply: `codex-cli ${CODEX_VERSION}` };
  // `codex login status` answers on stderr, as the real one does.
  if (args.positionals[0] === 'login' && args.positionals[1] === 'status') {
    return env.FAKE_HARNESS_LOGGED_OUT === '1'
      ? { reply: 'Not logged in', stream: 'stderr', exitCode: 1 }
      : { reply: 'Logged in using ChatGPT', stream: 'stderr' };
  }
  const subcommand = ['exec', 'e', 'resume'].includes(args.positionals[0] ?? '') ? args.positionals.shift() : undefined;
  const resumeId = subcommand === 'resume' && !hasFlag(args, '--last') ? args.positionals.shift() : undefined;
  const cwd = stringFlag(args, '-C', '--cd') ?? processCwd;
  const codexHome = env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex');
  const sessionId = resumeId ?? randomUUID();
  const model = stringFlag(args, '-m', '--model') ?? 'gpt-5-codex';
  const warnings: string[] = [];

  const overrides = configOverrides(listFlag(args, '-c', '--config'));
  let hooks = mergeHooks(
    readHooksFile(join(codexHome, 'hooks.json')),
    readHooksFile(join(gitRoot(cwd), '.codex', 'hooks.json')),
    configOverrideHooks(overrides),
  );
  validateMatchers(hooks, 'regex');
  const hookCount = Object.values(hooks).flatMap((groups) => groups ?? []).length;
  if (hookCount > 0 && !args.flags.has('--dangerously-bypass-hook-trust')) {
    warnings.push(`skipping ${hookCount} untrusted hook group(s); review them with /hooks`);
    hooks = {};
  }

  return {
    prompt: args.positionals.join(' ') || undefined,
    warnings,
    dialect: {
      harness: 'codex',
      displayName: 'Codex',
      interactive: subcommand !== 'exec' && subcommand !== 'e',
      sessionId,
      cwd,
      model,
      permissionMode: 'default',
      startSource: subcommand === 'resume' ? 'resume' : 'startup',
      hooks,
      hookOptions: {
        cwd,
        env,
        supportsHttp: false,
        matcherSyntax: 'regex',
        defaultTimeoutSeconds: 600,
        eventTimeouts: { SessionEnd: { defaultSeconds: 1, maxSeconds: 3 }, Interrupt: { defaultSeconds: 1, maxSeconds: 3 } },
      },
      transcript: new CodexRollout(codexHome, sessionId, cwd, model, resumeId !== undefined),
      notificationEvents: false,
      interruptEvent: true,
      stopFailureEvent: false,
      modelAndTurnIdFields: true,
      permissionSuggestions: false,
      permissionModeEvents: PERMISSION_MODE_EVENTS,
      subagentToolName: 'spawn_agent',
      shellToolName: 'Bash',
      backgroundFlag: false,
      mcpServers: codexMcpServers(overrides, env),
      shellEnv: shellEnvironment(env, overrides),
      sessionEndReason: 'other',
    },
  };
}

/** `-c key=value` overrides as keys and values. Like Codex, a value that isn't TOML is taken as a plain string. */
function configOverrides(overrides: string[]): [string, unknown][] {
  return overrides.map((override) => {
    const eq = override.indexOf('=');
    if (eq <= 0) throw new ConfigError(`-c ${override}: expected key=value`);
    const raw = override.slice(eq + 1);
    let value: unknown;
    try {
      value = parseTomlValue(raw);
    } catch {
      value = raw;
    }
    return [override.slice(0, eq).trim(), value];
  });
}

/** The hooks in the overrides' `hooks.<Event>` keys. */
function configOverrideHooks(overrides: [string, unknown][]): HooksConfig {
  const hooks: HooksConfig = {};
  for (const [key, groups] of overrides) {
    const event = /^hooks\.(\w+)$/.exec(key)?.[1];
    if (event === undefined) continue;
    if (!isMatcherGroups(groups)) throw new ConfigError(`-c ${key}: expected an array of {hooks=[…]} groups`);
    hooks[event] = groups;
  }
  return hooks;
}

/**
 * The env the model's shell commands get, as Codex's `shell_environment_policy` filters it: first its default excludes
 * (any var whose name has KEY, SECRET or TOKEN in it) unless `ignore_default_excludes` is true, then the vars
 * `exclude` matches (case-insensitive globs, `*` and `?`).
 */
function shellEnvironment(env: NodeJS.ProcessEnv, overrides: [string, unknown][]): NodeJS.ProcessEnv {
  const setting = (name: string) => overrides.filter(([key]) => key === `shell_environment_policy.${name}`).at(-1)?.[1];
  const exclude = setting('exclude') ?? [];
  if (!Array.isArray(exclude)) throw new ConfigError('shell_environment_policy.exclude: expected an array of patterns');
  const patterns = exclude.map((glob) => new RegExp(`^${String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`, 'i'));
  if (setting('ignore_default_excludes') !== true) patterns.push(/KEY|SECRET|TOKEN/i);
  return Object.fromEntries(Object.entries(env).filter(([name]) => !patterns.some((pattern) => pattern.test(name))));
}

function isMatcherGroups(value: unknown): value is MatcherGroup[] {
  return (
    Array.isArray(value) &&
    value.every((group: { hooks?: unknown }) => typeof group === 'object' && group !== null && Array.isArray(group.hooks))
  );
}

/** The nearest folder at or above `cwd` holding `.git`, or `cwd` outside a repo. Codex reads project hooks there. */
function gitRoot(cwd: string): string {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return cwd;
  }
}


/** `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl`: `{timestamp, type, payload}` per line. */
class CodexRollout implements Transcript {
  readonly path: string;
  private readonly codexHome: string;
  private readonly cwd: string;
  private readonly model: string;
  /** The calls run through `exec`, whose results are the script's report. */
  private readonly execCalls = new Set<string>();

  /** A resumed session carries on in the rollout it resumes; throws if there is none. */
  constructor(codexHome: string, sessionId: string, cwd: string, model: string, resume: boolean) {
    this.codexHome = codexHome;
    this.cwd = cwd;
    this.model = model;
    if (resume) {
      const existing = findRollout(join(codexHome, 'sessions'), sessionId);
      // Like Codex: nothing to resume is an error, not a new session.
      if (existing === undefined) throw new ConfigError(`no saved session ${sessionId} to resume`);
      this.path = existing;
      return;
    }
    const started = new Date();
    const iso = started.toISOString();
    const [year, month, day] = [iso.slice(0, 4), iso.slice(5, 7), iso.slice(8, 10)];
    const stamp = iso.slice(0, 19).replaceAll(':', '-');
    this.path = join(codexHome, 'sessions', year, month, day, `rollout-${stamp}-${sessionId}.jsonl`);
    this.append('session_meta', {
      id: sessionId,
      timestamp: iso,
      cwd,
      originator: 'codex_cli_rs',
      cli_version: CODEX_VERSION,
      source: 'cli',
      model_provider: 'openai',
    });
  }

  history(): ConversationMessage[] {
    return readJsonlFile(this.path).flatMap((line): ConversationMessage[] => {
      const payload = line.payload as { type?: string; role?: string; content?: { text?: string }[] };
      if (line.type !== 'response_item' || payload.type !== 'message') return [];
      if (payload.role !== 'user' && payload.role !== 'assistant') return [];
      const role = payload.role;
      return (payload.content ?? []).flatMap((part) => (part.text === undefined ? [] : [{ role, text: part.text }]));
    });
  }

  userPrompt(text: string, turnId: string): void {
    this.append('event_msg', { type: 'task_started', turn_id: turnId });
    this.append('turn_context', { turn_id: turnId, cwd: this.cwd, model: this.model, approval_policy: 'on-request' });
    this.append('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
    this.append('event_msg', { type: 'user_message', message: text, images: [] });
  }

  assistantText(text: string): void {
    this.append('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    this.append('event_msg', { type: 'agent_message', message: text });
  }

  /**
   * Like Codex 0.162: a shell command is a script for its `exec` tool (`custom_tool_call`, the script as `input`); any
   * other tool is a `function_call` with JSON arguments.
   */
  toolUse(id: string, name: string, input: unknown): void {
    const command = (input as { command?: unknown } | undefined)?.command;
    if (name === 'Bash' && typeof command === 'string') {
      this.execCalls.add(id);
      const script = `const r = await tools.exec_command({cmd:${JSON.stringify(command)}});\ntext(r.output);\ntext(\`exit_code=\${r.exit_code}\`);\n`;
      this.append('response_item', { type: 'custom_tool_call', status: 'completed', call_id: id, name: 'exec', input: script });
      return;
    }
    this.append('response_item', { type: 'function_call', name, arguments: JSON.stringify(input), call_id: id });
  }

  /** An `exec` call's result is the script's report, as Codex writes it: completed with the exit code, or failed. */
  toolResult(id: string, response: unknown, isError: boolean): void {
    if (!this.execCalls.delete(id)) {
      this.append('response_item', { type: 'function_call_output', call_id: id, output: toolOutput(response) });
      return;
    }
    const report = isError
      ? [{ type: 'input_text', text: 'Script failed\nWall time 0.0 seconds\nOutput:\n' }, { type: 'input_text', text: `Script error:\n${toolOutput(response)}` }]
      : [{ type: 'input_text', text: `Script completed\nWall time 0.1 seconds\nOutput:\n${toolOutput(response)}` }, { type: 'input_text', text: 'exit_code=0' }];
    this.append('response_item', { type: 'custom_tool_call_output', call_id: id, output: report });
  }

  subagent(agentId: string, agentType: string, task: string, result: string): string {
    const path = join(this.codexHome, 'sessions', 'subagents', `rollout-${agentId}.jsonl`);
    const line = (type: string, payload: unknown) => appendJsonl(path, { timestamp: new Date().toISOString(), type, payload });
    line('session_meta', { id: agentId, cwd: this.cwd, agent_type: agentType, cli_version: CODEX_VERSION });
    line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: task }] });
    line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: result }] });
    // The parent's rollout records the messages between them: the task (encrypted, so its payload is empty) and the answer.
    const taskName = `/root/${agentType}`;
    this.append('response_item', { type: 'agent_message', author: '/root', recipient: taskName, content: [{ type: 'input_text', text: `Message Type: NEW_TASK\nTask name: ${taskName}\nSender: /root\nPayload:\n` }] });
    this.append('response_item', { type: 'agent_message', author: taskName, recipient: '/root', content: [{ type: 'input_text', text: `Message Type: FINAL_ANSWER\nTask name: /root\nSender: ${taskName}\nPayload:\n${result}` }] });
    return path;
  }

  turnComplete(turnId: string, lastMessage: string): void {
    this.append('event_msg', { type: 'task_complete', turn_id: turnId, last_agent_message: lastMessage });
  }

  private append(type: string, payload: unknown): void {
    appendJsonl(this.path, { timestamp: new Date().toISOString(), type, payload });
  }
}


/** The rollout file of session `sessionId` under `dir` (`YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl`), if any. */
function findRollout(dir: string, sessionId: string): string | undefined {
  if (!existsSync(dir)) return undefined;
  const name = readdirSync(dir, { recursive: true, encoding: 'utf8' }).find((path) => path.endsWith(`-${sessionId}.jsonl`));
  return name === undefined ? undefined : join(dir, name);
}
