import { setViewSetting, useViewSettings } from '../board/view-settings';
import { AGENT_SIDEBARS, AGENT_SIDEBAR_LABELS, type AgentSidebar } from '../session/agent-sidebar';
import { inspectorShown } from '../session/inspector';
import { Hint, Segmented } from '../ui';

/** Picks the sidebar; Simple shows the inspector in the windows open now, rather than leaving it hidden behind its toggle. */
function pick(value: AgentSidebar): void {
  if (value === 'simple') inspectorShown.set('shown');
  setViewSetting('agentSidebar', value);
}

/** Settings › Agents › Sidebar, under Classic: an agent window's full details strip, or the simple inspector. */
export function AgentSidebarSetting() {
  const { agentSidebar } = useViewSettings();
  return (
    <>
      <Segmented
        aria-label="Agent sidebar"
        options={AGENT_SIDEBARS.map((id) => ({ id, label: AGENT_SIDEBAR_LABELS[id] }))}
        value={agentSidebar}
        onChange={pick}
      />
      <Hint>Agent sidebar: Simple shows an agent&apos;s work first and folds the rest away. Full is every section and control.</Hint>
    </>
  );
}
