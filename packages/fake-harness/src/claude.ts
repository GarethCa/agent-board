import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { hasFlag, listFlag, parseArgs, stringFlag, type FlagSpec } from './args.ts';
import { ConfigError, mergeHooks, parseHooksJson, readHooksFile, validateMatchers, type HooksConfig } from './hooks.ts';
import { appendJsonl, readJsonlFile } from './jsonl.ts';
import { parseClaudeMcpConfig, type McpServerConfig } from './mcp.ts';
import { type ConversationMessage, type Invocation, type Transcript } from './session.ts';
import { toolOutput } from './tool-output.ts';

const FLAGS: FlagSpec = {
  valued: new Set([
    '--settings', '--session-id', '--resume', '-r', '--model', '--fallback-model', '--permission-mode',
    '--output-format', '--input-format', '--append-system-prompt', '--system-prompt', '--allowedTools',
    '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--tools', '--mcp-config', '--add-dir', '--agent',
    '--agents', '--effort', '--max-turns', '--setting-sources', '--plugin-dir', '--name', '--json-schema',
    '--max-budget-usd',
  ]),
  switches: new Set([
    '-p', '--print', '-c', '--continue', '--verbose', '-d', '--debug', '--dangerously-skip-permissions',
    '--allow-dangerously-skip-permissions', '--ide', '--strict-mcp-config', '--include-partial-messages',
    '--replay-user-messages', '--fork-session', '-v', '--version', '-h', '--help', '--json', '--text',
  ]),
};

const CLAUDE_VERSION = '2.1.0';

/** Reads the same inputs the real `claude` reads: its flags, `--settings` (JSON or a path) and `~/.claude/settings.json`. */
export function claudeInvocation(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Invocation {
  const args = parseArgs(argv, FLAGS);
  if (hasFlag(args, '-v', '--version')) return { reply: `${CLAUDE_VERSION} (Claude Code)` };
  if (args.positionals[0] === 'auth' && args.positionals[1] === 'status') return authStatus(env);
  const configDir = env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude');
  const resumeId = stringFlag(args, '--resume', '-r');
  const sessionId = resumeId ?? stringFlag(args, '--session-id') ?? randomUUID();
  const model = stringFlag(args, '--model') ?? 'claude-opus-5';
  const projectDir = join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

  // Like Claude Code, `disableAllHooks` in the user's settings runs no hook at all, `--settings` ones too.
  const userSettings = join(configDir, 'settings.json');
  const hooks = hooksDisabled(userSettings)
    ? {}
    : mergeHooks(readHooksFile(userSettings), settingsFlagHooks(stringFlag(args, '--settings')));
  validateMatchers(hooks, 'claude');

  return {
    prompt: args.positionals.join(' ') || undefined,
    dialect: {
      harness: 'claude',
      displayName: 'Claude',
      version: CLAUDE_VERSION,
      interactive: !hasFlag(args, '-p', '--print'),
      sessionId,
      cwd,
      model,
      permissionMode: stringFlag(args, '--permission-mode') ?? 'default',
      startSource: resumeId ? 'resume' : 'startup',
      hooks,
      hookOptions: {
        cwd,
        env: { ...env, CLAUDE_PROJECT_DIR: cwd },
        supportsHttp: true,
        // Claude runs no `http` hook for `SessionStart` (checked against claude 2.1.310): only `command` ones.
        httpSkippedEvents: ['SessionStart'],
        matcherSyntax: 'claude',
        defaultTimeoutSeconds: 600,
      },
      transcript: new ClaudeTranscript(projectDir, sessionId, cwd, model),
      sessionStartWithFirstPrompt: false,
      notificationEvents: true,
      interruptEvent: false,
      stopFailureEvent: true,
      modelAndTurnIdFields: false,
      permissionSuggestions: true,
      subagentToolName: 'Agent',
      shellToolName: 'Bash',
      backgroundFlag: true,
      mcpServers: mcpConfigFlags(listFlag(args, '--mcp-config'), env),
      // Claude's Bash tool runs with its own env.
      shellEnv: env,
    },
  };
}

/**
 * `claude auth status`, as JSON (its default): signed in with claude.ai, or not with `FAKE_HARNESS_LOGGED_OUT=1`, when
 * it exits 1 as the real one does.
 */
function authStatus(env: NodeJS.ProcessEnv): Invocation {
  const loggedIn = env.FAKE_HARNESS_LOGGED_OUT !== '1';
  const status = loggedIn ? { loggedIn, authMethod: 'claude.ai', apiProvider: 'firstParty' } : { loggedIn, authMethod: 'none', apiProvider: 'firstParty' };
  return { reply: JSON.stringify(status, null, 2), exitCode: loggedIn ? 0 : 1 };
}

/** The servers of every `--mcp-config` (inline JSON or a file path), later ones over earlier. */
function mcpConfigFlags(values: string[], env: NodeJS.ProcessEnv): Record<string, McpServerConfig> {
  return Object.assign(
    {},
    ...values.map((value) => {
      if (value.trim().startsWith('{')) return parseClaudeMcpConfig(value, '--mcp-config', env);
      if (!existsSync(value)) throw new ConfigError(`--mcp-config file not found: ${value}`);
      return parseClaudeMcpConfig(readFileSync(value, 'utf8'), value, env);
    }),
  );
}

/** Whether the user's settings file turns every hook off (`"disableAllHooks": true`). */
function hooksDisabled(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return (JSON.parse(readFileSync(path, 'utf8')) as { disableAllHooks?: unknown }).disableAllHooks === true;
  } catch {
    return false;
  }
}

