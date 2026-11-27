import type { Agent, DaemonMethod, OrchestratorAction } from './protocol.ts';

/**
 * A connection, as the board methods see it: the session whose board token it presented, if it has, and a signal
 * that aborts once it closes (a wait it made stops then).
 */
export interface BoardConnection {
  boardSession?: string;
  closed?: AbortSignal;
}

/**
 * Who acts through an orchestrator method: an agent, or the user's side, a shell or the user with no token,
 * which reaches every agent.
 */
export interface Orchestrator extends Pick<Agent, 'sessionId' | 'name' | 'zoneId' | 'repoRoot'> {
  /** The orchestrator agent; null on the user's side, whose agents and edges are the user's own. */
  agent: Agent | null;
}

/** What a log line says beyond who and what: what it acted on (an agent, or a tile, zone or note), and what was asked. */
export interface ActivityEntry {
  /** An agent's session id, or a tile's, zone's or note's id; its name as it is now. */
  on?: { id: string; name: string };
  detail: string;
}

/**
 * What the layout commands (`orchestrator-layout.ts`) act through: who calls, which agents it reaches, and the log,
 * as every orchestrator method has them.
 */
export interface OrchestratorAccess {
  /** Who calls `method`: as every orchestrator method finds it, refusing (and logging) a session that may not. */
  caller(method: DaemonMethod, params: Record<string, unknown>, connection: BoardConnection): Orchestrator;
  /** Runs `act` as `me` doing `action`, logging it done or refused with what `entry` holds by then. */
  logged<T>(me: Orchestrator, action: OrchestratorAction, entry: ActivityEntry, act: () => Promise<T> | T): Promise<T>;
  /** Whether `me` made what `madeBy` names, or an agent of its crew did; the user's side made everything. */
  madeByCrew(me: Orchestrator, madeBy: string | null): boolean;
  /**
   * Whether `me` may take over what `madeBy` made, as a handover would: an agent (not the user's side) whose session has
   * ended, or that is gone.
   */
  mayTakeOver(me: Orchestrator, madeBy: string | null): boolean;
  /** Whether the agent session `sessionId` may act on the board now, as it is checked again when the user allows what it asked. */
  mayOrchestrate(sessionId: string): boolean;
}
