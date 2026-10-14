import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { issuePrompt, shortIssueId, type PullRequest } from '@agent-board/tracker';
import { runGit } from './git.ts';
import { CLAUDE_HOOK_EVENTS, lastMessageAfterHook, stateAfterExit } from './claude-state.ts';
import { guardCodexConfig, projectCodexConfig, type CodexConfigGuard } from './codex-config-guard.ts';
import { BOARD_SESSION_ENV, BOARD_SOCKET_ENV, BOARD_TOKEN_ENV, BOARD_ZONE_ENV } from './board-env.ts';
import { CODEX_HOOK_TIMEOUTS, codexHookCommand, HOOK_ENV_PREFIX, HOOK_TOKEN_ENV, HOOK_URL_ENV } from './hook-forwarder.ts';
import { stateAfterHook } from './harness-state.ts';
import { hashToken, newToken } from './tokens.ts';
import { isRunningSomething as defaultIsRunningSomething } from './foreground.ts';
import { keyedQueue } from './keyed-queue.ts';
import { loginShellKind } from './login-path.ts';
import {
  dimensionParam,
  invalidParams,
  optionalBooleanParam,
  optionalCountParam,
  optionalStringParam,
  paramsObject,
  requiredNameParam,
  stringParam,
} from './params.ts';
import { createPermissionHolds, stateWithPrompts, type HookReply } from './permissions.ts';
import {
  AGENT_ERROR,
  DEFAULT_REVIEW_CAP,
  INTERRUPT_KEY,
  INTERRUPTIBLE_STATES,
  isStatusProgress,
  MAX_DESCRIPTION_LENGTH,
  MAX_STATUS_LENGTH,
  type Agent,
  type AgentRepo,
  type AgentRole,
  AGENT_ROLES,
  type AgentState,
  type DaemonEvent,
  type Harness,
  type TileMove,
  type DaemonMethods,
  ORCHESTRATE_SCOPES,
  type OrchestrateScope,
  type PermissionDecision,
  type LinkedIssue,
  type ScheduleSpec,
  type SessionInfo,
  type SessionState,
  type SpawnAgentParams,
  type Subagent,
  type TerminalSize,
  type TilePosition,
  type TranscriptChunk,
  waitsForYou,
} from './protocol.ts';
import { folderPath, repoZoneOf } from './repo-zone.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import type { RunStart, ScheduleHost } from './schedules.ts';
import { sessionEnv, type SessionHost } from './sessions.ts';
import { RESET_MODES } from './shells.ts';
import { createSubagentStore, subagentsAfterExit, subagentsAfterHook } from './subagents.ts';
import { answerInput, draftAfterInput } from './terminal-input.ts';
import { createTranscriptReader } from './transcripts.ts';
import type { TrackerHost } from './trackers.ts';
import {
  frontZ,
  moveParams,
  optionalPlaceParam,
  saveMove,
  tilePosition,
  zoneIdParam,
  type PositionColumns,
} from './tile-position.ts';
import {
  addWorktree,
  agentBranchName,
  agentWorktreePath,
  freeBranchName,
  checkedBranchName,
  freeTypedBranch,
  nameSlug,
  removeWorktree,
  unsavedWork,
} from './worktrees.ts';
import { initProject, resolveZoneFolder } from './zones.ts';
import { carryClaudeTranscript } from './claude-transcript.ts';
import { recount } from './counts.ts';
import { handoffLine } from './handoff-text.ts';

/** Codex's flag that runs untrusted hooks without review (ADR-0004). */
const CODEX_BYPASS_FLAG = '--dangerously-bypass-hook-trust';

/**
 * What a model name may be (`opus`, `claude-opus-5-5[1m]`, `gpt-5-codex`): never an option of the harness's own, nor
 * whitespace, since it is passed as an argument.
 */
const MODEL_NAME = /^[\w.:@/[\]][\w.:@/[\]-]*$/;

/** Longest default name made from the task. */
const MAX_DEFAULT_NAME_LENGTH = 40;

/** How long an answer's text gets to land at the prompt before it is submitted, so it isn't taken as a pasted line. */
const ANSWER_SUBMIT_DELAY_MS = 50;

/** The agent's own hooks that begin a turn, or end one with no `Stop` after them (`onTurnBoundary`). */
const TURN_BOUNDARIES: ReadonlySet<unknown> = new Set(['UserPromptSubmit', 'StopFailure', 'Interrupt', 'SessionEnd']);

/**
 * Hooks of a turn's work, which a turn interrupted mid-hook can still deliver after the interrupt. Until the next
 * prompt they are stale: none may move the agent off the `idle` the interrupt left it in.
 */
const TURN_WORK_HOOKS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'PreCompact', 'PostCompact']);

/** Whether `payload` is a hook from an interrupted turn's work, landing after the interrupt. */
function isStaleAfterInterrupt(payload: Record<string, unknown>): boolean {
  const event = payload.hook_event_name;
  if (event === 'Notification') return payload.notification_type === 'permission_prompt';
  return typeof event === 'string' && TURN_WORK_HOOKS.has(event);
}

/** The terminal a relaunched agent starts in, until a client attaches and sizes it. */
const RELAUNCH_SIZE: TerminalSize = { cols: 120, rows: 40 };

/** How long claude waits on a hook call, in seconds. Only a held PermissionRequest takes longer. */
const HOOK_TIMEOUT_S = 5;

/** How much longer claude waits on a held PermissionRequest hook than the daemon holds it, so the daemon answers first. */
const PERMISSION_HOOK_MARGIN_S = 10;

export interface AgentHostOptions {
  db: DatabaseSync;
  sessions: SessionHost;
  /** Where agent worktrees go (ADR-0007). */
  worktreesDir: string;
  /** Where an agent asked for a scratch repo gets one, named after it (ADR-0007). */
  scratchDir: string;
  /** Remembers a folder an agent was started from, so pickers offer it again. */
  rememberFolder(path: string): void;
  /** The harness executables: found on the session's PATH by default. */
  claudeCommand: string;
  codexCommand: string;
  /** The stable launcher Codex's hook command runs (`writeHookShim`). */
  hookShimPath: string;
  /** Makes sure the launcher is there and runs this app; throws if it can't be written. */
  ensureHookShim(): void;
  /**
   * The `agent-board` CLI launcher (ADR-0010), which agents run as their board MCP server (`agent-board mcp`) unless
   * their zone turns it off. No agent gets the server without it.
   */
  boardCliPath?: string;
  /** The environment harness sessions start from. */
  env: NodeJS.ProcessEnv;
  /** The user's shell and its arguments. A login shell (`-l`) also launches the harness, so it gets the profile's PATH. */
  shell: string;
  shellArgs: string[];
  /** The hook ingress's URL. */
  hookUrl(): string;
  /** How long a PermissionRequest hook is held for an inbox answer before the harness's own prompt takes over. */
  permissionHoldMs: number;
  /** The zones' trackers, where agents started from or linked to an issue get it. */
  trackers: Pick<TrackerHost, 'issue'>;
  /** The pull requests made from the agent's branch, as last seen. */
  pullRequests(sessionId: string): readonly PullRequest[];
  /** Long-lived agents' cron schedules. */
  schedules: Pick<ScheduleHost, 'get' | 'set' | 'remove'>;
  /** Hears an agent hand off: today, its own turn ending with a final message (its Stop hook). */
  onHandoff(sessionId: string): void;
  /**
   * Hears an agent's own turn begin (`UserPromptSubmit`) or end without a `Stop` (`StopFailure`, Codex's `Interrupt`,
   * `SessionEnd`): what it handed off explicitly belongs to the turn it did it in.
   */
  onTurnBoundary?(sessionId: string): void;
  /** Hears an agent about to be deleted, so what goes with it can say so first: its flow edges. */
  onRemoving(sessionId: string): void;
  /** Ends the shells in the agent's session window's tabs, and removes the tabs: it is being deleted. */
  endTabs?(sessionId: string): Promise<void>;
  /** Whether the shell `pid` is running something: `isRunningSomething` by default. */
  isRunningSomething?(pid: number): Promise<boolean>;
  broadcast(event: DaemonEvent): void;
  log(message: string): void;
}

/**
 * A harness session started outside agent-board, to adopt as an agent: its session id, how it is drawn, and
 * where it carries on.
 */
export interface AdoptSpec {
  sessionId: string;
  harness: Harness;
  name: string;
  description: string;
  zoneId: string | null;
  position: TilePosition | null;
  /** Its Claude transcript, if known: copied beside a new folder, where `claude --resume` looks for it. */
  transcriptPath: string | null;
  /**
   * `in-place`: in a folder of the user's (its worktree, repo and branch, or the folder itself and no branch outside
   * git or on a detached HEAD), which the agent never owns. `new-worktree`: in a new worktree of `repoRoot` and a
   * branch cut from `base` (a branch, or a detached session's commit), in `folder` of it, which it owns as a spawned
   * agent does.
   */
  place:
    | { kind: 'in-place'; cwd: string; worktree: string; repoRoot: string; branch: string }
    | { kind: 'new-worktree'; repoRoot: string; base: { branch: string } | { commit: string }; folder: string };
  size: TerminalSize;
}

/** How far a loose implementer's reviewer starts from it, down and right, in board units. */
const REVIEWER_OFFSET = 48;