/** `--settings` takes inline JSON or a file path. */
function settingsFlagHooks(value: string | undefined): HooksConfig | undefined {
  if (value === undefined) return undefined;
  if (value.trim().startsWith('{')) return parseHooksJson(value, '--settings');
  if (!existsSync(value)) throw new ConfigError(`--settings file not found: ${value}`);
  return parseHooksJson(readFileSync(value, 'utf8'), value);
}

/** `~/.claude/projects/<cwd with non-alphanumerics as dashes>/<session-id>.jsonl`, one entry per line. */
class ClaudeTranscript implements Transcript {
  readonly path: string;
  private readonly projectDir: string;
  private readonly sessionId: string;
  private readonly cwd: string;
  private readonly model: string;
  private parentUuid: string | null = null;

  constructor(projectDir: string, sessionId: string, cwd: string, model: string) {
    this.projectDir = projectDir;
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.model = model;
    this.path = join(projectDir, `${sessionId}.jsonl`);
  }

  history(): ConversationMessage[] {
    return readJsonlFile(this.path).flatMap((entry): ConversationMessage[] => {
      const message = entry.message as { content: unknown } | undefined;
      if (entry.type === 'user' && typeof message?.content === 'string') return [{ role: 'user', text: message.content }];
      if (entry.type !== 'assistant' || !Array.isArray(message?.content)) return [];
      return (message.content as { type: string; text?: string }[]).flatMap((part) =>
        part.type === 'text' && part.text !== undefined ? [{ role: 'assistant' as const, text: part.text }] : [],
      );
    });
  }

  userPrompt(text: string, promptId: string): void {
    this.append({ type: 'user', promptId, message: { role: 'user', content: text } });
  }

  assistantText(text: string): void {
    this.append({ type: 'assistant', message: this.assistantMessage([{ type: 'text', text }], 'end_turn') });
  }

  toolUse(id: string, name: string, input: unknown): void {
    this.append({ type: 'assistant', message: this.assistantMessage([{ type: 'tool_use', id, name, input }], 'tool_use') });
  }

  /** Like Claude: a shell's output as the result's text, and what the tool returned beside it. */
  toolResult(id: string, response: unknown, isError: boolean): void {
    this.append({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: toolOutput(response), is_error: isError }] },
      toolUseResult: response,
    });
  }

  subagent(agentId: string, agentType: string, task: string, result: string, toolUseId: string): string {
    const path = join(this.projectDir, this.sessionId, 'subagents', `agent-${agentId}.jsonl`);
    // Beside it, as Claude Code 2.1.x keeps it: which call started it.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path.replace(/\.jsonl$/, '.meta.json'), `${JSON.stringify({ agentType, description: task, toolUseId })}\n`);
    const base = { isSidechain: true, agentId, agentType, sessionId: this.sessionId, cwd: this.cwd, version: CLAUDE_VERSION };
    const promptUuid = randomUUID();
    appendJsonl(path, { ...base, parentUuid: null, uuid: promptUuid, timestamp: now(), type: 'user', message: { role: 'user', content: task } });
    appendJsonl(path, {
      ...base,
      parentUuid: promptUuid,
      uuid: randomUUID(),
      timestamp: now(),
      type: 'assistant',
      message: this.assistantMessage([{ type: 'text', text: result }], 'end_turn'),
    });
    return path;
  }

  turnComplete(): void {}

  private assistantMessage(content: unknown[], stopReason: string) {
    return {
      id: `msg_fake_${randomUUID().slice(0, 8)}`,
      type: 'message',
      role: 'assistant',
      model: this.model,
      content,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  private append(entry: Record<string, unknown>): void {
    const uuid = randomUUID();
    appendJsonl(this.path, {
      parentUuid: this.parentUuid,
      isSidechain: false,
      userType: 'external',
      cwd: this.cwd,
      sessionId: this.sessionId,
      version: CLAUDE_VERSION,
      uuid,
      timestamp: now(),
      ...entry,
    });
    this.parentUuid = uuid;
  }
}

function now(): string {
  return new Date().toISOString();
}
