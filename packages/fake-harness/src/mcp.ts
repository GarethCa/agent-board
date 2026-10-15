import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ConfigError } from './hooks.ts';

/** A stdio MCP server as a harness's config names it. */
export interface McpServerConfig {
  command: string;
  args: string[];
  /** Its whole environment: what its harness passes it, and the vars its config sets. */
  env: NodeJS.ProcessEnv;
}

/** What a tool call returned: its text, and whether the tool said it failed. */
export interface McpToolResult {
  text: string;
  isError: boolean;
}

/**
 * The `mcpServers` of a Claude `--mcp-config` (JSON): stdio servers only, which is all the fakes start. Claude starts
 * each with its own env, `env`, plus the vars the config sets.
 */
export function parseClaudeMcpConfig(json: string, source: string, harnessEnv: NodeJS.ProcessEnv): Record<string, McpServerConfig> {
  let config: unknown;
  try {
    config = JSON.parse(json);
  } catch {
    throw new ConfigError(`${source}: invalid JSON`);
  }
  const servers = (config as { mcpServers?: unknown } | null)?.mcpServers;
  if (typeof servers !== 'object' || servers === null) throw new ConfigError(`${source}: expected {"mcpServers": {…}}`);
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      const { command, args = [], env = {} } = server as { command?: unknown; args?: unknown; env?: unknown };
      if (typeof command !== 'string' || !Array.isArray(args)) throw new ConfigError(`${source}: server ${name} needs a command and args`);
      return [name, { command, args: args.map(String), env: { ...harnessEnv, ...(env as Record<string, string>) } }];
    }),
  );
}

/**
 * A minimal MCP client over stdio, as a harness is one: starts the server, initializes, and calls tools. The server
 * goes when this process does (its stdin closes).
 */
export class McpClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (message: { result?: unknown; error?: { message: string } }) => void>();
  private nextId = 1;
  private ready: Promise<{ instructions?: string }> | undefined;
  private tools: Promise<string[]> | undefined;

  constructor(server: McpServerConfig, cwd: string) {
    this.child = spawn(server.command, server.args, { cwd, env: server.env, stdio: 'pipe' });
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message: { id?: number; result?: unknown; error?: { message: string } };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const settle = message.id === undefined ? undefined : this.pending.get(message.id);
      if (settle === undefined) return;
      this.pending.delete(message.id!);
      settle(message);
    });
    this.child.on('exit', () => {
      for (const settle of this.pending.values()) settle({ error: { message: 'the MCP server exited' } });
      this.pending.clear();
    });
  }

  /** Initializes the session once, resolving with the server's instructions. */
  initialize(): Promise<{ instructions?: string }> {
    this.ready ??= this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fake-harness', version: '0.0.0' },
    }).then((result) => {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      return result as { instructions?: string };
    });
    return this.ready;
  }

  /** The names of the tools the server lists, asked once, as a harness asks as it starts. */
  listTools(): Promise<string[]> {
    this.tools ??= this.initialize()
      .then(() => this.request('tools/list', {}))
      .then((result) => ((result as { tools?: { name: string }[] }).tools ?? []).map((tool) => tool.name));
    return this.tools;
  }

  /**
   * Calls a tool the server listed; one it didn't list is an error, as in a harness, which offers the model no such tool.
   * Once `signal` aborts (the turn was interrupted), the call is cancelled, as a harness does: `notifications/cancelled`.
   */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    if (!(await this.listTools()).includes(name)) return { text: `No such tool available: ${name}`, isError: true };
    const result = (await this.request('tools/call', { name, arguments: args }, signal)) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const text = (result.content ?? []).map((part) => part.text ?? '').join('\n');
    return { text, isError: result.isError === true };
  }

  private request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      signal?.addEventListener(
        'abort',
        () => {
          if (!this.pending.delete(id)) return;
          this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'interrupted' } })}\n`);
          reject(new Error('cancelled'));
        },
        { once: true },
      );
    });
  }
}

/**
 * The env vars Codex passes every stdio MCP server from its own env; a server's `env_vars` names more, and its `env`
 * sets some.
 */
const CODEX_MCP_DEFAULT_ENV = ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'USER', '__CF_USER_TEXT_ENCODING', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ'];

/**
 * The servers in Codex's `-c mcp_servers.<name>.<key>=<value>` overrides (`command`, `args`, `env`, `env_vars`), each
 * with the env Codex would start it with.
 */
export function codexMcpServers(overrides: [string, unknown][], harnessEnv: NodeJS.ProcessEnv): Record<string, McpServerConfig> {
  const fields: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of overrides) {
    const match = /^mcp_servers\.([\w-]+)\.(\w+)$/.exec(key);
    if (match !== null) (fields[match[1]!] ??= {})[match[2]!] = value;
  }
  return Object.fromEntries(
    Object.entries(fields).map(([name, { command, args = [], env = {}, env_vars: envVars = [] }]) => {
      if (typeof command !== 'string' || !Array.isArray(args) || !Array.isArray(envVars)) {
        throw new ConfigError(`mcp_servers.${name}: needs a command, and args and env_vars as arrays`);
      }
      const passed = [...CODEX_MCP_DEFAULT_ENV, ...envVars.map(String)].filter((each) => harnessEnv[each] !== undefined);
      const serverEnv = Object.fromEntries(passed.map((each) => [each, harnessEnv[each]]));
      return [name, { command, args: args.map(String), env: { ...serverEnv, ...(env as Record<string, string>) } }];
    }),
  );
}
