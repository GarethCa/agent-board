// The Codex hook → agent state mapping (ADR-0004). Pure, so every event's effect is unit-tested against the captured
// fixtures. Codex has no idle-prompt notification, so a Codex agent never enters `waiting`.
import type { SessionState } from './protocol.ts';

/** The state an agent in `current` moves to on a Codex hook call. Events with no say in the state leave it alone. */
export function codexStateAfterHook(current: SessionState, payload: Record<string, unknown>): SessionState {
  switch (payload.hook_event_name) {
    case 'SessionStart':
    case 'PreToolUse':
    case 'PreCompact':
      return 'running';
    // Between a prompt or a tool result and the next tool call: a cosmetic guess, allowed to be wrong.
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return 'thinking';
    case 'PermissionRequest':
      return 'needs-permission';
    // An interrupted turn gets no Stop.
    case 'Stop':
    case 'Interrupt':
      return 'idle';
    // `/compact` gets no Stop either; an automatic compaction happens mid-turn, which carries on.
    case 'PostCompact':
      return payload.trigger === 'manual' ? 'idle' : current;
    case 'SessionEnd':
      return 'done';
    // SubagentStart/SubagentStop draw characters on the tile; they don't change the agent's own state.
    default:
      return current;
  }
}
