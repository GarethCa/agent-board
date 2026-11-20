import type { DatabaseSync } from 'node:sqlite';
import type { PullRequest } from '@agent-board/tracker';
import type { AgentPageStore } from './agent-page.ts';
import type { AgentRecordStore } from './agent-records.ts';
import type { Clock } from './clock.ts';
import type { StartChange } from './agent-starts.ts';
import type { AfterTurn, Answered, UnsentSent } from './deliveries.ts';
import type { SendTrail } from './send-log.ts';
import type { HarnessPaths } from './harness-path.ts';
import type { HookReply } from './permissions.ts';
import type { AgentAsk, PlanSummary, DocumentSummary, Agent, WorkCategorySet, AgentStepsWait, RemoveAsk, AgentStart, AgentRole, DaemonEvent, Effort, EffortApplies, Harness, TicketBoardPlace, TileMove, PermissionDecision, PromptAnswer, LinkedIssue, SessionInfo, SessionState, SpawnAgentParams, TerminalSize, TilePosition, TranscriptChunk } from './protocol.ts';
import type { RunStart, ScheduleHost } from './schedules.ts';
import type { SessionHost } from './sessions.ts';
import type { CharacterSet } from './character.ts';
import type { TrackerHost } from './trackers.ts';
import type { PositionColumns } from './tile-position.ts';
import type { RoleTemplates } from './role-templates.ts';

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
  /** The reasoning effort Settings give a new agent not asked for one (`defaultEffort` in settings.ts), read as each starts. */
  defaultEffort: (harness: Harness, role: string | null) => Effort | null;
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
  /**
   * How long a PermissionRequest hook is held for an inbox answer before the harness's own prompt takes over, where its
   * terminal waits on the hook. One its terminal asks at the same time is held for `ASKING_PERMISSION_HOLD_MS`.
   */
  permissionHoldMs: number;
  /** How long after answers are sent to Claude's question dialog its call may take to run: `DIALOG_TAKE_MS` by default. */
  dialogTakeMs?: number;
  /** How long an agent's session gets to say it is up before its first prompt is offered by hand: a minute by default (tests shorten it). */
  startLimitMs?: number;
  /** How long a step of an agent's start may wait on another process: `START_STEP_TIMEOUT_MS` by default. */
  startStepTimeoutMs?: number;
  /** How long Enter first gets to start a turn of a message typed at an agent's prompt before it is pressed again. */
  submitConfirmMs?: number;
  /** How long after the user's last key in an agent's terminal nothing is typed there for the board: `USER_IDLE_MS`. */
  userIdleMs?: number;
  /** The zones' trackers, where agents started from or linked to an issue get it. */
  trackers: Pick<TrackerHost, 'issue' | 'issueFrom'>;
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
  /**
   * Hears an agent's own turn end with no `Stop`: interrupted (from the board, or Codex's `Interrupt`), failed or rate
   * limited (`StopFailure`), or found over with no hook at all. `why` says which, as a run's reason.
   */
  onTurnCut?(sessionId: string, why: string): void;
  /** An agent's branch changed in its worktree: the pull requests of the new one are wanted. */
  onBranchChanged?(sessionId: string): void;
  /** Hears an agent about to be deleted, so what goes with it can say so first: its flow edges. */
  onRemoving(sessionId: string): void;
  /** The questions and plans agents wait on the user for: while one does, it is `waiting`. */
  asks?: { pendingAsk(sessionId: string): AgentAsk | null; latestPlan(sessionId: string): PlanSummary | null; drop(sessionId: string): void };
  /** What an agent waits on the user for on a steps card, between turns (Needs you). */
  stepsWait?(sessionId: string): AgentStepsWait | null;
  /** The tiles an orchestrator asks the user to remove, and waits on: while it does, it is `waiting`. */
  removeAsk?(sessionId: string): RemoveAsk | null;
  /** The documents agents show the user. */
  documents?: { list(sessionId: string): DocumentSummary[] };
  /** Ends the shells in the agent's session window's tabs, and removes the tabs: it is being deleted. */
  endTabs?(sessionId: string): Promise<void>;
  /** The agent's own worktree is about to be removed with it: anything kept for other agents is copied out first. */
  beforeWorktreeRemoved?(sessionId: string, worktree: string): void;
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

