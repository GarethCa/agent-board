// The tabs inside a session window: an agent's own tab or a shell tile's own panes first, then its
// shell tabs, each a pane tree that can be split. Pure, so the rules are unit-tested; SessionBody and the agent tile's
// shells chip draw them.
import { paneIds, type PaneLayout } from '@agent-board/daemon/pane-layout';
import { inTabOrder, isOwnedBy, isOwnTab, pullRequestOfUrl, type Agent, type PullRequest, type Shell, type ShellOwner, type WindowOwner } from '@agent-board/daemon/protocol';
import { OWN_SURFACE, surfaceKey, type GateSurface, type PlanSurface, type PullRequestSurface, type Surface, type WebSurface } from '@agent-board/daemon/window-layout';
import { webTabLabel } from '@agent-board/daemon/web-url';
import { paneLabel } from '../board/rename';

/** The id of a window's first tab: the agent's own, whether or not the daemon has a row for it yet, or the shell tile's own panes. */
export const OWN_TAB = OWN_SURFACE;

/**
 * Whose window the tabs are in: an agent's, or a shell tile's, whose own row is its first tab; or a tab window
 * (slice 4), which is no session's, and holds no shell.
 */
export type TabOwner = { kind: 'agent'; agent: Pick<Agent, 'sessionId' | 'harness'> } | { kind: 'shell'; shell: Shell } | { kind: 'tabs'; id: string };

/** The owner of the window as the daemon names it. */
export const windowOwner = (owner: TabOwner): WindowOwner =>
  owner.kind === 'agent' ? { kind: 'agent', id: owner.agent.sessionId } : owner.kind === 'shell' ? { kind: 'shell', id: owner.shell.id } : owner;

/** The owner as the daemon names one of shells: undefined for a tab window, which has none. */
export const shellOwner = (owner: TabOwner): ShellOwner | undefined => {
  const named = windowOwner(owner);
  return named.kind === 'tabs' ? undefined : named;
};

export interface WindowTab {
  /** `OWN_TAB`, or the shell tab's shell id. */
  id: string;
  /** The daemon's row for it: undefined for the agent's own tab until it is first split; the tile itself for a shell tile's first. */
  shell: Shell | undefined;
  layout: PaneLayout;
  label: string;
}

/** What the tab strip calls the agent's own pane: the command it runs. */
export const HARNESS_COMMANDS: Record<Agent['harness'], string> = { claude: 'claude', codex: 'codex' };

/** A shell pane's name: the label the user gave it, else its shell's. */
const shellPaneLabel = (shell: Shell, sessionId: string) => paneLabel(shell, sessionId) ?? shell.name;

/**
 * The window's tabs: first an agent's own (one pane, the agent, until it is split; then named after all its panes) or
 * a shell tile's own panes (named after the tile), then its shell tabs in their order: as they were made, or moved in.
 */
export function windowTabs(owner: TabOwner, shells: readonly Shell[]): WindowTab[] {
  if (owner.kind === 'tabs') return [];
  const named = shellOwner(owner)!;
  const owned = inTabOrder(shells.filter((shell) => isOwnedBy(shell, named)));
  const first = owner.kind === 'agent' ? agentOwnTab(owner.agent, owned.find(isOwnTab)) : { id: OWN_TAB, shell: owner.shell, layout: owner.shell.layout, label: owner.shell.name };
  return [first, ...owned.filter((shell) => shell !== first.shell).map((shell) => ({ id: shell.id, shell, layout: shell.layout, label: shell.name }))];
}

/** The agent's own tab: named after its command, then any shell panes split beside it. */
function agentOwnTab(agent: Pick<Agent, 'sessionId' | 'harness'>, own: Shell | undefined): WindowTab {
  const layout: PaneLayout = own?.layout ?? { type: 'pane', sessionId: agent.sessionId };
  const label = [HARNESS_COMMANDS[agent.harness], ...paneIds(layout).filter((id) => id !== agent.sessionId).map((id) => shellPaneLabel(own!, id))].join(' │ ');
  return { id: OWN_TAB, shell: own, layout, label };
}

/** The agent whose pane sits in the window's first tab, if it is an agent's. */
const agentPaneOf = (owner: TabOwner): string | undefined => (owner.kind === 'agent' ? owner.agent.sessionId : undefined);

/** How a shell is doing, for its dot: running a command, at its prompt (or ended cleanly), or failed: its last command, or the shell itself. */
export type ShellState = 'running' | 'idle' | 'failed';

export interface WindowShell {
  /** The tab it is in. */
  tab: string;
  sessionId: string;
  label: string;
  state: ShellState;
  /** How it ended: an exit code, or null for a signal. Absent while it runs, and for one a restart stopped. */
  exitCode?: number | null;
  /** The exit status of its last command, while it runs and that failed. */
  failedCommand?: number;
  /** The ports its running command listens on, while it has some. */
  ports?: number[];
}

