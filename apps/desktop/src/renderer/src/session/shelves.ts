// What an agent's shelves hold: which shelves have a tab, what each tab says, what the
// page's "From the board" adds, and the board's Now until the agent writes a page. The rows of each shelf are the
// sidebar's records (sidebar-records.ts). Pure, so it is unit-tested; AgentShelves.tsx draws it.
import type { Agent, GateRun, NeedsYouShows, PageIcon, PlanSummary, SessionState } from '@agent-board/daemon/protocol';
import { gateBadge } from '@agent-board/daemon/gate-rules';
import { HUMAN_STATUS_BY_STATE, humanStatus, type HumanStatus } from '@agent-board/daemon/human-status';
import { insideWorktree } from './live-folder';
import { crewSection, docSection, documentSection, pullRequestSection, subagentSection, type Fading, type SidebarRow } from './sidebar-records';

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

/** Rows that count: a guess, or a record not just deleted. */
const live = (rows: readonly SidebarRow<unknown>[]) => rows.filter((row) => row.source === 'guessed' || row.gone !== true).length;

/** How many things Made holds: its pull requests, what it showed you (documents and the plan) and its hand-off docs. */
export function madeCount(agent: Agent, fading?: Fading): number {
  return live(pullRequestSection(agent, fading).rows) + documentSection(agent).length + live(docSection(agent, fading).rows);
}

/** Whether Made has anything to show, a record the user deleted included: its "N hidden · Show" is there. */
function madeHolds(agent: Agent, fading?: Fading): boolean {
  const pulls = pullRequestSection(agent, fading);
  const docs = docSection(agent, fading);
  return pulls.rows.length + pulls.hidden.length + documentSection(agent).length + docs.rows.length + docs.hidden.length > 0;
}

/** Whether Crew has anything to show: an agent it started (or one deleted from it), or a subagent. */
function crewHolds(agent: Agent, agents: readonly Agent[], fading?: Fading): boolean {
  const crew = crewSection(agent, agents, fading);
  return crew.rows.length + crew.hidden.length + subagentSection(agent).rows.length > 0;
}

/** How many Crew holds: the agents it started and its subagents. */
function crewCount(agent: Agent, agents: readonly Agent[], fading?: Fading): number {
  return live(crewSection(agent, agents, fading).rows) + subagentSection(agent).rows.length;
}

/**
 * A crew member's status, as its own window and tile say it: an ended one too may have failed, be paused, or need the
 * user (a restart stopped it, or its changes wait for review).
 */
export const crewStatus = (member: Parameters<typeof humanStatus>[0], shows: NeedsYouShows): HumanStatus => humanStatus(member, shows).status;

/** The agents it started that need you now, as their rows say: Crew's dot and From the board name these. */
export function crewNeedingYou(agent: Agent, agents: readonly Agent[], shows: NeedsYouShows): Agent[] {
  const byId = new Map(agents.map((each) => [each.sessionId, each]));
  return crewSection(agent, agents)
    .rows.map((row) => byId.get(row.item.sessionId))
    .filter((member): member is Agent => member !== undefined && crewStatus(member, shows) === 'needs-you');
}

/** What the folder's row says under its path: that it is live, and when it has left its worktree. */
export const folderMeta = (folder: string, worktree: string): string => (insideWorktree(folder, worktree) ? 'folder (live)' : 'outside its worktree · live');

/** What the clock's row says under its words: when it next runs, or that it is paused. */
export const clockMeta = (label: string): string => (label === 'paused' ? 'its clock · paused' : `its clock · next ${label}`);

/** A pull request of its, still open, whose checks are pending or failing. */
export interface PullRequestToWatch {
  url: string;
  number: number;
  title: string | null;
  checks: 'pending' | 'failing';
}

