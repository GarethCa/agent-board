// What an agent tile's footer shows, and what folds into its "+N" (the TileCompact mock). Pure, so the rules are
// unit-tested; HybridTile draws it.
import type { Agent, AgentRole, AgentSchedule, LinkedIssue, PullRequest } from '@agent-board/daemon/protocol';
import { modelLabel, roleText } from './AgentSetup';

export type TileBadge =
  /** The model it was started with, when not its harness's default. */
  | { kind: 'model'; model: string }
  /** The role it was started in, when it has one, and a custom role's name. */
  | { kind: 'role'; role: AgentRole; name: string | null }
  | { kind: 'issue'; issue: LinkedIssue }
  /** It says its work is finished (`Agent.workFinishedAt`): it handed off, or set its status done. */
  | { kind: 'finished'; at: string }
  /** A pull request of its own branch, or, `pushed`, of a branch it pushed to: shown, never acted on from it. */
  | { kind: 'pr'; pr: PullRequest; pushed?: true }
  | { kind: 'schedule'; schedule: AgentSchedule }
  | { kind: 'muted' }
  /** Its shell tabs' shells (AU1): one chip, however many. */
  | { kind: 'shells' };

export interface TileFooter {
  /** The badges the footer row shows, on one line. */
  shown: TileBadge[];
  /** The rest, one line each, for the "+N" chip's tooltip. */
  folded: string[];
}

/** Pull requests shown as chips; more fold into the "+N". */
const MAX_PULL_REQUEST_CHIPS = 2;

/**
 * The tile's footer: its model and role (none for the default model and no role, so tiles without look as before), its
 * linked issue, its first pull requests (its own branch's, else those of the branches it pushed to), its schedule, a mute's bell and its shells chip (when it
 * has `shells`) as badges, and the pull requests past those folded into a "+N", so the tile's head keeps its name
 * readable however much there is. A notice is no badge (the TileCompact mock folds it): it says why the agent stopped,
 * so the tile's body shows it.
 */
export function tileFooter(agent: Agent, shells = 0): TileFooter {
  const shown: TileBadge[] = [];
  if (agent.model !== null) shown.push({ kind: 'model', model: agent.model });
  if (agent.role !== null) shown.push({ kind: 'role', role: agent.role, name: agent.roleName });
  if (agent.issue !== null) shown.push({ kind: 'issue', issue: agent.issue });
  if (agent.workFinishedAt !== null) shown.push({ kind: 'finished', at: agent.workFinishedAt });
  const pullRequests = [...agent.pullRequests.map((pr) => ({ kind: 'pr' as const, pr })), ...agent.pushedPullRequests.map((pr) => ({ kind: 'pr' as const, pr, pushed: true as const }))];
  shown.push(...pullRequests.slice(0, MAX_PULL_REQUEST_CHIPS));
  if (agent.schedule !== null) shown.push({ kind: 'schedule', schedule: agent.schedule });
  if (agent.muted) shown.push({ kind: 'muted' });
  if (shells > 0) shown.push({ kind: 'shells' });

  const folded = pullRequests.slice(MAX_PULL_REQUEST_CHIPS).map((badge) => badgeLine(badge, shells));
  return { shown, folded };
}

/** A pull request's checks, in words. */
export function checksLabel(pr: PullRequest): string {
  return pr.checks === 'none' ? 'no checks' : `checks ${pr.checks}`;
}

/**
 * The most lines the footer takes; the badges that don't fit in it fold into the "+N". One, so a badge arriving (a pull
 * request) never takes a second line from the description above it and moves the rows of a fixed-size tile.
 */
export const FOOTER_LINES = 1;

/**
 * The order the footer's badges fold into the "+N" when they don't fit in its line (the mock leaves it open): the
 * shells chip, the schedule, the role before the model, the mute's bell, then pull requests, the later first. The issue
 * never folds: it is what the tile is for, and it is short. Nor does finished: it is what a lead looks for.
 */
const FOLD_ORDER: TileBadge['kind'][] = ['shells', 'schedule', 'role', 'model', 'muted', 'pr'];

/** The indexes in `shown` of the badges that can fold, in the order they do. */
export function foldRanking(shown: TileBadge[]): number[] {
  return shown
    .map((badge, index) => ({ index, rank: FOLD_ORDER.indexOf(badge.kind) }))
    .filter(({ rank }) => rank >= 0)
    .sort((a, b) => a.rank - b.rank || b.index - a.index)
    .map(({ index }) => index);
}

/** What a badge says, in a line, for the "+N" chip's tooltip once it has folded into it. */
export function badgeLine(badge: TileBadge, shells: number): string {
  switch (badge.kind) {
    case 'model':
      return `Model: ${modelLabel(badge.model)}`;
    case 'role':
      return `Role: ${roleText(badge.role, badge.name)}`;
    case 'issue':
      return `${badge.issue.id} ${badge.issue.title}`;
    case 'finished':
      return 'Says its work is finished';
    case 'pr':
      return `${badge.pushed ? 'Pushed to ' : ''}#${badge.pr.number} ${badge.pr.title}: ${badge.pr.state}, ${checksLabel(badge.pr)}`;
    case 'schedule':
      return `Schedule: ${badge.schedule.cron}`;
    case 'muted':
      return 'Notifications muted';
    case 'shells':
      return `${shells} ${shells === 1 ? 'shell' : 'shells'}`;
  }
}

/** One child of the footer, as measured: a badge that can fold, the "+N" chip, or something that stays. */
export type FooterItem = { kind: 'badge'; width: number; rank: number } | { kind: 'plus'; width: number } | { kind: 'fixed'; width: number };

/** How many lines `items` take in a row `available` wide, wrapping like the footer's flex row; one wider than it shrinks to it. */
function linesTaken(items: FooterItem[], available: number, gap: number): number {
  let lines = 1;
  let used = 0;
  for (const { width } of items) {
    const each = Math.min(width, available);
    if (used > 0 && used + gap + each > available) {
      lines += 1;
      used = each;
    } else used += (used > 0 ? gap : 0) + each;
  }
  return lines;
}

/**
 * How many of the footer's badges fold into the "+N" to keep it to `maxLines`: the lowest `rank`s go first, and the "+N"
 * takes its place once anything has (`plusShown` when pull requests past the second are already in it). `items` are in
 * the order the footer draws them. When even the fixed ones need more lines, every badge folds.
 */
export function foldCount({ items, available, gap, maxLines, plusShown }: { items: FooterItem[]; available: number; gap: number; maxLines: number; plusShown: boolean }): number {
  const badges = items.filter((item): item is Extract<FooterItem, { kind: 'badge' }> => item.kind === 'badge').sort((a, b) => a.rank - b.rank);
  for (let folded = 0; folded < badges.length; folded++) {
    const gone = new Set<FooterItem>(badges.slice(0, folded));
    const kept = items.filter((item) => !gone.has(item) && (item.kind !== 'plus' || folded > 0 || plusShown));
    if (linesTaken(kept, available, gap) <= maxLines) return folded;
  }
  return badges.length;
}