/** What `setStatus` sets: any of the line, the pose and the category, and whether its work is finished. */
export interface StatusUpdate {
  summary?: string | null;
  progress?: number | null;
  done?: boolean;
  character?: CharacterSet;
  category?: WorkCategorySet;
  /** What it is for (`Agent.purpose`); '' clears it. */
  purpose?: string;
  /** Who set what it is for, kept for its hover card, when not the status's `setBy`: the user's side sets no line of its own. */
  purposeBy?: string | null;
}

export interface AgentHost {
  /** Re-reads the branch of every agent's worktree, resolving once each is stored: the board lists them fresh. */
  refreshBranches(): Promise<void>;
  /** Re-reads one agent's branch from its worktree, as above. */
  refreshBranch(sessionId: string): Promise<void>;
  /** Whether the agent is being deleted: from the start of `delete` until its row is gone, its worktree too. */
  isDeleting(sessionId: string): boolean;
  /** Starts an agent; `spawnedBy` is the orchestrator starting it, if one is. */
  spawn(params: SpawnAgentParams, spawnedBy?: string, place?: FolderPlace, used?: SpawnUsed): Promise<Agent>;
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
  /** Pins the agent's tile expanded, or unpins it: as `agent.setPinnedExpanded`. */
  setPinnedExpanded(sessionId: string, pinned: boolean): Agent;
  /** Sets the agent's reasoning effort, and says when it takes it: as `agent.setEffort`. */
  setEffort(sessionId: string, effort: Effort | null): Promise<{ agent: Agent; applies: EffortApplies }>;
  /** Types the reasoning effort the agent waits to be given at its prompt, if it is ready for it now (call on each change of it). */
  applyEffort(sessionId: string): void;
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
  /**
   * Renames the agent's tile, keeping who did it (`Agent.renamed`): `by` an agent's or shell's name, `you` (the
   * default) for the user in the app, null for the agent itself. The same name again changes nothing.
   */
  setName(sessionId: string, name: string, by?: string | null): Agent;
  /**
   * Sets what the agent is for (`Agent.purpose`), trimmed to one line and at most `MAX_PURPOSE_LENGTH`; '' clears it.
   * Keeps who did it (`Agent.described`), `by` as `setName` takes it.
   */
  setPurpose(sessionId: string, purpose: string, by: string | null): Agent;
  /**
   * Gives the agent a role, as typed (`parseRole`), or none with null: its tile's badge, and whatever is keyed on the
   * role, take it at once. Only the role changes: the session isn't restarted, and no template is sent to it.
   */
  setRole(sessionId: string, role: string | null): Agent;
  /**
   * The template of `role` (as typed, `parseRole`) for the agent, filled in for it as its start would have: empty when
   * the role has none. A crew's reviewer passes its crew's round and last review. Read for sending to it, which only
   * happens when asked (`orchestrator.giveRole`).
   */
  roleTemplate(sessionId: string, role: string, crewReview?: { round: number; previous: string | null }): string;
  /**
   * Sets what the agent says it is doing now (ADR-0010), replacing what was there: a summary, trimmed and at most
   * `MAX_STATUS_LENGTH`, and a progress 0-100 or null; its character's pose; and its work category (ADR-0024), whole:
   * a label or who it waits on left out goes. Each left out keeps what it had, but one must be given. `done` says its
   * work is finished, and is the category Done unless it gave one. `setBy` is the orchestrator setting it for its crew.
   */
  setStatus(sessionId: string, update: StatusUpdate, setBy?: string | null): Agent;
  /** Whether the live agent went waiting after its turn ended, so sits at its prompt asking nothing (`createHookStates`'s). */
  waitsAtPrompt(sessionId: string): boolean;
  /** Notes that the agent says its work is finished (`Agent.workFinishedAt`) and is Done, as `done` does, until its next prompt. */
  markFinished(sessionId: string): Agent;
  /**
   * Makes the agents `from` started `to`'s, as if `to` had started them, `from` on the board or removed. Returns their ids; the caller tells the clients,
   * once whatever it runs this in has committed.
   */
  handCrew(from: string, to: string): string[];
  /** The removed orchestrator `sessionId` while some of its crew is still on the board (`Agent.orphanedFrom`), else undefined. */
  removedOrchestrator(sessionId: string): RemovedOrchestrator | undefined;
  /** Moves the agent's tile within its zone, into any other, or out onto the board. Only its tile moves. */
  move(sessionId: string, move: TileMove): Agent;
  /** Moves the tile of a ticket's helper, or of its chat, on that ticket's own board; its main-board tile stays. */
  placeOnTicket(sessionId: string, place: TicketBoardPlace): Agent;
  /** The zone of the agent's own repo that speaks for it (`repoZoneOf`), if any. */
  repoZoneId(sessionId: string): string | undefined;
  /**
   * Sends `text` to the agent as the user's next message, after any answer to it still being typed: its line breaks
   * kept, pasted as a terminal pastes them, and pasted even as one line with `paste`. Resolves with how it went.
   */
  answer(sessionId: string, text: string, paste?: boolean, trail?: SendTrail, from?: string): Promise<Answered>;
  /** A trail for the daemon log of one message of `chars` characters sent to the agent (`sendTrail`). */
  sendTrail(sessionId: string, chars: number): SendTrail;
  /**
   * Keeps a message for the live agent mid-turn until a turn of its ends, then types it, after any kept before it
   * (`Agent.messagesWaiting`): in the database too, so a daemon restart types it once the agent is resumed. Handed
   * back as not delivered if the agent ends first: to the agent that sent it (`from`), else to the user.
   */
  queueAfterTurn(sessionId: string, item: AfterTurn): void;
  /**
   * Drops the notices waiting for the agent that a message of its to `about` was not delivered (`keepUndelivered`):
   * its new message to that agent says what the lost one did. Returns how many went.
   */
  dropNotices(sessionId: string, about: string): number;
  /** Types the next message kept for the agent's turn to end, if it is ready for it now (call on each change of it). */
  deliverAfterTurn(sessionId: string): void;
  /**
   * Whether the user is at the agent's prompt: a draft of theirs is there, or they pressed a key in its terminal in the
   * last few seconds. Another agent's message waits then (`queueAfterTurn`), never typed into what they type.
   */
  userTyping(sessionId: string): boolean;
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
   * at its prompt, or with a message being typed or sent to it: its error's `reason` says which. `fold` is the id of
   * the zone whose fold pauses it (`zone.fold`), remembered while it stays paused.
   */
  pause(sessionId: string, by: string | null, why: string, fold?: string): Promise<Agent>;
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
  /** Releases one of the agent's held permission prompts unanswered, so the harness asks in its terminal now. */
  releasePermission(sessionId: string, requestId: string): void;
  /** Keeps the user's answer (null clears it) to one question of the agent's held question prompt, sending nothing. */
  answerQuestion(sessionId: string, requestId: string, index: number, answer: PromptAnswer | null): void;
  /** Sends the answers kept on the agent's held question prompt to its harness's dialog. */
  sendAnswers(sessionId: string, requestId: string): void;
  /**
   * Starts a scheduled run. An agent sitting at its prompt (idle, or after a failed turn) gets `prompt` as its next
   * message. An ended agent is relaunched in its worktree with `prompt`: Claude resumes its conversation, Codex starts
   * a new one unless it was paused (a hand-off resumes it). The run is skipped, saying why, while the agent is still working, rate-limited, waiting for you (on a
   * permission prompt, or its last message asks you something) or you are typing at its prompt.
   */
  runScheduled(sessionId: string, prompt: string, notTyped?: (reason: string) => void): RunStart;
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
  /** A session is live: the crew it leads are told, as they now read as led by it. */
  onStart(sessionId: string): void;
  /** Settles the session's agent, if it has one, once its process has exited. */
  onExit(session: SessionInfo): void;
  /** The agent's session printed something: an agent still `starting` with no hook for a while stops being. */
  onOutput(sessionId: string): void;
  /** Tells every client about the agent, if it still exists, after something it shows changed. */
  announce(sessionId: string): void;
  /** What agents recorded about their own work (`Agent.records`). */
  records: AgentRecordStore;
  /** The pages agents wrote for their sidebars (`Agent.page`). */
  pages: AgentPageStore;
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
export interface ConversationRow {
  harness_session_id: string;
  transcript_path: string | null;
  ended_at: string;
}

/** A removed orchestrator whose crew is still on the board: what taking that crew over checks. */
export interface RemovedOrchestrator {
  sessionId: string;
  name: string;
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
  effort: Effort | null;
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
  pinned_expanded: number;
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
  /** 1 once its daemon went away under it at work, until it is started again (migration 0069). */
  turn_cut_off: number;
  /** 1 once its current conversation has had a turn of its own (migration 0078); a fresh restart resets it. */
  had_turn: number;
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
  /** The work category it set (`setStatus` with a category): all null while it has none. */
  work_category: string | null;
  work_category_label: string | null;
  waiting_on_who: string | null;
  waiting_on_ref: string | null;
  work_category_set_at: string | null;
  work_category_set_by: string | null;
  /** What it says it is for (`setStatus` with a purpose): null while it has none. */
  purpose: string | null;
  /** Who last renamed it and set what it is for (`TileChange` as JSON): null before either. */
  renamed: string | null;
  described: string | null;
  /** The pose it set for its character (`setStatus` with a character): all null while it has none. */
  character_pose: string | null;
  character_face: string | null;
  character_prop: string | null;
  character_set_at: string | null;
  character_set_by: string | null;
  /** When it was paused, and the session id of the orchestrator that paused it (null for the user): `Agent.hibernated`. */
  hibernated_at: string | null;
  hibernated_by: string | null;
  /** The zone whose fold paused it (`zone.fold`), while it stays paused: what unfolding and waking that zone wakes. */
  hibernated_fold: string | null;
  /** When it said its work is finished (`Agent.workFinishedAt`), or null. */
  work_finished_at: string | null;
  spawned_by: string | null;
  /** The removed orchestrator that started it, until another takes its crew over (`Agent.orphanedFrom`). */
  orphaned_from: string | null;
  /** The ticket's chat it is a helper of (`Agent.ticket`), or null. */
  ticket: string | null;
  /** 1 for a ticket tile's chat (`Agent.ticketChat`). */
  ticket_chat: number;
  /** For a ticket's chat, 1 while it is its own lead, 0 while it is the implementer (`Agent.chatKind`). */
  ticket_lead: number;
  /** For a ticket's chat, the kind it switches to at its next hand-off (`Agent.chatSwitch`), or null. */
  chat_switch: string | null;
  /** A ticket chat's watches (`Agent.watch`): their settings, as JSON, or null while none is on. */
  watches: string | null;
  /** What its watches last saw, and their news, as JSON (`ticket-watches.ts`). */
  watch_state: string | null;
  /** Its place on its ticket's own board (`Agent.ticketPlace`); both null until it is placed there. */
  ticket_x: number | null;
  ticket_y: number | null;
  /**
   * How deep in a crew it was started (0 for the user's), fixed at spawn. Nothing limits it any more (a crew goes any
   * depth); it is still written so that an older daemon on this database finds it.
   */
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
  tracker_provider: string | null;
  tracker_scope: string | null;
  tracker_project: string | null;
  created_at: string;
}

/**
 * Where an agent starts instead of a worktree of its own: a folder it doesn't own (an Ask Claude agent's, with no repo,
 * or the user's checkout to read), which deleting it leaves alone. `repoRoot` is the repo it is in, or the folder
 * itself outside git; with `readOnly` it may change nothing there.
 */
export interface FolderPlace {
  cwd: string;
  repoRoot: string;
  readOnly: boolean;
  /** It is the Captain (ADR-0019): only `master.start` says so. */
  master?: boolean;
}

/**
 * What a spawn reports back, the template it used, and, for a running crew's reviewer, what the crew gives it: the
 * crew's round and this member's last review, which its template's `{{round}}` and `{{prev_review}}` are filled with in
 * place of the branch's own count of reviews (a crew with two reviewers starts two a round).
 */
export interface SpawnUsed {
  template: string | null;
  crewReview?: { round: number; previous: string | null };
}