/** Every shell pane in the window's tabs, never an agent's own, in tab order: what an agent tile's shells chip lists. */
export function windowShells(owner: TabOwner, shells: readonly Shell[]): WindowShell[] {
  return windowTabs(owner, shells).flatMap(({ id: tab, shell }) => {
    if (shell === undefined) return [];
    return paneIds(shell.layout)
      .filter((sessionId) => sessionId !== agentPaneOf(owner))
      .map((sessionId): WindowShell => {
        const label = shellPaneLabel(shell, sessionId);
        // A restart stopped it: not a failure, and it can be resumed.
        if (shell.stoppedPanes.includes(sessionId)) return { tab, sessionId, label, state: 'idle' };
        if (shell.endedPanes.includes(sessionId)) {
          const exitCode = shell.exitCodes[sessionId] ?? null;
          return { tab, sessionId, label, state: exitCode === 0 ? 'idle' : 'failed', exitCode };
        }
        if (shell.busyPanes.includes(sessionId)) {
          const ports = shell.panePorts[sessionId];
          return { tab, sessionId, label, state: 'running', ...(ports === undefined ? {} : { ports }) };
        }
        const failedCommand = shell.failedCommands[sessionId];
        return failedCommand === undefined ? { tab, sessionId, label, state: 'idle' } : { tab, sessionId, label, state: 'failed', failedCommand };
      });
  });
}

/** Which of several shells' states a dot shows: a failure first, then one running; undefined for none. */
export function worstState(states: readonly ShellState[]): ShellState | undefined {
  return (['failed', 'running', 'idle'] as const).find((state) => states.includes(state));
}

/** How many of the shells in the window's tabs are still running: what deleting the agent or shell tile ends with it. */
export function liveShellCount(owner: TabOwner, shells: readonly Shell[]): number {
  return windowTabs(owner, shells).reduce((count, tab) => count + tabLiveShells(tab, agentPaneOf(owner)), 0);
}

/** How many of a tab's shells are still running, never the agent's pane: what closing the tab ends, and asks about. */
export function tabLiveShells({ shell }: WindowTab, agentPane?: string): number {
  return shell === undefined ? 0 : paneIds(shell.layout).filter((id) => id !== agentPane && !shell.endedPanes.includes(id)).length;
}

/** The shells chip's count: "1 shell", "3 shells". */
export const shellsChipLabel = (count: number): string => (count === 1 ? '1 shell' : `${count} shells`);

/** The tab ⌘1–⌘8 picks by its place, ⌘9 the last, as in a browser; undefined past the end. */
export function tabAtDigit<T>(tabs: readonly T[], digit: number): T | undefined {
  return digit === 9 ? tabs.at(-1) : tabs[digit - 1];
}

/** The surface of a tab of `windowTabs`: the window's own, or a shell tab's. */
export const tabSurface = (tabId: string): Surface => (tabId === OWN_TAB ? { kind: 'own' } : { kind: 'shell', shellId: tabId });

/** The layout's key for a tab of `windowTabs`. */
export const tabKey = (tabId: string): string => surfaceKey(tabSurface(tabId));

/** The other sessions a window may show as tabs: every agent, and every shell tile on the board. */
export interface SessionTargets {
  agents: readonly Agent[];
  /** Shells, of which those that are tiles (no owner) count. */
  tiles: readonly Shell[];
}

/**
 * What one of a window's tabs shows, named as its tab is: one of `windowTabs` (its own, or a shell
 * tab), another agent's session, a shell tile's panes, a pull request, a web page, an agent's gate
 * or its plans.
 */
export type WindowSurface = { key: string; surface: Surface; label: string } & (
  | { kind: 'tab'; tab: WindowTab }
  | { kind: 'agent'; agent: Agent }
  | { kind: 'tile'; shell: Shell }
  | { kind: 'pr'; pr: PullRequestSurface }
  | { kind: 'web'; web: WebSurface }
  | { kind: 'gate'; gate: GateSurface; agent: Agent }
  | { kind: 'plan'; plan: PlanSurface; agent: Agent }
);

/** The surface of an agent's gate. */
export const gateSurfaceOf = (sessionId: string): GateSurface => ({ kind: 'gate', sessionId });

/** The surface of an agent's plans. */
export const planSurfaceOf = (sessionId: string): PlanSurface => ({ kind: 'plan', sessionId });

/**
 * An agent's gate's or plans' surface, named as its tab is: Gate or Plan, in its own window; else after its agent.
 * Undefined once its agent has gone.
 */