/** Its open pull requests whose checks are failing or pending, failing first. */
export function pullRequestsToWatch(agent: Agent, fading?: Fading): PullRequestToWatch[] {
  const watched: PullRequestToWatch[] = [];
  for (const row of pullRequestSection(agent, fading).rows) {
    if (row.source === 'recorded' && row.gone === true) continue;
    const { pr } = row.item;
    if (pr === undefined || (pr.state !== 'open' && pr.state !== 'draft') || (pr.checks !== 'pending' && pr.checks !== 'failing')) continue;
    watched.push({ url: row.item.url, number: row.item.number, title: row.item.title, checks: pr.checks });
  }
  return watched.sort((a, b) => Number(b.checks === 'failing') - Number(a.checks === 'failing'));
}

/**
 * The shelves that have a tab, in order: the page always, Made and Crew once they hold something, and Setup while it has
 * something to say: its technical rows, or its linked issue or its schedule, which are no technical detail.
 */
export function shelfTabs(agent: Agent, agents: readonly Agent[], shows: NeedsYouShows, { technical, fading }: { technical: boolean; fading?: Fading }): ShelfTab[] {
  const tabs: ShelfTab[] = [agent.page === null ? { id: 'page', label: 'Now' } : { id: 'page', label: agent.page.name, icon: agent.page.icon }];
  if (madeHolds(agent, fading)) tabs.push({ id: 'made', label: 'Made', count: madeCount(agent, fading) });
  if (crewHolds(agent, agents, fading)) tabs.push({ id: 'crew', label: 'Crew', count: crewCount(agent, agents, fading), ...(crewNeedingYou(agent, agents, shows).length > 0 ? { needsYou: true } : {}) });
  if (technical || agent.issue !== null || agent.schedule !== null) tabs.push({ id: 'setup', label: 'Setup' });
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

/** A gate run in words: "gate passed", "gate failed · lint", or how far it is, the same whatever its icon. */
export function gateWords(run: GateRun): string {
  if (run.status === 'passed') return 'gate passed';
  if (run.status === 'failed') return `gate failed${gateBadge(run).replace(/^✗ gate/, '')}`;
  return gateBadge(run);
}

/** A line's first letter in capitals: what a row's name says of what a fact says in lower case. */
export const sentenceCase = (line: string): string => `${line.charAt(0).toUpperCase()}${line.slice(1)}`;

/** A subagent's state as the status its row says, as a crew member's at its prompt would be read. */
export const subagentStatus = (state: SessionState): HumanStatus => HUMAN_STATUS_BY_STATE[state];

/** A folder as Setup's row says it: every worktree's path starts the same, so the part that differs is what is left. */
export const shortFolder = (folder: string): string => folder.replace(/^.*\/\.agent-board\/worktrees\//, '…/');

/** What the plan's row says under its name: its decision, or when it was shown, and when. */
export function planMeta(plan: Pick<PlanSummary, 'decision' | 'presentedAt'>, when: (at: string) => string): string {
  return plan.decision === null ? `shown ${when(plan.presentedAt)}` : `${plan.decision.outcome.replace('-', ' ')} · ${when(plan.decision.decidedAt)}`;
}

/** Who started it, as the page's status line says: "you", "the Captain", the orchestrator's name, or "an agent" not listed. */
export function startedBy(agent: Pick<Agent, 'spawnedBy'>, agents: readonly Pick<Agent, 'sessionId' | 'name' | 'master'>[]): string {
  if (agent.spawnedBy === null) return 'you';
  const by = agents.find((each) => each.sessionId === agent.spawnedBy);
  if (by === undefined) return 'an agent';
  return by.master ? 'the Captain' : by.name;
}

/** The page's status line: what the status word leaves out, if anything, then who started it and when. */
export function statusLine(detail: string | null, by: string, at: string): string {
  return [detail, `started by ${by}, ${at}`].filter(Boolean).join(' · ');
}

/**
 * How far along it is, for the page icon's ring on the rail: its page's first heading with a progress bar, else its
 * status line's; null for none.
 */
export function pageProgress(agent: Pick<Agent, 'page' | 'status'>): number | null {
  for (const block of agent.page?.blocks ?? []) if (block.kind === 'heading' && block.progress !== null) return block.progress;
  return agent.status?.progress ?? null;
}

/** Below this width the tabs show only their icons, their names in tooltips. */
export const ICON_TABS_BELOW = 240;
