// Permission prompts the needs-you inbox can answer, by holding the harness's PermissionRequest hook open (ADR-0004).
// Harness-agnostic: Claude and Codex both read `hookSpecificOutput.decision.behavior` from the hook's reply.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SessionState, PermissionDecision, PermissionPrompt } from './protocol.ts';

/** What a hook call is answered with: a JSON body, or nothing. */
export type HookReply = Record<string, unknown> | undefined;

/**
 * How long a PermissionRequest hook is held for an inbox answer before the harness's own prompt takes over. Short
 * until it is known whether Claude's terminal can answer while the hook is held (ADR-0004).
 */
export const DEFAULT_PERMISSION_HOLD_MS = 20_000;

/**
 * Hooks after which the asker can't still be waiting on an earlier permission: its turn ended (Codex's `Interrupt`
 * ends one with no `Stop`), or a new one began.
 */
const TURN_BOUNDARIES = new Set(['Stop', 'StopFailure', 'Interrupt', 'UserPromptSubmit', 'SubagentStop']);

export interface PermissionHoldsOptions {
  holdMs: number;
  /** A session's prompts changed on their own: a hold lapsed, or the harness gave up on its hook. */
  onChange(sessionId: string): void;
}

export interface PermissionHolds {
  /**
   * Holds a PermissionRequest hook open as a new prompt of the session's. Resolves with the hook's reply: the user's
   * decision, or nothing (so the harness asks in its terminal) once the hold lapses, `signal` aborts, or the request
   * is settled elsewhere.
   */
  hold(sessionId: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<HookReply>;
  /** The session's prompts, held or kept as context, oldest first. */
  prompts(sessionId: string): PermissionPrompt[];
  /** Answers the session's prompt `requestId` while it is held. Returns false if it is not (any more). */
  decide(sessionId: string, requestId: string, decision: PermissionDecision): boolean;
  /**
   * Notes another hook of the session's, and settles the prompts it shows were answered elsewhere (in the terminal).
   * Only a hook from the agent or subagent that asked can settle its prompt: the call itself running (a
   * `PostToolUse` of the same tool and input), or the asker's turn ending or a new one starting. Calls running
   * beside it settle nothing. Returns whether any prompt went.
   */
  afterHook(sessionId: string, payload: Record<string, unknown>): boolean;
  /** Forgets the session's prompts, releasing their hooks with no decision. */
  drop(sessionId: string): void;
  /** Releases every held hook and stops telling anyone about changes. */
  close(): void;
}

interface Held {
  prompt: PermissionPrompt;
  /** Answers the hook; gone once it has been answered. */
  reply: ((reply: HookReply) => void) | undefined;
}

/** States that outrank a pending permission: the agent has ended, failed or hit a rate limit. */
const OVER_PERMISSIONS = new Set<SessionState>(['done', 'failed', 'rate-limited']);

/**
 * An agent's state given its permission prompts: `needs-permission` while any is `pending`, even if a subagent's or
 * a parallel call's hook says it runs. Once a hook has `settled` its last one, an agent its hooks left at
 * `needs-permission` carries on `running`.
 */
export function stateWithPrompts(state: SessionState, prompts: { pending: number; settled: boolean }): SessionState {
  if (prompts.pending > 0) return OVER_PERMISSIONS.has(state) ? state : 'needs-permission';
  return prompts.settled && state === 'needs-permission' ? 'running' : state;
}

/** The PermissionRequest hook reply that carries `decision`. */
export function permissionReply(decision: PermissionDecision): Record<string, unknown> {
  const { behavior, message } = decision;
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: behavior === 'deny' && message !== undefined ? { behavior, message } : { behavior },
    },
  };
}

export function createPermissionHolds(options: PermissionHoldsOptions): PermissionHolds {
  /** Per session, its prompts oldest first. */
  const sessions = new Map<string, Held[]>();
  let closed = false;

  /** Answers the held hook, once; the prompt stays until the caller removes it. */
  const answer = (entry: Held, reply: HookReply) => {
    const send = entry.reply;
    entry.reply = undefined;
    entry.prompt = { ...entry.prompt, heldUntil: null };
    send?.(reply);
  };

  /** Releases and removes the session's prompts that `which` picks; returns whether any went. */
  const settle = (sessionId: string, which: (entry: Held) => boolean): boolean => {
    const entries = sessions.get(sessionId) ?? [];
    const settled = entries.filter(which);
    for (const entry of settled) answer(entry, undefined);
    const kept = entries.filter((entry) => !settled.includes(entry));
    if (kept.length === 0) sessions.delete(sessionId);
    else sessions.set(sessionId, kept);
    return settled.length > 0;
  };

  return {
    hold(sessionId, payload, signal) {
      return new Promise<HookReply>((resolve) => {
        const now = Date.now();
        const subagent = subagentOf(payload);
        const entry: Held = {
          prompt: {
            id: randomUUID(),
            toolName: typeof payload.tool_name === 'string' ? payload.tool_name : 'tool',
            toolInput: payload.tool_input ?? null,
            subagent:
              subagent === null
                ? null
                : { id: subagent, type: typeof payload.agent_type === 'string' ? payload.agent_type : 'agent' },
            requestedAt: new Date(now).toISOString(),
            heldUntil: new Date(now + options.holdMs).toISOString(),
          },
          reply: (reply) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', lapse);
            resolve(reply);
          },
        };
        // The hold lapsing and the harness hanging up both leave the terminal to ask.
        const lapse = () => {
          if (entry.reply === undefined) return;
          answer(entry, undefined);
          if (!closed) options.onChange(sessionId);
        };
        const timer = setTimeout(lapse, options.holdMs);
        sessions.set(sessionId, [...(sessions.get(sessionId) ?? []), entry]);
        if (signal.aborted) lapse();
        else signal.addEventListener('abort', lapse, { once: true });
      });
    },

    prompts: (sessionId) => (sessions.get(sessionId) ?? []).map((entry) => entry.prompt),

    decide(sessionId, requestId, decision) {
      const entry = sessions.get(sessionId)?.find((held) => held.prompt.id === requestId);
      if (entry?.reply === undefined) return false;
      answer(entry, permissionReply(decision));
      settle(sessionId, (held) => held === entry);
      return true;
    },

    afterHook(sessionId, payload) {
      const event = payload.hook_event_name;
      const from = subagentOf(payload);
      return settle(sessionId, ({ prompt }) => {
        if ((prompt.subagent?.id ?? null) !== from) return false;
        if (typeof event === 'string' && TURN_BOUNDARIES.has(event)) return true;
        return (
          event === 'PostToolUse' && payload.tool_name === prompt.toolName && isDeepStrictEqual(payload.tool_input, prompt.toolInput)
        );
      });
    },

    drop: (sessionId) => void settle(sessionId, () => true),

    close() {
      closed = true;
      for (const sessionId of [...sessions.keys()]) settle(sessionId, () => true);
    },
  };
}

/** The subagent a hook fired inside, or null for the agent itself. */
function subagentOf(payload: Record<string, unknown>): string | null {
  return typeof payload.agent_id === 'string' ? payload.agent_id : null;
}
