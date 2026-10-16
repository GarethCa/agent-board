import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { ConfigError } from './hooks.ts';

/** An MCP server as a harness's config names it: one it starts and talks to over stdio, or one it posts to over HTTP. */
export type McpServerConfig = McpStdioServer | McpHttpServer;

export interface McpStdioServer {
  command: string;
  args: string[];
  /** Its whole environment: what its harness passes it, and the vars its config sets. */
  env: NodeJS.ProcessEnv;
}

/** A Streamable HTTP server: its URL, and the headers each request carries (env vars already filled in). */
export interface McpHttpServer {
  url: string;
  headers: Record<string, string>;
}

/** What a tool call returned: its text, and whether the tool said it failed. */
export interface McpToolResult {
  text: string;
  isError: boolean;
}

/**
 * The `mcpServers` of a Claude `--mcp-config` (JSON). Claude starts a stdio server with its own env, `env`, plus the
 * vars the config sets; an `http` server's `url` and `headers` have `${VAR}` and `${VAR:-default}` filled in from `env`.
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
      const { type, url, headers = {} } = server as { type?: unknown; url?: unknown; headers?: unknown };
      if (type === 'http' || type === 'streamable-http') {
        if (typeof url !== 'string' || typeof headers !== 'object' || headers === null) throw new ConfigError(`${source}: server ${name} needs a url`);
        const filled = Object.entries(headers as Record<string, unknown>).map(([header, value]) => [header, expandEnv(String(value), harnessEnv)]);
        return [name, { url: expandEnv(url, harnessEnv), headers: Object.fromEntries(filled) }];
      }
      const { command, args = [], env = {} } = server as { command?: unknown; args?: unknown; env?: unknown };
      if (typeof command !== 'string' || !Array.isArray(args)) throw new ConfigError(`${source}: server ${name} needs a command and args`);
      return [name, { command, args: args.map(String), env: { ...harnessEnv, ...(env as Record<string, string>) } }];
    }),
  );
}

/** `${VAR}` and `${VAR:-default}` in `value`, from `env`, as Claude expands its MCP config. An unset var is empty. */
function expandEnv(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{(\w+)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => env[name] || (fallback ?? ''));
}

/** A JSON-RPC message as the client sends it, and what comes back for a request. */
type Message = { jsonrpc: '2.0'; id?: number; method: string; params?: unknown };
type Reply = { id?: number; result?: unknown; error?: { message: string } };

/** How the client reaches its server: a request resolves with its reply; a notification goes out with none. */
interface McpTransport {
  request(message: Message & { id: number }, signal: AbortSignal): Promise<Reply>;
  notify(message: Message): void;
}

