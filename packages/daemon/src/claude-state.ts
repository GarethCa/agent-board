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
  'PreCompact',
  'PostCompact',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;

/** The state an agent in `current` moves to on a Claude hook call. Events with no say in the state leave it alone. */
export function claudeStateAfterHook(current: SessionState, payload: Record<string, unknown>): SessionState {
  switch (payload.hook_event_name) {
    // A compaction (idle or mid-turn) or `/clear` restarts the session where it stands: no turn starts, and between
    // turns none ends, so no `Stop` would ever take it off `running`.
    case 'SessionStart':
      return payload.source === 'compact' || payload.source === 'clear' ? current : 'running';
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
        // Word of another session it tracks (`agent_needs_input`) doesn't lift it either.
        case 'idle_prompt':
        case 'agent_needs_input':
          return current === 'rate-limited' ? current : 'waiting';
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
 * Claude 2.1.312's own dialogs that fire `agent_needs_input` as they open, by that notification's text: menus over its
 * prompt, where typed keys and Enter would pick a row. Read from its binary, not seen firing. Its other
 * `agent_needs_input`s ask for itself mid-turn, or tell of another session it tracks (`<label> needs your input`).
 */
const OWN_DIALOGS: ReadonlySet<unknown> = new Set(['Teammate setup needs your input', 'Auto mode has a classifier billing notice to acknowledge']);

/** Whether `payload` is Claude telling of a dialog of its own it opened (`OWN_DIALOGS`). */
export function isOwnDialog(payload: Record<string, unknown>): boolean {
  return payload.hook_event_name === 'Notification' && payload.notification_type === 'agent_needs_input' && OWN_DIALOGS.has(payload.message);
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
 * Since when the agent has been compacting its conversation, after a hook call: from its own `PreCompact` until
 * `PostCompact`, or its turn or session ending, or a new prompt. A subagent's hooks leave it alone. Codex fires the same
 * two hooks, so it serves both harnesses; `now` is the hook's arrival.
 */
export function compactingAfterHook(current: string | null, payload: Record<string, unknown>, now: string): string | null {
  if (payload.agent_id !== undefined) return current;
  switch (payload.hook_event_name) {
    case 'PreCompact':
      return current ?? now;
    case 'PostCompact':
    case 'UserPromptSubmit':
    case 'Stop':
    case 'StopFailure':
    case 'Interrupt':
    case 'SessionEnd':
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
