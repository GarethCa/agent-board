import type { AgentState, Subagent } from '@agent-board/daemon/protocol';
import type { CharacterPose } from './Character';

/** Most characters a tile's top edge holds; past that the tile shows an overflow count. */
export const MAX_PERCHED = 5;

/**
 * Leaving subagents a full tile still shows past `MAX_PERCHED`, so it shows them go. They are gone within `LEAVE_MS`,
 * so the crowding is brief.
 */
export const MAX_LEAVING_PAST_CAP = 2;

/** How long a finished subagent takes to drop its result and fade. */
export const LEAVE_MS = 1600;

/** Live states that need the user, so their characters keep a place on a crowded tile. */
const NEEDS_YOU: ReadonlySet<AgentState> = new Set(['needs-permission', 'waiting']);

export interface Perch {
  /** The subagents to draw, in the order they started. */
  perched: Subagent[];
  /** Live subagents with no place. */
  overflow: number;
  /** When the next leaving subagent is gone, if any is leaving. */
  nextChangeInMs?: number;
}

/**
 * Which of an agent's subagents its tile draws at `now`: up to `MAX_PERCHED` live ones, the ones that need the user
 * first, and those that finished less than `LEAVE_MS` ago in any places left (at least `MAX_LEAVING_PAST_CAP`).
 */
export function perch(subagents: readonly Subagent[], now: number): Perch {
  const live = subagents.filter((subagent) => subagent.endedAt === null);
  const liveShown = [
    ...live.filter((subagent) => NEEDS_YOU.has(subagent.state)),
    ...live.filter((subagent) => !NEEDS_YOU.has(subagent.state)),
  ].slice(0, MAX_PERCHED);
  const leftFor = (subagent: Subagent) => LEAVE_MS - (now - Date.parse(subagent.endedAt!));
  const leaving = subagents.filter((subagent) => subagent.endedAt !== null && leftFor(subagent) > 0);
  const leavingShown = leaving.slice(0, Math.max(MAX_PERCHED - liveShown.length, MAX_LEAVING_PAST_CAP));
  const shown = new Set([...liveShown, ...leavingShown]);
  const nextChangeInMs = leaving.length > 0 ? Math.min(...leaving.map(leftFor)) : undefined;
  return {
    // In the order they started, so characters keep their places as they change state, finishing included.
    perched: subagents.filter((subagent) => shown.has(subagent)),
    overflow: live.length - liveShown.length,
    ...(nextChangeInMs !== undefined && { nextChangeInMs }),
  };
}

/** How a subagent's character stands: its state, or handing off its result as it leaves with one. */
export function poseOf(subagent: Subagent): CharacterPose {
  return subagent.endedAt !== null && subagent.state === 'done' && subagent.result !== null ? 'handing-off' : subagent.state;
}