export interface AgentHost {
  /** Whether the agent is being deleted: from the start of `delete` until its row is gone, its worktree too. */
  isDeleting(sessionId: string): boolean;
  /** Starts an agent; `spawnedBy` is the orchestrator starting it, if one is. */
  spawn(params: SpawnAgentParams, spawnedBy?: string): Promise<Agent>;
  /**
   * Spawns a reviewer of agent `of`: in its harness, repo and zone, on a new branch `branch` (or the first free
   * one after it) from the tip of its branch, in the same folder of its worktree, with `prompt` as its task.
   */
  spawnReviewer(params: { of: string; name: string; branch: string; prompt: string } & TerminalSize): Promise<Agent>;
  /**
   * Adopts a harness session started outside agent-board as an agent under the same session id, carrying on its
   * conversation with no new prompt: Claude with `--resume`, Codex with `codex resume` (or afresh if it can't).
   */
  adopt(spec: AdoptSpec): Promise<Agent>;
  /** The name an agent started with no task would get now: the lowest free `new-agent-N`. */
  nextName(): string;
  list(): Agent[];
  /** The agent, if there is one. */
  get(sessionId: string): Agent | undefined;
  /** Ends the agent and removes its worktree and branch, or with `keepWorktree` leaves them, and the work in them, alone. */
  delete(sessionId: string, force: boolean, keepWorktree?: boolean): Promise<void>;
  /** Its conversation from its transcript (`TranscriptReader.read`), for the chat view. */
  transcript(sessionId: string, since: number, generation?: number): Promise<TranscriptChunk>;
  /** A Claude subagent's conversation (`TranscriptReader.readSubagent`), started by its call `toolUseId`. */
  subagentTranscript(sessionId: string, toolUseId: string, agentId?: string): Promise<TranscriptChunk>;
  /** Links the agent to an issue in its repo zone's tracker (`repoZoneOf`), or unlinks it with null. */
  link(sessionId: string, issueId: string | null): Promise<Agent>;
  /** Mutes the agent's OS notifications, or unmutes them. */
  setMuted(sessionId: string, muted: boolean): Agent;
  /** Marks the agent's current ask seen, if it has one: it stops needing the user until it works and asks again. */
  markSeen(sessionId: string): Agent;
  /** Renames the agent's tile. */
  setName(sessionId: string, name: string): Agent;
  /**
   * Sets what the agent says it is doing now (ADR-0010), replacing what was there: a summary, trimmed and at most
   * `MAX_STATUS_LENGTH`, and a progress 0-100 or null.
   */
  setStatus(sessionId: string, summary: string, progress: number | null): Agent;
  /** Lets the agent orchestrate in `scope`, or stops it with null. */
  setOrchestrate(sessionId: string, scope: OrchestrateScope | null): Agent;
  /**
   * Hears a zone's `agentsOrchestrate` change. Off, it stops every agent in it orchestrating (the zone's grants are
   * held back while it is off, and come back with it; a grant by hand goes), and tells the clients of each it reaches.
   */
  zoneOrchestrateChanged(zoneId: string, on: boolean): void;
  /** Moves the agent's tile within its zone, into any other, or out onto the board. Only its tile moves. */
  move(sessionId: string, move: TileMove): Agent;
  /** The zone of the agent's own repo that speaks for it (`repoZoneOf`), if any. */
  repoZoneId(sessionId: string): string | undefined;
  /**
   * Sends `text` to the agent as the user's next message, after any answer to it still being typed: its line breaks
   * kept, pasted as a terminal pastes them, and pasted even as one line with `paste`.
   */
  answer(sessionId: string, text: string, paste?: boolean): Promise<void>;
  /**
   * Interrupts the agent's turn, as Ctrl-C in its terminal would, and returns it idle at its prompt with its permission
   * prompts released. Refuses an ended agent and one with no turn under way.
   */
  interrupt(sessionId: string): Agent;
  /** Ends the agent's session, keeping its worktree and branch, and resolves with it `done`. */
  stop(sessionId: string): Promise<Agent>;
  /**
   * Starts an ended agent (stopped by restart, or exited) again in its worktree, carrying on its conversation with no
   * new prompt: Claude with `--resume`, Codex with `codex resume` (or afresh if it can't). Ends the shell its pane
   * dropped into, refusing with `shellBusy` while that runs something, unless `force`. Refuses a running agent.
   */
  resume(sessionId: string, force: boolean): Promise<Agent>;
  /** Answers one of the agent's held permission prompts. */
  decidePermission(sessionId: string, requestId: string, decision: PermissionDecision): void;
  /** Gives the agent a cron schedule, replacing any it had, or takes it away with null. */
  setSchedule(sessionId: string, schedule: ScheduleSpec | null): Agent;
  /**
   * Starts a scheduled run. An agent sitting at its prompt (idle, or after a failed turn) gets `prompt` as its next
   * message. An ended agent is relaunched in its worktree with `prompt`: Claude resumes its conversation, Codex starts
   * a new one (a hand-off resumes it). The run is skipped, saying why, while the agent is still working, rate-limited, waiting for you (on a
   * permission prompt, or its last message asks you something) or you are typing at its prompt.
   */
  runScheduled(sessionId: string, prompt: string): RunStart;
  /**
   * Delivers `text`, the payload `name` (`final message`, `plan.md`, `review, round 1`), from agent `from` to agent
   * `to` as `to`'s next message, headed with both, as a scheduled run does (relaunching an ended `to`, resuming its
   * conversation whichever the harness, skipping one that can't take it now, saying why), `from` showing `handing-off` until it has landed.
   */
  deliver(from: string, to: string, name: string, text: string): Promise<RunStart>;
  /** The agent's final message from the turn it last finished, if it has finished one. */
  finalMessage(sessionId: string): string | undefined;
  /** Hears what a client typed into the agent's terminal, so a run never adds to a draft at its prompt. */
  onInput(sessionId: string, data: string): void;
  /**
   * Moves the session's agent, if it has one, and its subagents on a hook call. Resolves with the hook's reply: a
   * PermissionRequest is held open until the user decides in the inbox, or the hold lapses (`signal` aborts if the
   * harness hangs up first).
   */
  onHook(sessionId: string, payload: Record<string, unknown>, signal: AbortSignal): HookReply | Promise<HookReply>;
  /** Settles the session's agent, if it has one, once its process has exited. */
  onExit(session: SessionInfo): void;
  /** Tells every client about the agent, if it still exists, after something it shows changed. */
  announce(sessionId: string): void;
  /**
   * How many ended agents' panes have a shell open now. Those shells are not live sessions to the user, so they don't
   * keep the daemon up or make `daemon.stop` ask (ADR-0002); shutting down ends them with the rest.
   */
  fallbackShellCount(): number;
  /** The ended agent whose pane dropped into the shell session `sessionId`, if it is one. */
  fallbackOwner(sessionId: string): string | undefined;
  /** Releases held hooks; call before the database closes. */
  close(): void;
}

interface AgentRow extends PositionColumns {
  session_id: string;
  /** Null for a tile loose on the board. */
  zone_id: string | null;
  repo_root: string;
  /** The Codex setting it last started with from a zone of its repo. */
  codex_bypass_hook_trust: number;
  harness: Harness;
  model: string | null;
  role: AgentRole | null;
  name: string;
  description: string;
  branch: string;
  worktree: string;
  cwd: string;
  state: SessionState;
  notice: string | null;
  muted: number;
  seen: number;
  issue_provider: LinkedIssue['provider'] | null;
  issue_id: string | null;
  issue_title: string | null;
  issue_url: string | null;
  /** Codex's own id for its conversation; null until its first hook says. */
  harness_session_id: string | null;
  /** The transcript its harness's hooks named; null until its first hook. */
  transcript_path: string | null;
  created_at: string;
  ended_at: string | null;
  exit_code: number | null;
  stopped_by_restart: number;
  review_of: string | null;
  review_cap: number | null;
  /** 0 for an agent adopted in a folder of the user's, whose worktree and branch deleting it leaves alone. */
  owns_worktree: number;
  /** Its status (`setStatus`): all null until it sets one. */
  status_summary: string | null;
  status_progress: number | null;
  status_updated_at: string | null;
  orchestrate: OrchestrateScope | null;
  /** The zone that let it orchestrate (`Zone.agentsOrchestrate`), null when the user did by hand. */
  orchestrate_zone: string | null;
  spawned_by: string | null;
}

interface ZoneRow {
  id: string;
  name: string;
  /** Null while the zone is unbound: its agents start in its default repo, or the repo they are given. */
  repo_root: string | null;
  /** An unbound zone's default repo, or null. */
  default_repo: string | null;
  /** The repo it is cloning, while it is: it is unbound until the clone finishes. */
  clone_repo: string | null;
  folder: string;
  codex_bypass_hook_trust: number;
  board_mcp: number;
  agents_orchestrate: number;
  tracker_provider: string | null;
  created_at: string;
}

/**
 * Owns agents: a worktree and branch per agent, its harness session, and the state its hooks put it in. Agent rows
 * outlive their sessions, so ended agents keep their tiles until deleted. An agent whose session ended because its
 * daemon went away is `stopped-by-restart` (see `reconcileLostSessions`), whatever state it was in, until it is
 * resumed. Subagents, last messages and permission prompts live only in memory: they can't outlive the daemon, as
 * their agent's session can't.
 */
