import { isAbsolute, join, relative } from 'node:path';
import { existsSync } from 'node:fs';
import { createAgentPageStore } from './agent-page.ts';
import { createAgentRecordStore, guessedDocOf, recordHandlers } from './agent-records.ts';
import { runGit } from './git.ts';
import { stateAfterExit } from './claude-state.ts';
import { createAgentLifecycle, NO_CONVERSATION_NOTICE } from './agent-lifecycle.ts';
import { systemClock } from './clock.ts';
import { createComposerWatch } from './codex-screen.ts';
import { createAgentSpawns, issueColumns } from './agent-spawns.ts';
import { createDeliveries, type KeptWaiting, type UnsentSent, type WaitingStore } from './deliveries.ts';
import { readSender } from './sender-marker.ts';
import { refOf } from './crew-flags.ts';
import { draftLine, sendTrail } from './send-log.ts';
import { createHookStates } from './hook-states.ts';
import { answerTrustScreen, readStartupScreen, screenTail, type StartupScreen } from './startup-screen.ts';
import {
  dimensionParam,
  finiteNumberParam,
  invalidParams,
  oneOf,
  optionalBooleanParam,
  optionalCountParam,
  optionalStringParam,
  paramsObject,
  requiredNameParam,
  stringParam,
} from './params.ts';
import { answerProblem, ASKING_PERMISSION_HOLD_MS, createPermissionHolds, promptCounts, stateWithPrompts } from './permissions.ts';
import {
  AGENT_ERROR,
  DEFAULT_REVIEW_CAP,
  EFFORTS,
  effortRefusal,
  INTERRUPT_KEY,
  isMidTurn,
  pauseRefusal,
  waitsOnUser,
  isStatusProgress,
  MAX_FLAG_LENGTH,
  parseRole,
  MAX_PURPOSE_LENGTH,
  MAX_STATUS_LENGTH,
  type Agent,
  type AgentCharacter,
  type AgentWorkCategory,
  type WorkCategory,
  type WorkCategorySet,
  type AgentRepo,
  type Effort,
  type Harness,
  type TicketBoardPlace,
  type TicketChatKind,
  type AgentFlag,
  type UndeliveredMessage,
  SEND_TRAILER,
  type DaemonMethods,
  type PromptAnswer,
  type PromptQuestion,
  type SessionState,
  type SpawnAgentParams,
  type Subagent,
  agentRefOf,
  FIRST_PROMPT,
  waitsForYou,
} from './protocol.ts';
import { folderPath, repoZoneOf } from './repo-zone.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import type { SessionHost } from './sessions.ts';
import { createBackgroundCommands } from './background-commands.ts';
import { promptsIn } from './transcript-adapters.ts';
import {
  createQuietTurns,
  QUIET_TURN_MS,
  readTranscriptFromSync,
  readTranscriptTail,
  showsIdlePrompt,
  transcriptSizeSync,
  turnEndedInTranscript,
  turnInterruptedInTranscript,
} from './quiet-turns.ts';
import { createSubagentStore, subagentsAfterExit } from './subagents.ts';
import { oneLine, submitsDraft } from './terminal-input.ts';
import { flagLeadOf, isTicketChatKind } from './ticket-tiles.ts';
import { ticketWatchOf } from './ticket-watches.ts';
import { isWorking, statusAfterTurn } from './turn-status.ts';
import { AGENT_POSES, CHARACTER_EXPIRY_MS, characterLive, isRestingPose, type AgentFace, type AgentPose, type AgentProp, type CharacterSet } from './character.ts';
import { stateClock } from './state-since.ts';
import { createTranscriptReader } from './transcripts.ts';
import { moveParams, optionalPlaceParam, saveMove, tilePosition, zoneIdParam } from './tile-position.ts';
import type { ConversationRow, AgentHostOptions, AdoptSpec, StatusUpdate, AgentHost, RemovedOrchestrator, AgentRow, BranchReviewRow, ZoneRow } from './agent-types.ts';
export type { AgentHostOptions, AdoptSpec, StatusUpdate, AgentHost, RemovedOrchestrator, AgentRow, BranchReviewRow, ZoneRow };
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

/**
 * The flag raised for the user when Claude ran its question call without the answers the board sent (it took the
 * allow, not its `updatedInput`): it carries on as if the user had answered nothing (ADR-0004).
 */
export const ANSWERS_DROPPED_FLAG =
  'Claude ran its questions without the answers sent from the board, so it carries on as if you answered nothing: tell it your answers in its terminal';

/** How long after output a starting agent's screen is read for Claude's trust screen or its prompt, at most. */
const PROBE_MS = 250;
/** How much of a message not delivered its sender's notice quotes, in characters. */
const NOTICE_EXCERPT = 120;

/** How long a trust screen answered by its zone's setting may take to leave the screen before the user is asked. */
const TRUST_GONE_WAIT_MS = 3_000;

