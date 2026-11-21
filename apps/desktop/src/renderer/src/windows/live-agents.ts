import type { Agent } from '@agent-board/daemon/protocol';

/** `agents` with the one `id` changed to `now`, added if it is new, or left out once removed (`null`). */
export function withChange(agents: readonly Agent[], id: string, now: Agent | null): readonly Agent[] {
  const others = agents.filter((each) => each.sessionId !== id);
  if (now === null) return others;
  const at = agents.findIndex((each) => each.sessionId === id);
  return at === -1 ? [...agents, now] : agents.map((each) => (each.sessionId === id ? now : each));
}
