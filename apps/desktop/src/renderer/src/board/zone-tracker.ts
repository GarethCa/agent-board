import type { TrackerProvider, Zone } from '@agent-board/daemon/protocol';

/**
 * The tracker to save for a zone whose dialog says `provider` and `scope`. A zone's project is kept while the scope is
 * the one it has, however it is cased: the daemon spells a team's key or a repo's name its own way, so "jar" is the
 * team "ACME".
 */
export function trackerToSave(current: Zone['tracker'], provider: TrackerProvider, scope: string): NonNullable<Zone['tracker']> {
  const next = scope.trim();
  const same = current !== null && current.provider === provider && current.scope.toLowerCase() === next.toLowerCase();
  return { provider, scope: next, ...(same && current.project !== undefined ? { project: current.project } : {}) };
}