/** A stdio server: started once, one JSON-RPC message a line each way. It goes when this process does (its stdin closes). */
class StdioTransport implements McpTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, (message: Reply) => void>();

  constructor(server: McpStdioServer, cwd: string) {
    this.child = spawn(server.command, server.args, { cwd, env: server.env, stdio: 'pipe' });
    this.child.stderr.resume();
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message: Reply;
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

  request(message: Message & { id: number }, signal: AbortSignal): Promise<Reply> {
    return new Promise((resolve) => {
      this.pending.set(message.id, resolve);
      signal.addEventListener('abort', () => this.pending.delete(message.id), { once: true });
      this.notify(message);
    });
  }

  notify(message: Message): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

/**
 * A Streamable HTTP server: each message is a POST of its own, answered with JSON or an event stream (whose `: ` comment
 * lines keep a long call alive). A cancelled call's request is aborted, which the server sees as a hang-up.
 */
class HttpTransport implements McpTransport {
  private readonly server: McpHttpServer;

  constructor(server: McpHttpServer) {
    this.server = server;
  }

  async request(message: Message & { id: number }, signal: AbortSignal): Promise<Reply> {
    const response = await this.post(message, signal);
    const body = await response.text();
    if (!response.ok) return { error: { message: `HTTP ${response.status}: ${body.trim()}` } };
    if (!(response.headers.get('content-type') ?? '').startsWith('text/event-stream')) return JSON.parse(body) as Reply;
    const replies = body
      .split(/\n\n/)
      .map((event) => event.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n'))
      .filter((data) => data !== '')
      .map((data) => JSON.parse(data) as Reply);
    return replies.find((reply) => reply.id === message.id) ?? { error: { message: 'the event stream ended without a reply' } };
  }

  notify(message: Message): void {
    this.post(message).then((response) => response.body?.cancel(), () => {});
  }

  private post(message: Message, signal?: AbortSignal): Promise<Response> {
    return fetch(this.server.url, {
      method: 'POST',
      headers: { ...this.server.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(message),
      signal,
    });
  }
}

/** A minimal MCP client, as a harness is one: reaches the server, initializes, and calls tools. */
export class McpClient {
  private readonly transport: McpTransport;
  private nextId = 1;
  private ready: Promise<{ instructions?: string }> | undefined;
  private tools: Promise<string[]> | undefined;

  constructor(server: McpServerConfig, cwd: string) {
    this.transport = 'url' in server ? new HttpTransport(server) : new StdioTransport(server, cwd);
  }

  /** Initializes the session once, resolving with the server's instructions. */
  initialize(): Promise<{ instructions?: string }> {
    this.ready ??= this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'fake-harness', version: '0.0.0' },
    }).then((result) => {
      this.transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
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
    const call = new AbortController();
    return new Promise((resolve, reject) => {
      let settled = false;
      this.transport.request({ jsonrpc: '2.0', id, method, params }, call.signal).then(
        (message) => {
          settled = true;
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        },
        (error: Error) => {
          settled = true;
          reject(error);
        },
      );
      signal?.addEventListener(
        'abort',
        () => {
          if (settled) return;
          settled = true;
          this.transport.notify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'interrupted' } });
          call.abort();
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
 * The servers in Codex's `-c mcp_servers.<name>.<key>=<value>` overrides: a stdio one (`command`, `args`, `env`,
 * `env_vars`) with the env Codex would start it with, or a Streamable HTTP one (`url`, `bearer_token_env_var`,
 * `http_headers`) with the headers it would send.
 */
export function codexMcpServers(overrides: [string, unknown][], harnessEnv: NodeJS.ProcessEnv): Record<string, McpServerConfig> {
  const fields: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of overrides) {
    const match = /^mcp_servers\.([\w-]+)\.(\w+)$/.exec(key);
    if (match !== null) (fields[match[1]!] ??= {})[match[2]!] = value;
  }
  return Object.fromEntries(
    Object.entries(fields).map(([name, { command, args = [], env = {}, env_vars: envVars = [], url, bearer_token_env_var: bearer, http_headers: headers = {} }]) => {
      if (url !== undefined) {
        if (typeof url !== 'string' || (bearer !== undefined && typeof bearer !== 'string')) {
          throw new ConfigError(`mcp_servers.${name}: needs a url, and bearer_token_env_var as a string`);
        }
        const token = bearer === undefined ? undefined : harnessEnv[bearer];
        const auth = token ? { Authorization: `Bearer ${token}` } : {};
        return [name, { url, headers: { ...(headers as Record<string, string>), ...auth } }];
      }
      if (typeof command !== 'string' || !Array.isArray(args) || !Array.isArray(envVars)) {
        throw new ConfigError(`mcp_servers.${name}: needs a command, and args and env_vars as arrays`);
      }
      const passed = [...CODEX_MCP_DEFAULT_ENV, ...envVars.map(String)].filter((each) => harnessEnv[each] !== undefined);
      const serverEnv = Object.fromEntries(passed.map((each) => [each, harnessEnv[each]]));
      return [name, { command, args: args.map(String), env: { ...serverEnv, ...(env as Record<string, string>) } }];
    }),
  );
}
