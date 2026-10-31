import type { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import type { PullRequest } from '@agent-board/tracker';
import { createAgentRecordStore, guessedDocOf, recordHandlers, type AgentRecordStore } from './agent-records.ts';
import { runGit } from './git.ts';
import { stateAfterExit } from './claude-state.ts';
import { createAgentLifecycle } from './agent-lifecycle.ts';
import { systemClock, type Clock } from './clock.ts';
import { createComposerWatch } from './codex-screen.ts';
import { createAgentSpawns, issueColumns, type FolderPlace } from './agent-spawns.ts';
import type { StartChange } from './agent-starts.ts';
import { createDeliveries, type AfterTurn, type Answered, type UnsentSent } from './deliveries.ts';
import { createHookStates } from './hook-states.ts';
import { answerTrustScreen, readStartupScreen, screenTail, type StartupScreen } from './startup-screen.ts';
import { type HarnessPaths } from './harness-path.ts';
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
import type { AskHost } from './asks.ts';
import type { DocumentHost } from './documents.ts';
import { createPermissionHolds, stateWithPrompts, type HookReply } from './permissions.ts';
import {
  AGENT_ERROR,
  DEFAULT_REVIEW_CAP,
  INTERRUPT_KEY,
  isMidTurn,
  pauseRefusal,
  waitsOnUser,
  isStatusProgress,
  MAX_CREW_DEPTH,
  MAX_FLAG_LENGTH,
  MAX_STATUS_LENGTH,
  type Agent,
  type AgentRepo,
  type AgentStart,
  type AgentRole,
  type AgentState,
  type DaemonEvent,
  type Harness,
  type TileMove,
  type AgentFlag,
  type UndeliveredMessage,
  type DaemonMethods,
  ORCHESTRATE_SCOPES,
  type OrchestrateScope,
  type PermissionDecision,
  type LinkedIssue,
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
import type { SessionHost } from './sessions.ts';
import { createBackgroundCommands } from './background-commands.ts';
import { createQuietTurns, QUIET_TURN_MS, readTranscriptTail, showsIdlePrompt, turnEndedInTranscript } from './quiet-turns.ts';
import { createSubagentStore, subagentsAfterExit } from './subagents.ts';
import { oneLine, submitsDraft } from './terminal-input.ts';
import { isWorking, statusAfterTurn } from './turn-status.ts';
import { createTranscriptReader } from './transcripts.ts';
import type { TrackerHost } from './trackers.ts';
import { moveParams, optionalPlaceParam, saveMove, tilePosition, zoneIdParam, type PositionColumns } from './tile-position.ts';
import type { RoleTemplates } from './role-templates.ts';
import { inGroupFolder } from './zones.ts';

/**
 * How long a relaunched agent's session gets to say it is up (its `SessionStart`) before its tile offers its first prompt
 * to send by hand: as long as a starting one gets (`STARTING_MAX_MS`).
 */
const FIRST_PROMPT_STALL_MS = 60_000;
/**
 * The flag an agent's first prompt raises once its session is given up on saying it is up, its screen neither Claude's
 * trust screen nor its prompt: what the terminal shows follows it.
 */
const STALLED_FIRST_PROMPT =
  "its session never said it was up, so its first prompt isn't typed and messages to it wait: answer its terminal, or press Send on its tile. Its terminal shows: ";
/** The flag an agent with no first prompt raises once its session is given up on saying it is up (`STALLED_FIRST_PROMPT`). */
const STALLED_START =
  "its session never said it was up, so messages to it wait: answer what its terminal shows, or type at its prompt. Its terminal shows: ";

/** How long after output a starting agent's screen is read for Claude's trust screen or its prompt, at most. */
const PROBE_MS = 250;

/** How long a trust screen answered by its zone's setting may take to leave the screen before the user is asked. */
const TRUST_GONE_WAIT_MS = 3_000;

/** The agent's hooks after which its branch is read: not the ones before a tool runs or that only notify. */
const BRANCH_HOOKS = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']);

/** The agent's own hooks that begin a turn, or end one with no `Stop` after them (`onTurnBoundary`). */
const TURN_BOUNDARIES: ReadonlySet<unknown> = new Set(['UserPromptSubmit', 'StopFailure', 'Interrupt', 'SessionEnd']);

/**
 * Hooks of an agent's own turn, which only fire once a prompt was taken: one after something was typed at its prompt
 * says that it was, even when its `UserPromptSubmit` was lost.
 */
const TURN_HOOKS: ReadonlySet<unknown> = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop', 'StopFailure', 'Interrupt']);

/** The hooks that end the agent's own turn: by its `Stop`, failed (a rate limit too), or interrupted (Codex's). */
const TURN_ENDS: ReadonlySet<unknown> = new Set(['Stop', 'StopFailure', 'Interrupt']);

/** The states of an agent at work in a turn, which only a hook (or an interrupt) ends. */
const AT_WORK: ReadonlySet<SessionState> = new Set(['running', 'thinking']);

export interface AgentHostOptions {
  db: DatabaseSync;
  /** The time `starting` gives up by: the system clock by default. */
  clock?: Clock;
  /** How often agents at their prompt are looked at for commands left running: 5 s by default. */
  backgroundPollMs?: number;
  sessions: SessionHost;
  /** Where agent worktrees go (ADR-0007). */
  worktreesDir: string;
  /** Where a deleted reviewer's review is copied, for the follow-up reviewers of its branch. */
  reviewsDir: string;
  /** Where an agent asked for a scratch repo gets one, named after it (ADR-0007). */
  scratchDir: string;
  /** Where groups' own folders are (`groupFolder`): an agent in a group with no repo runs in the group's. */
  groupsDir: string;
  /** Remembers a folder an agent was started from, so pickers offer it again. */
  rememberFolder(path: string): void;
  /** The harness executables, as absolute paths: what an agent is launched with, never a name looked up at launch. */
  harnessPaths: HarnessPaths;
  /** The stable launcher Codex's hook command runs (`writeHookShim`). */
  hookShimPath: string;
  /** Makes sure the launcher is there and runs this app; throws if it can't be written. */
  ensureHookShim(): void;
  /**
   * The `agent-board` CLI launcher (ADR-0010), which the board MCP's instructions send agents to. Agents get the board
   * MCP unless their zone turns it off; no agent gets it without the CLI.
   */
  boardCliPath?: string;
  /** The context size Claude agents compact at (`DaemonSettings.compactWindow`), read as each starts; 0 for Claude's own. */
  compactWindow: () => number;
  /** Whether Claude agents get `FORCE_HYPERLINK=1` (`DaemonSettings.clickableLinks`), read as each starts. */
  clickableLinks: () => boolean;
  /** The environment harness sessions start from. */
  env: NodeJS.ProcessEnv;
  /** The user's shell and its arguments. A login shell (`-l`) also launches the harness, so it gets the profile's PATH. */
  shell: string;
  shellArgs: string[];
  /** The hook ingress's URL. */
  hookUrl(): string;
  /** The board MCP's URL, on the hook ingress (ADR-0010). */
  boardMcpUrl(): string;
  /** How long a PermissionRequest hook is held for an inbox answer before the harness's own prompt takes over. */
  permissionHoldMs: number;
  /** How long a step of an agent's start may wait on another process: `START_STEP_TIMEOUT_MS` by default. */
  startStepTimeoutMs?: number;
  /** How long Enter first gets to start a turn of a message typed at an agent's prompt before it is pressed again. */
  submitConfirmMs?: number;
  /** The zones' trackers, where agents started from or linked to an issue get it. */
  trackers: Pick<TrackerHost, 'issue'>;
  /** The pull requests made from the agent's branch, as last seen. */
  pullRequests(sessionId: string): readonly PullRequest[];
  /** The pull requests of branches it pushed to, as last seen: for its tile alone. */
  pushedPullRequests(sessionId: string): readonly PullRequest[];
  /** The pull requests it recorded that are neither of those, as last seen: for its sidebar. */
  recordedPullRequests?(sessionId: string): readonly PullRequest[];
  /** Long-lived agents' cron schedules (the clocks that message them), and the clock runs fresh agents do. */
  schedules: Pick<ScheduleHost, 'forAgent' | 'runOf'>;
  /** The zones' role templates, which an agent started in a role begins with. */
  roleTemplates: Pick<RoleTemplates, 'body' | 'describe'>;
  /** Hears an agent hand off: today, its own turn ending with a final message (its Stop hook). */
  onHandoff(sessionId: string): void;
  /**
   * Hears an agent's own turn begin (`UserPromptSubmit`) or end without a `Stop` (`StopFailure`, Codex's `Interrupt`,
   * `SessionEnd`): what it handed off explicitly belongs to the turn it did it in.
   */
  onTurnBoundary?(sessionId: string): void;
  /** An agent's branch changed in its worktree: the pull requests of the new one are wanted. */
  onBranchChanged?(sessionId: string): void;
  /** Hears an agent paused for usage started again: what was held for its pause can go now. */
  onWoken?(sessionId: string): void;
  /** Hears an agent about to be deleted, so what goes with it can say so first: its flow edges. */
  onRemoving(sessionId: string): void;
  /** The questions and plans agents wait on the user for: while one does, it is `waiting`. */
  asks?: Pick<AskHost, 'pendingAsk' | 'latestPlan' | 'drop'>;
  /** The documents agents show the user. */
  documents?: Pick<DocumentHost, 'list'>;
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

export interface AgentHost {
  /** Re-reads the branch of every agent's worktree, resolving once each is stored: the board lists them fresh. */
  refreshBranches(): Promise<void>;
  /** Re-reads one agent's branch from its worktree, as above. */
  refreshBranch(sessionId: string): Promise<void>;
  /** Whether the agent is being deleted: from the start of `delete` until its row is gone, its worktree too. */
  isDeleting(sessionId: string): boolean;
  /** Starts an agent; `spawnedBy` is the orchestrator starting it, if one is. */
  spawn(params: SpawnAgentParams, spawnedBy?: string, place?: FolderPlace, used?: { template: string | null }): Promise<Agent>;
  /** Starts an agent as `spawn` does, settling as soon as its tile is on the board (`agent.start`). */
  start(params: SpawnAgentParams): Promise<{ sessionId: string }>;
  /** The agents being started, and the starts that failed (`AgentStart`). */
  starts(): AgentStart[];
  /**
   * Runs a failed start again: one that failed before its agent was made, from the beginning; an agent whose harness
   * exited before its first hook, relaunched in its worktree with the first message it was started with.
   */
  retryStart(sessionId: string, allowProjectCodexConfig: boolean): void;
  /** Renames or moves the tile of an agent being started; once it is an agent, the agent's. */
  updateStart(sessionId: string, change: StartChange): void;
  /** Takes a start off the board, stopping one still going before its session would run; a start not known is over. */
  dismissStart(sessionId: string): void;
  /** Dismisses the starts whose tiles are in the zone, as it is removed. */
  dismissStartsIn(zoneId: string): void;
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
  /**
   * Ends the agent and removes its worktree and branch, or with `keepWorktree` leaves them, and the work in them, alone;
   * with `keepBranch` it removes the worktree but keeps the branch. `why` says who asked, for the log.
   */
  delete(sessionId: string, why: string, force: boolean, keepWorktree?: boolean, keepBranch?: boolean): Promise<void>;
  /** Its conversation from its transcript (`TranscriptReader.read`), for the chat view. */
  transcript(sessionId: string, since: number, generation?: number): Promise<TranscriptChunk>;
  /** A Claude subagent's conversation (`TranscriptReader.readSubagent`), started by its call `toolUseId`. */
  subagentTranscript(sessionId: string, toolUseId: string, agentId?: string): Promise<TranscriptChunk>;
  /** Links the agent to an issue in its repo zone's tracker (`repoZoneOf`), or unlinks it with null. */
  link(sessionId: string, issueId: string | null): Promise<Agent>;
  /** Mutes the agent's OS notifications, or unmutes them. */
  setMuted(sessionId: string, muted: boolean): Agent;
  /**
   * Marks the agent's current ask seen, if it has one: it stops needing the user until it works and asks again. Its
   * flag, if it has one, goes: the user has looked.
   */
  markSeen(sessionId: string): Agent;
  /**
   * Flags the live agent for a look (`Agent.flag`), replacing any flag it had: `reason` trimmed to one line, at most
   * `MAX_FLAG_LENGTH`; `via` the crew member an orchestrator passes on, by name.
   */
  flag(sessionId: string, reason: string, via: string | null): Agent;
  /** Drops the agent's flag, if it has one. */
  clearFlag(sessionId: string): Agent;
  /** Renames the agent's tile. */
  setName(sessionId: string, name: string): Agent;
  /**
   * Sets what the agent says it is doing now (ADR-0010), replacing what was there: a summary, trimmed and at most
   * `MAX_STATUS_LENGTH`, and a progress 0-100 or null.
   */
  setStatus(sessionId: string, summary: string, progress: number | null, done?: boolean, setBy?: string | null): Agent;
  /** Whether the live agent went waiting after its turn ended, so sits at its prompt asking nothing (`createHookStates`'s). */
  waitsAtPrompt(sessionId: string): boolean;
  /** Notes that the agent says its work is finished (`Agent.workFinishedAt`), until its next prompt. */
  markFinished(sessionId: string): Agent;
  /** Lets the agent orchestrate in `scope`, or stops it with null. */
  setOrchestrate(sessionId: string, scope: OrchestrateScope | null): Agent;
  /**
   * Why the agent may not orchestrate, beyond its zone (`notOrchestratingReason`): whether the user turned it off, and
   * how deep in a crew it is (0 for one the user started).
   */
  orchestrateFacts(sessionId: string): { off: boolean; depth: number };
  /**
   * Hears a zone's `agentsOrchestrate` change. Off, it stops every agent in it orchestrating (a grant by hand goes for
   * good), and on, they do again; tells the clients of each.
   */
  zoneOrchestrateChanged(zoneId: string, on: boolean): void;
  /** Moves the agent's tile within its zone, into any other, or out onto the board. Only its tile moves. */
  move(sessionId: string, move: TileMove): Agent;
  /** The zone of the agent's own repo that speaks for it (`repoZoneOf`), if any. */
  repoZoneId(sessionId: string): string | undefined;
  /**
   * Sends `text` to the agent as the user's next message, after any answer to it still being typed: its line breaks
   * kept, pasted as a terminal pastes them, and pasted even as one line with `paste`. Resolves with how it went.
   */
  answer(sessionId: string, text: string, paste?: boolean): Promise<Answered>;
  /**
   * Keeps a message for the live agent mid-turn until a turn of its ends, then types it, after any kept before it
   * (`Agent.messagesWaiting`); handed back as not delivered if it ends or the daemon closes first.
   */
  queueAfterTurn(sessionId: string, item: AfterTurn): void;
  /** Types the next message kept for the agent's turn to end, if it is ready for it now (call on each change of it). */
  deliverAfterTurn(sessionId: string): void;
  /**
   * Interrupts the agent's turn, as Ctrl-C in its terminal would, and returns it idle at its prompt with its permission
   * prompts released. Refuses an ended agent and one with no turn under way.
   */
  interrupt(sessionId: string, why: string): Agent;
  /**
   * Resumes the rate-limited Claude agent's turn on usage credits (`agent.continueOnCredits`), and resolves with it once
   * that turn starts. `why` says who asked, for the log. Refuses a Codex agent, and one not stopped by its usage limit.
   */
  continueOnCredits(sessionId: string, why: string): Promise<Agent>;
  /**
   * Ends the agent's session, keeping its worktree and branch, and resolves with it `done`. `why` says who asked, for
   * the log line of its exit.
   */
  stop(sessionId: string, why: string): Promise<Agent>;
  /**
   * Pauses the live agent between turns (`hibernated`): ends its session as `stop` does, its conversation kept to
   * carry on when it wakes. `by` is the session id of the orchestrator that paused it, or null for the user; `why`
   * says who asked, for the log. Refuses one mid-turn, waiting on you, with the user typing or a message never sent
   * at its prompt, or with a message being typed or sent to it.
   */
  pause(sessionId: string, by: string | null, why: string, reason?: string): Promise<Agent>;
  /**
   * Starts an ended agent (stopped by restart, or exited) again in its worktree, carrying on its conversation with no
   * new prompt: Claude with `--resume`, Codex with `codex resume` (or afresh if it can't). Ends the shell its pane
   * dropped into, refusing with `shellBusy` while that runs something, unless `force`. Refuses a running agent.
   * With `fresh` it starts a new conversation under a new harness session id instead (the old one goes to
   * `Agent.earlierConversations`), on `fresh.prompt` if given. `why` says who asked, for the log.
   */
  resume(sessionId: string, why: string, force: boolean, fresh?: { prompt?: string }): Promise<Agent>;
  /** Answers one of the agent's held permission prompts. */
  decidePermission(sessionId: string, requestId: string, decision: PermissionDecision): void;
  /**
   * Starts a scheduled run. An agent sitting at its prompt (idle, or after a failed turn) gets `prompt` as its next
   * message. An ended agent is relaunched in its worktree with `prompt`: Claude resumes its conversation, Codex starts
   * a new one unless it was paused (a hand-off resumes it). The run is skipped, saying why, while the agent is still working, rate-limited, waiting for you (on a
   * permission prompt, or its last message asks you something) or you are typing at its prompt.
   */
  runScheduled(sessionId: string, prompt: string): RunStart;
  /**
   * Delivers `text`, the payload `name` (`final message`, `plan.md`, `review, round 1`), from agent `from` to agent
   * `to` as `to`'s next message, headed with both, as a scheduled run does (relaunching an ended `to`, resuming its
   * conversation whichever the harness, skipping one that can't take it now, saying why), `from` showing `handing-off` until it has landed.
   */
  deliver(from: string, to: string, name: string, text: string): Promise<RunStart>;
  /**
   * Types `text` for the board at the live agent's prompt, once it is ready for its next message, as a hand-off is
   * (`whyNotReady`): never into a turn, a question or the user's half-typed line. Not started, busy, otherwise.
   */
  tell(to: string, text: string): Promise<RunStart>;
  /** The agent's final message from the turn it last finished, if it has finished one. */
  finalMessage(sessionId: string): string | undefined;
  /** Hears what a client typed into the agent's terminal, so a run never adds to a draft at its prompt. */
  onInput(sessionId: string, data: string): void;
  /**
   * Presses Enter on the message typed at the agent's prompt and never sent (`Agent.unsent`), as the user asked (or,
   * `byUser` false, an orchestrator), and resolves with the agent and how it went.
   */
  sendUnsent(sessionId: string, byUser?: boolean): Promise<{ agent: Agent; sent: UnsentSent }>;
  /**
   * Clears the message typed at the agent's prompt and never sent (`Agent.unsent`), as the user asked; or, `byUser`
   * false, an orchestrator, refused while the user is typing there.
   */
  clearUnsent(sessionId: string, byUser?: boolean): Agent;
  /**
   * Sends again, in order, what was sent to the agent before its session was up and never typed (`Agent.undelivered`),
   * as the user asked: as messages, an ended agent started again with the first. What can't be sent stays.
   */
  resendUndelivered(sessionId: string): Promise<Agent>;
  /** Forgets what was never delivered to the agent (`Agent.undelivered`), and its flag, as the user asked. */
  clearUndelivered(sessionId: string): Agent;
  /**
   * Types the first prompt its session never said it was up for (`Agent.untypedPrompt`), as the user asked: never
   * while Claude's trust screen is up.
   */
  typeFirstPrompt(sessionId: string): Promise<Agent>;
  /**
   * Answers Claude's trust screen (`Agent.trustFolder`) with `Yes, I trust this folder`, as the user asked: moves its
   * pointer there and presses Enter only once the screen shows it there. Its first prompt is then typed once its
   * session is up.
   */
  trustFolder(sessionId: string): Promise<Agent>;
  /**
   * Moves the session's agent, if it has one, and its subagents on a hook call. Resolves with the hook's reply: a
   * PermissionRequest is held open until the user decides in the inbox, or the hold lapses (`signal` aborts if the
   * harness hangs up first).
   */
  onHook(sessionId: string, payload: Record<string, unknown>, signal: AbortSignal): HookReply | Promise<HookReply>;
  /** Settles the session's agent, if it has one, once its process has exited. */
  onExit(session: SessionInfo): void;
  /** The agent's session printed something: an agent still `starting` with no hook for a while stops being. */
  onOutput(sessionId: string): void;
  /** Tells every client about the agent, if it still exists, after something it shows changed. */
  announce(sessionId: string): void;
  /** What agents recorded about their own work (`Agent.records`). */
  records: AgentRecordStore;
  /**
   * Tells every client the agent began (`began`) or stopped waiting on a question or plan. One beginning is a
   * new ask: what the user saw of its last is over.
   */
  waitChanged(sessionId: string, began: boolean): void;
  /**
   * How many ended agents' panes have a shell open now. Those shells are not live sessions to the user, so they don't
   * keep the daemon up or make `daemon.stop` ask (ADR-0002); shutting down ends them with the rest.
   */
  fallbackShellCount(): number;
  /** The ended agent whose pane dropped into the shell session `sessionId`, if it is one. */
  fallbackOwner(sessionId: string): string | undefined;
  /** Tells clients of the agent whose fallback shell this is, if any: what runs in the shell changed. */
  onShellChanged(shellId: string): void;
  /** Releases held hooks, and keeps what was queued for agents not up yet as undelivered; call before the database closes. */
  close(): void;
}

/** A row of `agent_conversations`: a conversation left behind by a fresh restart. */
interface ConversationRow {
  harness_session_id: string;
  transcript_path: string | null;
  ended_at: string;
}

export interface AgentRow extends PositionColumns {
  session_id: string;
  /** Null for a tile loose on the board. */
  zone_id: string | null;
  repo_root: string;
  /** The Codex setting it last started with from a zone of its repo. */
  codex_bypass_hook_trust: number;
  harness: Harness;
  model: string | null;
  role: AgentRole | null;
  role_name: string | null;
  name: string;
  description: string;
  branch: string;
  /** The other branch its worktree is on after a checkout, null while on `branch`, the one it owns. */
  current_branch: string | null;
  /** 1 while its worktree's HEAD is detached: the last branch it was on stays. */
  detached: number;
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
  /** When its own turn last ended with a final message (migration 0049). */
  finished_at: string | null;
  review_cap: number | null;
  /** 0 for an agent adopted in a folder of the user's, whose worktree and branch deleting it leaves alone. */
  owns_worktree: number;
  /** 1 for an agent that may change nothing where it runs (`FolderPlace.readOnly`). */
  read_only: number;
  /** 1 for the Captain (migration 0060): at most one agent. */
  master: number;
  /** 1 for an agent started in a group's folder of the user's, outside git (migration 0065): `Agent.plainFolder`. */
  plain_folder: number;
  /** Whether its zone's setting answered Claude's trust screen for it (`Agent.trustedByZone`). */
  trusted_by_zone: number;
  /** A reviewer's: the branch it reviews, and the commit it checked out detached. Null for any other agent. */
  reviews_branch: string | null;
  reviews_head: string | null;
  /** Its status (`setStatus`): all null until it sets one. */
  status_summary: string | null;
  status_progress: number | null;
  status_updated_at: string | null;
  status_set_by: string | null;
  /** When it was paused, and the session id of the orchestrator that paused it (null for the user): `Agent.hibernated`. */
  hibernated_at: string | null;
  hibernated_by: string | null;
  hibernated_reason: string | null;
  /** When it said its work is finished (`Agent.workFinishedAt`), or null. */
  work_finished_at: string | null;
  /** The scope the user let it orchestrate in by hand, or null to follow its zone's switch. */
  orchestrate: OrchestrateScope | null;
  /** 1 once the user turned it off: no zone lets it orchestrate then, until the user turns it on. */
  orchestrate_off: number;
  spawned_by: string | null;
  /** How deep in a crew it was started (0 for the user's), fixed at spawn: removing an agent above it never lowers it. */
  crew_depth: number;
}

/** A review of a branch (`branch_reviews`): what it reviewed, and its reviewer or the copy kept of its review. */
export interface BranchReviewRow {
  id: number;
  repo_root: string;
  branch: string;
  head: string;
  session_id: string | null;
  review_path: string | null;
}

export interface ZoneRow {
  id: string;
  name: string;
  /** Null while the zone is unbound: its agents start in its default repo, or the repo they are given. */
  repo_root: string | null;
  /** An unbound zone's default repo, or null. */
  default_repo: string | null;
  /** A group's folder of the user's, outside git, or null for the one the app makes (`Zone.groupFolder`). */
  group_folder: string | null;
  /** The repo it is cloning, while it is: it is unbound until the clone finishes. */
  clone_repo: string | null;
  folder: string;
  codex_bypass_hook_trust: number;
  trusts_folder: number;
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
    'id, name, repo_root, folder, default_repo, group_folder, codex_bypass_hook_trust, trusts_folder, board_mcp, agents_orchestrate, tracker_provider, clone_repo, created_at';
  const selectZone = db.prepare(`SELECT ${zoneColumns} FROM zones WHERE id = ?`);
  const selectZones = db.prepare(`SELECT ${zoneColumns} FROM zones`);
  const updatePlace = db.prepare('UPDATE agents SET zone_id = ?, x = ?, y = ?, z = ? WHERE session_id = ?');
  const update = db.prepare('UPDATE agents SET state = ? WHERE session_id = ?');
  const updateTrustedByZone = db.prepare('UPDATE agents SET trusted_by_zone = 1 WHERE session_id = ?');
  const updateMuted = db.prepare('UPDATE agents SET muted = ? WHERE session_id = ?');
  const updateSeen = db.prepare('UPDATE agents SET seen = ? WHERE session_id = ?');
  const updateBranch = db.prepare('UPDATE agents SET branch = ?, current_branch = ?, detached = ? WHERE session_id = ?');
  const updateName = db.prepare('UPDATE agents SET name = ? WHERE session_id = ?');
  // The Captain was named "Board master" before it was called the Captain: an unchanged name follows (a name the user chose stays).
  db.prepare("UPDATE agents SET name = 'Captain' WHERE master = 1 AND name = 'Board master'").run();
  const updateStatus = db.prepare(
    'UPDATE agents SET status_summary = ?, status_progress = ?, status_updated_at = ?, status_set_by = ? WHERE session_id = ?',
  );
  const updateFinished = db.prepare('UPDATE agents SET work_finished_at = ? WHERE session_id = ?');
  const updateOrchestrate = db.prepare('UPDATE agents SET orchestrate = ?, orchestrate_off = ? WHERE session_id = ?');
  /** The agents a zone's setting reaches: those in it. */
  const selectReachedBy = db.prepare('SELECT session_id FROM agents WHERE zone_id = ?');
  /** The agents in a zone the user let orchestrate by hand: not the Captain, whose scope is what it is (ADR-0019). */
  const clearHandGrantsIn = db.prepare('UPDATE agents SET orchestrate = NULL WHERE zone_id = ? AND orchestrate IS NOT NULL AND master = 0');
  const updateHarnessSession = db.prepare('UPDATE agents SET harness_session_id = ? WHERE session_id = ?');
  const selectConversations = db.prepare(
    'SELECT harness_session_id, transcript_path, ended_at FROM agent_conversations WHERE session_id = ? ORDER BY id',
  );
  const updateTranscript = db.prepare('UPDATE agents SET transcript_path = ? WHERE session_id = ?');
  const transcripts = createTranscriptReader((sessionId) => options.broadcast({ type: 'agent.transcriptChanged', sessionId }));
  const updateIssue = db.prepare(
    'UPDATE agents SET issue_provider = ?, issue_id = ?, issue_title = ?, issue_url = ? WHERE session_id = ?',
  );

  const subagents = createSubagentStore();
  const records = createAgentRecordStore(db);
  /**
   * The final message of each agent's last finished turn (its Stop's `last_assistant_message`), which a manual edge
   * sends. Unlike its last message (`hookStates`) a new prompt keeps it: it is still the last finished turn's. Kept in
   * its row, so it outlives the daemon.
   */
  const updateFinalMessage = db.prepare("UPDATE agents SET final_message = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE session_id = ?");
  const selectFinalMessage = db.prepare('SELECT final_message FROM agents WHERE session_id = ?');
  const permissions = createPermissionHolds({
    holdMs: options.permissionHoldMs,
    onChange(sessionId) {
      const agent = get(sessionId);
      if (agent !== undefined) options.broadcast({ type: 'agent.updated', agent });
    },
  });
  /** What times the agent host's own waits: the system clock by default. */
  const clock = options.clock ?? systemClock;
  /** A flag as kept (`flags`): `Agent.flag` without who it reaches, which `forUser` decides. */
  type StoredFlag = Omit<AgentFlag, 'to'> & { forUser?: boolean; keepsEnded?: boolean };
  /**
   * Each live agent's flag (`Agent.flag`), without who it reaches (`forUser` when only the user can answer it, never its
   * orchestrator): in memory, as its session ending clears it, but for one that outlives it (`keepsEnded`: what was
   * never delivered to it, which only the user resends).
   */
  const flags = new Map<string, StoredFlag>();
  /**
   * A flag that stands in place of the one the agent had (`replaced`), its reason going on in this one's
   * (`base`, then `. Also: <its reason>`), to stand again once this one's condition is over: what was never delivered,
   * and what sits unsent at its prompt. Each may stand in place of the other, so each forgets the other's once it ends.
   */
  interface Folding {
    id: number;
    base: string;
    at: string;
    keepsEnded: boolean;
    replaced?: StoredFlag;
  }
  /** The flag `folding` shows: its own reason, then the one it stands in place of. */
  const foldedFlag = (folding: Folding): StoredFlag => {
    const also = folding.replaced === undefined ? '' : `. Also: ${folding.replaced.reason}`;
    const reason = `${folding.base}${also}`.slice(0, MAX_FLAG_LENGTH);
    return { id: folding.id, reason, at: folding.at, via: null, forUser: true, ...(folding.keepsEnded ? { keepsEnded: true } : {}) };
  };
  /** The agent's foldings now: what was never delivered to it, and what sits unsent at its prompt. */
  const foldingsOf = (sessionId: string): Folding[] =>
    [undelivered.get(sessionId), notSentFlags.get(sessionId)].filter((folding): folding is Folding => folding !== undefined);
  /**
   * Shows `folding` as it is now, if it stands, and in every other folding that stands in place of it, so none keeps
   * an old copy of it.
   */
  const refreshFolding = (sessionId: string, folding: Folding, seen = new Set<number>()) => {
    if (seen.has(folding.id)) return;
    seen.add(folding.id);
    const shown = foldedFlag(folding);
    if (flags.get(sessionId)?.id === folding.id) flags.set(sessionId, shown);
    for (const other of foldingsOf(sessionId)) {
      if (other !== folding && other.replaced?.id === folding.id) {
        other.replaced = shown;
        refreshFolding(sessionId, other, seen);
      }
    }
  };
  /**
   * The flag `goneId` is over: a folding that stood in place of it stands in place of `instead` now (what that one stood
   * in place of), or of nothing.
   */
  const unfold = (sessionId: string, goneId: number, instead: StoredFlag | undefined) => {
    for (const folding of foldingsOf(sessionId)) {
      if (folding.replaced?.id !== goneId) continue;
      if (instead === undefined) delete folding.replaced;
      else folding.replaced = instead;
      refreshFolding(sessionId, folding);
    }
  };
  /**
   * Raises `base` as a folding's flag, in place of `before` (the folding it was, if any): a flag the agent already had
   * goes on in its reason (`Folding`). One whose `before` the other folding stands in place of stays under it, where
   * that one shows it (the caller's `unfold`): on top, each would stand in place of the other.
   */
  const raiseFolding = (sessionId: string, before: Folding | undefined, base: string, keepsEnded: boolean, at = new Date().toISOString()): Folding => {
    const standing = flags.get(sessionId);
    const buried = before !== undefined && foldingsOf(sessionId).some((other) => other !== before && other.replaced?.id === before.id);
    const replaced = standing !== undefined && standing.id !== before?.id && !buried ? standing : before?.replaced;
    const folding: Folding = { id: ++lastFlagId, base, at, keepsEnded, ...(replaced === undefined ? {} : { replaced }) };
    if (!buried) flags.set(sessionId, foldedFlag(folding));
    return folding;
  };
  /**
   * Takes down `folding`, whose condition is over: the flag it stood in place of stands again while the agent is live,
   * if it still stood, and a folding standing in place of it stands in place of that one now (`unfold`).
   */
  const lowerFolding = (sessionId: string, folding: Folding) => {
    if (flags.get(sessionId)?.id === folding.id) {
      if (folding.replaced !== undefined && getRow(sessionId)?.ended_at === null) flags.set(sessionId, folding.replaced);
      else flags.delete(sessionId);
    }
    unfold(sessionId, folding.id, folding.replaced);
    resurface(sessionId);
  };
  /** The flag the agent's foldings stand in place of that is none of them: its own, or why its start stalled. */
  const underFoldings = (sessionId: string): StoredFlag | undefined => {
    const foldings = foldingsOf(sessionId);
    return foldings.map((folding) => folding.replaced).find((flag) => flag !== undefined && !foldings.some((folding) => folding.id === flag.id));
  };
  /**
   * Shows again the foldings whose condition still holds but that no flag shows, once the flag that stood in place of
   * them (the agent's own) has gone: the newest on top, standing in place of the other. Only what was never delivered
   * once the agent has ended (`ended`). While a flag that is no folding stands, they wait for it to go.
   */
  const resurface = (sessionId: string, ended = getRow(sessionId)?.ended_at !== null) => {
    const shown = flags.get(sessionId);
    const foldings = foldingsOf(sessionId).filter((folding) => !ended || folding.keepsEnded);
    const top = foldings.find((folding) => folding.id === shown?.id);
    if (shown !== undefined && top === undefined) return;
    const hidden = foldings.filter((folding) => folding !== top && !foldings.some((other) => other.replaced?.id === folding.id)).sort((a, b) => b.id - a.id);
    const head = top ?? hidden.shift();
    if (head === undefined) return;
    const other = hidden[0];
    if (other !== undefined && head.replaced === undefined) {
      head.replaced = foldedFlag(other);
      refreshFolding(sessionId, head);
    }
    if (top === undefined) flags.set(sessionId, foldedFlag(head));
  };
  /**
   * Per agent, what was sent to it and never typed (`Agent.undelivered`): before its session was up, or mid-turn, oldest first, and
   * the flag that says so (`Folding`): kept, in the database too, until the user resends or clears it, so the daemon
   * shows it again once it restarts.
   */
  const undelivered = new Map<string, Folding & { items: UndeliveredMessage[] }>();
  const insertUndelivered = db.prepare('INSERT INTO undelivered_messages (session_id, what, text, reason, at) VALUES (?, ?, ?, ?, ?)');
  const deleteUndelivered = db.prepare('DELETE FROM undelivered_messages WHERE session_id = ?');
  const selectUndelivered = db.prepare('SELECT session_id, what, text, reason, at FROM undelivered_messages ORDER BY id');
  /**
   * Raises the flag that says `items` were never delivered to the agent, the last at `at`, in place of the one before
   * (`keepUndelivered`).
   */
  const flagUndelivered = (sessionId: string, items: UndeliveredMessage[], at: string) => {
    const before = undelivered.get(sessionId);
    const lost = items.length === 1 ? items[0]!.what : `${items.length} messages`;
    const base = `${lost} ${items.length === 1 ? 'was' : 'were'} not delivered (${items.at(-1)!.reason}): Resend on its tile`;
    const folding = raiseFolding(sessionId, before, base, true, at);
    undelivered.set(sessionId, { ...folding, items });
    if (before !== undefined) unfold(sessionId, before.id, foldedFlag(undelivered.get(sessionId)!));
  };
  /**
   * Hands back what was queued for the agent and never typed: kept for Resend, and flagged to the user. A flag the agent
   * already had (its own words, or why its start stalled) is kept: its reason goes on in this flag's, and it stands
   * again once what was not delivered is resent or cleared, unless it has gone meanwhile.
   */
  const keepUndelivered = (sessionId: string, what: string, text: string, reason: string) => {
    if (getRow(sessionId) === undefined) return;
    options.log(`${what} sent to ${sessionId} before it was up was not delivered: ${reason}`);
    const at = new Date().toISOString();
    insertUndelivered.run(sessionId, what, text, reason, at);
    flagUndelivered(sessionId, [...(undelivered.get(sessionId)?.items ?? []), { what, text, reason }], at);
    announce(sessionId);
  };
  /**
   * Forgets what was never delivered to the agent, and the flag that said so if it still stands, putting back the flag
   * it held before (`keepUndelivered`) while the agent is live.
   */
  const dropUndelivered = (sessionId: string) => {
    const kept = undelivered.get(sessionId);
    if (kept === undefined) return [];
    undelivered.delete(sessionId);
    deleteUndelivered.run(sessionId);
    lowerFolding(sessionId, kept);
    return kept.items;
  };
  /**
   * Takes down the flag `flagId` a waiting first prompt raised, if it still stands, and forgets it as the flag a
   * folding holds to put back (`unfold`): what it said is over.
   */
  const takeDownFirstPromptFlag = (sessionId: string, flagId: number | null) => {
    if (flagId === null) return;
    if (flags.get(sessionId)?.id === flagId) flags.delete(sessionId);
    unfold(sessionId, flagId, undefined);
    resurface(sessionId);
  };
  /** The last flag's id: each new one is the next. */
  let lastFlagId = 0;
  /** Per agent, the flag that says what was typed at its prompt was never sent (`flagNotSent`, a `Folding`). */
  const notSentFlags = new Map<string, Folding>();
  // What was never delivered before the daemon last closed is flagged again, as it was: once every folding's state is
  // declared, as raising one reads them all (`foldingsOf`).
  const keptUndelivered = Map.groupBy(
    selectUndelivered.all() as unknown as (UndeliveredMessage & { session_id: string; at: string })[],
    (row) => row.session_id,
  );
  for (const [sessionId, rows] of keptUndelivered) {
    flagUndelivered(sessionId, rows.map(({ what, text, reason }) => ({ what, text, reason })), rows.at(-1)!.at);
  }
  /**
   * Tells the user that `what` was typed at the agent's prompt and given up on, and `why`: only their Send or Clear
   * (in its terminal, `inTerminal`, when they typed there) moves it on. A flag the agent already had is kept: its
   * reason goes on in this flag's, and it stands again once the message is sent or cleared, unless it has gone
   * meanwhile. With no `what`, takes this flag down: the prompt holds nothing unsent now.
   */
  const flagNotSent = (sessionId: string, what?: string, why?: string, inTerminal = false) => {
    const before = notSentFlags.get(sessionId);
    if (what === undefined) {
      if (before === undefined) return;
      notSentFlags.delete(sessionId);
      lowerFolding(sessionId, before);
      return;
    }
    const where = inTerminal ? 'send or clear it in its terminal' : 'Send or Clear it on its tile';
    const folding = raiseFolding(sessionId, before, `${what} was typed at its prompt but not sent (${why}): ${where}`, false);
    notSentFlags.set(sessionId, folding);
    if (before !== undefined) unfold(sessionId, before.id, foldedFlag(folding));
  };
  /**
   * Per agent launched whose session isn't up yet: its first prompt not yet typed, if it has one, its harness, what settles whether to type it
   * (true once its session is up: Claude's `SessionStart`, or its prompt seen on its screen once it stalled or its
   * trust screen was answered; Codex's composer drawn up (`codexComposerUp`); or on the user's Send; false once that
   * session ends or the agent is deleted), whether its session has been given up on saying it is up (`stalled`): its
   * tile then offers the prompt to send, whether a Claude agent's screen shows Claude's trust screen (`trust`), or did
   * (`trusted`), whether its zone's setting has tried to answer that screen (`zoneTried`: once, then the user's flag), whether a Codex agent's screen is watched for its composer (`watchScreen`), and the flag it raised
   * (`flagId`), which asks for a look.
   */
  const firstPrompts = new Map<
    string,
    {
      prompt: string | undefined;
      harness: Harness;
      settle: (ready: boolean) => void;
      stalled: boolean;
      trust: boolean;
      trusted: boolean;
      zoneTried: boolean;
      flagId: number | null;
      cancel: () => void;
      watchScreen: boolean;
    }
  >();
  type FirstPrompt = typeof firstPrompts extends Map<string, infer Entry> ? Entry : never;
  const settleFirstPrompt = (sessionId: string, ready: boolean) => {
    const entry = firstPrompts.get(sessionId);
    if (entry === undefined) return;
    firstPrompts.delete(sessionId);
    entry.cancel();
    composerWatch.forget(sessionId);
    entry.settle(ready);
    // Its flag goes with it, unless the agent has flagged something of its own since.
    takeDownFirstPromptFlag(sessionId, entry.flagId);
    if (entry.stalled) announce(sessionId);
  };
  /**
   * Raises `reason` as the flag of the agent whose first prompt waits (`entry`), in place of the one it raised before,
   * unless the agent has flagged something of its own, which stays, as its own words. `forUser` sends it to the user
   * even when the agent has an orchestrator.
   */
  const flagFirstPrompt = (sessionId: string, entry: FirstPrompt, reason: string, forUser = false) => {
    if (flags.has(sessionId) && flags.get(sessionId)!.id !== entry.flagId) return;
    entry.flagId = ++lastFlagId;
    flags.set(sessionId, { id: entry.flagId, reason: reason.slice(0, MAX_FLAG_LENGTH), at: new Date().toISOString(), via: null, forUser });
  };
  /** The flag the agent whose session never said it was up raises, with what its terminal shows (`lines`). */
  const stalledFlag = (entry: FirstPrompt, lines: readonly string[]) =>
    `${entry.prompt === undefined ? STALLED_START : STALLED_FIRST_PROMPT}${screenTail(lines) || 'nothing'}`;
  /** Takes down the flag the agent's waiting first prompt raised, if it is still up. */
  const unflagFirstPrompt = (sessionId: string, entry: FirstPrompt) => {
    takeDownFirstPromptFlag(sessionId, entry.flagId);
    entry.flagId = null;
  };
  /**
   * Reads the screen of the agent whose first prompt waits, and acts on it (`readStartupScreen`). Claude's trust
   * screen flags the user: it asks whether to trust the folder, which only the user decides (Trust folder, or their
   * own keys in its terminal), never its orchestrator, and nothing is typed there, as Enter would pick `No, exit`. Its
   * prompt, once the agent has stalled or its trust screen was answered, gets the first prompt typed: its session is
   * up though no `SessionStart` said so. `SessionStart` stays what types it otherwise, so a prompt drawn as Claude
   * starts is never typed at ahead of its hooks (`stalling`: it is being given up on now). Resolves with what the
   * screen showed, or undefined if the prompt went meanwhile.
   */
  const probeFirstPrompt = async (sessionId: string, stalling = false) => {
    const entry = firstPrompts.get(sessionId);
    if (entry === undefined) return undefined;
    const lines = await sessions.screenLines(sessionId);
    if (lines === null || firstPrompts.get(sessionId) !== entry) return undefined;
    // Codex's screens are its composer watch's to read (`createComposerWatch`): only what it shows is of use here.
    if (entry.harness !== 'claude') return { screen: { kind: 'other' } as StartupScreen, lines };
    const screen = readStartupScreen(lines);
    if (screen.kind === 'trust') {
      // Its zone's setting is answering it, or the user's flag is up already.
      if (entry.trust || trusting.has(sessionId)) return { screen, lines };
      if (!entry.zoneTried && zoneTrusts(sessionId)) {
        entry.zoneTried = true;
        if (await trustByZone(sessionId, entry)) return { screen, lines };
        if (firstPrompts.get(sessionId) !== entry) return undefined;
      }
      entry.trust = true;
      const row = getRow(sessionId);
      options.log(`${sessionId} shows Claude's trust screen: its first prompt waits for the user to answer it`);
      flagFirstPrompt(sessionId, entry, `Claude is asking whether to trust this folder: ${row?.cwd ?? 'its folder'}`, true);
      announce(sessionId);
      return { screen, lines };
    }
    if (entry.trust) {
      entry.trust = false;
      entry.trusted = true;
      options.log(`${sessionId}'s trust screen was answered`);
      unflagFirstPrompt(sessionId, entry);
      announce(sessionId);
      // Claude may be mid-redraw now: a screen that is neither is only flagged if a later read still finds it so.
      if (screen.kind === 'other') return { screen, lines };
    }
    // Given up on already, its trust screen answered, and still neither its prompt nor that screen: it asks for a look.
    if (entry.stalled && entry.trusted && entry.flagId === null && screen.kind === 'other') {
      flagFirstPrompt(sessionId, entry, stalledFlag(entry, lines));
      announce(sessionId);
    }
    if (screen.kind === 'prompt' && (entry.stalled || stalling || entry.trusted)) {
      options.log(`${sessionId} shows its prompt though its session never said it was up: typing its first prompt`);
      settleFirstPrompt(sessionId, true);
    }
    return { screen, lines };
  };
  /** Agents whose trust screen Trust folder, or their zone's setting, is answering: a second click waits for none. */
  const trusting = new Set<string>();
  /** Whether `path` is `dir` or in it. */
  const inside = (path: string, dir: string) => {
    const from = relative(dir, path);
    return from === '' || (!from.startsWith('..') && !isAbsolute(from));
  };
  /**
   * Whether the agent's zone trusts its folder for new agents (`Zone.trustsFolder`) and the agent runs in it: in the
   * zone's own folder or a worktree the app made (ADR-0007), never any other path.
   */
  const zoneTrusts = (sessionId: string): boolean => {
    const row = getRow(sessionId);
    const zone = row === undefined ? undefined : repoZone(row);
    if (row === undefined || zone === undefined || zone.trusts_folder !== 1 || zone.repo_root === null || zone.repo_root !== row.repo_root) return false;
    // The zone's own folder, or that folder in a worktree the app made for this agent (ADR-0007): no other path.
    return (
      inside(row.cwd, folderPath(zone.repo_root, zone.folder)) ||
      (inside(row.worktree, options.worktreesDir) && inside(row.cwd, join(row.worktree, zone.folder)))
    );
  };
  /**
   * Answers the trust screen of the agent whose zone trusts its folder, as Trust folder would (`answerTrustScreen`),
   * and records that its zone's setting did, for its tile. Resolves whether it did; false leaves it to the user's flag.
   */
  const trustByZone = async (sessionId: string, entry: FirstPrompt): Promise<boolean> => {
    trusting.add(sessionId);
    try {
      const refused = await answerTrustScreen({
        screen: () => sessions.screenLines(sessionId),
        write: (data) => sessions.write(sessionId, data),
        wait: (ms) => new Promise<void>((resolve) => void clock.setTimer(resolve, ms)),
      });
      if (refused === 'not-trust') return false;
      if (refused === 'pointer') {
        options.log(`${sessionId}'s zone trusts its folder, but its trust screen did not move to "Yes, I trust this folder": left to the user`);
        return false;
      }
      // Answered: a read of its prompt from now on types the task, though no `SessionStart` has come.
      if (firstPrompts.get(sessionId) === entry) entry.trusted = true;
      // Claude may redraw a moment after Enter: held as answered until its screen leaves the trust screen, so a read
      // meanwhile never flags the user for a screen the setting is answering. If it never leaves, the user's flag.
      // Its first prompt settling meanwhile (its `SessionStart` came) is the screen gone.
      let gone = false;
      for (let waited = 0; ; waited += PROBE_MS) {
        gone = firstPrompts.get(sessionId) !== entry || readStartupScreen((await sessions.screenLines(sessionId)) ?? []).kind !== 'trust';
        if (gone || waited >= TRUST_GONE_WAIT_MS) break;
        await new Promise<void>((resolve) => void clock.setTimer(resolve, PROBE_MS));
      }
      if (!gone) {
        options.log(`${sessionId}'s trust screen is still up after its zone's setting answered it: left to the user`);
        if (firstPrompts.get(sessionId) === entry) entry.trusted = false;
        return false;
      }
      updateTrustedByZone.run(sessionId);
      options.log(`trusted ${sessionId}'s folder by its zone's setting`);
      announce(sessionId);
      // Its prompt may have been drawn while held, its `SessionStart` not yet come: read it again, so it is typed.
      probeSoon(sessionId);
      return true;
    } finally {
      trusting.delete(sessionId);
    }
  };
  /** Per agent, a read of its screen due soon (`probeFirstPrompt`), once for all the output that comes meanwhile. */
  const probesDue = new Set<string>();
  const probeSoon = (sessionId: string) => {
    if (probesDue.has(sessionId) || firstPrompts.get(sessionId)?.harness !== 'claude') return;
    probesDue.add(sessionId);
    clock.setTimer(() => {
      probesDue.delete(sessionId);
      probeFirstPrompt(sessionId).catch((error: unknown) => options.log(`reading ${sessionId}'s screen failed: ${(error as Error).message}`));
    }, PROBE_MS);
  };
  /**
   * The agent's session never said it was up: its screen is read (`probeFirstPrompt`). Unless that types its first
   * prompt or finds Claude's trust screen, the prompt waits, untyped, for its `SessionStart`, its prompt on its screen
   * or the user's Send, and a flag says so, with what its terminal shows, to its orchestrator, else the user (unless
   * the agent has flagged something of its own).
   */
  const stallFirstPrompt = async (sessionId: string) => {
    const entry = firstPrompts.get(sessionId);
    if (entry === undefined || entry.stalled) return;
    // Its trust screen is being answered: look again once that is done, so a hang after it still raises its flag.
    if (trusting.has(sessionId)) return void clock.setTimer(() => stallSoon(sessionId), PROBE_MS);
    const shown = await probeFirstPrompt(sessionId, true);
    // Typed, or given up on by another read meanwhile.
    if (firstPrompts.get(sessionId) !== entry || entry.stalled) return;
    entry.stalled = true;
    if (entry.trust) return announce(sessionId);
    options.log(
      entry.prompt === undefined
        ? `${sessionId}'s session never said it was up: nothing is typed at it until it does`
        : `${sessionId}'s session never said it was up: its first prompt is not typed until it does, or the user sends it`,
    );
    flagFirstPrompt(sessionId, entry, stalledFlag(entry, shown?.lines ?? []));
    announce(sessionId);
  };
  const stallSoon = (sessionId: string) =>
    void stallFirstPrompt(sessionId).catch((error: unknown) => options.log(`reading ${sessionId}'s screen failed: ${(error as Error).message}`));
  /** Codex fires no hook before its first prompt: its screen says when its session is up, its composer drawn. */
  const composerWatch = createComposerWatch(
    (sessionId) => sessions.screenLines(sessionId),
    (sessionId) => {
      // A draft of the user's at its composer is theirs: the task waits until it is sent (a turn) or cleared.
      if (!firstPrompts.has(sessionId) || hookStates.isDrafting(sessionId)) return;
      hookStates.composerUp(sessionId);
      settleFirstPrompt(sessionId, true);
    },
  );
  /** The Codex agent began a turn before its first prompt was typed: that prompt waits for Send, offered now. */
  const stopWatchingScreen = (sessionId: string) => {
    const entry = firstPrompts.get(sessionId);
    if (entry === undefined || !entry.watchScreen) return;
    entry.watchScreen = false;
    composerWatch.forget(sessionId);
    options.log(`${sessionId} began a turn by hand before its first prompt was typed: that prompt waits for Send`);
    stallSoon(sessionId);
  };
  // These are made before anything below: what they are given of it is only reached once the host is built.
  const hookStates = createHookStates<AgentRow>({
    permissions,
    subagents,
    // Due until typed: a `SessionStart` landing as it is typed (its prompt, seen, typed it first) is still its start.
    firstPromptDue: (sessionId): boolean => firstPrompts.get(sessionId)?.prompt !== undefined || deliveries.isTypingFirst(sessionId),
    upByScreen: (sessionId) => firstPrompts.get(sessionId)?.watchScreen === true,
    save: (row, state, next, always) => save(row, state, next, always),
    unsee: (sessionId) => updateSeen.run(0, sessionId),
    log: (message) => options.log(message),
    clock: options.clock ?? systemClock,
    onCommand: (sessionId) => backgroundCommands.of(sessionId).length > 0,
    startingEnded(sessionId) {
      announce(sessionId);
      stallSoon(sessionId);
    },
    recordFinal: (sessionId, finalMessage) => void updateFinalMessage.run(finalMessage, sessionId),
    finished(sessionId) {
      options.onHandoff(sessionId);
    },
  });
  const backgroundCommands = createBackgroundCommands({
    atPrompt: () =>
      (selectAll.all() as unknown as AgentRow[])
        .filter((row) => hookStates.isAtPrompt(row) && !hookStates.isStarting(row.session_id))
        .map((row) => ({ sessionId: row.session_id, harness: row.harness })),
    pidOf: (sessionId) => sessions.list().find((session) => session.id === sessionId && session.endedAt === null)?.pid,
    changed: (sessionId) => announce(sessionId),
    pollMs: options.backgroundPollMs,
    log: options.log,
    hookShimPath: options.hookShimPath,
  });
  const deliveries = createDeliveries({
    write: (sessionId, data) => sessions.write(sessionId, data),
    getRow: (sessionId) => getRow(sessionId),
    requireAgent: (sessionId) => requireAgent(sessionId),
    whyNotReady: hookStates.whyNotReady,
    relaunch: (row, prompt, why, codexSessionId) => lifecycle.relaunch(row, prompt, why, codexSessionId),
    pausing: (sessionId) => lifecycle.pausing(sessionId),
    promptNow(sessionId) {
      const row = getRow(sessionId);
      return row === undefined || row.ended_at !== null ? 'moved-on' : hookStates.promptNow(row);
    },
    announce: (sessionId) => announce(sessionId),
    undelivered: (sessionId, what, text, reason) => keepUndelivered(sessionId, what, text, reason),
    notSent: (sessionId, what, why, inTerminal) => flagNotSent(sessionId, what, why, inTerminal),
    log: options.log,
    // Its waits are the terminal's, in real time: never the schedules' clock, which tests drive by hand.
    submitConfirmMs: options.submitConfirmMs,
  });
  /** Agents the net left waiting on a question since their last saved state: it says so once. */
  const leftWaiting = new Set<string>();
  /**
   * The safety net under a lost `Stop`: a Claude agent at work with no hook and no output for `QUIET_TURN_MS` ended its
   * turn unheard when its transcript says the turn ended (`turnEndedInTranscript`) and its screen shows Claude's prompt
   * between turns (`showsIdlePrompt`). It moves to idle, as that `Stop` would have moved it, and the log says why; else
   * the log says why not, and it is looked at again a spell later. Its final message is not handed on: no hook carried
   * it. The quiet is timed from every state `save` gives it. One waiting on a question of its own (`questionUp`) is
   * timed too: a notification that came with its `Stop` lost, or a dialog of Claude's closed with no hook, leaves it
   * there with its turn over.
   */
  const quietTurns = createQuietTurns({ clock, check: (sessionId) => void endQuietTurn(sessionId) });
  const endQuietTurn = async (sessionId: string) => {
    const generation = quietTurns.generation(sessionId);
    const row = getRow(sessionId);
    // Moved off work some other way than `save` (its lifecycle's own state): nothing to time.
    if (row === undefined || row.ended_at !== null || !(AT_WORK.has(row.state) || questionUp(row))) return quietTurns.stopped(sessionId);
    if (permissions.prompts(sessionId).length > 0) return;
    const quiet = `agent ${sessionId} was ${row.state} with no hook or output for ${QUIET_TURN_MS / 60_000} min`;
    const [lines, ended] = await Promise.all([
      sessions.screenLines(sessionId),
      row.transcript_path === null ? undefined : readTranscriptTail(row.transcript_path).then(turnEndedInTranscript),
    ]);
    // A hook or output while they were read: it is at work after all.
    const now = getRow(sessionId);
    if (lines === null || quietTurns.generation(sessionId) !== generation || now?.state !== row.state) return;
    const why =
      ended === undefined ? 'its transcript says nothing of its turn' : !ended ? 'its transcript shows its turn under way' : !showsIdlePrompt(lines) ? "its screen shows no prompt of Claude's between turns" : undefined;
    if (why !== undefined) {
      // A question really up may stay so for hours: said once a hook, though it is looked at again, as a dialog closed in
      // its terminal brings no hook to say so.
      if (AT_WORK.has(row.state) || !leftWaiting.has(sessionId)) options.log(`${quiet}, but ${why}: left ${AT_WORK.has(row.state) ? 'at work' : 'waiting'}`);
      if (!AT_WORK.has(row.state)) leftWaiting.add(sessionId);
      return;
    }
    const as = AT_WORK.has(row.state) ? 'as the Stop it never sent would have' : 'nothing of its own up';
    options.log(`${quiet}, its transcript says its turn ended and its screen shows Claude's prompt: moved to idle, ${as}`);
    deliveries.turnEnded(sessionId, true);
    save(now, 'idle', subagentsAfterExit(subagents.of(sessionId), 'idle', new Date()), true);
  };
  const startupLines = createStartupLines(options.sessions, (sessionId) => hookStates.isStarting(sessionId), (sessionId) => announce(sessionId));
  const spawns = createAgentSpawns({
    ...options,
    records,
    getRow: (sessionId) => getRow(sessionId),
    get: (sessionId) => get(sessionId),
    rows: () => selectAll.all() as unknown as AgentRow[],
    getZone: (zoneId) => selectZone.get(zoneId) as ZoneRow | undefined,
    repoZoneFor: (zoneId, repoRoot) => repoZoneFor(zoneId, repoRoot),
    announce: (sessionId) => announce(sessionId),
    promptQueued: (sessionId) => hookStates.promptQueued(sessionId),
    typeFirstPrompt(sessionId, prompt, harness) {
      // A launch before this one's session came up (a quick retry) types nothing: this one's prompt is typed instead.
      settleFirstPrompt(sessionId, false);
      const { promise: ready, resolve: settle } = Promise.withResolvers<boolean>();
      // One relaunched (woken, restarted) shows no `starting` to give up: it is given up on after as long.
      const cancel = (options.clock ?? systemClock).setTimer(() => stallSoon(sessionId), FIRST_PROMPT_STALL_MS);
      firstPrompts.set(sessionId, { prompt, harness, settle, stalled: false, trust: false, trusted: false, zoneTried: false, flagId: null, cancel, watchScreen: harness === 'codex' });
      deliveries.firstPrompt(sessionId, prompt, ready);
    },
    watch: (...launched) => lifecycle.watchLaunched(...launched),
  });
  const lifecycle = createAgentLifecycle({
    ...options,
    // What was held for its pause goes once its session is up: typed before, a hand-off is only busy.
    onWoken: (sessionId) =>
      void deliveries.untilUp(sessionId).then(
        () => options.onWoken?.(sessionId),
        (error: Error) => options.log(`could not hand ${sessionId} what was held for its pause: ${error.message}`),
      ),
    getRow: (sessionId) => getRow(sessionId),
    get: (sessionId) => get(sessionId),
    requireAgent: (sessionId) => requireAgent(sessionId),
    repoZone: (row) => repoZone(row),
    announce: (sessionId) => announce(sessionId),
    setState: (sessionId, state) => update.run(state, sessionId),
    unsee: (sessionId) => updateSeen.run(0, sessionId),
    launch: spawns.launch,
    subagents,
    permissions,
    transcripts,
    // What is kept of an agent's start goes with its run, and with it.
    hookStates: {
      relaunched(sessionId) {
        startupLines.forget(sessionId);
        hookStates.relaunched(sessionId);
      },
      deleted(sessionId) {
        quietTurns.stopped(sessionId);
        leftWaiting.delete(sessionId);
        startupLines.forget(sessionId);
        spawns.forget(sessionId);
        settleFirstPrompt(sessionId, false);
        notSentFlags.delete(sessionId);
        undelivered.delete(sessionId);
        flags.delete(sessionId);
        hookStates.deleted(sessionId);
      },
    },
    deliveries,
  });

  /**
   * The state an agent without an enabled schedule shows: `stopped-by-restart` once its daemon went away under it,
   * until it is resumed. (A scheduled one follows its schedule, which relaunches it.)
   */
  const unscheduledState = (row: AgentRow): AgentState =>
    row.ended_at !== null && row.stopped_by_restart === 1 ? 'stopped-by-restart' : row.state;

  /** Whether the agent is paused: ended by a pause, not woken since. */
  const isHibernated = (row: AgentRow) => row.ended_at !== null && row.hibernated_at !== null;

  /** Who paused an agent, by name as it is now: the user (null), or the orchestrator `id`, removed or not. */
  const pausedBy = (id: string | null): { by: string | null; byId: string | null } =>
    id === null ? { by: null, byId: null } : { by: getRow(id)?.name ?? 'a removed orchestrator', byId: id };

  const selectLiveSession = db.prepare('SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL');
  const selectCrew = db.prepare('SELECT session_id FROM agents WHERE spawned_by = ?');

  /** The agent's flag, reaching its orchestrator while that one is live, else the user. */
  const flagOf = (row: AgentRow): AgentFlag | null => {
    const kept = flags.get(row.session_id);
    if (kept === undefined || (row.ended_at !== null && kept.keepsEnded !== true)) return null;
    const { id, reason, at, via, forUser } = kept;
    const led = forUser !== true && row.spawned_by !== null && selectLiveSession.get(row.spawned_by) !== undefined;
    return { id, reason, at, via, to: led ? 'orchestrator' : 'user' };
  };

  const toAgent = (row: AgentRow): Agent => {
    const schedule = options.schedules.forAgent(row.session_id);
    const live = row.ended_at === null;
    const ask = live ? (options.asks?.pendingAsk(row.session_id) ?? null) : null;
    const plan = options.asks?.latestPlan(row.session_id) ?? null;
    // A clock's fresh agent whose turn ended on a question waits for you, as a scheduled one does: its run goes on.
    const clockRunAsking = options.schedules.runOf(row.session_id) !== undefined && hookStates.askingAtPrompt(row);
    const hooked = isHibernated(row) ? 'hibernated' : schedule?.enabled ? hookStates.scheduledState(row) : clockRunAsking ? 'waiting' : unscheduledState(row);
    // Its call waits on the user mid-turn, whatever its hooks say, but for a permission prompt of a subagent's.
    const state = live && waitsOnUser({ ask, plan }) && hooked !== 'needs-permission' ? 'waiting' : hooked;
    // Its first prompt is queued and its session has sent no hook: the turn hasn't begun, which is not idle.
    const starting = live && state === 'idle' && hookStates.isStarting(row.session_id);
    // At its prompt, asking nothing, with a command it left running: its work goes on, and it doesn't wait for you.
    const commands = live && !starting && state === hooked && hookStates.isAtPrompt(row) ? backgroundCommands.of(row.session_id) : [];
    const started = starting ? 'starting' : commands.length > 0 ? 'on-command' : state;
    // One the board stopped as it started (its notice says why) didn't fail to start.
    const startup =
      started === 'starting' || (!live && hookStates.startFailed(row.session_id) && row.notice === null)
        ? { output: startupLines.get(row.session_id), failed: !live }
        : null;
    const shownState =
      deliveries.isHandingOff(row.session_id) && state !== 'waiting' && state !== 'needs-permission' && permissions.prompts(row.session_id).length === 0
        ? 'handing-off'
        : started;
    return {
      sessionId: row.session_id,
      zoneId: row.zone_id,
      position: tilePosition(row),
      repoRoot: row.repo_root,
      harness: row.harness,
      model: row.model,
      role: row.role,
      roleName: row.role_name,
      reviews: row.reviews_branch === null || row.reviews_head === null ? null : { branch: row.reviews_branch, head: row.reviews_head },
      name: row.name,
      description: row.description,
      branch: row.current_branch ?? row.branch,
      ownedBranch: row.branch,
      detached: row.detached === 1,
      worktree: row.worktree,
      cwd: row.cwd,
      // Handing off shows over what it was doing, but never over its needing you: that would take it out of the inbox,
      // and tell you again that it waits when it came back.
      state: shownState,
      notice: row.notice,
      hibernated: isHibernated(row)
        ? { at: row.hibernated_at!, ...pausedBy(row.hibernated_by), ...(row.hibernated_reason === null ? {} : { reason: row.hibernated_reason }) }
        : null,
      earlierConversations: (selectConversations.all(row.session_id) as unknown as ConversationRow[]).map((each) => ({
        conversationId: each.harness_session_id,
        transcriptPath: each.transcript_path,
        endedAt: each.ended_at,
      })),
      status: statusAfterTurn(
        row.status_summary === null || row.status_updated_at === null
          ? null
          : { summary: row.status_summary, progress: row.status_progress, updatedAt: row.status_updated_at, setBy: row.status_set_by },
        isWorking({ state: shownState, ask, plan, endedAt: row.ended_at }),
        // Kept for hand-offs, but of a turn before an interrupted one: no tile shows it as that turn's.
        hookStates.endedOnNoMessage(row.session_id)
          ? undefined
          : (selectFinalMessage.get(row.session_id) as { final_message: string | null } | undefined)?.final_message,
        row.finished_at,
      ),
      workFinishedAt: row.work_finished_at,
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
      shellSessionId: lifecycle.fallbackShell(row.session_id) ?? null,
      shellHarness: lifecycle.shellHarnessOf(row),
      clickableLinks: spawns.hyperlinked(row.session_id) ?? null,
      subagents: [...subagents.of(row.session_id)],
      commands: [...commands],
      pullRequests: [...options.pullRequests(row.session_id)],
      pushedPullRequests: [...options.pushedPullRequests(row.session_id)],
      recordedPullRequests: [...(options.recordedPullRequests?.(row.session_id) ?? [])],
      lastMessage: hookStates.lastMessage(row.session_id) ?? null,
      compactingSince: hookStates.compactingSince(row.session_id) ?? null,
      finishedAt: row.finished_at,
      permissions: permissions.prompts(row.session_id),
      ask,
      plan,
      docs: options.documents?.list(row.session_id) ?? [],
      schedule,
      reviewOf: row.review_of,
      reviewCap: row.review_cap ?? DEFAULT_REVIEW_CAP,
      ownsWorktree: row.owns_worktree === 1,
      master: row.master === 1,
      // Agents in the app's own group folders from before the column are still known by where they run.
      plainFolder: row.plain_folder === 1 || inGroupFolder(options.groupsDir, row.worktree),
      orchestrate: orchestrateNow(row),
      spawnedBy: row.spawned_by,
      records: records.of(row.session_id),
      guessedDoc: guessedDocOf(row.worktree),
      startup,
      flag: flagOf(row),
      unsent: live ? (deliveries.unsent(row.session_id) ?? null) : null,
      untypedPrompt: untypedPromptOf(row.session_id),
      trustFolder: live && firstPrompts.get(row.session_id)?.trust === true ? row.cwd : null,
      trustedByZone: row.trusted_by_zone === 1,
      queuedUntilUp: live ? deliveries.queuedUntilUp(row.session_id) : 0,
      messagesWaiting: live ? deliveries.waitingAfterTurn(row.session_id) : 0,
      undelivered: undelivered.get(row.session_id)?.items ?? [],
    };
  };

  /** The first prompt the agent's tile offers to send: one whose session never said it was up, but not on the trust screen. */
  const untypedPromptOf = (sessionId: string): string | null => {
    const entry = firstPrompts.get(sessionId);
    return entry?.stalled === true && !entry.trust ? (entry.prompt ?? null) : null;
  };

  const getRow = (sessionId: string) => selectOne.get(sessionId) as AgentRow | undefined;

  /**
   * The scope the agent may orchestrate in now (ADR-0011): the user's by hand, if they set one; else `zone` while the
   * zone its tile is in now lets its agents orchestrate, unless the user turned it off, or it is as deep in a crew as
   * an agent may be (`MAX_CREW_DEPTH`).
   */
  const orchestrateNow = (row: AgentRow): OrchestrateScope | null => {
    if (row.orchestrate !== null) return row.orchestrate;
    if (row.orchestrate_off === 1 || row.zone_id === null) return null;
    const zone = selectZone.get(row.zone_id) as ZoneRow | undefined;
    return zone?.agents_orchestrate === 1 && row.crew_depth < MAX_CREW_DEPTH - 1 ? 'zone' : null;
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

  /** Whether the live agent waits on a question or dialog of its own, in its turn: not at its prompt. */
  const questionUp = (row: AgentRow) => row.state === 'waiting' && hookStates.promptNow(row) === 'moved-on';

  /**
   * Records the agent's new state and subagents and tells every client; unless `always`, only if either changed.
   * Subagent lists are compared by reference: the subagent functions return the same list when nothing changed.
   */
  const save = (row: AgentRow, state: SessionState, next: readonly Subagent[], always = false) => {
    leftWaiting.delete(row.session_id);
    // Every state given it, however it came (a hook, a decision on the board): at work, or on a question, its quiet starts now.
    if (row.harness === 'claude' && (AT_WORK.has(state) || questionUp({ ...row, state }))) quietTurns.working(row.session_id);
    else quietTurns.stopped(row.session_id);
    if (!always && state === row.state && next === subagents.of(row.session_id)) return;
    subagents.set(row.session_id, next);
    // A new state is a new ask, or work: either way what was seen is over.
    if (state !== row.state) updateSeen.run(0, row.session_id);
    update.run(state, row.session_id);
    options.broadcast({ type: 'agent.updated', agent: get(row.session_id)! });
  };

  /** Each agent's branch reads: the last one queued, and whether it has yet to start. */
  const branchReads = new Map<string, { tail: Promise<void>; waiting: boolean }>();

  /** Longest a git read of an agent's branch may take. */
  const BRANCH_READ_MS = 5000;

  /** Whether `branch` was made by renaming `from`: its reflog, which `git branch -m` moves with it, says so. */
  const renamedFrom = async (worktree: string, from: string, branch: string): Promise<boolean> => {
    const log = await runGit(worktree, ['reflog', 'show', '--format=%gs', `refs/heads/${branch}`], BRANCH_READ_MS);
    return log.ok && log.stdout.split('\n').some((line) => line.startsWith(`Branch: renamed refs/heads/${from} to `));
  };

  const readBranch = async (sessionId: string): Promise<void> => {
    const row = getRow(sessionId);
    if (row === undefined || row.branch === '' || row.reviews_branch !== null || !existsSync(row.worktree)) return;
    const head = await runGit(row.worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD'], BRANCH_READ_MS);
    const detached = !head.ok;
    // Not a failure to read git, but a HEAD on no branch; any other failure leaves it as it was.
    if (detached && head.stderr !== '') return;
    let owned = row.branch;
    let current: string | null = row.current_branch;
    if (!detached) {
      const name = head.stdout;
      if (name === '') return;
      if (name === owned) current = null;
      // Its own ref gone: it is renamed only if git says this branch was renamed from it (`git branch -m` carries the
      // reflog over). Any other branch it is on is not its own: it stays unowned, so closing deletes none but its own.
      else if (
        !(await runGit(row.worktree, ['rev-parse', '--verify', '--quiet', `refs/heads/${owned}`], BRANCH_READ_MS)).ok &&
        (await renamedFrom(row.worktree, owned, name))
      ) {
        owned = name;
        current = null;
      } else current = name;
    }
    const now = getRow(sessionId);
    if (now === undefined || (owned === now.branch && current === now.current_branch && detached === (now.detached === 1))) return;
    updateBranch.run(owned, current, detached ? 1 : 0, sessionId);
    announce(sessionId);
    if ((current ?? owned) !== (now.current_branch ?? now.branch)) options.onBranchChanged?.(sessionId);
  };

  /**
   * Follows the branch the agent's worktree is on now: it may have renamed it, checked out another or
   * detached. Reads of one agent run one at a time; one asked for while another runs waits for it, and every asker
   * before it starts shares it, so the answer is never older than the asking.
   */
  const refreshBranch = (sessionId: string): Promise<void> => {
    let reads = branchReads.get(sessionId);
    if (reads === undefined) {
      reads = { tail: Promise.resolve(), waiting: false };
      branchReads.set(sessionId, reads);
    }
    const entry = reads;
    if (entry.waiting) return entry.tail;
    entry.waiting = true;
    const mine: Promise<void> = entry.tail
      .then(() => {
        entry.waiting = false;
        return readBranch(sessionId);
      })
      .catch((error: Error) => options.log(`could not read the branch of ${sessionId}: ${error.message}`))
      .finally(() => {
        if (!entry.waiting && entry.tail === mine) branchReads.delete(sessionId);
      });
    entry.tail = mine;
    return mine;
  };

  const announce = (sessionId: string) => {
    const agent = get(sessionId);
    if (agent !== undefined) options.broadcast({ type: 'agent.updated', agent });
  };

  /** Tells every client the agent changed, and returns it. */
  const announced = (sessionId: string): Agent => {
    const agent = get(sessionId)!;
    options.broadcast({ type: 'agent.updated', agent });
    return agent;
  };

  const host: AgentHost = {
    nextName: spawns.nextName,

    spawn: spawns.spawn,

    start: spawns.start,

    starts: spawns.starts,

    retryStart(sessionId, allowProjectCodexConfig) {
      if (spawns.pending.has(sessionId)) return spawns.pending.retry(sessionId, allowProjectCodexConfig);
      const row = getRow(sessionId);
      if (row === undefined) throw invalidParams(`no agent being started as ${sessionId}`);
      if (row.ended_at === null || !hookStates.startFailed(sessionId)) throw invalidParams(`${row.name} did not fail to start`);
      // The same first message as it was started with: its role's template and issue too, not only its task.
      const first = spawns.firstMessage(sessionId) ?? (row.description || undefined);
      const started = lifecycle.relaunch(row, first, 'to retry its start', null);
      if (!started.started) throw invalidParams(`${row.name} can't be started again: ${started.reason}`);
      startupLines.forget(sessionId);
      // Starting again, so a second exit before its first hook is a failed start as well.
      if (first !== undefined) hookStates.promptQueued(sessionId);
      announce(sessionId);
    },

    updateStart(sessionId, change) {
      const zoneId = change.move?.zoneId;
      if (zoneId != null && selectZone.get(zoneId) === undefined) throw invalidParams(`no zone ${zoneId}`);
      if (spawns.pending.has(sessionId)) return void spawns.pending.update(sessionId, change);
      // Its session runs by now: the change is the agent's.
      if (change.move !== undefined) host.move(sessionId, change.move);
      if (change.name !== undefined) host.setName(sessionId, change.name.trim());
    },

    dismissStart: (sessionId) => spawns.pending.dismiss(sessionId),

    dismissStartsIn: (zoneId) => spawns.pending.dismissIn(zoneId),

    spawnReviewer: spawns.spawnReviewer,

    adopt: spawns.adopt,

    list: () => (selectAll.all() as unknown as AgentRow[]).map(toAgent),

    async refreshBranches() {
      const live = (selectAll.all() as unknown as AgentRow[]).filter((row) => row.ended_at === null);
      await Promise.all(live.map((row) => refreshBranch(row.session_id)));
    },

    refreshBranch,

    get,

    transcript(sessionId, since, generation) {
      const row = requireRow(sessionId);
      return transcripts.read(sessionId, row.harness, row.transcript_path, since, generation);
    },

    subagentTranscript(sessionId, toolUseId, agentId) {
      const row = requireRow(sessionId);
      return transcripts.readSubagent(row.harness, row.transcript_path, toolUseId, agentId);
    },

    isDeleting: lifecycle.isDeleting,

    // Read first: a rename with no hook after it must not hide the branch it owns from the unsaved-work check.
    async delete(sessionId, why, force, keepWorktree, keepBranch) {
      await refreshBranch(sessionId);
      return lifecycle.delete(sessionId, why, force, keepWorktree, keepBranch);
    },

    answer: deliveries.answer,
    queueAfterTurn: deliveries.queueAfterTurn,
    deliverAfterTurn: deliveries.deliverAfterTurn,

    runScheduled: deliveries.runScheduled,

    deliver: deliveries.deliver,
    tell: deliveries.tell,

    finalMessage: (sessionId) =>
      (selectFinalMessage.get(sessionId) as { final_message: string | null } | undefined)?.final_message ?? undefined,

    onInput(sessionId, data) {
      // Enter on the user's draft at a Codex agent's composer starts a turn of theirs, before its hooks say so. Until
      // its composer has been seen up, what they type (a row's number and Enter) answers a startup screen instead.
      const watching = firstPrompts.get(sessionId)?.watchScreen === true && composerWatch.seenUp(sessionId);
      if (watching && submitsDraft(hookStates.isDrafting(sessionId), data)) stopWatchingScreen(sessionId);
      hookStates.typed(sessionId, data);
      deliveries.typed(sessionId, data);
    },

    async sendUnsent(sessionId, byUser) {
      const sent = await deliveries.send(sessionId, byUser);
      return { agent: get(sessionId)!, sent };
    },

    async resendUndelivered(sessionId) {
      const agent = requireAgent(sessionId);
      const items = dropUndelivered(sessionId);
      if (items.length === 0) throw invalidParams(`${agent.name} has nothing undelivered to resend`);
      announce(sessionId);
      let sent = 0;
      try {
        const row = getRow(sessionId)!;
        // Ended (not paused): started again, carrying on its conversation, with the first as its first message; the
        // rest wait until it is up. A paused one is woken by the first, as any message wakes it.
        if (row.ended_at !== null && row.hibernated_at === null) {
          const started = lifecycle.relaunch(row, items[0]!.text, 'to resend what was not delivered', row.harness_session_id);
          if (!started.started) throw invalidParams(`${agent.name} can't be started again: ${started.reason}`);
          sent = 1;
        }
        for (; sent < items.length; sent += 1) await deliveries.answer(sessionId, items[sent]!.text);
      } catch (error) {
        // What wasn't sent stays, to resend once what stopped it is seen to.
        for (const item of items.slice(sent)) keepUndelivered(sessionId, item.what, item.text, item.reason);
        throw error;
      }
      options.log(`resent what was not delivered to ${sessionId}, as the user asked`);
      return get(sessionId)!;
    },

    clearUndelivered(sessionId) {
      requireAgent(sessionId);
      if (dropUndelivered(sessionId).length > 0) announce(sessionId);
      return get(sessionId)!;
    },

    clearUnsent(sessionId, byUser) {
      // Typed at its terminal as much as the user's keys are: a draft of theirs there goes with it.
      hookStates.typed(sessionId, deliveries.clear(sessionId, byUser));
      return get(sessionId)!;
    },

    async typeFirstPrompt(sessionId) {
      const agent = requireAgent(sessionId);
      if (agent.untypedPrompt === null) throw invalidParams(`${agent.name} has no first prompt waiting to be typed`);
      // Never typed into Claude's trust screen: its Enter would pick `No, exit`.
      const shown = await probeFirstPrompt(sessionId);
      if (shown?.screen.kind === 'trust') throw invalidParams(`${agent.name} is on Claude's trust screen: answer it (Trust folder) before its first prompt is typed`);
      // Typed meanwhile, its prompt seen on its screen.
      if (!firstPrompts.has(sessionId)) return get(sessionId)!;
      // The user says its session is up: it is typed now, as on its first hook.
      options.log(`typing ${sessionId}'s first prompt as the user asked: its session never said it was up`);
      settleFirstPrompt(sessionId, true);
      return get(sessionId)!;
    },

    async trustFolder(sessionId) {
      const agent = requireAgent(sessionId);
      const entry = firstPrompts.get(sessionId);
      if (agent.endedAt !== null || entry?.trust !== true) throw invalidParams(`${agent.name} is not asking whether to trust its folder`);
      if (trusting.has(sessionId)) throw invalidParams(`${agent.name}'s folder is being trusted`);
      trusting.add(sessionId);
      try {
        const refused = await answerTrustScreen({
          screen: () => sessions.screenLines(sessionId),
          write: (data) => sessions.write(sessionId, data),
          wait: (ms) => new Promise<void>((resolve) => void clock.setTimer(resolve, ms)),
        });
        if (refused === 'not-trust') throw invalidParams(`${agent.name} no longer shows Claude's trust screen`);
        if (refused === 'pointer') {
          throw invalidParams(`${agent.name}'s trust screen did not move to "Yes, I trust this folder": answer it in its terminal`);
        }
        options.log(`trusted ${sessionId}'s folder as the user asked`);
      } finally {
        trusting.delete(sessionId);
      }
      return get(sessionId)!;
    },

    interrupt(sessionId, why) {
      const agent = requireAgent(sessionId);
      if (agent.endedAt !== null) throw invalidParams(`${agent.name} has ended`);
      if (!isMidTurn(agent)) throw invalidParams(`${agent.name} has no turn under way to interrupt`);
      options.log(`interrupting agent ${sessionId} for ${why}`);
      sessions.write(sessionId, INTERRUPT_KEY);
      // The turn is over now: Claude fires no hook for an interrupted turn, and the subagents and prompts went with it,
      // and the call it waited on the user in, whether or not its harness cancels it.
      permissions.drop(sessionId);
      options.asks?.drop(sessionId);
      hookStates.interrupted(sessionId);
      deliveries.turnEnded(sessionId, false);
      save(getRow(sessionId)!, 'idle', subagentsAfterExit(subagents.of(sessionId), 'idle', new Date()), true);
      return get(sessionId)!;
    },

    async continueOnCredits(sessionId, why) {
      const agent = requireAgent(sessionId);
      if (agent.harness !== 'claude') throw invalidParams(`${agent.name} runs ${agent.harness}, which has no usage credits to continue on`);
      options.log(`continuing agent ${sessionId} on credits for ${why}`);
      await deliveries.continueOnCredits(sessionId, () => sessions.screenLines(sessionId));
      return get(sessionId)!;
    },

    stop: lifecycle.stop,

    pause(sessionId, by, why, reason) {
      const agent = requireAgent(sessionId);
      const row = getRow(sessionId)!;
      // One not up yet with no first prompt and nothing queued loses nothing: its wait for its session is all it holds.
      const notUp = deliveries.whyNotUp(sessionId);
      const holdsNothing = notUp !== undefined && firstPrompts.get(sessionId)?.prompt === undefined && deliveries.queuedUntilUp(sessionId) === 0;
      const refusal =
        pauseRefusal(agent) ??
        (lifecycle.pausing(sessionId) === undefined ? undefined : 'it is already being paused') ??
        (deliveries.unsent(sessionId) === undefined ? undefined : 'a message typed at its prompt was never sent') ??
        (holdsNothing ? undefined : (notUp ?? (deliveries.busy(sessionId) ? 'a message is being sent to it: wait for its turn' : undefined))) ??
        hookStates.whyNotReady(row, true);
      if (refusal !== undefined) throw invalidParams(`${agent.name} can't be paused: ${refusal}`);
      return lifecycle.hibernate(sessionId, by, why, reason);
    },

    resume: lifecycle.resume,

    decidePermission(sessionId, requestId, decision) {
      const agent = requireAgent(sessionId);
      if (!permissions.decide(sessionId, requestId, decision)) {
        throw new RpcMethodError(AGENT_ERROR.permissionGone, `${agent.name} is no longer waiting on that permission here`);
      }
      // The harness has its answer and carries on (its next hook says how), unless more prompts are pending.
      const pending = permissions.prompts(sessionId).length;
      const row = getRow(sessionId)!;
      hookStates.permissionDecided(sessionId);
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
      // Claude's trust screen stays flagged until it is answered, what was never delivered until it is resent or
      // cleared, and what sits unsent at its prompt until it is sent or cleared: looking at any answers nothing.
      const entry = firstPrompts.get(sessionId);
      const kept = flags.get(sessionId);
      const stays =
        kept !== undefined && ((entry?.trust === true && kept.id === entry.flagId) || kept.keepsEnded === true || kept.id === notSentFlags.get(sessionId)?.id);
      const unflagged = stays ? false : flags.delete(sessionId);
      // What still waits on the user under the flag read away stands again.
      if (unflagged) resurface(sessionId);
      // Seen is the user having looked, whatever Needs you lists: a finished turn too, so listing those later shows it read.
      const seeing = row.seen === 0 && waitsForYou(toAgent(row), 'turns');
      if (seeing) updateSeen.run(1, sessionId);
      if (seeing || unflagged) options.broadcast({ type: 'agent.updated', agent: get(sessionId)! });
      return get(sessionId)!;
    },

    flag(sessionId, reason, via) {
      const row = requireRow(sessionId);
      if (row.ended_at !== null) throw invalidParams(`${row.name} has ended`);
      const text = oneLine(reason);
      if (text === '') throw invalidParams('say why you need a look: the reason must not be blank');
      if (text.length > MAX_FLAG_LENGTH) throw invalidParams(`the reason is ${text.length} characters; at most ${MAX_FLAG_LENGTH}`);
      // Its new flag stands in place of its last, which a folding may still carry: none puts that one back.
      const earlier = underFoldings(sessionId);
      if (earlier !== undefined) unfold(sessionId, earlier.id, undefined);
      flags.set(sessionId, { id: ++lastFlagId, reason: text, at: new Date().toISOString(), via });
      return announced(sessionId);
    },

    clearFlag(sessionId) {
      requireRow(sessionId);
      const shown = flags.get(sessionId);
      if (shown === undefined) return get(sessionId)!;
      // A folding stays while its condition holds: what goes is the flag it stands in place of, if any. Otherwise the
      // flag goes, and the foldings it stood in place of stand again.
      if (foldingsOf(sessionId).some((folding) => folding.id === shown.id)) {
        const own = underFoldings(sessionId);
        if (own === undefined) return get(sessionId)!;
        unfold(sessionId, own.id, undefined);
      } else flags.delete(sessionId);
      resurface(sessionId);
      return announced(sessionId);
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

    setStatus(sessionId, summary, progress, done = false, setBy = null) {
      requireAgent(sessionId);
      const text = oneLine(summary);
      if (text === '') throw invalidParams('the status summary must not be blank');
      if (text.length > MAX_STATUS_LENGTH) {
        throw invalidParams(`the status summary is ${text.length} characters; at most ${MAX_STATUS_LENGTH}`);
      }
      if (progress !== null && !isStatusProgress(progress)) {
        throw invalidParams('progress must be a whole number from 0 to 100');
      }
      const at = new Date().toISOString();
      updateStatus.run(text, progress, at, setBy, sessionId);
      if (done && requireRow(sessionId).work_finished_at === null) updateFinished.run(at, sessionId);
      const agent = get(sessionId)!;
      options.broadcast({ type: 'agent.updated', agent });
      return agent;
    },

    waitsAtPrompt: (sessionId) => hookStates.waitsAtPrompt(sessionId),

    markFinished(sessionId) {
      if (requireRow(sessionId).work_finished_at === null) updateFinished.run(new Date().toISOString(), sessionId);
      const agent = get(sessionId)!;
      options.broadcast({ type: 'agent.updated', agent });
      return agent;
    },

    setOrchestrate(sessionId, scope) {
      requireAgent(sessionId);
      if (scope !== null && !ORCHESTRATE_SCOPES.includes(scope)) throw invalidParams(`unknown orchestrate scope ${String(scope)}`);
      updateOrchestrate.run(scope, scope === null ? 1 : 0, sessionId);
      const agent = get(sessionId)!;
      options.broadcast({ type: 'agent.updated', agent });
      return agent;
    },

    orchestrateFacts(sessionId) {
      const row = requireRow(sessionId);
      return { off: row.orchestrate_off === 1, depth: row.crew_depth };
    },

    zoneOrchestrateChanged(zoneId, on) {
      // Its agents follow it (`orchestrateNow`); a grant by hand in it goes for good when it goes off.
      if (!on) clearHandGrantsIn.run(zoneId);
      for (const { session_id: sessionId } of selectReachedBy.all(zoneId) as { session_id: string }[]) {
        options.broadcast({ type: 'agent.updated', agent: get(sessionId)! });
      }
    },

    onHook(sessionId, payload, signal) {
      const row = getRow(sessionId);
      // A hook still in flight when the process exited must not revive the ended agent's state.
      if (row === undefined || row.ended_at !== null) return undefined;
      // Hooks follow the agent's tool calls, so look for config it may have just written, in case a watch missed it.
      lifecycle.checkGuard(sessionId);
      if (payload.hook_event_name === 'SessionStart') lifecycle.started(sessionId);
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
      // The agent may have just run `git branch -m` or checked out another branch.
      if (payload.agent_id === undefined && BRANCH_HOOKS.has(payload.hook_event_name as string)) void refreshBranch(sessionId);
      if (payload.agent_id === undefined && TURN_BOUNDARIES.has(payload.hook_event_name)) options.onTurnBoundary?.(sessionId);
      // Its own turn started or ran, so what was typed at its prompt has been taken; never a stale hook of a turn interrupted.
      if (payload.agent_id === undefined && TURN_HOOKS.has(payload.hook_event_name) && !hookStates.isStale(sessionId, payload)) {
        if (payload.hook_event_name === 'UserPromptSubmit') deliveries.promptSubmitted(sessionId, payload.prompt);
        deliveries.turnSeen(sessionId, payload.hook_event_name === 'Interrupt');
      }
      // Its own turn ended: what was queued in it is due to start a turn of its own.
      if (payload.agent_id === undefined && TURN_ENDS.has(payload.hook_event_name) && !hookStates.isStale(sessionId, payload)) {
        const limited = payload.hook_event_name === 'StopFailure' && payload.error === 'rate_limit';
        deliveries.turnEnded(sessionId, payload.hook_event_name !== 'Interrupt' && !limited, limited ? 'rate-limited' : 'interrupted');
      }
      // A new prompt is new work: it is no longer finished.
      if (payload.agent_id === undefined && payload.hook_event_name === 'UserPromptSubmit' && row.work_finished_at !== null) {
        updateFinished.run(null, sessionId);
        announce(sessionId);
      }
      // Its own turn ended, so no call of it still waits on the user: one its harness gave up on (timed out) goes too.
      if (payload.agent_id === undefined && payload.hook_event_name === 'Stop') options.asks?.drop(sessionId);
      // Before its state is saved, so the turn's end already shows what it left running.
      backgroundCommands.onHook(sessionId, payload);
      const reply = hookStates.onHook(row, payload, signal);
      // Its session is up, its state saved as at its prompt: its first prompt is typed there now. Only on its start:
      // another hook, or a `SessionStart` after a compaction (which can come mid-turn), is of a turn the user began by
      // hand, which the prompt would be pasted into, left unsent.
      const started = row.harness === 'claude' && payload.hook_event_name === 'SessionStart' && payload.source !== 'compact';
      // With no first prompt to paste into a turn begun by hand, any hook of its own says its session is up: but its
      // `SessionEnd`, which says it is going.
      const waiting = firstPrompts.get(sessionId);
      const upWithout = waiting !== undefined && waiting.prompt === undefined && payload.hook_event_name !== 'SessionEnd';
      if (payload.agent_id === undefined && (started || upWithout)) settleFirstPrompt(sessionId, true);
      // Codex fires `SessionStart` only with a prompt: one while its first is due is of a turn the user began by hand,
      // under which its composer stays drawn. Its screen is no longer watched: the task waits on its tile for Send.
      const handTyped = payload.hook_event_name === 'SessionStart' || payload.hook_event_name === 'UserPromptSubmit';
      if (row.harness === 'codex' && payload.agent_id === undefined && handTyped) stopWatchingScreen(sessionId);
      return reply;
    },

    onOutput(sessionId) {
      hookStates.outputSeen(sessionId);
      quietTurns.activity(sessionId);
      if (firstPrompts.get(sessionId)?.watchScreen === true) composerWatch.outputSeen(sessionId);
      probeSoon(sessionId);
      // Its startup's lines, not its prompt as its first prompt is typed there.
      if (hookStates.isStarting(sessionId) && !hookStates.isUp(sessionId)) startupLines.soon(sessionId);
      deliveries.outputSeen(sessionId);
    },

    onExit(session) {
      if (lifecycle.shellExited(session.id)) return;
      permissions.drop(session.id);
      hookStates.ended(session.id);
      quietTurns.stopped(session.id);
      settleFirstPrompt(session.id, false);
      backgroundCommands.forget(session.id);
      // What it printed last, as it ended, is why its start failed.
      if (hookStates.startFailed(session.id)) startupLines.now(session.id);
      deliveries.ended(session.id, session.stoppedByRestart);
      lifecycle.stopGuard(session.id);
      // What was never delivered to it is flagged on, for Resend.
      if (flags.get(session.id)?.keepsEnded !== true) flags.delete(session.id);
      // Only what outlives its session stands now: its own reason, which it can no longer answer, goes from what was
      // never delivered. What ran above (its first prompt settled, its unsent message gone) resurfaced as if it were
      // live, as its row isn't saved ended yet: this puts that right.
      const own = underFoldings(session.id);
      if (own !== undefined) unfold(session.id, own.id, undefined);
      resurface(session.id, true);
      const row = getRow(session.id);
      if (row === undefined) return;
      // Its crew's flags reach the user now.
      for (const { session_id: crewId } of selectCrew.all(session.id) as { session_id: string }[]) {
        if (flags.has(crewId)) announce(crewId);
      }
      // Always tell clients: the agent has ended even if its state already said so. Stopped by the user is not a failure.
      const state = lifecycle.isStopping(session.id) ? 'done' : stateAfterExit(row.state, session.exitCode);
      save(row, state, subagentsAfterExit(subagents.of(session.id), state, new Date()), true);
      lifecycle.exited(session.id, session.stoppedByRestart);
    },

    repoZoneId(sessionId) {
      const row = getRow(sessionId);
      return row && repoZone(row)?.id;
    },

    announce,
    records,

    waitChanged(sessionId, began) {
      if (began) updateSeen.run(0, sessionId);
      announce(sessionId);
    },

    fallbackShellCount: lifecycle.fallbackShellCount,

    fallbackOwner: lifecycle.fallbackOwner,

    onShellChanged: lifecycle.onShellChanged,

    close: () => {
      deliveries.handBackQueued();
      transcripts.close();
      backgroundCommands.close();
      lifecycle.close();
      permissions.close();
    },
  };
  return host;
}

/** `agent.spawn`'s and `agent.start`'s params, checked. */
function spawnParams(params: unknown): SpawnAgentParams {
  const p = paramsObject(params);
  return {
    zoneId: zoneIdParam(p),
    repo: agentRepoParam(p),
    baseBranch: optionalStringParam(p, 'baseBranch'),
    branch: optionalStringParam(p, 'branch'),
    harness: optionalStringParam(p, 'harness') as Harness | undefined,
    model: optionalStringParam(p, 'model'),
    role: optionalStringParam(p, 'role'),
    noTemplate: optionalBooleanParam(p, 'noTemplate'),
    checkout: optionalStringParam(p, 'checkout') as 'main' | 'worktree' | undefined,
    issueZoneId: optionalStringParam(p, 'issueZoneId'),
    allowProjectCodexConfig: optionalBooleanParam(p, 'allowProjectCodexConfig'),
    prompt: optionalStringParam(p, 'prompt'),
    name: optionalStringParam(p, 'name'),
    issueId: optionalStringParam(p, 'issueId'),
    position: optionalPlaceParam(p),
    orchestrate: optionalStringParam(p, 'orchestrate') as OrchestrateScope | undefined,
    cols: dimensionParam(p, 'cols'),
    rows: dimensionParam(p, 'rows'),
  };
}

/** The `agent.*` RPC handlers. */
export function agentHandlers<Context>(
  agents: AgentHost,
): RpcHandlers<Pick<DaemonMethods, Exclude<Extract<keyof DaemonMethods, `agent.${string}`>, 'agent.setSchedule'>>, Context> {
  return {
    ...recordHandlers<Context>({ records: agents.records, agents }),
    'agent.spawn': (params) => agents.spawn(spawnParams(params)),
    'agent.start': (params) => agents.start(spawnParams(params)),
    'agent.starts': () => agents.starts(),
    'agent.retryStart': (params) => {
      const p = paramsObject(params);
      agents.retryStart(stringParam(p, 'sessionId'), optionalBooleanParam(p, 'allowProjectCodexConfig') ?? false);
      return null;
    },
    'agent.updateStart': (params) => {
      const p = paramsObject(params);
      const move = p.move === undefined ? undefined : moveParams(paramsObject(p.move));
      agents.updateStart(stringParam(p, 'sessionId'), { name: p.name === undefined ? undefined : requiredNameParam(p, 'name'), move });
      return null;
    },
    'agent.dismissStart': (params) => {
      agents.dismissStart(stringParam(paramsObject(params), 'sessionId'));
      return null;
    },
    'agent.list': () => agents.list(),
    'agent.refreshBranches': async () => {
      await agents.refreshBranches();
      return null;
    },
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
      await agents.delete(stringParam(p, 'sessionId'), "the app's agent.delete", p.force === true, p.keepWorktree === true);
      return null;
    },
    'agent.answer': async (params) => {
      const p = paramsObject(params);
      const { queued } = await agents.answer(stringParam(p, 'sessionId'), stringParam(p, 'text'), optionalBooleanParam(p, 'paste'));
      return { queued };
    },
    'agent.interrupt': (params) => agents.interrupt(stringParam(paramsObject(params), 'sessionId'), "the app's agent.interrupt"),
    'agent.continueOnCredits': (params) => agents.continueOnCredits(stringParam(paramsObject(params), 'sessionId'), "the app's agent.continueOnCredits"),
    'agent.sendUnsent': async (params) => (await agents.sendUnsent(stringParam(paramsObject(params), 'sessionId'))).agent,
    'agent.typeFirstPrompt': (params) => agents.typeFirstPrompt(stringParam(paramsObject(params), 'sessionId')),
    'agent.trustFolder': (params) => agents.trustFolder(stringParam(paramsObject(params), 'sessionId')),
    'agent.clearUnsent': (params) => agents.clearUnsent(stringParam(paramsObject(params), 'sessionId')),
    'agent.resendUndelivered': (params) => agents.resendUndelivered(stringParam(paramsObject(params), 'sessionId')),
    'agent.clearUndelivered': (params) => agents.clearUndelivered(stringParam(paramsObject(params), 'sessionId')),
    'agent.stop': (params) => agents.stop(stringParam(paramsObject(params), 'sessionId'), "the app's agent.stop"),
    'agent.pause': (params) => agents.pause(stringParam(paramsObject(params), 'sessionId'), null, "the app's agent.pause"),
    'agent.resume': (params) => {
      const p = paramsObject(params);
      if (p.force !== undefined && typeof p.force !== 'boolean') throw invalidParams('force must be a boolean');
      return agents.resume(stringParam(p, 'sessionId'), "the app's agent.resume", p.force === true);
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

/** A spawn's optional `repo`: `{ path }` or `{ scratch: true }`. */
function agentRepoParam(fields: Record<string, unknown>): AgentRepo | undefined {
  if (fields.repo === undefined) return undefined;
  const repo = paramsObject(fields.repo);
  if (repo.scratch === true) return { scratch: true };
  return { path: stringParam(repo, 'path') };
}

/** How often a starting agent's tile is told the last line its terminal shows, at most. */
const STARTUP_LINE_MS = 250;

/**
 * The last line each starting agent's terminal showed, for its tile (`AgentStartup.output`): read from its screen a
 * moment after output comes, at most every `STARTUP_LINE_MS`, and told to clients when it changes.
 */
function createStartupLines(
  sessions: Pick<SessionHost, 'screenLine'>,
  isStarting: (sessionId: string) => boolean,
  changed: (sessionId: string) => void,
) {
  const lines = new Map<string, string>();
  const due = new Set<string>();
  const read = (sessionId: string) =>
    void sessions
      .screenLine(sessionId)
      .then((line) => {
        if (line === null || line === lines.get(sessionId)) return;
        lines.set(sessionId, line);
        changed(sessionId);
      })
      .catch(() => {});
  return {
    get: (sessionId: string): string | null => lines.get(sessionId) ?? null,
    /** Forgets the agent's line: it is relaunched, or deleted. */
    forget: (sessionId: string) => void lines.delete(sessionId),
    /** Reads the line soon, once for all the output that comes meanwhile. */
    soon(sessionId: string) {
      if (due.has(sessionId)) return;
      due.add(sessionId);
      setTimeout(() => {
        due.delete(sessionId);
        // One that ended meanwhile had its line read as it ended.
        if (isStarting(sessionId)) read(sessionId);
      }, STARTUP_LINE_MS).unref();
    },
    /** Reads the line now: the session is ending. */
    now: read,
  };
}