function agentToolSurface(owner: TabOwner, surface: Surface, agents: readonly Agent[]): WindowSurface | undefined {
  if (surface.kind !== 'gate' && surface.kind !== 'plan') return undefined;
  const agent = agents.find((each) => each.sessionId === surface.sessionId);
  if (agent === undefined) return undefined;
  const own = owner.kind === 'agent' && owner.agent.sessionId === agent.sessionId;
  const name = surface.kind === 'gate' ? 'Gate' : 'Plan';
  const base = { key: surfaceKey(surface), label: own ? name : `${name} · ${agent.name}`, agent };
  return surface.kind === 'gate' ? { ...base, surface, kind: 'gate', gate: surface } : { ...base, surface, kind: 'plan', plan: surface };
}

/** A pull request's surface, named as its tab is. */
const pullRequestSurface = (surface: PullRequestSurface): WindowSurface => ({
  key: surfaceKey(surface),
  surface,
  label: `PR #${surface.number}`,
  kind: 'pr',
  pr: surface,
});

/** A web page's surface, named by its host as its tab is. */
const webSurface = (surface: WebSurface): WindowSurface => ({ key: surfaceKey(surface), surface, label: webTabLabel(surface.url), kind: 'web', web: surface });

/** The session `surface` shows, if it is another session's and that is still there to show, never the window's own. */
function sessionSurface(owner: TabOwner, surface: Surface, targets: SessionTargets): WindowSurface | undefined {
  if (surface.kind !== 'session') return undefined;
  const { target } = surface;
  const key = surfaceKey(surface);
  const named = windowOwner(owner);
  if (target.kind === named.kind && target.id === named.id) return undefined;
  if (target.kind === 'agent') {
    const agent = targets.agents.find((each) => each.sessionId === target.id);
    return agent === undefined ? undefined : { key, surface, label: agent.name, kind: 'agent', agent };
  }
  const tile = targets.tiles.find((each) => each.id === target.id && each.owner === null);
  return tile === undefined ? undefined : { key, surface, label: tile.name, kind: 'tile', shell: tile };
}

/**
 * Every surface the window has: its own and its shell tabs (`windowTabs`), then those of `shown` (its layout's) that
 * show another session still there, then its pull requests and web pages, which are there for as long as their tabs
 * are. A tile that became a tab is no longer one to show.
 */
export function windowSurfaces(owner: TabOwner, shells: readonly Shell[], shown: readonly Surface[], targets: SessionTargets): WindowSurface[] {
  const tabs = windowTabs(owner, shells).map((tab): WindowSurface => {
    const surface = tabSurface(tab.id);
    return { key: surfaceKey(surface), surface, label: tab.label, kind: 'tab', tab };
  });
  return [
    ...tabs,
    ...shown.flatMap((surface) => sessionSurface(owner, surface, targets) ?? []),
    ...shown.flatMap((surface) => (surface.kind === 'pr' ? [pullRequestSurface(surface)] : surface.kind === 'web' ? [webSurface(surface)] : [])),
    ...shown.flatMap((surface) => agentToolSurface(owner, surface, targets.agents) ?? []),
  ];
}

/** What a tab window popped out with `surface` is called (slice 4): the pull request, or the web page's host. */
export function tabWindowTitle(surface: Surface): string {
  if (surface.kind === 'pr') return `${surface.repo}#${surface.number}`;
  if (surface.kind === 'web') return webTabLabel(surface.url);
  if (surface.kind === 'gate') return 'Gate';
  if (surface.kind === 'plan') return 'Plan';
  return 'Tabs';
}

/** The pull requests the window's + menu offers to open as a tab: its agent's on GitHub, newest first, not shown yet. */
export function pullRequestChoices(pullRequests: readonly PullRequest[], shown: readonly Surface[]): { label: string; surface: Surface }[] {
  const showing = new Set(shown.map(surfaceKey));
  return pullRequests.flatMap((pr) => {
    const surface = pullRequestSurfaceOf(pr);
    return surface === undefined || showing.has(surfaceKey(surface)) ? [] : [{ label: `#${pr.number} ${pr.title}`, surface }];
  });
}

/** The PR tab's surface for one of an agent's pull requests: undefined for one whose URL names no GitHub pull request. */
export function pullRequestSurfaceOf(pr: Pick<PullRequest, 'url'>): PullRequestSurface | undefined {
  const ref = pullRequestOfUrl(pr.url);
  return ref === undefined ? undefined : { kind: 'pr', ...ref };
}

/** The sessions the window's + menu offers to show as a tab: every other agent, then every shell tile, not shown yet. */
export function sessionChoices(owner: TabOwner, shown: readonly Surface[], targets: SessionTargets): WindowSurface[] {
  const showing = new Set(shown.map(surfaceKey));
  const candidates: Surface[] = [
    ...targets.agents.map((agent): Surface => ({ kind: 'session', target: { kind: 'agent', id: agent.sessionId } })),
    ...targets.tiles.map((tile): Surface => ({ kind: 'session', target: { kind: 'shell', id: tile.id } })),
  ];
  return candidates.flatMap((surface) => (showing.has(surfaceKey(surface)) ? [] : (sessionSurface(owner, surface, targets) ?? [])));
}
