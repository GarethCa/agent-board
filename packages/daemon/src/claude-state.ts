// The Claude Code hook → agent state mapping (ADR-0004). Pure, so every event's effect is unit-tested.
import type { SessionState } from './protocol.ts';

/** The Claude Code hook events the daemon listens to (ADR-0004). */
export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;

/** The state an agent in `current` moves to on a Claude hook call. Events with no say in the state leave it alone. */
export function claudeStateAfterHook(current: SessionState, payload: Record<string, unknown>): SessionState {
  switch (payload.hook_event_name) {
    case 'SessionStart':
    case 'PreToolUse':
      return 'running';
    // Between a prompt or a tool result and the next tool call: a cosmetic guess, allowed to be wrong.
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return 'thinking';
    case 'PermissionRequest':
      return 'needs-permission';
    case 'Notification':
      switch (payload.notification_type) {
        case 'permission_prompt':
          return 'needs-permission';
        // Its usage limit still stops it: Claude shows its rate-limit menu, or `continue` at its prompt, until a turn.
        case 'idle_prompt':
          return current === 'rate-limited' ? current : 'waiting';
        case 'agent_needs_input':
          return 'waiting';
        default:
          return current;
      }
    case 'Stop':
      return 'idle';
    case 'StopFailure':
      return payload.error === 'rate_limit' ? 'rate-limited' : 'failed';
    case 'SessionEnd':
      return 'done';
    // SubagentStart/SubagentStop draw characters on the tile; they don't change the agent's own state.
    default:
      return current;
  }
}

/**
 * What the agent last said to the user, after a hook call: its own turn's final message (`Stop`), or a mid-turn
 * request for input (Claude's `agent_needs_input`). A new prompt forgets it, so it never stands for a later question.
 * Subagents' hooks and the generic `idle_prompt` text leave it alone. Codex's `Stop` and `UserPromptSubmit` carry
 * the same fields, so it serves both harnesses.
 */
export function lastMessageAfterHook(current: string | null, payload: Record<string, unknown>): string | null {
  if (payload.agent_id !== undefined) return current;
  switch (payload.hook_event_name) {
    case 'Stop':
      return typeof payload.last_assistant_message === 'string' ? payload.last_assistant_message : current;
    case 'Notification':
      return payload.notification_type === 'agent_needs_input' && typeof payload.message === 'string' ? payload.message : current;
    case 'UserPromptSubmit':
      return null;
    default:
      return current;
  }
}

/**
 * The state of an agent whose process has exited: `done` if it ended the session itself or exited cleanly, `failed`
 * if it crashed or was killed (`exitCode` null).
 */
export function stateAfterExit(current: SessionState, exitCode: number | null): SessionState {
  return current === 'done' || exitCode === 0 ? 'done' : 'failed';
}
