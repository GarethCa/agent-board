// Which sidebar an agent's window shows: its shelves, or the full details strip. The Simplified design always has the
// shelves; under Classic it is a choice, Settings › Agents › Sidebar, kept in the shared view state
// (board/view-settings.ts) so every window follows a pick at once. Full stays a choice for one release.
import { storedValue } from '../stored-value';

/** The two sidebars, as Settings lists them: the shelves opening on the agent's page, or the strip of every section and control. */
export const AGENT_SIDEBARS = ['shelves', 'full'] as const;
export type AgentSidebar = (typeof AGENT_SIDEBARS)[number];

/** Each choice's name, as Settings shows it. */
export const AGENT_SIDEBAR_LABELS: Record<AgentSidebar, string> = { shelves: 'Shelves', full: 'Full' };

/**
 * The saved choice, or Full for none or one this version doesn't know: Classic's windows open as they always have.
 * Simple, which the shelves replace, reads as the shelves.
 */
export function agentSidebarFrom(saved: unknown): AgentSidebar {
  if (saved === 'simple') return 'shelves';
  return AGENT_SIDEBARS.find((each) => each === saved) ?? 'full';
}

/** The sidebar a window shows: the shelves under the Simplified design, whatever was chosen, else the choice. */
export function sidebarFor(simplified: boolean, chosen: AgentSidebar): AgentSidebar {
  return simplified ? 'shelves' : chosen;
}

/**
 * Whether a window shows the shelves: an agent's own window while the sidebar is Shelves. A session with no agent (one
 * that isn't an agent, one not listed yet, one deleted) keeps the details strip, as shells and tab windows do: the
 * shelves have nothing to say of it.
 */
export function showsShelves(sidebar: AgentSidebar, content: { kind: string; agent?: unknown }): boolean {
  return sidebar === 'shelves' && content.kind === 'session' && content.agent !== undefined;
}

/** Whether the shelves are collapsed to their rail (`rail`) or open (unset): one choice for every agent window, ⌘I's. */
export const shelvesCollapsed = storedValue('agent-board.shelves-rail');