export function createAgentHost(options: AgentHostOptions): AgentHost {
  const { db, sessions } = options;
  const select = `SELECT a.*, s.harness, s.cwd, s.created_at, s.ended_at, s.exit_code, s.stopped_by_restart
    FROM agents a JOIN sessions s ON s.id = a.session_id`;
  // In the order they were spawned: a relaunch restarts the session's `created_at`.
  const selectAll = db.prepare(`${select} ORDER BY a.rowid`);
  const selectOne = db.prepare(`${select} WHERE a.session_id = ?`);
  const zoneColumns =
    'id, name, repo_root, folder, default_repo, codex_bypass_hook_trust, board_mcp, agents_orchestrate, tracker_provider, clone_repo, created_at';
  const selectZone = db.prepare(`SELECT ${zoneColumns} FROM zones WHERE id = ?`);
  const selectZones = db.prepare(`SELECT ${zoneColumns} FROM zones`);
  const insert = db.prepare(
    `INSERT INTO agents (session_id, zone_id, repo_root, codex_bypass_hook_trust, model, role, name, description, branch,
       worktree, state, issue_provider, issue_id, issue_title, issue_url, x, y, z, review_of, base_commit, owns_worktree,
       harness_session_id, orchestrate, spawned_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectNames = db.prepare('SELECT name FROM agents');
  const updatePlace = db.prepare('UPDATE agents SET zone_id = ?, x = ?, y = ?, z = ? WHERE session_id = ?');
  const update = db.prepare('UPDATE agents SET state = ? WHERE session_id = ?');
  const updateNotice = db.prepare('UPDATE agents SET notice = ? WHERE session_id = ?');
  const updateMuted = db.prepare('UPDATE agents SET muted = ? WHERE session_id = ?');
  const updateSeen = db.prepare('UPDATE agents SET seen = ? WHERE session_id = ?');
  const updateName = db.prepare('UPDATE agents SET name = ? WHERE session_id = ?');
  const updateStatus = db.prepare(
    'UPDATE agents SET status_summary = ?, status_progress = ?, status_updated_at = ? WHERE session_id = ?',
  );
  const updateOrchestrate = db.prepare('UPDATE agents SET orchestrate = ?, orchestrate_zone = ? WHERE session_id = ?');
  /** The agents a zone's setting reaches: those in it, and those it let orchestrate, wherever they are. */
  const selectReachedBy = db.prepare('SELECT session_id FROM agents WHERE zone_id = ? OR orchestrate_zone = ?');
  /** The agents in a zone the user let orchestrate by hand. */
  const clearHandGrantsIn = db.prepare(
    'UPDATE agents SET orchestrate = NULL WHERE zone_id = ? AND orchestrate IS NOT NULL AND orchestrate_zone IS NULL',
  );
  const selectChildren = db.prepare('SELECT session_id FROM agents WHERE spawned_by = ?');
  const forgetParent = db.prepare('UPDATE agents SET spawned_by = NULL WHERE spawned_by = ?');
  const updateHarnessSession = db.prepare('UPDATE agents SET harness_session_id = ? WHERE session_id = ?');
  const updateTranscript = db.prepare('UPDATE agents SET transcript_path = ? WHERE session_id = ?');
  const transcripts = createTranscriptReader();
  const updateBypass = db.prepare('UPDATE agents SET codex_bypass_hook_trust = ? WHERE session_id = ?');
  /** Live Codex agents running with the bypass flag, watched for project config appearing. */
  const guards = new Map<string, CodexConfigGuard>();
  const updateIssue = db.prepare(
    'UPDATE agents SET issue_provider = ?, issue_id = ?, issue_title = ?, issue_url = ? WHERE session_id = ?',
  );
  const remove = db.prepare('DELETE FROM agents WHERE session_id = ?');

  const subagents = createSubagentStore();
  /**
   * Agents whose `waiting` came from Claude's `idle_prompt` after their turn ended: they sit at their prompt, not on a
   * question. A scheduled agent like that is waiting for its next run, not for you.
   */
  const idlePrompted = new Set<string>();
  /** What each agent last said to the user (`lastMessageAfterHook`). */
  const lastMessages = new Map<string, string>();
  /**
   * The final message of each agent's last finished turn (its Stop's `last_assistant_message`), which a manual edge
   * sends. Unlike `lastMessages` a new prompt keeps it: it is still the last finished turn's. Kept in its row, so it
   * outlives the daemon.
   */
  const updateFinalMessage = db.prepare('UPDATE agents SET final_message = ? WHERE session_id = ?');
  const selectFinalMessage = db.prepare('SELECT final_message FROM agents WHERE session_id = ?');
  /** Per agent handing off, how many of its deliveries are still landing: it shows `handing-off` until none are. */
  const handingOff = new Map<string, number>();
  /** Per agent, the answer being typed into its terminal, so the next waits for it. */
  const answering = new Map<string, Promise<void>>();
  /** Agents being stopped by the user, whose exit is `done` however their process ends. */
  const stopping = new Set<string>();
  /** Agents interrupted since their last prompt: hooks still landing from that turn's work are ignored. */
  const interrupted = new Set<string>();
  /**
   * Codex agents started with `codex resume` that haven't started yet (no SessionStart): one that exits first couldn't
   * resume its conversation, and is started afresh.
   */
  const codexResuming = new Set<string>();
  /** Agents with a draft the user typed at their prompt (`draftAfterInput`) and hasn't submitted. */
  const drafting = new Set<string>();
  /**
   * Agents whose latest permission request has been settled (answered in the terminal or the turn moved on): a
   * `permission_prompt` notification then is the late echo of that prompt, not a new one.
   */
  const permissionSettled = new Set<string>();
  /** Per ended agent, the live login shell its pane dropped into; and per such shell, its agent. */
  const fallbackShells = new Map<string, string>();
  const fallbackOwners = new Map<string, string>();
  /** Agents being deleted, whose pane drops into no shell. */
  const deleting = new Set<string>();
  let closed = false;
  const isRunningSomething = options.isRunningSomething ?? defaultIsRunningSomething;
  const permissions = createPermissionHolds({
    holdMs: options.permissionHoldMs,
    onChange(sessionId) {
      const agent = get(sessionId);
      if (agent !== undefined) options.broadcast({ type: 'agent.updated', agent });
    },
  });

  /**
   * Whether the agent's last message asks the user something: its last paragraph has a question mark. A turn that ends
   * on a question leaves Claude only `idle_prompt`, as a turn that ends on an answer does.
   */
  const asking = (sessionId: string) => {
    const message = lastMessages.get(sessionId);
    return message !== undefined && message.trim().split(/\n\s*\n/).at(-1)!.includes('?');
  };

  /**
   * Whether the agent sits at its prompt between turns, ready for its next message and, unless `evenAsking`, not asking
   * you anything.
   */
  const atPrompt = (row: AgentRow, evenAsking = false) =>
    row.ended_at === null &&
    permissions.prompts(row.session_id).length === 0 &&
    (evenAsking || !asking(row.session_id)) &&
    (row.state === 'idle' || (row.state === 'waiting' && idlePrompted.has(row.session_id)));

  /**
   * The state a live agent with an enabled schedule shows: `scheduled` at its prompt, waiting for its next run, and
   * `waiting` for you, so in the needs-you inbox, when its turn ended on a question.
   */
  const scheduledState = (row: AgentRow): AgentState => {
    if (atPrompt(row)) return 'scheduled';
    if (row.ended_at === null && row.state === 'idle' && asking(row.session_id)) return 'waiting';
    return row.state;
  };

  /**
   * Why a scheduled run can't start in the live agent now, or undefined if it can. With `evenAsking`, as for a hand-off,
   * a last message asking you something doesn't stop it: what's typed is the agent's next input either way.
   */
  const whyNotReady = (row: AgentRow, evenAsking = false): string | undefined => {
    const sessionId = row.session_id;
    const askingYou = !evenAsking && asking(sessionId);
    if (row.state === 'rate-limited') return 'it was rate-limited';
    // A failed turn leaves the agent at its prompt.
    if (!atPrompt(row, evenAsking) && !(row.state === 'failed' && permissions.prompts(sessionId).length === 0)) {
      const waiting =
        row.state === 'waiting' || row.state === 'needs-permission' || permissions.prompts(sessionId).length > 0 || askingYou;
      return waiting ? 'it was waiting for you' : 'it was still working';
    }
    if (askingYou) return 'it was waiting for you';
    if (drafting.has(sessionId)) return 'you were typing in its terminal';
    return undefined;
  };

  /**
   * The state an agent without an enabled schedule shows: `stopped-by-restart` once its daemon went away under it,
   * until it is resumed. (A scheduled one follows its schedule, which relaunches it.)
   */
  const unscheduledState = (row: AgentRow): AgentState =>
    row.ended_at !== null && row.stopped_by_restart === 1 ? 'stopped-by-restart' : row.state;

  const toAgent = (row: AgentRow): Agent => {
    const schedule = options.schedules.get(row.session_id);
    const state = schedule?.enabled ? scheduledState(row) : unscheduledState(row);
    return {
      sessionId: row.session_id,
      zoneId: row.zone_id,
      position: tilePosition(row),
      repoRoot: row.repo_root,
      harness: row.harness,
      model: row.model,
      role: row.role,
      name: row.name,
      description: row.description,
      branch: row.branch,
      worktree: row.worktree,
      cwd: row.cwd,
      // Handing off shows over what it was doing, but never over its needing you: that would take it out of the inbox,
      // and tell you again that it waits when it came back.
      state:
        handingOff.has(row.session_id) && state !== 'waiting' && state !== 'needs-permission' && permissions.prompts(row.session_id).length === 0
          ? 'handing-off'
          : state,
      notice: row.notice,
      status:
        row.status_summary === null || row.status_updated_at === null
          ? null
          : { summary: row.status_summary, progress: row.status_progress, updatedAt: row.status_updated_at },
      muted: row.muted === 1,
      // An ended agent asks nothing: what it was last seen at doesn't carry over.
      seen: row.seen === 1 && row.ended_at === null,
      issue:
        row.issue_provider === null || row.issue_id === null
          ? null
          : { provider: row.issue_provider, id: row.issue_id, title: row.issue_title ?? '', url: row.issue_url ?? '' },
      createdAt: row.created_at,
      endedAt: row.ended_at,
      exitCode: row.exit_code,
      shellSessionId: fallbackShells.get(row.session_id) ?? null,
      subagents: [...subagents.of(row.session_id)],
      pullRequests: [...options.pullRequests(row.session_id)],
      lastMessage: lastMessages.get(row.session_id) ?? null,
      permissions: permissions.prompts(row.session_id),
      schedule,
      reviewOf: row.review_of,
      reviewCap: row.review_cap ?? DEFAULT_REVIEW_CAP,
      ownsWorktree: row.owns_worktree === 1,
      orchestrate: orchestrateNow(row),
      spawnedBy: row.spawned_by,
    };
  };

  const getRow = (sessionId: string) => selectOne.get(sessionId) as AgentRow | undefined;

  /**
   * The scope the agent may orchestrate in now. A zone's grant holds only while its tile is in that zone and the zone
   * still lets its agents orchestrate: moved in, an agent gets nothing from the zone; moved out, it keeps nothing.
   */
  const orchestrateNow = (row: AgentRow): OrchestrateScope | null => {
    if (row.orchestrate_zone === null) return row.orchestrate;
    const granting = row.zone_id === row.orchestrate_zone ? (selectZone.get(row.zone_id) as ZoneRow | undefined) : undefined;
    return granting?.agents_orchestrate === 1 ? row.orchestrate : null;
  };

  /** The zone of the agent's own repo that speaks for it, wherever its tile sits (`repoZoneOf`). */
  const repoZone = (row: AgentRow): ZoneRow | undefined => repoZoneFor(row.zone_id, row.repo_root);

  /** The zone of `repoRoot` that speaks for an agent of it whose tile is in `zoneId` (`repoZoneOf`). */
  const repoZoneFor = (zoneId: string | null, repoRoot: string): ZoneRow | undefined =>
    repoZoneOf(
      { zoneId, repoRoot },
      (selectZones.all() as unknown as ZoneRow[]).map((zone) => ({
        ...zone,
        repoRoot: zone.repo_root,
        hasTracker: zone.tracker_provider !== null,
        createdAt: zone.created_at,
      })),
    );

  /** Whether an agent whose tile is in `zoneId` gets the board MCP server: on unless its zone turned it off. */
  const boardMcpOn = (zoneId: string | null): boolean =>
    zoneId === null || (selectZone.get(zoneId) as ZoneRow | undefined)?.board_mcp !== 0;

  const get = (sessionId: string): Agent | undefined => {
    const row = getRow(sessionId);
    return row && toAgent(row);
  };

  const requireRow = (sessionId: string): AgentRow => {
    const row = getRow(sessionId);
    if (row === undefined) throw invalidParams(`no agent ${sessionId}`);
    return row;
  };

  const requireAgent = (sessionId: string): Agent => toAgent(requireRow(sessionId));

  /** Types `text` at the agent's prompt as one line and submits it, as `typeInput` does. */
  const typeLine = (sessionId: string, text: string) => typeInput(sessionId, oneLine(text));

  /**
   * Writes `line` at the agent's prompt, after any line still being typed to it (two typed at once would run
   * together), and submits it once it has landed, so it isn't taken as a pasted line.
   */
  const typeInput = async (sessionId: string, line: string) => {
    const typed = (answering.get(sessionId) ?? Promise.resolve()).then(async () => {
      sessions.write(sessionId, line);
      await new Promise((resolve) => setTimeout(resolve, ANSWER_SUBMIT_DELAY_MS));
      sessions.write(sessionId, '\r');
    });
    answering.set(sessionId, typed);
    try {
      await typed;
    } finally {
      if (answering.get(sessionId) === typed) answering.delete(sessionId);
    }
  };

  /**
   * Records the agent's new state and subagents and tells every client; unless `always`, only if either changed.
   * Subagent lists are compared by reference: the subagent functions return the same list when nothing changed.
   */
  const save = (row: AgentRow, state: SessionState, next: readonly Subagent[], always = false) => {
    if (!always && state === row.state && next === subagents.of(row.session_id)) return;
    subagents.set(row.session_id, next);
    // A new state is a new ask, or work: either way what was seen is over.
    if (state !== row.state) updateSeen.run(0, row.session_id);
    update.run(state, row.session_id);
    options.broadcast({ type: 'agent.updated', agent: get(row.session_id)! });
  };

  /**
   * Stops a flagged Codex agent once project config appears where Codex would load it: a new chat in its TUI (`/new`,
   * `/fork`) would run that config's hooks without review.
   */
  const stopForProjectConfig = (sessionId: string, path: string) => {
    guards.delete(sessionId);
    updateNotice.run(
      `agent-board stopped this agent: ${path} appeared in its worktree while it ran with ${CODEX_BYPASS_FLAG}, and a ` +
        `new chat in it (/new, /fork) would have run that config's hooks without review. Its work is still in its ` +
        `worktree and branch.`,
      sessionId,
    );
    options.log(`stopping codex agent ${sessionId}: ${path} appeared while it ran with ${CODEX_BYPASS_FLAG}`);
    const agent = get(sessionId);
    if (agent !== undefined) options.broadcast({ type: 'agent.updated', agent });
    sessions.kill(sessionId).catch((error: Error) => options.log(`could not stop ${sessionId}: ${error.message}`));
  };

  /**
   * Starts the agent's harness in `cwd` as session `id`, with a new hook token, and `task` (if any) as its first
   * message. With `resume`, Claude carries on conversation `id`, and Codex conversation `resume.codexSessionId` if it
   * is known (else it starts afresh). Returns whether Codex runs with the hook-trust bypass flag. Throws
   * `AGENT_ERROR.projectCodexConfig` for a Codex agent whose worktree has Codex config, unless allowed.
   */
  const launch = (spec: {
    id: string;
    harness: Harness;
    /** Its model, or null for the harness's default. */
    model: string | null;
    /** The setting of the zone it starts from: Codex starts with `--dangerously-bypass-hook-trust`. */
    bypassHookTrust: boolean;
    /** The zone its tile is in, whose setting says whether it gets the board MCP server; null for loose. */
    zoneId: string | null;
    cwd: string;
    worktree: string;
    task?: string;
    resume?: { codexSessionId: string | null };
    allowProjectCodexConfig: boolean;
    size: TerminalSize;
  }): boolean => {
    const { id, harness, cwd, worktree, task } = spec;
    const token = newToken();
    const boardCli = options.boardCliPath !== undefined && boardMcpOn(spec.zoneId) ? options.boardCliPath : undefined;
    let harnessCommand: HarnessLaunch;
    if (harness === 'claude') {
      const settings = JSON.stringify(claudeSettings(options.hookUrl(), options.permissionHoldMs));
      harnessCommand = {
        command: options.claudeCommand,
        args: [
          spec.resume ? '--resume' : '--session-id',
          id,
          '--settings',
          settings,
          ...(boardCli === undefined ? [] : ['--mcp-config', JSON.stringify(claudeMcpConfig(boardCli))]),
          ...(spec.model === null ? [] : ['--model', spec.model]),
          ...(task === undefined ? [] : ['--', task]),
        ],
      };
    } else {
      const codex = codexLaunch({
        command: options.codexCommand,
        hookShimPath: options.hookShimPath,
        zoneBypassHookTrust: spec.bypassHookTrust,
        boardCli,
        model: spec.model ?? undefined,
        cwd,
        worktree,
        resume: spec.resume?.codexSessionId ?? undefined,
        prompt: task,
      });
      if (codex.projectConfig !== undefined && !spec.allowProjectCodexConfig) {
        throw new RpcMethodError(AGENT_ERROR.projectCodexConfig, projectConfigWarning(codex.projectConfig, options.hookShimPath));
      }
      harnessCommand = codex;
    }
    const { command, args } = harnessLaunch(options.shell, options.shellArgs, cwd, harnessCommand.command, harnessCommand.args);
    // A daemon started from inside Claude Code must not make its agents think they are nested in it.
    const env = { ...options.env };
    delete env.CLAUDECODE;
    sessions.start({
      id,
      harness,
      command,
      args,
      cwd,
      env: sessionEnv(id, env, { [HOOK_TOKEN_ENV]: token, [HOOK_URL_ENV]: options.hookUrl() }),
      zoneId: spec.zoneId,
      ...spec.size,
      hookTokenSha256: hashToken(token),
    });
    return harness === 'codex' && harnessCommand.args.includes(CODEX_BYPASS_FLAG);
  };

  /**
   * Relaunches an ended agent in its worktree as a new session under the same id, back at `idle` until its
   * SessionStart hook: for a scheduled run with its `prompt` (Codex afresh), or, with no prompt, to resume it where
   * the restart stopped it. `codexSessionId` is the Codex conversation to carry on, if any.
   */
  const relaunch = (
    row: AgentRow,
    prompt: string | undefined,
    why: string,
    codexSessionId = prompt === undefined ? row.harness_session_id : null,
  ): RunStart => {
    const sessionId = row.session_id;
    if (!existsSync(row.cwd)) return { started: false, reason: 'its worktree is gone' };
    void endFallbackShell(sessionId);
    if (row.harness === 'codex') {
      try {
        options.ensureHookShim();
      } catch (error) {
        return { started: false, reason: `the Codex hook launcher can't be written: ${(error as Error).message}` };
      }
    }
    // Its repo's zone's setting, wherever its tile sits; with no zone of its repo left, the one it last started with.
    const bypassHookTrust = repoZone(row)?.codex_bypass_hook_trust ?? row.codex_bypass_hook_trust;
    updateBypass.run(bypassHookTrust, sessionId);
    let bypassed: boolean;
    try {
      bypassed = launch({
        id: sessionId,
        harness: row.harness,
        model: row.model,
        bypassHookTrust: bypassHookTrust === 1,
        zoneId: row.zone_id,
        cwd: row.cwd,
        worktree: row.worktree,
        task: prompt,
        resume: { codexSessionId },
        allowProjectCodexConfig: false,
        size: RELAUNCH_SIZE,
      });
    } catch (error) {
      if (error instanceof RpcMethodError && error.code === AGENT_ERROR.projectCodexConfig) {
        return { started: false, reason: 'its worktree has Codex config of its own, so start it by hand to review its hooks' };
      }
      return { started: false, reason: `it could not be relaunched: ${(error as Error).message}` };
    }
    subagents.set(sessionId, []);
    lastMessages.delete(sessionId);
    drafting.delete(sessionId);
    updateNotice.run(null, sessionId);
    update.run('idle', sessionId);
    updateSeen.run(0, sessionId);
    watchResumed(sessionId, row.harness, row.cwd, row.worktree, bypassed, codexSessionId);
    options.log(`relaunched ${row.harness} agent ${sessionId} ${why}`);
    announce(sessionId);
    return { started: true };
  };

  /**
   * After a launch that carries on a conversation: watches a bypassed Codex agent's worktree for project config, and
   * starts a Codex agent afresh if `codex resume` can't carry on `codexSessionId`.
   */
  const watchResumed = (
    sessionId: string,
    harness: Harness,
    cwd: string,
    worktree: string,
    bypassed: boolean,
    codexSessionId: string | null,
  ) => {
    if (bypassed) guards.set(sessionId, guardCodexConfig(cwd, worktree, (path) => stopForProjectConfig(sessionId, path)));
    if (harness === 'codex' && codexSessionId !== null) codexResuming.add(sessionId);
  };

  /**
   * Starts a Codex agent that `codex resume` couldn't carry on (its conversation pruned or deleted) on a new
   * conversation in its worktree, once its old session has finished exiting, and says why on its tile.
   */
  const startAfresh = (sessionId: string) => {
    void sessions.kill(sessionId).then(() => {
      const row = getRow(sessionId);
      if (row === undefined || row.ended_at === null) return;
      const started = relaunch(row, undefined, "afresh: Codex couldn't resume its conversation", null);
      if (!started.started) return options.log(`could not start ${sessionId} afresh: ${started.reason}`);
      updateNotice.run("Codex couldn't resume its conversation, so it started a new conversation in the same worktree.", sessionId);
      announce(sessionId);
    }, (error: Error) => options.log(`could not start ${sessionId} afresh: ${error.message}`));
  };

  /**
   * Drops the ended agent's pane into the user's login shell in its folder, under its last output, once its session
   * has finished exiting (and its screen is saved). Not while it is being deleted or relaunched, or the daemon closes,
   * nor for an ephemeral reviewer, which the daemon itself stops once its review is in.
   */
  const startFallbackShell = (sessionId: string) => {
    void sessions.kill(sessionId).then(() => {
      const row = getRow(sessionId);
      if (closed || deleting.has(sessionId) || row === undefined || row.ended_at === null || row.review_of !== null || fallbackShells.has(sessionId)) return;
      if (!existsSync(row.cwd)) return;
      const saved = sessions.savedScreen(sessionId);
      const size = saved === undefined ? RELAUNCH_SIZE : { cols: saved.cols, rows: saved.rows };
      const restore = saved === undefined ? '' : `${saved.data}${RESET_MODES}\r\n`;
      const shell = sessions.createShell({ ...size, cwd: row.cwd, restore, zoneId: row.zone_id });
      fallbackShells.set(sessionId, shell.id);
      fallbackOwners.set(shell.id, sessionId);
      announce(sessionId);
    }).catch((error: Error) => options.log(`could not open a shell for ${sessionId}: ${error.message}`));
  };

  /** Ends the shell the agent's pane dropped into, if any, and resolves once it has exited. */
  const endFallbackShell = async (sessionId: string): Promise<void> => {
    const shellId = fallbackShells.get(sessionId);
    if (shellId === undefined) return;
    fallbackShells.delete(sessionId);
    fallbackOwners.delete(shellId);
    await sessions.kill(shellId).catch((error: Error) => options.log(`could not end the shell ${shellId}: ${error.message}`));
    sessions.forget(shellId);
  };

  const announce = (sessionId: string) => {
    const agent = get(sessionId);
    if (agent !== undefined) options.broadcast({ type: 'agent.updated', agent });
  };

  /** Choosing a free branch and creating it run one at a time per repo, so two spawns never pick the same name. */
  const inRepoQueue = keyedQueue();

  /** Names given to agents still being spawned, so two spawns at once never both take the same `new-agent-N`. */
  const reservedNames = new Set<string>();

  /** The lowest `new-agent-N` no agent is called, or is being given: what an agent started with no task is named. */
  const freeAgentName = (): string => {
    const taken = new Set([...(selectNames.all() as { name: string }[]).map((row) => row.name), ...reservedNames]);
    let n = 1;
    while (taken.has(`new-agent-${n}`)) n += 1;
    return `new-agent-${n}`;
  };

  /**
   * The repo a new agent's worktree is cut from, and the folder in it the agent starts in: the repo it was given (a
   * new scratch repo named after it, or a folder in a repo), else its zone's, else its group's default repo. `undo`
   * removes a scratch repo made for it, for a spawn that fails after.
   */
  const agentRepo = async (
    params: SpawnAgentParams,
    zone: ZoneRow | undefined,
    name: string,
  ): Promise<{ repoRoot: string; folder: string; undo?: () => Promise<void> }> => {
    const { repo } = params;
    if (repo !== undefined && 'scratch' in repo) {
      mkdirSync(options.scratchDir, { recursive: true });
      const slug = nameSlug(name);
      let path = join(options.scratchDir, slug);
      for (let n = 2; existsSync(path); n++) path = join(options.scratchDir, `${slug}-${n}`);
      const { repoRoot, undo } = await initProject(path);
      return { repoRoot, folder: '', undo };
    }
    if (repo !== undefined) {
      if (!isAbsolute(repo.path)) throw invalidParams(`repo path must be absolute, got ${repo.path}`);
      return resolveZoneFolder(repo.path);
    }
    if (zone === undefined) throw invalidParams('pick a repo to start the agent in');
    if (zone.repo_root !== null) return { repoRoot: zone.repo_root, folder: zone.folder };
    if (zone.clone_repo !== null) {
      throw invalidParams(`${zone.name} is still cloning ${zone.clone_repo}: start agents once it has finished`);
    }
    if (zone.default_repo !== null) return resolveZoneFolder(zone.default_repo);
    throw invalidParams(`${zone.name} has no repo: pick one to start the agent in`);
  };

  /** The zone a new agent's issue comes from: `issueZoneId`, else its own; it must have a tracker. */
  const issueZone = (params: SpawnAgentParams, zone: ZoneRow | undefined): string => {
    const id = params.issueZoneId ?? zone?.id;
    const from = id === undefined ? undefined : (selectZone.get(id) as ZoneRow | undefined);
    if (from === undefined || from.tracker_provider === null) throw invalidParams('only a zone with a tracker starts agents from issues');
    return from.id;
  };

  return {
    nextName: freeAgentName,

    async spawn(params, spawnedBy) {
      const { zoneId, harness = 'claude', prompt = '', name, issueId, allowProjectCodexConfig = false, position, cols, rows } = params;
      const zone = zoneId === null ? undefined : (selectZone.get(zoneId) as ZoneRow | undefined);
      if (zoneId !== null && zone === undefined) throw invalidParams(`no zone ${zoneId}`);
      if (zoneId === null && position === undefined) throw invalidParams('an agent loose on the board needs a position');
      if (harness !== 'claude' && harness !== 'codex') throw invalidParams(`unknown harness ${String(harness)}`);
      const model = params.model?.trim() || null;
      // Passed to the harness as an argument: never an option of its own.
      if (model !== null && !MODEL_NAME.test(model)) throw invalidParams(`${model} is not a model name`);
      if (params.role !== undefined && !AGENT_ROLES.includes(params.role)) throw invalidParams(`unknown role ${String(params.role)}`);
      if (params.orchestrate !== undefined && !ORCHESTRATE_SCOPES.includes(params.orchestrate)) {
        throw invalidParams(`unknown orchestrate scope ${String(params.orchestrate)}`);
      }
      // An orchestrator's agents never orchestrate (ADR-0011). The user's may, as asked or as their zone lets them.
      const zoneGrants = spawnedBy === undefined && params.orchestrate === undefined && zone?.agents_orchestrate === 1;
      const orchestrate = spawnedBy === undefined ? (params.orchestrate ?? (zoneGrants ? 'zone' : null)) : null;
      // A typed branch is checked before anything is made for the agent, a scratch repo included.
      const typedBranch = params.branch === undefined ? undefined : await checkedBranchName(params.branch).catch(wrapInvalid);
      // Its base reaches git only as `refs/heads/<base>`; checked all the same, so no name is ever read as an option.
      if (params.baseBranch !== undefined) await checkedBranchName(params.baseBranch).catch(wrapInvalid);
      const fromZone = issueId === undefined ? undefined : issueZone(params, zone);
      if (harness === 'codex') {
        try {
          options.ensureHookShim();
        } catch (error) {
          throw invalidParams(`can't write the Codex hook launcher ${options.hookShimPath}: ${(error as Error).message}`);
        }
      }
      // Started from an issue: the issue comes first in its prompt, and names its branch.
      const fromIssue = fromZone === undefined || issueId === undefined ? undefined : await options.trackers.issue(fromZone, issueId);
      const task = [fromIssue && issuePrompt(fromIssue.issue), prompt.trim()].filter(Boolean).join('\n\n');
      // Named after its issue as people write it in its scope (`#34`, not `acme/app#34`), else after its task, else
      // `new-agent-N` when it starts at its prompt.
      const agentName =
        name?.trim() ||
        (fromIssue ? defaultName(`${shortIssueId(fromIssue.issue)}: ${fromIssue.issue.title}`) : task === '' ? freeAgentName() : defaultName(task));
      reservedNames.add(agentName);
      // What was made for it so far, undone if it fails to start: its worktree and branch, then any scratch repo.
      const undo: (() => Promise<void>)[] = [];
      try {
        // The tile shows the issue already: describe the work by the typed task, else the issue's own description.
        const description = prompt.trim() || fromIssue?.issue.description.trim() || task;
        const { repoRoot, folder, undo: undoRepo } = await agentRepo(params, zone, agentName);
        if (undoRepo !== undefined) undo.unshift(undoRepo);
        const { branch, worktree, baseCommit } = await inRepoQueue(repoRoot, async () => {
          const branch =
            typedBranch !== undefined
              ? await freeTypedBranch(repoRoot, typedBranch).catch(wrapInvalid)
              : fromIssue
                ? await freeBranchName(repoRoot, fromIssue.branch)
                : agentBranchName(agentName);
          const worktree = agentWorktreePath(options.worktreesDir, repoRoot, branch);
          await addWorktree(repoRoot, worktree, branch, params.baseBranch).catch(wrapInvalid);
          // What its work is reviewed against: the commit it started from.
          const head = await runGit(worktree, ['rev-parse', 'HEAD']);
          return { branch, worktree, baseCommit: head.ok ? head.stdout : null };
        });
        undo.unshift(() => removeWorktree(repoRoot, worktree, branch));
        // A zone-less agent takes the bypass setting of its repo's zone, else the default (on).
        const bypassHookTrust =
          zone?.repo_root === repoRoot ? zone.codex_bypass_hook_trust : (repoZoneFor(zoneId, repoRoot)?.codex_bypass_hook_trust ?? 1);

        const id = randomUUID();
        // A folder zone's folder may be untracked, so missing from the new worktree.
        const cwd = folder === '' ? worktree : join(worktree, folder);
        mkdirSync(cwd, { recursive: true });
        const bypassed = launch({
          id,
          harness,
          model,
          bypassHookTrust: bypassHookTrust === 1,
          zoneId,
          cwd,
          worktree,
          task: task === '' ? undefined : task,
          allowProjectCodexConfig,
          size: { cols, rows },
        });
        // The session already runs, but its hooks can't arrive before this synchronous insert. It is idle until its
        // SessionStart hook says it runs.
        insert.run(
          id,
          zoneId,
          repoRoot,
          bypassHookTrust,
          model,
          params.role ?? null,
          agentName,
          description.slice(0, MAX_DESCRIPTION_LENGTH),
          branch,
          worktree,
          'idle',
          ...issueColumns(fromIssue?.issue ?? null),
          position?.x ?? null,
          position?.y ?? null,
          position === undefined ? null : frontZ(db),
          null,
          baseCommit,
          1,
          null,
          orchestrate,
          spawnedBy ?? null,
        );
        if (zoneGrants) updateOrchestrate.run(orchestrate, zoneId, id);
        // A repo it was given is offered again, once it has an agent in it.
        if (params.repo !== undefined && 'path' in params.repo) options.rememberFolder(folderPath(repoRoot, folder));
        const agent = get(id)!;
        options.log(`spawned ${harness} agent ${id} on ${branch} in ${worktree}${bypassed ? ` with ${CODEX_BYPASS_FLAG}` : ''}`);
        options.broadcast({ type: 'agent.updated', agent });
        if (bypassed) guards.set(id, guardCodexConfig(cwd, worktree, (path) => stopForProjectConfig(id, path)));
        return get(id)!;
      } catch (error) {
        for (const step of undo) await step().catch(() => {});
        throw error;
      } finally {
        reservedNames.delete(agentName);
      }
    },

    async spawnReviewer({ of, name, branch: wanted, prompt, cols, rows }) {
      const implementer = getRow(of);
      if (implementer === undefined) throw invalidParams(`no agent ${of}`);
      const repoRoot = implementer.repo_root;
      const { branch, worktree } = await inRepoQueue(repoRoot, async () => {
        const branch = await freeBranchName(repoRoot, wanted);
        const worktree = agentWorktreePath(options.worktreesDir, repoRoot, branch);
        await addWorktree(repoRoot, worktree, branch, implementer.branch).catch((error: Error) => {
          throw invalidParams(error.message);
        });
        return { branch, worktree };
      });
      const loose = implementer.zone_id === null && implementer.x !== null && implementer.y !== null;
      const id = randomUUID();
      // The folder of its worktree the implementer works in, a folder zone's.
      const cwd = join(worktree, relative(implementer.worktree, implementer.cwd));
      try {
        mkdirSync(cwd, { recursive: true });
        launch({
          id,
          harness: implementer.harness,
          model: implementer.model,
          bypassHookTrust: implementer.codex_bypass_hook_trust === 1,
          zoneId: implementer.zone_id,
          cwd,
          worktree,
          task: prompt,
          allowProjectCodexConfig: false,
          size: { cols, rows },
        });
      } catch (error) {
        await removeWorktree(repoRoot, worktree, branch).catch(() => {});
        throw error;
      }
      insert.run(
        id,
        implementer.zone_id,
        repoRoot,
        implementer.codex_bypass_hook_trust,
        implementer.model,
        'reviewer',
        name,
        `Reviews ${implementer.name}'s work on ${implementer.branch}`.slice(0, MAX_DESCRIPTION_LENGTH),
        branch,
        worktree,
        'idle',
        ...issueColumns(null),
        // Loose on the board with its implementer, it is put just below and right of it; in a zone, the zone lays it out.
        loose ? implementer.x! + REVIEWER_OFFSET : null,
        loose ? implementer.y! + REVIEWER_OFFSET : null,
        loose ? frontZ(db) : null,
        of,
        null,
        1,
        null,
        null,
        null,
      );
      options.log(`spawned ${implementer.harness} reviewer ${id} of ${of} on ${branch} in ${worktree}`);
      announce(id);
      return get(id)!;
    },

    async adopt({ sessionId, harness, name, description, zoneId, position, transcriptPath, place, size }) {
      if (getRow(sessionId) !== undefined) throw invalidParams(`${name} is already an agent`);
      if (harness === 'codex') {
        try {
          options.ensureHookShim();
        } catch (error) {
          throw invalidParams(`can't write the Codex hook launcher ${options.hookShimPath}: ${(error as Error).message}`);
        }
      }
      let undo: (() => Promise<void>) | undefined;
      let at: { cwd: string; worktree: string; repoRoot: string; branch: string; ownsWorktree: boolean };
      if (place.kind === 'in-place') {
        at = { ...place, ownsWorktree: false };
      } else {
        const { repoRoot, base, folder } = place;
        const { branch, worktree } = await inRepoQueue(repoRoot, async () => {
          const branch = await freeBranchName(repoRoot, `${'branch' in base ? base.branch : nameSlug(name)}-resumed`);
          const worktree = agentWorktreePath(options.worktreesDir, repoRoot, branch);
          await addWorktree(repoRoot, worktree, branch, 'branch' in base ? base.branch : base).catch(wrapInvalid);
          return { branch, worktree };
        });
        undo = () => removeWorktree(repoRoot, worktree, branch);
        const cwd = folder === '' ? worktree : join(worktree, folder);
        mkdirSync(cwd, { recursive: true });
        at = { cwd, worktree, repoRoot, branch, ownsWorktree: true };
      }
      const bypassHookTrust = repoZoneFor(zoneId, at.repoRoot)?.codex_bypass_hook_trust ?? 1;
      // Its work from here on is what a review looks at: the commit it carries on from.
      const head = at.branch === '' ? undefined : await runGit(at.worktree, ['rev-parse', 'HEAD']).catch(() => undefined);
      const baseCommit = head?.ok ? head.stdout : null;
      // Codex's own id for its conversation is the session id its hooks reported.
      const codexSessionId = harness === 'codex' ? sessionId : null;
      let bypassed: boolean;
      try {
        if (harness === 'claude' && transcriptPath !== null) carryClaudeTranscript(transcriptPath, at.cwd);
        bypassed = launch({
          id: sessionId,
          harness,
          model: null,
          bypassHookTrust: bypassHookTrust === 1,
          zoneId,
          cwd: at.cwd,
          worktree: at.worktree,
          resume: { codexSessionId },
          allowProjectCodexConfig: false,
          size,
        });
      } catch (error) {
        await undo?.().catch(() => {});
        throw error;
      }
      insert.run(
        sessionId,
        zoneId,
        at.repoRoot,
        bypassHookTrust,
        null,
        null,
        name,
        description.slice(0, MAX_DESCRIPTION_LENGTH),
        at.branch,
        at.worktree,
        'idle',
        ...issueColumns(null),
        position?.x ?? null,
        position?.y ?? null,
        position?.z ?? null,
        null,
        baseCommit,
        at.ownsWorktree ? 1 : 0,
        codexSessionId,
        null,
        null,
      );
      watchResumed(sessionId, harness, at.cwd, at.worktree, bypassed, codexSessionId);
      options.log(`adopted ${harness} session ${sessionId} as an agent in ${at.cwd}`);
      announce(sessionId);
      return get(sessionId)!;
    },

    list: () => (selectAll.all() as unknown as AgentRow[]).map(toAgent),

    get,

    transcript(sessionId, since, generation) {
      const row = requireRow(sessionId);
      return transcripts.read(sessionId, row.harness, row.transcript_path, since, generation);
    },

    subagentTranscript(sessionId, toolUseId, agentId) {
      const row = requireRow(sessionId);
      return transcripts.readSubagent(row.harness, row.transcript_path, toolUseId, agentId);
    },

    isDeleting: (sessionId) => deleting.has(sessionId),

    async delete(sessionId, force, keepWorktree = false) {
      const agent = requireAgent(sessionId);
      // Its own repo, wherever its tile sits.
      const { repoRoot } = agent;
      if (!force && !keepWorktree && agent.ownsWorktree) {
        const reason = await unsavedWork(repoRoot, agent.worktree, agent.branch);
        if (reason !== undefined) throw new RpcMethodError(AGENT_ERROR.unsavedWork, `${agent.name}: ${reason}`);
      }
      guards.get(sessionId)?.stop();
      guards.delete(sessionId);
      deleting.add(sessionId);
      try {
        if (agent.endedAt === null) await sessions.kill(sessionId);
        await endFallbackShell(sessionId);
        await options.endTabs?.(sessionId);
        // An agent adopted in the user's own folder takes nothing of theirs with it.
        if (agent.ownsWorktree && !keepWorktree) await removeWorktree(repoRoot, agent.worktree, agent.branch);
      } finally {
        deleting.delete(sessionId);
      }
      options.schedules.remove(sessionId);
      options.onRemoving(sessionId);
      remove.run(sessionId);
      // The agents it started stay, started by no one now; the activity log keeps who did.
      const children = (selectChildren.all(sessionId) as { session_id: string }[]).map((child) => child.session_id);
      forgetParent.run(sessionId);
      for (const child of children) announce(child);
      sessions.forget(sessionId);
      subagents.delete(sessionId);
      idlePrompted.delete(sessionId);
      drafting.delete(sessionId);
      lastMessages.delete(sessionId);
      handingOff.delete(sessionId);
      permissions.drop(sessionId);
      transcripts.forget(sessionId);
      options.log(`deleted agent ${sessionId}${agent.ownsWorktree ? ` and its worktree ${agent.worktree}` : ''}`);
      options.broadcast({ type: 'agent.removed', sessionId });
    },

    async answer(sessionId, text, paste = false) {
      const agent = requireAgent(sessionId);
      if (agent.endedAt !== null) throw invalidParams(`${agent.name} has ended`);
      // Its state says so while any permission prompt, its own or a subagent's, is pending.
      if (agent.state === 'needs-permission') throw invalidParams(`${agent.name} needs permission first`);
      if (oneLine(text) === '') throw invalidParams('the answer must not be empty');
      await typeInput(sessionId, answerInput(text, paste));
    },

    // An ended agent may have one too: its next run relaunches it.
    setSchedule(sessionId, schedule) {
      requireAgent(sessionId);
      if (schedule === null) options.schedules.remove(sessionId);
      else options.schedules.set(sessionId, schedule);
      announce(sessionId);
      return get(sessionId)!;
    },

    runScheduled(sessionId, prompt) {
      const row = getRow(sessionId);
      if (row === undefined) return { started: false, reason: 'the agent has been deleted' };
      if (row.ended_at !== null) return relaunch(row, prompt, 'for its scheduled run');
      const reason = whyNotReady(row);
      if (reason !== undefined) return { started: false, reason };
      typeLine(sessionId, prompt).catch((error: Error) => options.log(`could not start a run of ${sessionId}: ${error.message}`));
      return { started: true };
    },

    async deliver(from, to, name, text) {
      const row = getRow(to);
      if (row === undefined) return { started: false, reason: 'the agent has been deleted' };
      if (oneLine(text) === '') return { started: false, reason: 'there was nothing to send' };
      const reason = row.ended_at === null ? whyNotReady(row, true) : undefined;
      if (reason !== undefined) return { started: false, reason, busy: true };
      const line = handoffLine(getRow(from)?.name ?? 'another agent', name, text);
      recount(handingOff, from, 1);
      announce(from);
      try {
        if (row.ended_at !== null) return relaunch(row, line, `for a hand-off from ${from}`, row.harness_session_id);
        await typeLine(to, line);
        return { started: true };
      } finally {
        // Deleting `from` meanwhile forgot its count.
        recount(handingOff, from, -1);
        announce(from);
      }
    },

    finalMessage: (sessionId) =>
      (selectFinalMessage.get(sessionId) as { final_message: string | null } | undefined)?.final_message ?? undefined,

    onInput(sessionId, data) {
      if (draftAfterInput(drafting.has(sessionId), data)) drafting.add(sessionId);
      else drafting.delete(sessionId);
    },

    interrupt(sessionId) {
      const agent = requireAgent(sessionId);
      if (agent.endedAt !== null) throw invalidParams(`${agent.name} has ended`);
      if (!INTERRUPTIBLE_STATES.has(agent.state)) throw invalidParams(`${agent.name} has no turn under way to interrupt`);
      sessions.write(sessionId, INTERRUPT_KEY);
      // The turn is over now: Claude fires no hook for an interrupted turn, and the subagents and prompts went with it.
      permissions.drop(sessionId);
      interrupted.add(sessionId);
      save(getRow(sessionId)!, 'idle', subagentsAfterExit(subagents.of(sessionId), 'idle', new Date()), true);
      return get(sessionId)!;
    },

    async stop(sessionId) {
      const agent = requireAgent(sessionId);
      if (agent.endedAt !== null) throw invalidParams(`${agent.name} has already ended`);
      stopping.add(sessionId);
      try {
        await sessions.kill(sessionId);
      } finally {
        stopping.delete(sessionId);
      }
      return get(sessionId)!;
    },

    async resume(sessionId, force) {
      const agent = requireAgent(sessionId);
      if (agent.endedAt === null) throw invalidParams(`${agent.name} is still running`);
      // The daemon ends a reviewer once its review is in, and its round with it: a restart wouldn't reopen the round.
      if (agent.reviewOf !== null && agent.state !== 'stopped-by-restart') throw invalidParams(`${agent.name} is a reviewer whose round is over`);
      // Its session may still be finishing its exit, which a new one under the same id would collide with.
      await sessions.kill(sessionId).catch(() => {});
      const shell = sessions.list().find((session) => session.id === agent.shellSessionId);
      if (shell !== undefined && !force && (await isRunningSomething(shell.pid))) {
        throw new RpcMethodError(AGENT_ERROR.shellBusy, `${agent.name}'s shell is running something`);
      }
      await endFallbackShell(sessionId);
      const row = getRow(sessionId);
      if (row === undefined || row.ended_at === null) return requireAgent(sessionId);
      const why = agent.state === 'stopped-by-restart' ? 'to resume it after a restart' : 'to restart it';
      const resumed = relaunch(row, undefined, why);
      if (!resumed.started) throw invalidParams(`${agent.name} can't be resumed: ${resumed.reason}`);
      return get(sessionId)!;
    },

    decidePermission(sessionId, requestId, decision) {
      const agent = requireAgent(sessionId);
      if (!permissions.decide(sessionId, requestId, decision)) {
        throw new RpcMethodError(AGENT_ERROR.permissionGone, `${agent.name} is no longer waiting on that permission here`);
      }
      // The harness has its answer and carries on (its next hook says how), unless more prompts are pending.
      const pending = permissions.prompts(sessionId).length;
      const row = getRow(sessionId)!;
      permissionSettled.add(sessionId);
      save(row, stateWithPrompts(row.state, { pending, settled: true }), subagents.of(sessionId), true);
    },

    async link(sessionId, issueId) {
      const agent = requireAgent(sessionId);
      const zoneOf = () => {
        const zone = repoZone(getRow(sessionId)!);
        if (zone === undefined) throw invalidParams(`no zone on the board is bound to ${agent.repoRoot}, to take issues from`);
        return zone.id;
      };
      const issue = issueId === null ? null : (await options.trackers.issue(zoneOf(), issueId)).issue;
      updateIssue.run(...issueColumns(issue), sessionId);
      const linked = get(sessionId)!;
      options.broadcast({ type: 'agent.updated', agent: linked });
      return linked;
    },

    move(sessionId, move) {
      const agent = requireAgent(sessionId);
      if (move.zoneId !== null && selectZone.get(move.zoneId) === undefined) throw invalidParams(`no zone ${move.zoneId}`);
      saveMove(db, updatePlace, sessionId, agent.position, move);
      const moved = get(sessionId)!;
      options.broadcast({ type: 'agent.updated', agent: moved });
      return moved;
    },

    markSeen(sessionId) {
      const row = requireRow(sessionId);
      if (row.seen === 0 && waitsForYou(toAgent(row))) {
        updateSeen.run(1, sessionId);
        options.broadcast({ type: 'agent.updated', agent: get(sessionId)! });
      }
      return get(sessionId)!;
    },

    setMuted(sessionId, muted) {
      requireAgent(sessionId);
      updateMuted.run(muted ? 1 : 0, sessionId);
      const agent = get(sessionId)!;
      options.broadcast({ type: 'agent.updated', agent });
      return agent;
    },

    setName(sessionId, name) {
      requireAgent(sessionId);
      updateName.run(name, sessionId);
      const agent = get(sessionId)!;
      options.broadcast({ type: 'agent.updated', agent });
      return agent;
    },

    setStatus(sessionId, summary, progress) {
      requireAgent(sessionId);
      const text = oneLine(summary);
      if (text === '') throw invalidParams('the status summary must not be blank');
      if (text.length > MAX_STATUS_LENGTH) {
        throw invalidParams(`the status summary is ${text.length} characters; at most ${MAX_STATUS_LENGTH}`);
      }
      if (progress !== null && !isStatusProgress(progress)) {
        throw invalidParams('progress must be a whole number from 0 to 100');
      }
      updateStatus.run(text, progress, new Date().toISOString(), sessionId);
      const agent = get(sessionId)!;
      options.broadcast({ type: 'agent.updated', agent });
      return agent;
    },

    setOrchestrate(sessionId, scope) {
      requireAgent(sessionId);
      if (scope !== null && !ORCHESTRATE_SCOPES.includes(scope)) throw invalidParams(`unknown orchestrate scope ${String(scope)}`);
      updateOrchestrate.run(scope, null, sessionId);
      const agent = get(sessionId)!;
      options.broadcast({ type: 'agent.updated', agent });
      return agent;
    },

    zoneOrchestrateChanged(zoneId, on) {
      // The zone's own grants stay, held while it is on (`orchestrateNow`); a grant by hand in it goes for good.
      if (!on) clearHandGrantsIn.run(zoneId);
      for (const { session_id: sessionId } of selectReachedBy.all(zoneId, zoneId) as { session_id: string }[]) {
        options.broadcast({ type: 'agent.updated', agent: get(sessionId)! });
      }
    },

    onHook(sessionId, payload, signal) {
      const row = getRow(sessionId);
      // A hook still in flight when the process exited must not revive the ended agent's state.
      if (row === undefined || row.ended_at !== null) return undefined;
      // Hooks follow the agent's tool calls, so look for config it may have just written, in case a watch missed it.
      guards.get(sessionId)?.check();
      if (payload.hook_event_name === 'SessionStart') codexResuming.delete(sessionId);
      // Codex names its conversation itself: `codex resume` needs that name.
      const conversation = payload.session_id;
      if (payload.hook_event_name === 'SessionStart' && typeof conversation === 'string' && conversation !== row.harness_session_id) {
        updateHarnessSession.run(conversation, sessionId);
      }
      // A subagent's hooks (with its `agent_id`) may name its own transcript: Codex's SubagentStart does.
      const transcript = payload.transcript_path;
      if (payload.agent_id === undefined && typeof transcript === 'string' && transcript !== row.transcript_path) {
        updateTranscript.run(transcript, sessionId);
      }
      if (payload.agent_id === undefined && TURN_BOUNDARIES.has(payload.hook_event_name)) options.onTurnBoundary?.(sessionId);
      if (payload.hook_event_name === 'UserPromptSubmit') {
        interrupted.delete(sessionId);
        drafting.delete(sessionId);
      } else if (interrupted.has(sessionId) && isStaleAfterInterrupt(payload)) return undefined;
      const settled = permissions.afterHook(sessionId, payload);
      const reply = payload.hook_event_name === 'PermissionRequest' ? permissions.hold(sessionId, payload, signal) : undefined;
      if (payload.hook_event_name === 'PermissionRequest') {
        permissionSettled.delete(sessionId);
        // Another prompt is a new ask, even when the state was already needs-permission.
        updateSeen.run(0, sessionId);
      } else if (settled) permissionSettled.add(sessionId);
      // A permission notification landing after its prompt was settled would put the agent back to needs-permission with
      // nothing to answer, until some later hook.
      // The cost: if a later prompt's PermissionRequest never reaches the daemon (a failed hook), its notification is
      // dropped too, and the agent shows its hooks' state until the next hook.
      if (
        payload.hook_event_name === 'Notification' &&
        payload.notification_type === 'permission_prompt' &&
        permissionSettled.has(sessionId) &&
        permissions.prompts(sessionId).length === 0
      ) {
        return undefined;
      }
      const previousMessage = lastMessages.get(sessionId) ?? null;
      const lastMessage = lastMessageAfterHook(previousMessage, payload);
      if (lastMessage === null) lastMessages.delete(sessionId);
      else lastMessages.set(sessionId, lastMessage);
      const next = subagentsAfterHook(subagents.of(sessionId), payload, new Date());
      const pending = permissions.prompts(sessionId).length;
      // An agent started with no task has nothing to run yet: its session starting leaves it idle for its first message.
      const awaitingTask = payload.hook_event_name === 'SessionStart' && row.state === 'idle' && row.description === '';
      const state = stateWithPrompts(awaitingTask ? 'idle' : stateAfterHook(row.harness, row.state, payload), { pending, settled });
      const idlePrompt = payload.hook_event_name === 'Notification' && payload.notification_type === 'idle_prompt';
      if (idlePrompt && row.state === 'idle' && state === 'waiting') idlePrompted.add(sessionId);
      else if (state !== row.state) idlePrompted.delete(sessionId);
      save(row, state, next, settled || reply !== undefined || lastMessage !== previousMessage);
      // Its own turn ended with a final message (a subagent's Stop is SubagentStop): it hands that off.
      const finalMessage = payload.last_assistant_message;
      if (payload.hook_event_name === 'Stop' && payload.agent_id === undefined && typeof finalMessage === 'string') {
        updateFinalMessage.run(finalMessage, sessionId);
        options.onHandoff(sessionId);
      }
      return reply;
    },

    onExit(session) {
      const owner = fallbackOwners.get(session.id);
      if (owner !== undefined) {
        // The shell its pane dropped into has exited: the pane shows the agent's own ended session again.
        fallbackOwners.delete(session.id);
        fallbackShells.delete(owner);
        // Forgotten once its exit has finished: its screen is saved then, and would be written back after a forget now.
        void sessions.kill(session.id).catch(() => {}).then(() => sessions.forget(session.id));
        return announce(owner);
      }
      permissions.drop(session.id);
      permissionSettled.delete(session.id);
      interrupted.delete(session.id);
      guards.get(session.id)?.stop();
      guards.delete(session.id);
      idlePrompted.delete(session.id);
      drafting.delete(session.id);
      const row = getRow(session.id);
      if (row === undefined) return;
      // Always tell clients: the agent has ended even if its state already said so. Stopped by the user is not a failure.
      const state = stopping.has(session.id) ? 'done' : stateAfterExit(row.state, session.exitCode);
      save(row, state, subagentsAfterExit(subagents.of(session.id), state, new Date()), true);
      if (session.stoppedByRestart) codexResuming.delete(session.id);
      else if (codexResuming.delete(session.id) && !stopping.has(session.id)) startAfresh(session.id);
      else startFallbackShell(session.id);
    },

    repoZoneId(sessionId) {
      const row = getRow(sessionId);
      return row && repoZone(row)?.id;
    },

    announce,

    fallbackShellCount: () => fallbackShells.size,

    fallbackOwner: (sessionId) => fallbackOwners.get(sessionId),

    close: () => {
      closed = true;
      permissions.close();
    },
  };
}

