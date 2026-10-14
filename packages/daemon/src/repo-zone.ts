// Which zone speaks for an agent's repo: an agent's tile can sit anywhere, so the zone it sits in may not be
// of its repo at all. Imported by the app too, so it uses nothing of Node's.

/** What `repoZoneOf` needs of a zone. */
export interface RepoZoneCandidate {
  id: string;
  /** Null for an unbound zone. */
  repoRoot: string | null;
  hasTracker: boolean;
  /** When it was made: zones are tried oldest first, ties by id, so every caller picks the same one. */
  createdAt: string;
}

/**
 * The zone whose tracker an agent's issues come from and whose settings it starts with: the zone it sits in when that
 * is of its repo, else the oldest zone of its repo with a tracker, else the group with a tracker it sits in (a group's issues are any repo's), else the oldest zone of its repo. Undefined when none of those is on the board.
 */
export function repoZoneOf<Zone extends RepoZoneCandidate>(
  agent: { zoneId: string | null; repoRoot: string },
  zones: readonly Zone[],
): Zone | undefined {
  const own = zones
    .filter((zone) => zone.repoRoot === agent.repoRoot)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const group = zones.find((zone) => zone.id === agent.zoneId && zone.repoRoot === null && zone.hasTracker);
  return own.find((zone) => zone.id === agent.zoneId) ?? own.find((zone) => zone.hasTracker) ?? group ?? own[0];
}

/** The absolute path of `folder` (`/`-separated) in `repoRoot`: the root itself for ''. */
export function folderPath(repoRoot: string, folder: string): string {
  return folder === '' ? repoRoot : `${repoRoot}/${folder}`;
}
