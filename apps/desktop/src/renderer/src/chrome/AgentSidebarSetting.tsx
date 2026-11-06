import { setViewSetting, useViewSettings } from '../board/view-settings';
import { AGENT_SIDEBARS, AGENT_SIDEBAR_LABELS } from '../session/agent-sidebar';
import { Hint, Segmented } from '../ui';

/** Settings › Agents › Sidebar, under Classic: an agent window's shelves, or the full details strip. */
export function AgentSidebarSetting() {
  const { agentSidebar } = useViewSettings();
  return (
    <>
      <Segmented
        aria-label="Agent sidebar"
        options={AGENT_SIDEBARS.map((id) => ({ id, label: AGENT_SIDEBAR_LABELS[id] }))}
        value={agentSidebar}
        onChange={(value) => setViewSetting('agentSidebar', value)}
      />
      <Hint>Agent sidebar: Shelves opens on an agent&apos;s own page, with the rest a tab away. Full is every section and control.</Hint>
    </>
  );
}