/** The `agent.*` RPC handlers. */
export function agentHandlers<Context>(
  agents: AgentHost,
): RpcHandlers<Pick<DaemonMethods, Extract<keyof DaemonMethods, `agent.${string}`>>, Context> {
  return {
    'agent.spawn': (params) => {
      const p = paramsObject(params);
      return agents.spawn({
        zoneId: zoneIdParam(p),
        repo: agentRepoParam(p),
        baseBranch: optionalStringParam(p, 'baseBranch'),
        branch: optionalStringParam(p, 'branch'),
        harness: optionalStringParam(p, 'harness') as Harness | undefined,
        model: optionalStringParam(p, 'model'),
        role: optionalStringParam(p, 'role') as AgentRole | undefined,
        issueZoneId: optionalStringParam(p, 'issueZoneId'),
        allowProjectCodexConfig: optionalBooleanParam(p, 'allowProjectCodexConfig'),
        prompt: optionalStringParam(p, 'prompt'),
        name: optionalStringParam(p, 'name'),
        issueId: optionalStringParam(p, 'issueId'),
        position: optionalPlaceParam(p),
        orchestrate: optionalStringParam(p, 'orchestrate') as OrchestrateScope | undefined,
        cols: dimensionParam(p, 'cols'),
        rows: dimensionParam(p, 'rows'),
      });
    },
    'agent.list': () => agents.list(),
    'agent.transcript': (params) => {
      const p = paramsObject(params);
      return agents.transcript(stringParam(p, 'sessionId'), optionalCountParam(p, 'since') ?? 0, optionalCountParam(p, 'generation'));
    },
    'agent.subagentTranscript': (params) => {
      const p = paramsObject(params);
      return agents.subagentTranscript(stringParam(p, 'sessionId'), stringParam(p, 'toolUseId'), optionalStringParam(p, 'agentId'));
    },
    'agent.nextName': () => ({ name: agents.nextName() }),
    'agent.delete': async (params) => {
      const p = paramsObject(params);
      if (p.force !== undefined && typeof p.force !== 'boolean') throw invalidParams('force must be a boolean');
      if (p.keepWorktree !== undefined && typeof p.keepWorktree !== 'boolean') throw invalidParams('keepWorktree must be a boolean');
      await agents.delete(stringParam(p, 'sessionId'), p.force === true, p.keepWorktree === true);
      return null;
    },
    'agent.answer': async (params) => {
      const p = paramsObject(params);
      await agents.answer(stringParam(p, 'sessionId'), stringParam(p, 'text'), optionalBooleanParam(p, 'paste'));
      return null;
    },
    'agent.interrupt': (params) => agents.interrupt(stringParam(paramsObject(params), 'sessionId')),
    'agent.stop': (params) => agents.stop(stringParam(paramsObject(params), 'sessionId')),
    'agent.resume': (params) => {
      const p = paramsObject(params);
      if (p.force !== undefined && typeof p.force !== 'boolean') throw invalidParams('force must be a boolean');
      return agents.resume(stringParam(p, 'sessionId'), p.force === true);
    },
    'agent.decidePermission': (params) => {
      const p = paramsObject(params);
      const behavior = p.behavior;
      if (behavior !== 'allow' && behavior !== 'deny') throw invalidParams('behavior must be allow or deny');
      const message = optionalStringParam(p, 'message');
      agents.decidePermission(stringParam(p, 'sessionId'), stringParam(p, 'requestId'), { behavior, message });
      return null;
    },
    'agent.link': (params) => {
      const p = paramsObject(params);
      return agents.link(stringParam(p, 'sessionId'), p.issueId === null ? null : stringParam(p, 'issueId'));
    },
    'agent.setSchedule': (params) => {
      const p = paramsObject(params);
      if (p.schedule === null) return agents.setSchedule(stringParam(p, 'sessionId'), null);
      const schedule = paramsObject(p.schedule);
      return agents.setSchedule(stringParam(p, 'sessionId'), {
        cron: stringParam(schedule, 'cron'),
        prompt: stringParam(schedule, 'prompt'),
        enabled: optionalBooleanParam(schedule, 'enabled'),
      });
    },
    'agent.move': (params) => {
      const p = paramsObject(params);
      return agents.move(stringParam(p, 'sessionId'), moveParams(p));
    },
    'agent.setName': (params) => {
      const p = paramsObject(params);
      return agents.setName(stringParam(p, 'sessionId'), requiredNameParam(p, 'name'));
    },
    'agent.setOrchestrate': (params) => {
      const p = paramsObject(params);
      return agents.setOrchestrate(stringParam(p, 'sessionId'), p.scope === null ? null : (stringParam(p, 'scope') as OrchestrateScope));
    },
    'agent.markSeen': (params) => agents.markSeen(stringParam(paramsObject(params), 'sessionId')),
    'agent.setMuted': (params) => {
      const p = paramsObject(params);
      if (typeof p.muted !== 'boolean') throw invalidParams('muted must be a boolean');
      return agents.setMuted(stringParam(p, 'sessionId'), p.muted);
    },
  };
}

