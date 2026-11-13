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

/** What `issueZoneOf` needs of a zone. */
export interface IssueZoneCandidate {
  id: string;
  name: string;
  /** Its repo: a bound zone's, else a group's default repo; null for neither. */
  repoRoot: string | null;
  tracker: { provider: string; scope: string; project: string | null } | null;
  /** When it was made: the oldest is taken of several alike. */
  createdAt: string;
}

/** The team or repo an issue id names: `OPS` of `OPS-12`, `acme/app` of `acme/app#34`; none for `#34`. */
function issueIdScope(issueId: string): string | undefined {
  return (/^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(issueId) ?? /^([^\s#/]+\/[^\s#/]+)#\d+$/.exec(issueId))?.[1];
}

/** Whether `path` is `root` or a folder in it, both absolute and `/`-separated. */
const isWithin = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/**
 * The zone whose tracker a new agent's issue is read from (a zone is only a group, so an agent may start one
 * from an issue in a zone with no tracker, or in a repo no zone is bound to): its own zone if that has a tracker, unless
 * the issue's id names another zone's team or repo; else, of the zones with a tracker, those whose team or repo the
 * issue's id names (all of them if none does), the zone of the
 * agent that starts it, then a zone of its repo (`repo`, the folder it works in), then the oldest when they all share
 * one tracker. Else why it can't tell.
 */
export function issueZoneOf<Zone extends IssueZoneCandidate>(
  start: { issueId: string; zoneId: string | null; spawnerZoneId: string | null; repo: string | null },
  zones: readonly Zone[],
): Zone | string {
  const tracked = zones
    .filter((zone) => zone.tracker !== null)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  if (tracked.length === 0) return `no zone on the board has a tracker to read ${start.issueId} from: add one to a zone, or start the agent without an issue`;
  const scope = issueIdScope(start.issueId)?.toLowerCase();
  const named = tracked.filter((zone) => zone.tracker!.scope.toLowerCase() === scope);
  const own = tracked.find((zone) => zone.id === start.zoneId);
  if (own !== undefined && (named.length === 0 || named.includes(own))) return own;
  const candidates = named.length > 0 ? named : tracked;
  const trackers = new Set(candidates.map(({ tracker }) => `${tracker!.provider}\n${tracker!.scope}\n${tracker!.project ?? ''}`));
  const found =
    candidates.find((zone) => zone.id === start.spawnerZoneId) ??
    candidates.find((zone) => start.repo !== null && zone.repoRoot !== null && isWithin(start.repo, zone.repoRoot)) ??
    (trackers.size === 1 ? candidates[0] : undefined);
  if (found !== undefined) return found;
  const names = candidates.map((zone) => zone.name);
  return `${start.issueId} could be in the tracker of ${[names.slice(0, -1).join(', '), names.at(-1)].join(' or ')}: start the agent in the zone whose tracker has it`;
}
