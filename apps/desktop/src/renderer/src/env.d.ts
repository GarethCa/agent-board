import type { AgentBoardApi } from '../../preload/api';
import type { DemoApi } from './demo/demo-mode';

declare global {
  interface Window {
    agentBoard: AgentBoardApi;
    /** A recording spec's camera and cursor, in demo mode only (demo/demo-mode.ts). */
    __demo?: Partial<DemoApi>;
  }
}