/**
 * The `claude --settings` that sends every hook event to the daemon as an `http` hook (ADR-0004). The token is
 * interpolated from the session's environment by Claude, so it never appears on the command line. Claude waits on a
 * PermissionRequest hook a little longer than the daemon holds it (`permissionHoldMs`), so the daemon's no-decision
 * answer, not a timeout, is what hands the prompt back to the terminal.
 */
export function claudeSettings(hookUrl: string, permissionHoldMs: number) {
  const handler = (timeout: number) => ({
    type: 'http',
    url: hookUrl,
    headers: { Authorization: `Bearer $${HOOK_TOKEN_ENV}` },
    allowedEnvVars: [HOOK_TOKEN_ENV],
    timeout,
  });
  const permissionTimeout = Math.ceil(permissionHoldMs / 1000) + PERMISSION_HOOK_MARGIN_S;
  return {
    hooks: Object.fromEntries(
      CLAUDE_HOOK_EVENTS.map((event) => [
        event,
        [{ hooks: [handler(event === 'PermissionRequest' ? permissionTimeout : HOOK_TIMEOUT_S)] }],
      ]),
    ),
  };
}

/** What the board MCP server is called in a harness's MCP config. */
const BOARD_MCP_SERVER = 'agent-board';

/** The board env the MCP server needs (ADR-0010). */
const BOARD_MCP_ENV = [BOARD_SOCKET_ENV, BOARD_TOKEN_ENV, BOARD_SESSION_ENV, BOARD_ZONE_ENV];

