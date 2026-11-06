// What an agent's shelves hold: which shelves have a tab, what each tab says, what the
// page's "From the board" adds, and the board's Now until the agent writes a page. The rows of each shelf are the
// sidebar's records (sidebar-records.ts). Pure, so it is unit-tested; AgentShelves.tsx draws it.
import type { Agent, NeedsYouShows, PageIcon } from '@agent-board/daemon/protocol';
import { humanStatus } from '@agent-board/daemon/human-status';
import { crewSection, docSection, documentSection, pinSection, pullRequestSection, subagentSection, type SidebarRow } from './sidebar-records';

/** The shelves, in their tabs' order: the agent's page, what it made, its crew, and its setup. */
export const SHELVES = ['page', 'made', 'crew', 'setup'] as const;
export type ShelfId = (typeof SHELVES)[number];

/** A shelf's tab: its name, and what it says beside it. */
export interface ShelfTab {
  id: ShelfId;
  label: string;
  /** The page's tab only: the icon the agent picked, or none for the board's Now (its pulse icon). */
  icon?: PageIcon;
  /** How many rows it holds, beside its name: Made's and, on the rail, Crew's. */
  count?: number;
  /** Crew: one of its agents needs you (an orange dot). */
  needsYou?: boolean;
}

/** How many rows a section shows: deleted records are hidden. */
const live = (rows: readonly SidebarRow<unknown>[]) => rows.length;

/**
 * How many things Made holds: its pull requests, what it showed you (documents and the plan), its hand-off docs and,
 * until they move onto its page, its pins.
 */
export function madeCount(agent: Agent): number {
  return live(pullRequestSection(agent).rows) + documentSection(agent).length + live(docSection(agent).rows) + live(pinSection(agent).rows);
}

/** How many Crew holds: the agents it started and its subagents. */
function crewCount(agent: Agent, agents: readonly Agent[]): number {
  return live(crewSection(agent, agents).rows) + subagentSection(agent).rows.length;
}

/** The agents it started that need you now. */
export function crewNeedingYou(agent: Agent, agents: readonly Agent[], shows: NeedsYouShows): Agent[] {
  const byId = new Map(agents.map((each) => [each.sessionId, each]));
  return crewSection(agent, agents)
    .rows.map((row) => byId.get(row.item.sessionId))
    .filter((member): member is Agent => member !== undefined && member.endedAt === null && humanStatus(member, shows).status === 'needs-you');
}

/** A pull request of its, still open, whose checks are pending or failing. */
export interface PullRequestToWatch {
  url: string;
  number: number;
  title: string | null;
  checks: 'pending' | 'failing';
}

/** Its open pull requests whose checks are failing or pending, failing first. */
export function pullRequestsToWatch(agent: Agent): PullRequestToWatch[] {
  const watched: PullRequestToWatch[] = [];
  for (const row of pullRequestSection(agent).rows) {
    const { pr } = row.item;
    if (pr === undefined || (pr.state !== 'open' && pr.state !== 'draft') || (pr.checks !== 'pending' && pr.checks !== 'failing')) continue;
    watched.push({ url: row.item.url, number: row.item.number, title: row.item.title, checks: pr.checks });
  }
  return watched.sort((a, b) => Number(b.checks === 'failing') - Number(a.checks === 'failing'));
}

/**
 * The shelves that have a tab, in order: the page always, Made and Crew once they hold something, and Setup while the
 * window gives it something to hold.
 */
export function shelfTabs(agent: Agent, agents: readonly Agent[], shows: NeedsYouShows, { setup }: { setup: boolean }): ShelfTab[] {
  const tabs: ShelfTab[] = [agent.page === null ? { id: 'page', label: 'Now' } : { id: 'page', label: agent.page.name, icon: agent.page.icon }];
  const made = madeCount(agent);
  if (made > 0) tabs.push({ id: 'made', label: 'Made', count: made });
  const crew = crewCount(agent, agents);
  if (crew > 0) tabs.push({ id: 'crew', label: 'Crew', count: crew, ...(crewNeedingYou(agent, agents, shows).length > 0 ? { needsYou: true } : {}) });
  if (setup) tabs.push({ id: 'setup', label: 'Setup' });
  return tabs;
}

/** The shelf to show: the one asked for while it has a tab, else the page (as a window always opens on). */
export function shelfShown(asked: ShelfId, tabs: readonly ShelfTab[]): ShelfId {
  return tabs.some((tab) => tab.id === asked) ? asked : 'page';
}

/**
 * The board's Now, the page's place until the agent writes one: what it is doing (its status line, with its progress)
 * or else its last message, and its linked issue.
 */
export type NowCard =
  | { kind: 'status'; summary: string; progress: number | null }
  | { kind: 'message'; text: string }
  | { kind: 'none' };

export function nowCard(agent: Pick<Agent, 'status' | 'lastMessage'>): NowCard {
  if (agent.status !== null) return { kind: 'status', summary: agent.status.summary, progress: agent.status.progress };
  if (agent.lastMessage) return { kind: 'message', text: agent.lastMessage };
  return { kind: 'none' };
}

/** Below this width the tabs show only their icons, their names in tooltips. */
export const ICON_TABS_BELOW = 240;
