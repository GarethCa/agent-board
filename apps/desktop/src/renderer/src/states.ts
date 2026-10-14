import type { AgentState } from '@agent-board/daemon/protocol';

/** How the app names each agent state, on tiles and characters. */
export const STATE_LABELS: Record<AgentState, string> = {
  running: 'running',
  thinking: 'thinking',
  waiting: 'waiting for you',
  'needs-permission': 'needs permission',
  idle: 'idle',
  'rate-limited': 'rate limited',
  failed: 'failed',
  done: 'done',
  scheduled: 'scheduled',
  'stopped-by-restart': 'stopped',
  'handing-off': 'handing off',
};

/**
 * The shorter names a tile's state pill uses (the TileCompact mock), so the pill never crowds the agent's name. Its
 * `title` gives the full one.
 */
export const TILE_STATE_LABELS: Record<AgentState, string> = {
  ...STATE_LABELS,
  waiting: 'waiting',
  'needs-permission': 'allow?',
  'rate-limited': 'limited',
};