/**
 * The `claude --mcp-config` that runs the board MCP server, `agent-board mcp` (ADR-0010). Claude starts it with its own
 * env, which has the board env.
 */
function claudeMcpConfig(boardCli: string) {
  return { mcpServers: { [BOARD_MCP_SERVER]: { type: 'stdio', command: boardCli, args: ['mcp'] } } };
}

/** A harness executable and its arguments. */
interface HarnessLaunch {
  command: string;
  args: string[];
}

export interface CodexLaunchOptions {
  command: string;
  hookShimPath: string;
  /** The zone's setting: start with `--dangerously-bypass-hook-trust`. */
  zoneBypassHookTrust: boolean;
  /** The `agent-board` CLI launcher, to run as the board MCP server (ADR-0010); none without. */
  boardCli?: string;
  /** Where Codex starts, and the worktree it is in. */
  cwd: string;
  worktree: string;
  /** Codex's id for a conversation to carry on (`codex resume <id>`); a new one without. */
  resume?: string;
  /** Its model (`-m`); Codex's default without. */
  model?: string;
  /** The first message; none leaves Codex at its prompt. */
  prompt?: string;
}

/**
 * How to start `codex` for an agent (ADR-0004): every hook event as a `-c` override running the forwarder, the
 * `AGENT_BOARD_HOOK_*` env (hook URL and token) hidden from the model's shell commands, the board MCP server
 * (ADR-0010) when it has `boardCli`, and the hook-trust bypass flag when the zone has it on. Use it for every launch of a Codex agent, a resume included.
 *
 * The flag skips review for every hook in the session, not just ours, and hooks run outside Codex's sandbox. So when
 * the worktree has Codex config of its own where Codex loads it from (the start folder up to the worktree root),
 * Codex is started without the flag, to review that config's hooks itself, and `projectConfig` names it.
 */