/** The agent's hooks after which its branch is read: not the ones before a tool runs or that only notify. */
const BRANCH_HOOKS = new Set(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']);

/** How long after typing `/effort` at an agent its `UserPromptSubmit` for it is still known as that, not a prompt. */
const EFFORT_ECHO_MS = 60_000;

/** How long after Claude's question dialog closed, each look after the last, its transcript is read for a decline. */
const DECLINE_LOOKS_MS = [200, 800, 2000];

/** The agent's own hooks that begin a turn, or end one with no `Stop` after them (`onTurnBoundary`). */
const TURN_BOUNDARIES: ReadonlySet<unknown> = new Set(['UserPromptSubmit', 'StopFailure', 'Interrupt', 'SessionEnd']);

/**
 * Hooks of an agent's own turn, which only fire once a prompt was taken: one after something was typed at its prompt
 * says that it was, even when its `UserPromptSubmit` was lost.
 */
const TURN_HOOKS: ReadonlySet<unknown> = new Set(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop', 'StopFailure', 'Interrupt']);

/** The hooks that end the agent's own turn: by its `Stop`, failed (a rate limit too), or interrupted (Codex's). */
const TURN_ENDS: ReadonlySet<unknown> = new Set(['Stop', 'StopFailure', 'Interrupt']);

/** The resting poses, as an SQL list: they outlive their turn's end. */
const RESTING_SQL = AGENT_POSES.filter(isRestingPose)
  .map((pose) => `'${pose}'`)
  .join(', ');

/** The work category it set, from its row: null while it has none. */
function workCategoryOf(
  row: Pick<AgentRow, 'work_category' | 'work_category_label' | 'waiting_on_who' | 'waiting_on_ref' | 'work_category_set_at' | 'work_category_set_by'>,
): AgentWorkCategory | null {
  if (row.work_category === null || row.work_category_set_at === null) return null;
  return {
    category: row.work_category as WorkCategory,
    label: row.work_category_label,
    waitingOn: row.waiting_on_who === null ? null : { who: row.waiting_on_who, ref: row.waiting_on_ref },
    setAt: row.work_category_set_at,
    setBy: row.work_category_set_by,
  };
}

/** The agent's pose from its row, while it lasts at `now`: a working pose lapses with no new set (`characterLive`). */
function characterOf(
  row: Pick<AgentRow, 'character_pose' | 'character_face' | 'character_prop' | 'character_set_at' | 'character_set_by'>,
  now: number,
): AgentCharacter | null {
  if (row.character_pose === null || row.character_set_at === null) return null;
  const character: AgentCharacter = {
    pose: row.character_pose as AgentPose,
    face: row.character_face as AgentFace | null,
    prop: row.character_prop as AgentProp | null,
    setAt: row.character_set_at,
    setBy: row.character_set_by,
  };
  return characterLive(character, now) ? character : null;
}

/** The states of an agent at work in a turn, which only a hook (or an interrupt) ends. */
const AT_WORK: ReadonlySet<SessionState> = new Set(['running', 'thinking']);

/** The states an agent's turn leaves it in once over, however it ended: no `waiting`, which a question in its turn is too. */
const TURN_OVER: ReadonlySet<SessionState> = new Set(['idle', 'failed', 'rate-limited', 'done']);

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
    'id, name, repo_root, folder, default_repo, group_folder, codex_bypass_hook_trust, trusts_folder, board_mcp, tracker_provider, tracker_scope, tracker_project, clone_repo, created_at';
  const selectZone = db.prepare(`SELECT ${zoneColumns} FROM zones WHERE id = ?`);
  const selectZones = db.prepare(`SELECT ${zoneColumns} FROM zones`);
  const updatePlace = db.prepare('UPDATE agents SET zone_id = ?, x = ?, y = ?, z = ? WHERE session_id = ?');
  const updateTicketPlace = db.prepare('UPDATE agents SET ticket_x = ?, ticket_y = ? WHERE session_id = ?');
  const update = db.prepare('UPDATE agents SET state = ? WHERE session_id = ?');
  const updateNotice = db.prepare('UPDATE agents SET notice = ? WHERE session_id = ?');
  const updateHadTurn = db.prepare('UPDATE agents SET had_turn = 1 WHERE session_id = ? AND had_turn = 0');
  const updateHooksSilent = db.prepare('UPDATE agents SET hooks_silent = ? WHERE session_id = ?');
  const selectHooksSilent = db.prepare('SELECT session_id FROM agents WHERE hooks_silent = 1');
  const updateCutOff = db.prepare('UPDATE agents SET turn_cut_off = 0 WHERE session_id = ?');
  const updateTrustedByZone = db.prepare('UPDATE agents SET trusted_by_zone = 1 WHERE session_id = ?');
  const updateMuted = db.prepare('UPDATE agents SET muted = ? WHERE session_id = ?');
  const updateEffort = db.prepare('UPDATE agents SET effort = ? WHERE session_id = ?');
  /** Per live Claude agent, the reasoning effort to type at its prompt (`/effort`) once it is between turns. */
  const effortAfterTurn = new Map<string, Effort>();
  /** When each agent's shown state began, for `Agent.stateSince`. */
  const stateTimes = stateClock();
  /** Agents whose `effortAfterTurn` is being typed now. */
  const typingEffort = new Set<string>();
  /**
   * Per Claude agent, the `/effort` command last typed at its prompt, and when. Should Claude fire `UserPromptSubmit`
   * for it, that starts no turn (none will end with a `Stop`), so the hook is passed over (`isEffortEcho`).
   */
  const effortTyped = new Map<string, { command: string; at: number }>();
  /** Whether `payload` is the `UserPromptSubmit` of the `/effort` just typed at the agent: once, within a minute. */
  const isEffortEcho = (sessionId: string, payload: Record<string, unknown>): boolean => {
    const typed = effortTyped.get(sessionId);
    if (payload.hook_event_name !== 'UserPromptSubmit' || payload.agent_id !== undefined || typed === undefined) return false;
    if (typeof payload.prompt !== 'string' || payload.prompt.trim() !== typed.command || Date.now() - typed.at > EFFORT_ECHO_MS) return false;
    effortTyped.delete(sessionId);
    return true;
  };
  /** Live Codex agents set to a reasoning effort their session doesn't have: they take it when next started. */
  const effortAtRestart = new Set<string>();

  /**
   * Types the reasoning effort the live Claude agent waits for at its prompt, if it is ready for it now; resolves
   * whether it was typed. One not ready is tried again on its next change (`applyEffort`).
   */
  const typeEffort = async (sessionId: string): Promise<boolean> => {
    const effort = effortAfterTurn.get(sessionId);
    if (effort === undefined || typingEffort.has(sessionId)) return false;
    typingEffort.add(sessionId);
    const command = `/effort ${effort}`;
    effortTyped.set(sessionId, { command, at: Date.now() });
    try {
      const why = await deliveries.typeCommand(sessionId, command);
      if (why !== undefined) return false;
      // Set again meanwhile, to another: that one is typed next.
      if (effortAfterTurn.get(sessionId) === effort) effortAfterTurn.delete(sessionId);
      return true;
    } finally {
      typingEffort.delete(sessionId);
    }
  };
  const updateSeen = db.prepare('UPDATE agents SET seen = ? WHERE session_id = ?');
  const updateBranch = db.prepare('UPDATE agents SET branch = ?, current_branch = ?, detached = ? WHERE session_id = ?');
  const updateName = db.prepare('UPDATE agents SET name = ? WHERE session_id = ?');
  const updateRole = db.prepare('UPDATE agents SET role = ?, role_name = ? WHERE session_id = ?');
  // The Captain was named "Board master" before it was called the Captain: an unchanged name follows (a name the user chose stays).
  db.prepare("UPDATE agents SET name = 'Captain' WHERE master = 1 AND name = 'Board master'").run();
  const updateStatus = db.prepare(
    'UPDATE agents SET status_summary = ?, status_progress = ?, status_updated_at = ?, status_set_by = ? WHERE session_id = ?',
  );
  const updatePurpose = db.prepare('UPDATE agents SET purpose = ? WHERE session_id = ?');
  const updateFinished = db.prepare('UPDATE agents SET work_finished_at = ? WHERE session_id = ?');
  const updateWorkCategory = db.prepare(
    'UPDATE agents SET work_category = ?, work_category_label = ?, waiting_on_who = ?, waiting_on_ref = ?, work_category_set_at = ?, work_category_set_by = ? WHERE session_id = ?',
  );
  /** A Done it set goes with its next prompt, as its work's finish does: new work is not done. */
  const clearDoneCategory = db.prepare(
    "UPDATE agents SET work_category = NULL, work_category_label = NULL, waiting_on_who = NULL, waiting_on_ref = NULL, work_category_set_at = NULL, work_category_set_by = NULL WHERE session_id = ? AND work_category = 'done'",
  );
  const updateCharacter = db.prepare(
    'UPDATE agents SET character_pose = ?, character_face = ?, character_prop = ?, character_set_at = ?, character_set_by = ? WHERE session_id = ?',
  );
  const NO_CHARACTER = 'character_pose = NULL, character_face = NULL, character_prop = NULL, character_set_at = NULL, character_set_by = NULL';
  /** Takes the agent's pose off: every pose, or with `resting` only a resting one, or only a working one. */
  const clearCharacter = db.prepare(`UPDATE agents SET ${NO_CHARACTER} WHERE session_id = ?`);
  const clearRestingCharacter = db.prepare(`UPDATE agents SET ${NO_CHARACTER} WHERE session_id = ? AND character_pose IN (${RESTING_SQL})`);
  const clearWorkingCharacter = db.prepare(`UPDATE agents SET ${NO_CHARACTER} WHERE session_id = ? AND character_pose NOT IN (${RESTING_SQL})`);
  /** A working pose that lapsed, unless a new set came since. */
  const clearLapsedCharacter = db.prepare(`UPDATE agents SET ${NO_CHARACTER} WHERE session_id = ? AND character_set_at = ?`);
  // The daemon went away, and every turn with it: a working pose went at its turn's end.
  db.prepare(`UPDATE agents SET ${NO_CHARACTER} WHERE character_pose NOT IN (${RESTING_SQL})`).run();
  /** Cancels the timer that redraws a working pose's tile as it lapses (`CHARACTER_EXPIRY_MS`), one per agent. */
  const characterLapses = new Map<string, () => void>();
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
  const pages = createAgentPageStore(db);
  /**
   * The final message of each agent's last finished turn (its Stop's `last_assistant_message`), which a manual edge
   * sends. Unlike its last message (`hookStates`) a new prompt keeps it: it is still the last finished turn's. Kept in
   * its row, so it outlives the daemon.
   */
  const updateFinalMessage = db.prepare("UPDATE agents SET final_message = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE session_id = ?");
  const selectFinalMessage = db.prepare('SELECT final_message FROM agents WHERE session_id = ?');
  const permissions = createPermissionHolds({
    holdMs: options.permissionHoldMs,
    askingHoldMs: Math.max(options.permissionHoldMs, ASKING_PERMISSION_HOLD_MS),
    dialogTakeMs: options.dialogTakeMs,
    onChange(sessionId) {
      const agent = get(sessionId);
      if (agent !== undefined) options.broadcast({ type: 'agent.updated', agent });
    },
    // Claude took the board's Send but not its answers, and carries on as if the user had answered nothing: only the
    // user can tell it what they picked, so flag them, in place of whatever flag it had.
    onAnswersDropped(sessionId) {
      const row = getRow(sessionId);
      if (row === undefined || row.ended_at !== null) return;
      const earlier = underFoldings(sessionId);
      if (earlier !== undefined) unfold(sessionId, earlier.id, undefined);
      flags.set(sessionId, { id: ++lastFlagId, reason: ANSWERS_DROPPED_FLAG, at: new Date().toISOString(), via: null, forUser: true });
      announce(sessionId);
    },
    onDialogClosed: (sessionId, requestId) => lookForDecline(sessionId, requestId),
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
    /** Whether it reaches the agent's live orchestrator, as its own flag would, rather than only the user. */
    toLead?: boolean;
  }
  /** The flag `folding` shows: its own reason, then the one it stands in place of. */
  const foldedFlag = (folding: Folding): StoredFlag => {
    const also = folding.replaced === undefined ? '' : `. Also: ${folding.replaced.reason}`;
    const reason = `${folding.base}${also}`.slice(0, MAX_FLAG_LENGTH);
    // One that carries a flag only the user may answer goes to the user with it.
    const forUser = folding.toLead !== true || folding.replaced?.forUser === true;
    return { id: folding.id, reason, at: folding.at, via: null, forUser, ...(folding.keepsEnded ? { keepsEnded: true } : {}) };
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
  const raiseFolding = (
    sessionId: string,
    before: Folding | undefined,
    base: string,
    keepsEnded: boolean,
    { at = new Date().toISOString(), toLead = false }: { at?: string; toLead?: boolean } = {},
  ): Folding => {
    const standing = flags.get(sessionId);
    const buried = before !== undefined && foldingsOf(sessionId).some((other) => other !== before && other.replaced?.id === before.id);
    const replaced = standing !== undefined && standing.id !== before?.id && !buried ? standing : before?.replaced;
    const folding: Folding = { id: ++lastFlagId, base, at, keepsEnded, ...(replaced === undefined ? {} : { replaced }), ...(toLead ? { toLead } : {}) };
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
    const folding = raiseFolding(sessionId, before, base, true, { at });
    undelivered.set(sessionId, { ...folding, items });
    if (before !== undefined) unfold(sessionId, before.id, foldedFlag(undelivered.get(sessionId)!));
  };
  /**
   * Hands back what was queued for the agent and never typed: kept for Resend, and flagged to the user. A flag the agent
   * already had (its own words, or why its start stalled) is kept: its reason goes on in this flag's, and it stands
   * again once what was not delivered is resent or cleared, unless it has gone meanwhile. One another agent sent
   * (`from`) goes back to that agent instead (`tellSender`): the user never sent it, and the agent it was for has
   * nothing to answer for.
   */
  const keepUndelivered = (sessionId: string, what: string, text: string, reason: string, from?: string) => {
    if (getRow(sessionId) === undefined) return;
    if (from !== undefined) return tellSender(from, sessionId, text, reason);
    options.log(`${what} sent to ${sessionId} before it was up was not delivered: ${reason}`);
    const at = new Date().toISOString();
    insertUndelivered.run(sessionId, what, text, reason, at);
    flagUndelivered(sessionId, [...(undelivered.get(sessionId)?.items ?? []), { what, text, reason }], at);
    announce(sessionId);
  };
  /**
   * Tells the agent `from` that its message `text` to the agent `to` was not delivered, and why: typed at its prompt,
   * as its crew's flags are, once its turn ends. An older notice of the same still waiting goes, this one counting
   * what it told of. One whose sender has gone is only logged: nobody is left to tell. A send to an ended agent is
   * refused, so the notice says to restart it first.
   */
  const tellSender = (from: string, to: string, text: string, reason: string) => {
    const receiver = getRow(to)!;
    options.log(`a message from ${from} to ${to} was not delivered (${reason}): ${from} is told`);
    if (getRow(from) === undefined) return options.log(`${from} has been deleted: the message to ${to} is dropped`);
    const lost = deliveries.dropNotices(from, to) + 1;
    const sent = oneLine(readSender(text).text.replace(SEND_TRAILER, ''));
    const excerpt = sent.length > NOTICE_EXCERPT ? `${sent.slice(0, NOTICE_EXCERPT).trimEnd()}…` : sent;
    const ref = refOf({ sessionId: to });
    const messages = lost === 1 ? 'Your message' : `Your ${lost} messages`;
    const send = `\`agent-board send ${ref} -- '…'\``;
    const notice = [
      `[agent-board] ${messages} to ${receiver.name} (${ref}) ${lost === 1 ? 'was' : 'were'} not delivered: ${reason}. The last began: "${excerpt}"`,
      receiver.ended_at === null
        ? `Send it again with ${send} if it still matters.`
        : `Restart it with \`agent-board restart ${ref}\`, then send it again with ${send}, if it still matters.`,
    ].join('\n');
    const told = (why: string) => options.log(`the notice to ${from} that its message to ${to} was not delivered: ${why}`);
    deliveries.queueAfterTurn(from, {
      text: notice,
      about: to,
      lost,
      typing: () => told('being typed'),
      settled: (started, why) => told(started ? 'typed' : (why ?? 'not typed')),
    });
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
   * meanwhile. With no `what`, takes this flag down: the prompt holds nothing unsent now. A first prompt left unsent
   * goes to the agent's live orchestrator, as its own flag would: nobody else heard of it, and that orchestrator may
   * submit it (`send --submit`). Not when the user typed there: that prompt holds their words too.
   */
  const flagNotSent = (sessionId: string, what?: string, why?: string, inTerminal = false) => {
    const before = notSentFlags.get(sessionId);
    if (what === undefined) {
      if (before === undefined) return;
      notSentFlags.delete(sessionId);
      lowerFolding(sessionId, before);
      return;
    }
    const row = getRow(sessionId);
    const toLead = what === FIRST_PROMPT && !inTerminal && row !== undefined && led(row) !== null;
    const where = inTerminal
      ? 'send or clear it in its terminal'
      : toLead
        ? `Send or Clear it on its tile, or \`agent-board send ${agentRefOf(sessionId)} --submit\``
        : 'Send or Clear it on its tile';
    const folding = raiseFolding(sessionId, before, `${what} was typed at its prompt but not sent (${why}): ${where}`, false, { toLead });
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
    // No task and its composer seen up (holding a draft of the user's): its session is up, nothing is stalled.
    if (entry.prompt === undefined && entry.watchScreen && composerWatch.seenUp(sessionId)) return;
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
    // No task to wait for Send: the user submitting at a composer seen up says its session is up.
    if (entry.prompt === undefined) {
      hookStates.composerUp(sessionId);
      return settleFirstPrompt(sessionId, true);
    }
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
    startingMaxMs: options.startLimitMs,
    onCommand: (sessionId) => backgroundCommands.of(sessionId).length > 0,
    startingEnded(sessionId) {
      announce(sessionId);
      stallSoon(sessionId);
    },
    silent: (selectHooksSilent.all() as { session_id: string }[]).map((silent) => silent.session_id),
    silentChanged(sessionId, silent) {
      updateHooksSilent.run(silent ? 1 : 0, sessionId);
      announce(sessionId);
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
  const insertWaiting = db.prepare(
    'INSERT INTO waiting_messages (session_id, text, from_session_id, about_session_id, lost, at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const deleteWaiting = db.prepare('DELETE FROM waiting_messages WHERE id = ?');
  const selectWaiting = db.prepare('SELECT id, session_id, text, from_session_id, about_session_id, lost FROM waiting_messages ORDER BY id');
  /** Where what waits for an agent's turn to end is kept, so a restart types it once the agent is resumed. */
  const waitingStore: WaitingStore = {
    add: (sessionId, { text, from, about, lost }) =>
      Number(insertWaiting.run(sessionId, text, from ?? null, about ?? null, lost ?? null, new Date().toISOString()).lastInsertRowid),
    remove: (id) => void deleteWaiting.run(id),
    all: () =>
      (
        selectWaiting.all() as unknown as {
          id: number;
          session_id: string;
          text: string;
          from_session_id: string | null;
          about_session_id: string | null;
          lost: number | null;
        }[]
      ).map(
        (row): KeptWaiting => ({
          id: row.id,
          sessionId: row.session_id,
          text: row.text,
          ...(row.from_session_id === null ? {} : { from: row.from_session_id }),
          ...(row.about_session_id === null ? {} : { about: row.about_session_id }),
          ...(row.lost === null ? {} : { lost: row.lost }),
        }),
      ),
  };
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
    draftHeldFor: hookStates.draftHeldFor,
    announce: (sessionId) => announce(sessionId),
    undelivered: (sessionId, what, text, reason, from) => keepUndelivered(sessionId, what, text, reason, from),
    promptsFromNow(sessionId) {
      const row = getRow(sessionId);
      const path = row?.transcript_path ?? null;
      const start = path === null ? undefined : transcriptSizeSync(path);
      if (row === undefined || path === null || start === undefined) return undefined;
      return () => readTranscriptFromSync(path, start).flatMap((line) => promptsIn(row.harness, line));
    },
    waiting: waitingStore,
    notSent: (sessionId, what, why, inTerminal) => flagNotSent(sessionId, what, why, inTerminal),
    log: options.log,
    // Its waits are the terminal's, in real time: never the schedules' clock, which tests drive by hand.
    submitConfirmMs: options.submitConfirmMs,
    userIdleMs: options.userIdleMs,
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
    options.onTurnCut?.(sessionId, 'its turn ended with no word from its harness');
    save(now, 'idle', subagentsAfterExit(subagents.of(sessionId), 'idle', new Date()), true);
  };
  /**
   * The agent's turn was interrupted, by the board or in its terminal: it is over now. Claude fires no hook for an
   * interrupted turn, and the subagents and prompts went with it, and the call it waited on the user in, whether or not
   * its harness cancels it.
   */
  const endInterruptedTurn = (sessionId: string) => {
    permissions.drop(sessionId);
    options.asks?.drop(sessionId);
    hookStates.interrupted(sessionId);
    deliveries.turnEnded(sessionId, false);
    options.onTurnCut?.(sessionId, 'its turn was interrupted');
    save(getRow(sessionId)!, 'idle', subagentsAfterExit(subagents.of(sessionId), 'idle', new Date()), true);
  };
  /**
   * Claude's question dialog closed with the prompt still up (`onDialogClosed`): unless its call's `PostToolUse` comes,
   * the user declined the questions there (Esc), which ends Claude's turn with no hook. Its transcript then says the
   * user interrupted it for tool use: looked for each of `DECLINE_LOOKS_MS` after, as Claude writes it, and on it the
   * turn ends as an interrupt from the board would end it.
   */
  const lookForDecline = (sessionId: string, requestId: string, look = 0) => {
    const asking = () => permissions.prompts(sessionId).some((prompt) => prompt.id === requestId);
    clock.setTimer(() => {
      const row = getRow(sessionId);
      if (row === undefined || row.ended_at !== null || row.transcript_path === null || !asking()) return;
      void readTranscriptTail(row.transcript_path).then((lines) => {
        const now = getRow(sessionId);
        if (now === undefined || now.ended_at !== null || !asking()) return;
        if (!turnInterruptedInTranscript(lines)) {
          if (look + 1 < DECLINE_LOOKS_MS.length) lookForDecline(sessionId, requestId, look + 1);
          return;
        }
        options.log(`agent ${sessionId}'s questions were declined in its terminal, which ended its turn: moved to idle`);
        endInterruptedTurn(sessionId);
      });
    }, DECLINE_LOOKS_MS[look]!);
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
      const cancel = (options.clock ?? systemClock).setTimer(() => stallSoon(sessionId), options.startLimitMs ?? FIRST_PROMPT_STALL_MS);
      firstPrompts.set(sessionId, { prompt, harness, settle, stalled: false, trust: false, trusted: false, zoneTried: false, flagId: null, cancel, watchScreen: harness === 'codex' });
      deliveries.firstPrompt(sessionId, prompt, ready);
    },
    watch: (...launched) => lifecycle.watchLaunched(...launched),
  });
  const lifecycle = createAgentLifecycle({
    ...options,
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
        stateTimes.forget(sessionId);
        hookStates.deleted(sessionId);
      },
    },
    deliveries,
  });

  /**
   * Whether its daemon went away under the agent, and it has not been resumed since: so with a schedule too, whose
   * clock may not fire for days, if ever again.
   */
  const isStoppedByRestart = (row: AgentRow) => row.ended_at !== null && row.stopped_by_restart === 1;

  /** Whether the agent is paused: ended by a pause, not woken since. */
  const isHibernated = (row: AgentRow) => row.ended_at !== null && row.hibernated_at !== null;

  /** Who paused an agent, by name as it is now: the user (null), or the orchestrator `id`, removed or not. */
  const pausedBy = (id: string | null): { by: string | null; byId: string | null } =>
    id === null ? { by: null, byId: null } : { by: getRow(id)?.name ?? 'a removed orchestrator', byId: id };

  const selectLiveSession = db.prepare('SELECT 1 FROM sessions WHERE id = ? AND ended_at IS NULL');
  // A ticket's chat leads its helpers too, those it didn't start among them.
  const selectCrew = db.prepare('SELECT session_id FROM agents WHERE spawned_by = ? OR ticket = ?');
  const updateLead = db.prepare('UPDATE agents SET spawned_by = ?, orphaned_from = NULL WHERE session_id = ?');
  const selectHandedCrew = db.prepare('SELECT session_id FROM agents WHERE spawned_by = ? OR orphaned_from = ?');
  // Only while a crew agent still names it: a removed orchestrator with none left has nothing to hand over.
  const selectRemovedLead = db.prepare(
    'SELECT session_id, name FROM removed_orchestrators r WHERE session_id = ? AND EXISTS (SELECT 1 FROM agents WHERE orphaned_from = r.session_id)',
  );
  const selectRemovedLeadName = db.prepare('SELECT name FROM removed_orchestrators WHERE session_id = ?');
  const deleteRemovedLead = db.prepare('DELETE FROM removed_orchestrators WHERE session_id = ?');

  /** The removed orchestrator `id` whose crew is still on the board, as a handover needs it; undefined for none. */
  const removedLead = (id: string): RemovedOrchestrator | undefined => {
    const row = selectRemovedLead.get(id) as { session_id: string; name: string } | undefined;
    return row === undefined ? undefined : { sessionId: row.session_id, name: row.name };
  };

  /**
   * The ticket the agent is a helper of, while its chat is on the board: a start that raced the chat's delete, or an
   * older daemon's delete, leaves the column naming a gone chat, and the agent is then a helper of none.
   */
  const ticketOf = (row: AgentRow): string | null => (row.ticket !== null && getRow(row.ticket)?.ticket_chat === 1 ? row.ticket : null);
  /** Its place on its ticket's own board, while it has one and is in a ticket (`Agent.ticketPlace`). */
  const ticketPlaceOf = (row: AgentRow): { ticketPlace?: TicketBoardPlace } =>
    row.ticket_x === null || row.ticket_y === null || (row.ticket_chat !== 1 && ticketOf(row) === null) ? {} : { ticketPlace: { x: row.ticket_x, y: row.ticket_y } };

  /**
   * The name of the agent's orchestrator while that one is live: its ticket's chat for a helper, else the agent that
   * started it. Null for a loose agent, the Captain's, or one whose orchestrator ended.
   */
  const led = (row: AgentRow): string | null => {
    const leadId = flagLeadOf({ ticket: ticketOf(row), spawnedBy: row.spawned_by });
    if (leadId === null) return null;
    const lead = getRow(leadId);
    // Never the Captain (ADR-0019): what its leads ask or plan waits for the user, never for it to settle.
    return lead === undefined || lead.master === 1 || selectLiveSession.get(leadId) === undefined ? null : lead.name;
  };

  /** Tells every client about the agents `leadId` started, whose `ledBy` changed with it: its start, end or new name. */
  const announceCrew = (leadId: string) => {
    for (const { session_id: crewId } of selectCrew.all(leadId, leadId) as { session_id: string }[]) announce(crewId);
  };

  /** The agent's flag, reaching its orchestrator while that one is live, else the user. */
  const flagOf = (row: AgentRow): AgentFlag | null => {
    const kept = flags.get(row.session_id);
    if (kept === undefined || (row.ended_at !== null && kept.keepsEnded !== true)) return null;
    const { id, reason, at, via, forUser } = kept;
    return { id, reason, at, via, to: forUser !== true && led(row) !== null ? 'orchestrator' : 'user' };
  };

  const toAgent = (row: AgentRow): Agent => {
    const schedule = options.schedules.forAgent(row.session_id);
    const live = row.ended_at === null;
    const ask = live ? (options.asks?.pendingAsk(row.session_id) ?? null) : null;
    const removeAsk = live ? (options.removeAsk?.(row.session_id) ?? null) : null;
    const plan = options.asks?.latestPlan(row.session_id) ?? null;
    // A clock's fresh agent whose turn ended on a question waits for you, as a scheduled one does: its run goes on.
    const clockRunAsking = options.schedules.runOf(row.session_id) !== undefined && hookStates.askingAtPrompt(row);
    const hooked = isHibernated(row)
      ? 'hibernated'
      : isStoppedByRestart(row)
        ? 'stopped-by-restart'
        : schedule?.enabled
          ? hookStates.scheduledState(row)
          : clockRunAsking
            ? 'waiting'
            : row.state;
    // Its call waits on the user mid-turn, whatever its hooks say, but for a permission prompt of a subagent's.
    const state = live && waitsOnUser({ ask, removeAsk, plan }) && hooked !== 'needs-permission' ? 'waiting' : hooked;
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
      effort: row.effort,
      effortPending: !live ? null : effortAfterTurn.has(row.session_id) ? 'after-turn' : effortAtRestart.has(row.session_id) ? 'restart' : null,
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
      cutOffMidTurn: row.turn_cut_off === 1,
      hibernated: isHibernated(row)
        ? { at: row.hibernated_at!, ...pausedBy(row.hibernated_by) }
        : null,
      earlierConversations: (selectConversations.all(row.session_id) as unknown as ConversationRow[]).map((each) => ({
        conversationId: each.harness_session_id,
        transcriptPath: each.transcript_path,
        endedAt: each.ended_at,
      })),
      // An ended session strikes no pose of its own: the board draws how it ended.
      character: row.ended_at === null ? characterOf(row, clock.now()) : null,
      workCategory: workCategoryOf(row),
      purpose: row.purpose,
      status: statusAfterTurn(
        row.status_summary === null || row.status_updated_at === null
          ? null
          : { summary: row.status_summary, progress: row.status_progress, updatedAt: row.status_updated_at, setBy: row.status_set_by },
        isWorking({ state: shownState, ask, removeAsk, plan, endedAt: row.ended_at }),
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
      stateSince: stateTimes.since(
        row.session_id,
        shownState,
        new Date(clock.now()).toISOString(),
        shownState === 'hibernated' ? row.hibernated_at : live ? null : row.ended_at,
      ),
      finishedAt: row.finished_at,
      permissions: permissions.prompts(row.session_id),
      ask,
      removeAsk,
      stepsWait: live ? (options.stepsWait?.(row.session_id) ?? null) : null,
      plan,
      docs: options.documents?.list(row.session_id) ?? [],
      schedule,
      reviewOf: row.review_of,
      reviewCap: row.review_cap ?? DEFAULT_REVIEW_CAP,
      ownsWorktree: row.owns_worktree === 1,
      master: row.master === 1,
      // Agents in the app's own group folders from before the column are still known by where they run.
      plainFolder: row.plain_folder === 1 || inGroupFolder(options.groupsDir, row.worktree),
      spawnedBy: row.spawned_by,
      orphanedFrom: row.orphaned_from === null ? null : { sessionId: row.orphaned_from, name: (selectRemovedLeadName.get(row.orphaned_from) as { name: string } | undefined)?.name ?? 'a removed orchestrator' },
      ticket: ticketOf(row),
      ticketChat: row.ticket_chat === 1,
      ...(row.ticket_chat === 1 ? { chatKind: row.ticket_lead === 1 ? ('lead' as const) : ('implementer' as const) } : {}),
      ...(row.ticket_chat === 1 && isTicketChatKind(row.chat_switch) ? { chatSwitch: row.chat_switch } : {}),
      ...(row.ticket_chat === 1 ? { watch: ticketWatchOf(row.watches, row.watch_state) } : {}),
      ...ticketPlaceOf(row),
      ledBy: led(row),
      records: records.of(row.session_id),
      page: pages.of(row.session_id) ?? null,
      guessedDoc: guessedDocOf(row.worktree),
      startup,
      hooksSilent: live && hookStates.hooksSilent(row.session_id),
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

  /**
   * Why an answer to the agent's question prompt can't land: its answers were sent from the board already (`sent`), or
   * it is gone, answered in its terminal or changed.
   */
  const questionsGone = (agent: Agent, sent = false) =>
    new RpcMethodError(
      AGENT_ERROR.permissionGone,
      sent
        ? `${agent.name}'s answers were already sent from the board: nothing more was sent`
        : `${agent.name}'s questions were answered in its terminal, or changed: nothing was sent from here`,
    );
  /** The questions of the agent's question prompt `requestId` while the board can still answer it, or it refuses. */
  const openQuestions = (agent: Agent, requestId: string): PromptQuestion[] => {
    const prompt = permissions.prompts(agent.sessionId).find((each) => each.id === requestId);
    if (prompt === undefined || prompt.questions === null || prompt.dialog === null || prompt.heldUntil === null) {
      throw questionsGone(agent, (prompt?.dialog?.sentAt ?? null) !== null);
    }
    return prompt.questions;
  };

  const requireAgent = (sessionId: string): Agent => toAgent(requireRow(sessionId));

  /** Sets its work category whole (a label or who left out goes), or clears it with a null category. */
  const setWorkCategory = (sessionId: string, set: WorkCategorySet, at: string, setBy: string | null): void => {
    const cleared = set.category === null;
    updateWorkCategory.run(set.category, set.label ?? null, set.waitingOn?.who ?? null, set.waitingOn?.ref ?? null, cleared ? null : at, cleared ? null : setBy, sessionId);
  };

  /**
   * Its work is finished, whether it said `done` or handed off: Done, unless it gave a category with it, and when it
   * finished, kept from the first time. Its next prompt clears both.
   */
  const finishWork = (sessionId: string, at: string, setBy: string | null, category: WorkCategorySet = { category: 'done' }): void => {
    setWorkCategory(sessionId, category, at, setBy);
    if (requireRow(sessionId).work_finished_at === null) updateFinished.run(at, sessionId);
  };

  /**
   * Sets the agent's pose (`none` takes it off), its face and prop with it. A working pose lapses with no new set, and
   * its tile is redrawn then; the board draws whichever pose was set last, however soon after the one before.
   */
  const setCharacter = (sessionId: string, character: CharacterSet, at: string, setBy: string | null): void => {
    characterLapses.get(sessionId)?.();
    characterLapses.delete(sessionId);
    if (character.pose === 'none') {
      clearCharacter.run(sessionId);
      return;
    }
    updateCharacter.run(character.pose, character.face ?? null, character.prop ?? null, at, setBy, sessionId);
    if (isRestingPose(character.pose)) return;
    const cancel = clock.setTimer(() => {
      characterLapses.delete(sessionId);
      if (Number(clearLapsedCharacter.run(sessionId, at).changes) === 0) return;
      const agent = get(sessionId);
      if (agent !== undefined) options.broadcast({ type: 'agent.updated', agent });
    }, CHARACTER_EXPIRY_MS);
    characterLapses.set(sessionId, cancel);
  };

  /** Takes the agent's pose off, as much of it as `clear` does, and the timer of its lapse with it. Its state saved after says so to every client. */
  const takeOffPose = (sessionId: string, clear: typeof clearCharacter): void => {
    if (Number(clear.run(sessionId).changes) === 0) return;
    characterLapses.get(sessionId)?.();
    characterLapses.delete(sessionId);
  };

  /** Whether the live agent waits on a question or dialog of its own, in its turn: not at its prompt. */
  const questionUp = (row: AgentRow) => row.state === 'waiting' && hookStates.promptNow(row) === 'moved-on';

  /**
   * Takes off the pose a move from `row`'s state to `state` ends. A turn over takes a working pose with it, however it
   * ended: its `Stop`, an interrupt (Claude sends no hook for one), or the idle a `Stop` that never came is moved to
   * (its idle prompt, which moves it to `waiting`, is `onHook`'s to read).
   * A turn begun from its prompt takes a resting one, which rested until then, whether a prompt began it or a wake with
   * none. A permission or a question in a turn under way is neither.
   */
  const poseAfterMove = (row: AgentRow, state: SessionState): void => {
    if (state === row.state) return;
    const wasAtPrompt = TURN_OVER.has(row.state) || (row.state === 'waiting' && !questionUp(row));
    if (TURN_OVER.has(state)) takeOffPose(row.session_id, clearWorkingCharacter);
    else if (wasAtPrompt && (AT_WORK.has(state) || state === 'needs-permission')) takeOffPose(row.session_id, clearRestingCharacter);
  };

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
    // Its next turn has begun: a cut-off turn is over, carried on or not (the continue line, or any other message, began it).
    // A turn has begun: its new conversation has started, so "no earlier conversation" is over.
    if (AT_WORK.has(state) && row.notice === NO_CONVERSATION_NOTICE) updateNotice.run(null, row.session_id);
    if (AT_WORK.has(state) && row.turn_cut_off === 1) updateCutOff.run(row.session_id);
    poseAfterMove(row, state);
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
    sendTrail: (sessionId, chars) => sendTrail(options.log, sessionId, chars),
    queueAfterTurn: deliveries.queueAfterTurn,
    dropNotices: deliveries.dropNotices,
    deliverAfterTurn: deliveries.deliverAfterTurn,
    userTyping: deliveries.userTyping,

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
      hookStates.typed(sessionId, data, getRow(sessionId));
      deliveries.typed(sessionId, data);
    },

    async sendUnsent(sessionId, byUser) {
      let sent: UnsentSent;
      try {
        sent = await deliveries.send(sessionId, byUser);
      } catch (error) {
        options.log(draftLine(sessionId, `not sent: ${(error as Error).message}`));
        throw error;
      }
      options.log(draftLine(sessionId, sent.started ? 'sent, turn started on it' : `not sent, still at its prompt: ${sent.why}`));
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
      options.log(draftLine(sessionId, 'cleared'));
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
      endInterruptedTurn(sessionId);
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

    pause(sessionId, by, why, fold) {
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
      if (refusal !== undefined) throw invalidParams(`${agent.name} can't be paused: ${refusal}`, refusal);
      return lifecycle.hibernate(sessionId, by, why, fold ?? null);
    },

    resume: lifecycle.resume,

    decidePermission(sessionId, requestId, decision) {
      const agent = requireAgent(sessionId);
      const prompt = permissions.prompts(sessionId).find((each) => each.id === requestId);
      if (prompt?.questions != null) throw invalidParams(`${agent.name} asked questions: answer them (agent.answerQuestion, then agent.sendAnswers)`);
      if (decision.behavior === 'allow' && decision.scope === 'session' && prompt?.heldUntil != null && prompt.sessionGrant === null) {
        throw invalidParams('the harness suggested nothing to allow for the session with that prompt');
      }
      if (!permissions.decide(sessionId, requestId, decision)) {
        throw new RpcMethodError(AGENT_ERROR.permissionGone, `${agent.name} is no longer waiting on that permission here`);
      }
      // The harness has its answer and carries on (its next hook says how), unless more prompts are pending.
      const counts = promptCounts(permissions.prompts(sessionId));
      const row = getRow(sessionId)!;
      hookStates.permissionDecided(sessionId);
      save(row, stateWithPrompts(row.state, { ...counts, settled: true }), subagents.of(sessionId), true);
    },

    releasePermission(sessionId, requestId) {
      const agent = requireAgent(sessionId);
      if (!permissions.release(sessionId, requestId)) {
        throw new RpcMethodError(AGENT_ERROR.permissionGone, `${agent.name} is no longer waiting on that permission here`);
      }
      // Its prompt stays, now asking in the terminal.
      options.broadcast({ type: 'agent.updated', agent: get(sessionId)! });
    },

    answerQuestion(sessionId, requestId, index, answer) {
      const agent = requireAgent(sessionId);
      const question = openQuestions(agent, requestId)[index];
      if (question === undefined) throw invalidParams(`${agent.name}'s dialog has no question ${index}`);
      const problem = answer === null ? undefined : answerProblem(question, answer);
      if (problem !== undefined) throw invalidParams(problem);
      if (!permissions.answerQuestion(sessionId, requestId, index, answer)) throw questionsGone(agent);
      options.broadcast({ type: 'agent.updated', agent: get(sessionId)! });
    },

    sendAnswers(sessionId, requestId) {
      const agent = requireAgent(sessionId);
      openQuestions(agent, requestId);
      const prompt = permissions.prompts(sessionId).find((each) => each.id === requestId);
      if (prompt?.dialog?.answers.some((each) => each === null)) throw invalidParams(`answer each of ${agent.name}'s questions before sending`);
      if (!permissions.sendAnswers(sessionId, requestId)) throw questionsGone(agent);
      // Still waiting on its dialog until the call runs (its PostToolUse settles the prompt).
      options.broadcast({ type: 'agent.updated', agent: get(sessionId)! });
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

    placeOnTicket(sessionId, place) {
      const agent = requireAgent(sessionId);
      if (agent.ticket === null && !agent.ticketChat) throw invalidParams(`agent ${sessionId} is not in a ticket`);
      updateTicketPlace.run(place.x, place.y, sessionId);
      const placed = get(sessionId)!;
      options.broadcast({ type: 'agent.updated', agent: placed });
      return placed;
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
      const seeing = row.seen === 0 && waitsForYou({ ...toAgent(row), ledBy: null }, 'turns');
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

    async setEffort(sessionId, effort) {
      const row = requireRow(sessionId);
      const notTaken = effort === null ? undefined : effortRefusal(row.harness, effort);
      if (notTaken !== undefined) throw invalidParams(notTaken);
      // Already its harness's own: nothing changes, and nothing waits for a restart that a level set before didn't.
      if (effort === null && row.effort === null) return { agent: requireAgent(sessionId), applies: effortAtRestart.has(sessionId) ? 'restart' : 'now' };
      updateEffort.run(effort, sessionId);
      effortAfterTurn.delete(sessionId);
      if (row.ended_at !== null) return { agent: announced(sessionId), applies: 'restart' };
      // Neither harness has a command for its own default: its next start, passing none, gives it.
      if (row.harness === 'codex' || effort === null) {
        effortAtRestart.add(sessionId);
        options.log(`${sessionId} takes reasoning effort ${effort ?? "of its harness's own"} when it is next started`);
        return { agent: announced(sessionId), applies: 'restart' };
      }
      // Typed live, it is what the session runs at from then on: nothing waits for a restart any more.
      effortAtRestart.delete(sessionId);
      effortAfterTurn.set(sessionId, effort);
      const typed = await typeEffort(sessionId).catch((error: Error) => {
        options.log(`could not type /effort at ${sessionId}: ${error.message}`);
        return false;
      });
      return { agent: announced(sessionId), applies: typed ? 'now' : 'after-turn' };
    },

    applyEffort(sessionId) {
      if (!effortAfterTurn.has(sessionId)) return;
      void typeEffort(sessionId).then(
        (typed) => typed && announce(sessionId),
        (error: Error) => options.log(`could not type /effort at ${sessionId}: ${error.message}`),
      );
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
      // Its crew read "With" its name.
      announceCrew(sessionId);
      return agent;
    },

    setRole(sessionId, role) {
      requireAgent(sessionId);
      const parsed = role === null ? { role: null, name: null } : parseRole(role);
      if ('error' in parsed) throw invalidParams(parsed.error);
      updateRole.run(parsed.role, parsed.name, sessionId);
      const agent = get(sessionId)!;
      options.broadcast({ type: 'agent.updated', agent });
      return agent;
    },

    roleTemplate(sessionId, role, crewReview) {
      const parsed = parseRole(role);
      if ('error' in parsed) throw invalidParams(parsed.error);
      return spawns.roleTemplate(requireRow(sessionId), parsed, crewReview);
    },

    setStatus(sessionId, { summary = null, progress = null, done = false, character, category, purpose }, setBy = null) {
      requireAgent(sessionId);
      if (summary === null && character === undefined && category === undefined && purpose === undefined) {
        throw invalidParams('give a status summary, a character pose, a category, a description, or more');
      }
      const about = purpose === undefined ? undefined : oneLine(purpose);
      if (about !== undefined && about.length > MAX_PURPOSE_LENGTH) {
        throw invalidParams(`the description is ${about.length} characters; at most ${MAX_PURPOSE_LENGTH}`);
      }
      const text = summary === null ? null : oneLine(summary);
      if (text === '') throw invalidParams('the status summary must not be blank');
      if (text !== null && text.length > MAX_STATUS_LENGTH) {
        throw invalidParams(`the status summary is ${text.length} characters; at most ${MAX_STATUS_LENGTH}`);
      }
      if (progress !== null && !isStatusProgress(progress)) {
        throw invalidParams('progress must be a whole number from 0 to 100');
      }
      if (progress !== null && text === null) throw invalidParams('progress goes with a status summary');
      const at = new Date().toISOString();
      if (text !== null) updateStatus.run(text, progress, at, setBy, sessionId);
      // By the clock its lapse is timed and read by.
      if (character !== undefined) setCharacter(sessionId, character, new Date(clock.now()).toISOString(), setBy);
      if (done) finishWork(sessionId, at, setBy, category);
      else if (category !== undefined) setWorkCategory(sessionId, category, at, setBy);
      if (about !== undefined) updatePurpose.run(about === '' ? null : about, sessionId);
      const agent = get(sessionId)!;
      options.broadcast({ type: 'agent.updated', agent });
      return agent;
    },

    waitsAtPrompt: (sessionId) => hookStates.waitsAtPrompt(sessionId),

    markFinished(sessionId) {
      finishWork(sessionId, new Date().toISOString(), null);
      const agent = get(sessionId)!;
      options.broadcast({ type: 'agent.updated', agent });
      return agent;
    },

    handCrew(from, to) {
      const crew = (selectHandedCrew.all(from, from) as { session_id: string }[]).map((row) => row.session_id).filter((id) => id !== to);
      for (const id of crew) updateLead.run(to, id);
      deleteRemovedLead.run(from);
      return crew;
    },

    removedOrchestrator: removedLead,


    onHook(sessionId, payload, signal) {
      const row = getRow(sessionId);
      // A hook still in flight when the process exited must not revive the ended agent's state.
      if (row === undefined || row.ended_at !== null) return undefined;
      // The `/effort` the board typed, should Claude report it as a prompt: it starts no turn.
      if (isEffortEcho(sessionId, payload)) {
        options.log(`${sessionId} reported the ${String(payload.prompt)} typed at its prompt as a prompt: no turn starts on it`);
        return undefined;
      }
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
        updateHadTurn.run(sessionId);
        if (payload.hook_event_name === 'UserPromptSubmit') deliveries.promptSubmitted(sessionId, payload.prompt);
        deliveries.turnSeen(sessionId, TURN_ENDS.has(payload.hook_event_name));
      }
      // Its own turn ended: what was queued in it is due to start a turn of its own.
      if (payload.agent_id === undefined && TURN_ENDS.has(payload.hook_event_name) && !hookStates.isStale(sessionId, payload)) {
        const limited = payload.hook_event_name === 'StopFailure' && payload.error === 'rate_limit';
        deliveries.turnEnded(sessionId, payload.hook_event_name !== 'Interrupt' && !limited, limited ? 'rate-limited' : 'interrupted');
        if (payload.hook_event_name !== 'Stop') {
          options.onTurnCut?.(sessionId, payload.hook_event_name === 'Interrupt' ? 'its turn was interrupted' : limited ? 'its turn was rate-limited' : 'its turn failed');
        }
      }
      // A new prompt is new work: it is no longer finished.
      if (payload.agent_id === undefined && payload.hook_event_name === 'UserPromptSubmit' && (row.work_finished_at !== null || row.work_category === 'done')) {
        updateFinished.run(null, sessionId);
        clearDoneCategory.run(sessionId);
        announce(sessionId);
      }
      // Its own turn ended, so no call of it still waits on the user: one its harness gave up on (timed out) goes too.
      if (payload.agent_id === undefined && payload.hook_event_name === 'Stop') options.asks?.drop(sessionId);
      // What its hooks alone say of its pose (`poseAfterMove` has the rest): its session's end takes any off, and a prompt
      // taken a resting one, in a turn under way too. Its idle prompt says its turn is over where no `Stop` did (lost, or
      // a turn interrupted in its terminal): it moves to `waiting`, as a question in a turn does, so only the hook tells
      // them apart. Before its state is saved, so the tile drawn for it is without the pose.
      if (payload.agent_id === undefined && !hookStates.isStale(sessionId, payload)) {
        if (payload.hook_event_name === 'SessionEnd') takeOffPose(sessionId, clearCharacter);
        if (payload.hook_event_name === 'UserPromptSubmit') takeOffPose(sessionId, clearRestingCharacter);
        if (payload.hook_event_name === 'Notification' && payload.notification_type === 'idle_prompt') takeOffPose(sessionId, clearWorkingCharacter);
      }
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

    onStart(sessionId) {
      announceCrew(sessionId);
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
      // Its next start takes the effort it was last set to.
      effortAfterTurn.delete(session.id);
      effortAtRestart.delete(session.id);
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
      // Its crew's flags, turns, questions and changes reach the user now.
      announceCrew(session.id);
      // Always tell clients: the agent has ended even if its state already said so. Stopped by the user is not a failure.
      const state = lifecycle.isStopping(session.id) ? 'done' : stateAfterExit(row.state, session.exitCode);
      save(row, state, subagentsAfterExit(subagents.of(session.id), state, new Date()), true);
      lifecycle.exited(session.id, session.stoppedByRestart, row.state);
    },

    repoZoneId(sessionId) {
      const row = getRow(sessionId);
      return row && repoZone(row)?.id;
    },

    announce,
    records,
    pages,

    waitChanged(sessionId, began) {
      if (began) updateSeen.run(0, sessionId);
      announce(sessionId);
    },

    fallbackShellCount: lifecycle.fallbackShellCount,

    fallbackOwner: lifecycle.fallbackOwner,

    onShellChanged: lifecycle.onShellChanged,

    close: () => {
      deliveries.close();
      transcripts.close();
      backgroundCommands.close();
      lifecycle.close();
      permissions.close();
      for (const cancel of characterLapses.values()) cancel();
      characterLapses.clear();
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
    effort: optionalStringParam(p, 'effort') as Effort | undefined,
    role: optionalStringParam(p, 'role'),
    noTemplate: optionalBooleanParam(p, 'noTemplate'),
    checkout: optionalStringParam(p, 'checkout') as 'main' | 'worktree' | undefined,
    issueZoneId: optionalStringParam(p, 'issueZoneId'),
    ticketChat: optionalBooleanParam(p, 'ticketChat'),
    chatKind: optionalStringParam(p, 'chatKind') as TicketChatKind | undefined,
    ticket: optionalStringParam(p, 'ticket'),
    allowProjectCodexConfig: optionalBooleanParam(p, 'allowProjectCodexConfig'),
    prompt: optionalStringParam(p, 'prompt'),
    name: optionalStringParam(p, 'name'),
    issueId: optionalStringParam(p, 'issueId'),
    purpose: optionalStringParam(p, 'purpose'),
    position: optionalPlaceParam(p),
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
      const sessionId = stringParam(p, 'sessionId');
      const text = stringParam(p, 'text');
      // The user's own message: never held for their typing, which only another agent's is.
      const answered = await agents.answer(sessionId, text, optionalBooleanParam(p, 'paste'), agents.sendTrail(sessionId, text.length));
      return { queued: !('userTyping' in answered) && answered.queued };
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
      if (p.scope !== undefined && p.scope !== 'session') throw invalidParams('scope must be session');
      agents.decidePermission(stringParam(p, 'sessionId'), stringParam(p, 'requestId'), { behavior, message, ...(p.scope === 'session' ? { scope: 'session' as const } : {}) });
      return null;
    },
    'agent.releasePermission': (params) => {
      const p = paramsObject(params);
      agents.releasePermission(stringParam(p, 'sessionId'), stringParam(p, 'requestId'));
      return null;
    },
    'agent.answerQuestion': (params) => {
      const p = paramsObject(params);
      const index = p.index;
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw invalidParams('index must be a whole number, from 0');
      agents.answerQuestion(stringParam(p, 'sessionId'), stringParam(p, 'requestId'), index, promptAnswerParam(p.answer));
      return null;
    },
    'agent.sendAnswers': (params) => {
      const p = paramsObject(params);
      agents.sendAnswers(stringParam(p, 'sessionId'), stringParam(p, 'requestId'));
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
    'agent.placeOnTicket': (params) => {
      const p = paramsObject(params);
      return agents.placeOnTicket(stringParam(p, 'sessionId'), { x: finiteNumberParam(p, 'x'), y: finiteNumberParam(p, 'y') });
    },
    'agent.setName': (params) => {
      const p = paramsObject(params);
      return agents.setName(stringParam(p, 'sessionId'), requiredNameParam(p, 'name'));
    },
    'agent.setRole': (params) => {
      const p = paramsObject(params);
      return agents.setRole(stringParam(p, 'sessionId'), p.role === null ? null : stringParam(p, 'role'));
    },
    'agent.markSeen': (params) => agents.markSeen(stringParam(paramsObject(params), 'sessionId')),
    'agent.setEffort': (params) => {
      const p = paramsObject(params);
      return agents.setEffort(stringParam(p, 'sessionId'), p.effort === null ? null : oneOf(p, 'effort', EFFORTS));
    },
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

/** An answer to one of Claude's questions, as the app sends it: an option, several, the user's own words, or null to clear it. */
function promptAnswerParam(answer: unknown): PromptAnswer | null {
  if (answer === null) return null;
  const shape = 'answer must be null, { option }, { options } or { text }';
  if (typeof answer !== 'object' || Array.isArray(answer)) throw invalidParams(shape);
  const keys = Object.keys(answer);
  const value = answer as Record<string, unknown>;
  if (keys.length !== 1) throw invalidParams(shape);
  if (typeof value.option === 'number') return { option: value.option };
  if (Array.isArray(value.options) && value.options.every((each) => typeof each === 'number')) return { options: value.options as number[] };
  if (typeof value.text === 'string') return { text: value.text };
  throw invalidParams(shape);
}
