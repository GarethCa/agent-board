// What a reviewer started from a zone's New agent dialog reviews: another agent's branch, in that agent's repo.
import type { Agent, SpawnAgentParams, Zone } from '@agent-board/daemon/protocol';

/** The agents whose branches it can review: in the zone, or of its repo, with a branch, newest first. */
export function reviewable(zone: Zone, agents: readonly Agent[]): Agent[] {
  return agents.filter((agent) => agent.branch !== '' && (agent.zoneId === zone.id || agent.repoRoot === zone.repoRoot)).reverse();
}

/**
 * The spawn's branch to review and repo, for `reviewed`: its branch, checked out of its own repo, which a zone may not
 * share (an agent dragged in keeps its repo). Its zone's own repo needs no naming. With none picked, the zone's repo's
 * checked-out branch.
 */
export function reviewSpawn(zone: Zone, reviewed: Agent | undefined): Pick<SpawnAgentParams, 'baseBranch' | 'repo'> {
  if (reviewed === undefined) return {};
  return reviewed.repoRoot === zone.repoRoot ? { baseBranch: reviewed.branch } : { baseBranch: reviewed.branch, repo: { path: reviewed.repoRoot } };
}
