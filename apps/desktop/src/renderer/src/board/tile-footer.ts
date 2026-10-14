// What an agent tile's footer shows, and what folds into its "+N" (the TileCompact mock). Pure, so the rules are
// unit-tested; HybridTile draws it.
import type { Agent, AgentSchedule, LinkedIssue, PullRequest } from '@agent-board/daemon/protocol';

export type TileBadge =
  | { kind: 'issue'; issue: LinkedIssue }
  | { kind: 'pr'; pr: PullRequest }
  | { kind: 'schedule'; schedule: AgentSchedule }
  | { kind: 'muted' };

export interface TileFooter {
  /** The badges the footer row shows, wrapping onto a second line when it must. */
  shown: TileBadge[];
  /** The rest, one line each, for the "+N" chip's tooltip. */
  folded: string[];
}

/** Pull requests shown as chips; more fold into the "+N". */
const MAX_PULL_REQUEST_CHIPS = 2;

/**
 * The tile's footer: its linked issue, its first pull requests, its schedule and a mute's bell as badges, and the pull
 * requests past those folded into a "+N", so the tile's head keeps its name readable however much there is. A notice
 * is no badge (the TileCompact mock folds it): it says why the agent stopped, so the tile's body shows it.
 */
export function tileFooter(agent: Agent): TileFooter {
  const shown: TileBadge[] = [];
  if (agent.issue !== null) shown.push({ kind: 'issue', issue: agent.issue });
  for (const pr of agent.pullRequests.slice(0, MAX_PULL_REQUEST_CHIPS)) shown.push({ kind: 'pr', pr });
  if (agent.schedule !== null) shown.push({ kind: 'schedule', schedule: agent.schedule });
  if (agent.muted) shown.push({ kind: 'muted' });

  const folded = agent.pullRequests.slice(MAX_PULL_REQUEST_CHIPS).map((pr) => `#${pr.number} ${pr.title}: ${pr.state}, ${checksLabel(pr)}`);
  return { shown, folded };
}

/** A pull request's checks, in words. */
export function checksLabel(pr: PullRequest): string {
  return pr.checks === 'none' ? 'no checks' : `checks ${pr.checks}`;
}
