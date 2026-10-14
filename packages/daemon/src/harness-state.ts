// The hook → state mapping for either harness (ADR-0004), for agents and external sessions alike.
import { claudeStateAfterHook } from './claude-state.ts';
import { codexStateAfterHook } from './codex-state.ts';
import type { SessionState, Harness } from './protocol.ts';

/** The state a session of `harness` in `current` moves to on one of its hooks. */
export function stateAfterHook(harness: Harness, current: SessionState, payload: Record<string, unknown>): SessionState {
  return harness === 'claude' ? claudeStateAfterHook(current, payload) : codexStateAfterHook(current, payload);
}