export function codexLaunch(options: CodexLaunchOptions): HarnessLaunch & { projectConfig?: string } {
  const hookCommand = codexHookCommand(options.hookShimPath);
  const args = options.resume === undefined ? [] : ['resume', options.resume];
  args.push(...Object.entries(CODEX_HOOK_TIMEOUTS).flatMap(([event, timeout]) => [
    '-c',
    `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(hookCommand)},timeout=${timeout}}]}]`,
  ]));
  // The hook URL and token stay out of the model's shell commands; the board env (ADR-0010) is for them.
  args.push('-c', `shell_environment_policy.exclude=[${JSON.stringify(`${HOOK_ENV_PREFIX}*`)}]`);
  if (options.boardCli !== undefined) {
    // Codex gives an MCP server only a few env vars of its own unless told which others to pass.
    args.push(
      '-c',
      `mcp_servers.${BOARD_MCP_SERVER}.command=${JSON.stringify(options.boardCli)}`,
      '-c',
      `mcp_servers.${BOARD_MCP_SERVER}.args=["mcp"]`,
      '-c',
      `mcp_servers.${BOARD_MCP_SERVER}.env_vars=${JSON.stringify(BOARD_MCP_ENV)}`,
    );
  }
  const projectConfig = projectCodexConfig(options.cwd, options.worktree);
  if (options.zoneBypassHookTrust && projectConfig === undefined) args.push(CODEX_BYPASS_FLAG);
  if (options.model !== undefined) args.push('-m', options.model);
  if (options.prompt !== undefined) args.push('--', options.prompt);
  return projectConfig === undefined ? { command: options.command, args } : { command: options.command, args, projectConfig };
}

