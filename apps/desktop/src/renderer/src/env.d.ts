import type { AgentBoardApi } from '../../preload/api';

declare global {
  interface Window {
    agentBoard: AgentBoardApi;
  }
}
