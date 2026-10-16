import { planPending, waitsForYou, type Agent, type AgentState } from '@agent-board/daemon/protocol';

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

/**
 * The state and label an agent's pill draws: once its waiting has been seen it loses the needs-you look but keeps the
 * name of what it waits for, as on its tile and in the inbox. One rule for every place a pill is drawn.
 */
export function agentPill(agent: Agent, labels: Record<AgentState, string> = STATE_LABELS, state: AgentState = agent.state): { state: AgentState; label: string } {
  const ended = endedPill(agent);
  if (ended !== undefined) return ended;
  return { state: agent.seen && waitsForYou(agent) ? 'idle' : state, label: (state === 'waiting' && askLabel(agent)) || labels[state] };
}

/**
 * An ended agent's pill (BW1): `ended · exit N`, coloured by its exit code, or plain `ended` when a signal ended it,
 * coloured by its state then (done when the user stopped it, failed when it was killed otherwise). Not one a restart
 * stopped, which keeps its own stopped look until it is resumed.
 */
function endedPill(agent: Pick<Agent, 'endedAt' | 'exitCode' | 'state'>): { state: AgentState; label: string } | undefined {
  if (agent.endedAt === null || agent.state === 'stopped-by-restart') return undefined;
  if (agent.exitCode === null) return { state: agent.state === 'done' ? 'done' : 'failed', label: 'ended' };
  return { state: agent.exitCode === 0 ? 'done' : 'failed', label: `ended · exit ${agent.exitCode}` };
}

/** What a waiting agent asks of the user through the board: a question, or a plan to review; '' for neither. */
function askLabel(agent: Pick<Agent, 'ask' | 'plan'>): string {
  return agent.ask !== null ? 'asks you' : planPending(agent) ? 'plan to review' : '';
}
