import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HooksConfig } from './hooks.ts';

export type HookEvent = Record<string, unknown> & { hook_event_name: string };

export interface HookRecorder {
  /** URL to point http hooks at. */
  url: string;
  /** Every hook payload received, in arrival order. */
  events: HookEvent[];
  /** Headers of each request, index-aligned with `events`. */
  headers: IncomingHttpHeaders[];
  close(): Promise<void>;
}

/**
 * Returns (or resolves to) the JSON body to answer a hook with (e.g. a PermissionRequest decision), or undefined for
 * an empty 200. A promise holds the hook open until it settles.
 */
export type HookResponder = (event: HookEvent) => unknown;

/** A local HTTP server that records hook calls, standing in for the daemon's hook ingress. */
export async function startHookRecorder(respond: HookResponder = () => undefined): Promise<HookRecorder> {
  const events: HookEvent[] = [];
  const headers: IncomingHttpHeaders[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8').on('data', (chunk: string) => (body += chunk));
    request.on('end', () => {
      let event: HookEvent;
      try {
        event = JSON.parse(body) as HookEvent;
      } catch {
        response.writeHead(400).end('hook body must be JSON');
        return;
      }
      events.push(event);
      headers.push(request.headers);
      void Promise.resolve(respond(event)).then((reply) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(reply === undefined ? '' : JSON.stringify(reply));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hooks`,
    events,
    headers,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Every hook event Claude Code fires that the board cares about. */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Notification',
  'SubagentStart', 'SubagentStop', 'Stop', 'StopFailure', 'SessionEnd',
] as const;

/** Codex's hook events. */
export const CODEX_HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt', 'PreCompact', 'PostCompact',
] as const;

/** A `claude --settings` object that sends every event to `url` as an http hook. */
export function claudeHookSettings(url: string, http: { headers?: Record<string, string>; allowedEnvVars?: string[] } = {}): { hooks: HooksConfig } {
  const hooks: HooksConfig = {};
  for (const event of CLAUDE_HOOK_EVENTS) hooks[event] = [{ hooks: [{ type: 'http', url, timeout: 10, ...http }] }];
  return { hooks };
}

/** A Codex `hooks.json` object that runs `command` for every event. */
export function codexHooksJson(command: string): { hooks: HooksConfig } {
  const hooks: HooksConfig = {};
  for (const event of CODEX_HOOK_EVENTS) hooks[event] = [{ hooks: [{ type: 'command', command, timeout: 10 }] }];
  return { hooks };
}
