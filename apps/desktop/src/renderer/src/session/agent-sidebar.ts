// Which sidebar an agent's window shows: the full details strip, or the simple inspector on the left. The
// Simplified design always has the inspector; under Classic it is a choice, Settings › Agents › Sidebar, kept in the
// shared view state (board/view-settings.ts) so every window follows a pick at once.

/** The two sidebars, as Settings lists them: the short grouped inspector, or the strip of every section and control. */
export const AGENT_SIDEBARS = ['simple', 'full'] as const;
export type AgentSidebar = (typeof AGENT_SIDEBARS)[number];

/** Each choice's name, as Settings shows it. */
export const AGENT_SIDEBAR_LABELS: Record<AgentSidebar, string> = { simple: 'Simple', full: 'Full' };

/** The saved choice, or Full for none or one this version doesn't know: Classic's windows open as they always have. */
export function agentSidebarFrom(saved: unknown): AgentSidebar {
  return AGENT_SIDEBARS.find((each) => each === saved) ?? 'full';
}

/** The sidebar a window shows: the inspector under the Simplified design, whatever was chosen, else the choice. */
export function sidebarFor(simplified: boolean, chosen: AgentSidebar): AgentSidebar {
  return simplified ? 'simple' : chosen;
}

/**
 * Whether a window shows the inspector: an agent's own window while the sidebar is Simple. A session with no agent (one
 * that isn't an agent, one not listed yet, one deleted) keeps the details strip, as shells and tab windows do: the
 * inspector has nothing to say of it.
 */
export function showsInspector(sidebar: AgentSidebar, content: { kind: string; agent?: unknown }): boolean {
  return sidebar === 'simple' && content.kind === 'session' && content.agent !== undefined;
}