/** What the user confirms before a Codex agent starts in a worktree with Codex config of its own. */
function projectConfigWarning(path: string, hookShimPath: string): string {
  return (
    `This worktree has Codex config of its own (${path}). The agent will start without ${CODEX_BYPASS_FLAG}, and ` +
    `Codex will ask you to review hooks in its terminal: that config's hooks are listed with agent-board's, and ` +
    `trusting all of them trusts both. Codex shows each hook's source and command; agent-board's run ` +
    `${codexHookCommand(hookShimPath)}. Read the repo's hooks before you trust them.`
  );
}

/**
 * How to start a harness in `cwd`: through the user's login shell when sessions use one (a daemon started from the
 * Dock has launchd's bare PATH, and the harness usually lives on the profile's), otherwise directly. The script
 * changes back to `cwd`, in case the profile changed directory. A login shell that is neither POSIX nor fish (nu,
 * xonsh, tcsh…) is skipped, and the harness is started directly on the daemon's PATH.
 */
export function harnessLaunch(
  shell: string,
  shellArgs: string[],
  cwd: string,
  command: string,
  args: string[],
): { command: string; args: string[] } {
  const kind = loginShellKind(shell, shellArgs);
  if (kind === undefined) return { command, args };
  // The directory, harness and arguments travel as the script's own arguments, so nothing is quoted into it.
  const script = kind === 'fish' ? 'cd $argv[1]; and exec $argv[2..-1]' : 'cd "$0" && exec "$@"';
  return { command: shell, args: [...shellArgs, '-c', script, cwd, command, ...args] };
}

/** A tile name from a prompt: its first line, cut at a word boundary to at most `MAX_DEFAULT_NAME_LENGTH`. */
export function defaultName(prompt: string): string {
  const line = prompt.split('\n', 1)[0]!.replace(/\s+/g, ' ').trim();
  if (line.length <= MAX_DEFAULT_NAME_LENGTH) return line;
  const cut = line.slice(0, MAX_DEFAULT_NAME_LENGTH);
  const space = cut.lastIndexOf(' ');
  return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Text as one line at a prompt: a line break would submit what came before it on its own. */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** The `issue_provider`, `issue_id`, `issue_title` and `issue_url` columns for an agent's issue, all null for none. */
function issueColumns(issue: LinkedIssue | null): [string | null, string | null, string | null, string | null] {
  return issue === null ? [null, null, null, null] : [issue.provider, issue.id, issue.title, issue.url];
}

/** A spawn's optional `repo`: `{ path }` or `{ scratch: true }`. */
function agentRepoParam(fields: Record<string, unknown>): AgentRepo | undefined {
  if (fields.repo === undefined) return undefined;
  const repo = paramsObject(fields.repo);
  if (repo.scratch === true) return { scratch: true };
  return { path: stringParam(repo, 'path') };
}

/** A failure of git's, or of a check, as the spawn's refusal. */
function wrapInvalid(error: Error): never {
  throw invalidParams(error.message);
}
