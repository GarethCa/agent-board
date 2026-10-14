import type { BuildInfo } from '@agent-board/daemon/protocol';

declare const __AGENT_BOARD_BUILD__: BuildInfo;

/** The commit this app (and the daemon it starts) was built from, set by electron.vite.config.ts. */
export const BUILD: BuildInfo = __AGENT_BOARD_BUILD__;
