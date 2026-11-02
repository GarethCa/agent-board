import { useSimplified } from '../design';
import { useViewSettings } from '../board/view-settings';
import { sidebarFor, type AgentSidebar } from './agent-sidebar';

/** The sidebar agent windows show now, kept current as the design or the choice changes in any window. */
export function useAgentSidebar(): AgentSidebar {
  return sidebarFor(useSimplified(), useViewSettings().agentSidebar);
}
