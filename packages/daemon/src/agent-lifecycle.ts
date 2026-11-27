import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { CODEX_BYPASS_FLAG, launchRole, reviewFile, type LaunchSpec } from './agent-spawns.ts';
import type { AgentHost, AgentHostOptions, AgentRow, BranchReviewRow, ZoneRow } from './agent-types.ts';
import { hasClaudeTranscript } from './claude-transcript.ts';
import { guardCodexConfig, type CodexConfigGuard } from './codex-config-guard.ts';
import type { createDeliveries } from './deliveries.ts';
import { isRunningSomething as defaultIsRunningSomething } from './foreground.ts';
import type { createHookStates } from './hook-states.ts';
import { readLaunchSettings } from './launch-settings.ts';
import { invalidParams } from './params.ts';
import type { PermissionHolds } from './permissions.ts';
import { AGENT_ERROR, INTERRUPTIBLE_STATES, type Agent, type Harness, type SessionState, type TerminalSize } from './protocol.ts';
import { readTranscriptTailSync, turnInterruptedInTranscript } from './quiet-turns.ts';
import { RpcMethodError } from './rpc.ts';
import type { RunStart } from './schedules.ts';
import type { SessionHost } from './sessions.ts';
import { RESET_MODES } from './shells.ts';
import type { SubagentStore } from './subagents.ts';
import type { TranscriptReader } from './transcripts.ts';
import { removeLaunchSettingsFile } from './launch-settings.ts';
import { removeWorktree, unsavedWork } from './worktrees.ts';

/** The tile's notice for an agent that had turns, relaunched without the conversation to carry on; cleared once a turn begins. */
export const NO_CONVERSATION_NOTICE = 'No earlier conversation: started fresh';

/**
 * What a resumed agent whose turn its daemon cut off is told, as its next message, by any resume in its conversation
 * (the user's Resume, `restart-daemon`, an orchestrator's restart or wake). One that was idle, or had ended its turn on a
 * question, is told nothing.
 */
export const CONTINUE_LINE = 'The app restarted; carry on from where you were.';

/**
 * Whether an agent its daemon went away under in `state` had its turn cut off: it was mid-turn (`INTERRUPTIBLE_STATES`,
 * a permission prompt's too), and, for Claude, its transcript doesn't say the user interrupted that turn, which Claude
 * fires no hook for.
 */
function cutOff(state: SessionState, harness: Harness | null, transcriptPath: string | null): boolean {
  if (!INTERRUPTIBLE_STATES.has(state)) return false;
  return harness !== 'claude' || transcriptPath === null || !turnInterruptedInTranscript(readTranscriptTailSync(transcriptPath));
}

/** 1 when an agent cut off in `state` was on a permission prompt, asking rather than working; else 0. */
function asking(state: SessionState): number {
  return state === 'needs-permission' ? 1 : 0;
}

/**
 * Marks the agents a daemon that died left at work as cut off mid-turn. Run at daemon start, before their sessions are
 * marked ended: their last state is still the one they had when it died.
 */
export function markTurnsCutOff(db: DatabaseSync): void {
  const live = db
    .prepare(
      `SELECT a.session_id, a.state, a.transcript_path, s.harness FROM agents a JOIN sessions s ON s.id = a.session_id
        WHERE s.ended_at IS NULL`,
    )
    .all() as { session_id: string; state: SessionState; transcript_path: string | null; harness: Harness | null }[];
  const mark = db.prepare('UPDATE agents SET turn_cut_off = 1, turn_cut_off_asking = ? WHERE session_id = ?');
  for (const row of live) if (cutOff(row.state, row.harness, row.transcript_path)) mark.run(asking(row.state), row.session_id);
}

/** Why an ended agent may not be started again now (`wakeRefusal`): the error Wake throws, and the reason a message's sender hears. */
interface WakeRefusal {
  message: string;
  reason: string;
  /** Its error code, when the app asks the user about it first (a busy shell). */
  code?: number;
  /** Only the user could clear it: a sender that can't ask them keeps the message as undelivered. */
  askUser?: true;
}

/** The terminal a relaunched agent starts in, until a client attaches and sizes it. */
const RELAUNCH_SIZE: TerminalSize = { cols: 120, rows: 40 };

/** What an agent's lifecycle reads of the host. */
interface AgentLifecycleOptions
  extends Pick<
    AgentHostOptions,
    | 'db'
    | 'reviewsDir'
    | 'launchSettingsDir'
    | 'harnessPaths'
    | 'ensureHookShim'
    | 'env'
    | 'onRemoving'
    | 'endTabs'
    | 'beforeWorktreeRemoved'
    | 'isRunningSomething'
    | 'broadcast'
    | 'log'
  > {
  sessions: Pick<SessionHost, 'kill' | 'forget' | 'list' | 'shellHarnessNow' | 'savedScreen' | 'createShell' | 'shellState'>;
  getRow(sessionId: string): AgentRow | undefined;
  get(sessionId: string): Agent | undefined;
  /** The agent, or an invalid-params error if there is none. */
  requireAgent(sessionId: string): Agent;
  /** The zone of the agent's own repo that speaks for it, wherever its tile sits (`repoZoneOf`). */
  repoZone(row: AgentRow): ZoneRow | undefined;
  /** Tells every client about the agent. */
  announce(sessionId: string): void;
  /**
   * After its exit has left what it will (its pane dropped into a shell, or not), and after that shell exits: the agent
   * may now be closed (`isClosed`), with nothing of it left running.
   */
  settled(sessionId: string): void;
  /** Records the agent's state, telling no one. */
  setState(sessionId: string, state: SessionState): void;
  /** Marks what the agent last asked unseen. */
  unsee(sessionId: string): void;
  /** Launches the agent's harness (`createAgentSpawns`); returns whether Codex runs with the bypass flag. */
  launch(spec: LaunchSpec): boolean;
  subagents: Pick<SubagentStore, 'set' | 'delete'>;
  permissions: Pick<PermissionHolds, 'drop'>;
  transcripts: Pick<TranscriptReader, 'forget'>;
  /** The agent's hook states: what a relaunch and a delete forget of them. */
  hookStates: Pick<ReturnType<typeof createHookStates>, 'relaunched' | 'deleted'>;
  /** The hand-offs still landing: what a delete forgets of them. */
  deliveries: Pick<ReturnType<typeof createDeliveries>, 'forget'>;
}

/**
 * An agent's life after its start: stopping, resuming or relaunching it in its worktree, the login shell its pane drops
 * into once it has ended, and deleting it with its worktree. Watches a launched Codex agent for project config, and for
 * `codex resume` failing.
 */
export function createAgentLifecycle(options: AgentLifecycleOptions): Pick<
  AgentHost,
  'isDeleting' | 'delete' | 'stop' | 'resume' | 'fallbackShellCount' | 'fallbackOwner' | 'onShellChanged'
> & {
  /**
   * Ends the live agent's session as `stop` does, marked paused (`hibernated`) by `by` (null for the user), so its
   * pane keeps its last screen and drops into no shell. `fold` is the zone whose fold pauses it, or null. Its caller
   * checks it may be paused.
   */
  hibernate(sessionId: string, by: string | null, why: string, fold: string | null): Promise<Agent>;
  /**
   * While the agent is being paused, what resolves once its session has ended (or failed to): what is sent to it
   * meanwhile then wakes it instead of being typed into a terminal that is going. Undefined while it isn't.
   */
  pausing(sessionId: string): Promise<void> | undefined;
  /**
   * Starts the ended agent again with `prompt` as its first message, as a relaunch does, unless what Wake refuses
   * stands in its way (`wakeRefusal`, never forced: nobody is there to ask). A refusal only the user could overrule
   * says so (`askUser`). A promise only when its pane dropped into a shell, which it looks at first; one started
   * meanwhile is busy.
   */
  wake(row: AgentRow, prompt: string | undefined, why: string, codexSessionId?: string | null, retry?: boolean): RunStart | Promise<RunStart>;
  /** Whether a wake is looking at the agent's shell before it starts it again: it shows ended until it has. */
  isWaking(sessionId: string): boolean;
  /**
   * After a launch: watches a bypassed Codex agent's worktree for project config, and starts a Codex agent afresh if
   * `codex resume` can't carry on `codexSessionId`.
   */
  watchLaunched(sessionId: string, harness: Harness, cwd: string, worktree: string, bypassed: boolean, codexSessionId: string | null): void;
  /** The live login shell the ended agent's pane dropped into, if any. */
  fallbackShell(sessionId: string): string | undefined;
  /** Its own harness, while it is the foreground process of the shell its ended pane dropped into. */
  shellHarnessOf(row: AgentRow): Harness | null;
  /** Looks for project config a bypassed Codex agent may have just written, in case a watch missed it. */
  checkGuard(sessionId: string): void;
  /** Hears the agent's SessionStart: a Codex agent that gets this far has resumed its conversation. */
  started(sessionId: string): void;
  /** Stops watching the agent's worktree for project config. */
  stopGuard(sessionId: string): void;
  /**
   * Hears a session exit. If it is a shell an ended agent's pane dropped into, the pane shows the agent's own ended
   * session again, and it returns true.
   */
  shellExited(shellId: string): boolean;
  /** Whether the user is stopping the agent: its exit is `done` however its process ends. */
  isStopping(sessionId: string): boolean;
  /**
   * After the agent's exit is saved: starts a Codex agent `codex resume` couldn't carry on afresh, or else drops its
   * pane into a login shell. Neither once its daemon went away under it: then, if it was at work as it went
   * (`lastState`, its state before its exit was saved), its turn was cut off, and resuming it tells it to carry on.
   * Any other exit ends what was cut off.
   */
  exited(sessionId: string, stoppedByRestart: boolean, lastState: SessionState): void;
  /** Opens no more shells: the daemon is closing. */
  close(): void;
} {
  const { db, sessions, getRow, get, requireAgent, repoZone, announce, subagents, permissions, transcripts, hookStates, deliveries } =
    options;
  const selectReviewBy = db.prepare('SELECT * FROM branch_reviews WHERE session_id = ?');
  const keepBranchReview = db.prepare('UPDATE branch_reviews SET review_path = ?, session_id = NULL WHERE id = ?');
  const updateNotice = db.prepare('UPDATE agents SET notice = ? WHERE session_id = ?');
  const updateCutOff = db.prepare('UPDATE agents SET turn_cut_off = ?, turn_cut_off_asking = ? WHERE session_id = ?');
  const selectChildren = db.prepare('SELECT session_id FROM agents WHERE spawned_by = ?');
  const orphanCrew = db.prepare('UPDATE agents SET spawned_by = NULL, orphaned_from = ? WHERE spawned_by = ?');
  const selectHelpers = db.prepare('SELECT session_id FROM agents WHERE ticket = ?');
  /** A removed ticket's helpers are in no ticket now. */
  const clearTicket = db.prepare('UPDATE agents SET ticket = NULL, ticket_x = NULL, ticket_y = NULL WHERE ticket = ?');
  const keepRemovedLead = db.prepare('INSERT OR REPLACE INTO removed_orchestrators (session_id, name, crew_depth) VALUES (?, ?, ?)');
  const dropBareLeads = db.prepare('DELETE FROM removed_orchestrators WHERE session_id NOT IN (SELECT orphaned_from FROM agents WHERE orphaned_from IS NOT NULL)');
  const keepConversation = db.prepare('INSERT INTO agent_conversations (session_id, harness_session_id, transcript_path) VALUES (?, ?, ?)');
  const startConversation = db.prepare('UPDATE agents SET harness_session_id = ?, transcript_path = NULL, had_turn = 0 WHERE session_id = ?');
  const restoreConversation = db.prepare('UPDATE agents SET harness_session_id = ?, transcript_path = ?, had_turn = ? WHERE session_id = ?');
  const updateBypass = db.prepare('UPDATE agents SET codex_bypass_hook_trust = ? WHERE session_id = ?');
  // One statement for all three, so whatever wakes or closes a paused agent also forgets the fold that paused it.
  const updateHibernated = db.prepare('UPDATE agents SET hibernated_at = ?, hibernated_by = ?, hibernated_fold = ? WHERE session_id = ?');
  /** Live Codex agents running with the bypass flag, watched for project config appearing. */
  const guards = new Map<string, CodexConfigGuard>();
  const remove = db.prepare('DELETE FROM agents WHERE session_id = ?');
  /** Per agent being paused, what resolves once its session has ended (`pausing`). */
  const pausing = new Map<string, Promise<void>>();
  /** Agents being stopped by the user, whose exit is `done` however their process ends. */
  const stopping = new Set<string>();
  /**
   * Codex agents started with `codex resume` that haven't started yet (no SessionStart): one that exits first couldn't
   * resume its conversation, and is started afresh.
   */
  const codexResuming = new Set<string>();
  /** Per ended agent, the live login shell its pane dropped into; and per such shell, its agent. */
  const fallbackShells = new Map<string, string>();
  const fallbackOwners = new Map<string, string>();
  /** Agents a wake is starting again, while it looks at the shell their pane dropped into first. */
  const waking = new Set<string>();
  /** Agents being deleted, whose pane drops into no shell. */
  const deleting = new Set<string>();
  let closed = false;
  const isRunningSomething = options.isRunningSomething ?? defaultIsRunningSomething;

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
    sessions.kill(sessionId, 'project config appearing').catch((error: Error) => options.log(`could not stop ${sessionId}: ${error.message}`));
  };

  /** The id Claude knows the agent's conversation by: its session id, until a fresh restart started another. */
  const claudeConversationId = (row: AgentRow): string => row.harness_session_id ?? row.session_id;

  /** Why the agent's harness can't be launched in its worktree, if so (before anything is launched). */
  const launchRefusal = (row: AgentRow): string | undefined => {
    if (!existsSync(row.cwd)) return 'its worktree is gone';
    if (options.harnessPaths.path(row.harness) === undefined) return options.harnessPaths.notFound(row.harness);
    return undefined;
  };

  /**
   * Why the ended agent may not be started again now, whoever asks (Wake, a message, a hand-off, a run), if so: a
   * reviewer whose round is over (not one paused or stopped by a restart, nor, with `retry`, one whose start failed),
   * its own harness running in the shell its pane dropped into (never, even with `force`: two harnesses never share its
   * worktree), or that shell running a command (unless `force`, the user's answer to being asked). Read now, not as of
   * the last quiet save; a promise only when there is such a shell to look at.
   */
  const wakeRefusal = (agent: Agent, force: boolean, retry = false): WakeRefusal | undefined | Promise<WakeRefusal | undefined> => {
    if (!retry && agent.reviewOf !== null && agent.state !== 'stopped-by-restart' && agent.state !== 'hibernated') {
      return { message: `${agent.name} is a reviewer whose round is over`, reason: 'it is a reviewer whose round is over' };
    }
    const shell = sessions.list().find((session) => session.id === agent.shellSessionId);
    if (shell === undefined) return undefined;
    return (async () => {
      if ((await sessions.shellHarnessNow(shell.id)) === agent.harness) {
        const reason = `${agent.harness} is running in its shell: exit it first`;
        return { message: `${agent.name} can't be restarted: ${agent.harness} is running in its shell. Exit it first`, reason, askUser: true as const };
      }
      if (!force && (await isRunningSomething(shell.pid))) {
        return { message: `${agent.name}'s shell is running something`, reason: 'its shell is running something', code: AGENT_ERROR.shellBusy, askUser: true as const };
      }
      return undefined;
    })();
  };

  const wake = (row: AgentRow, prompt: string | undefined, why: string, codexSessionId?: string | null, retry = false): RunStart | Promise<RunStart> => {
    const sessionId = row.session_id;
    const agent = get(sessionId);
    if (agent === undefined) return { started: false, reason: 'the agent has been deleted' };
    // Another wake still looking at its shell starts it, or doesn't: this one waits its turn, as for a busy agent.
    if (waking.has(sessionId)) return { started: false, reason: 'it is being started', busy: true };
    const go = (refusal: WakeRefusal | undefined): RunStart => {
      // Its daemon closed while its shell was looked at: nothing is launched after shutdown.
      if (closed) return { started: false, reason: 'the daemon is closing' };
      if (refusal !== undefined) return { started: false, reason: refusal.reason, ...(refusal.askUser === undefined ? {} : { askUser: true }) };
      // Read again after a look at its shell: deleted, or started by another wake, meanwhile.
      const now = getRow(sessionId);
      if (now === undefined) return { started: false, reason: 'the agent has been deleted' };
      if (now.ended_at === null) return { started: false, reason: 'it was started meanwhile', busy: true };
      return relaunch(now, prompt, why, codexSessionId);
    };
    const refusal = wakeRefusal(agent, false, retry);
    if (!(refusal instanceof Promise)) return go(refusal);
    waking.add(sessionId);
    return refusal.then(go).finally(() => waking.delete(sessionId));
  };

  /**
   * Relaunches an ended agent in its worktree as a new session under the same id, back at `idle` until its
   * SessionStart hook: with `prompt` as its first message (Codex afresh, unless `codexSessionId` names the Codex
   * conversation to carry on), or, with no prompt, to resume it where it stopped. Checks only that it can be launched:
   * its callers check `wakeRefusal` first (`wake`, `resume`), but a Codex agent started afresh as its `codex resume`
   * failed, which left nothing in its pane.
   */
  const relaunch = (
    row: AgentRow,
    prompt: string | undefined,
    why: string,
    codexSessionId = prompt === undefined ? row.harness_session_id : null,
    fresh = false,
    carryOn = false,
    quiet = false,
  ): RunStart => {
    const sessionId = row.session_id;
    const refusal = launchRefusal(row);
    if (refusal !== undefined) {
      // Looked for again in the background, so the next try finds a harness installed since.
      if (existsSync(row.cwd)) void options.harnessPaths.refresh(row.harness);
      return { started: false, reason: refusal };
    }
    void endFallbackShell(sessionId, `relaunch ${why}`);
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
    // An agent that never had a turn has no conversation to resume (Claude saves one with the first message, and
    // Codex names it then): it starts fresh under the same id, on its task if it had one.
    // Claude's conversation is named by the session id it was started with, which a fresh restart changes.
    const conversationId = claudeConversationId(row);
    const noConversation =
      row.harness === 'claude' ? !hasClaudeTranscript(row.transcript_path, conversationId, row.cwd, options.env) : row.harness_session_id === null && prompt === undefined;
    // One cut off mid-turn carries on in its conversation, told to; with none to carry on, it starts on its task. A quiet
    // resume types nothing a turn has already had: only a task that never reached it.
    const task =
      prompt ??
      (noConversation ? (row.description !== '' && !(quiet && row.had_turn === 1) ? row.description : undefined) : carryOn ? CONTINUE_LINE : undefined);
    let bypassed: boolean;
    try {
      bypassed = options.launch({
        id: sessionId,
        harness: row.harness,
        model: row.model,
        effort: row.effort,
        bypassHookTrust: bypassHookTrust === 1,
        zoneId: row.zone_id,
        cwd: row.cwd,
        worktree: row.worktree,
        task,
        resume: {
          codexSessionId,
          claudeConversation: !noConversation,
          ...(row.harness === 'claude' && conversationId !== sessionId ? { claudeSessionId: conversationId } : {}),
        },
        allowProjectCodexConfig: false,
        size: RELAUNCH_SIZE,
        ...(row.read_only === 1 ? { readOnly: true } : {}),
        role: launchRole(row),
        launchSettings: readLaunchSettings(row.launch_settings),
      });
    } catch (error) {
      if (error instanceof RpcMethodError && error.code === AGENT_ERROR.projectCodexConfig) {
        return { started: false, reason: 'its worktree has Codex config of its own, so start it by hand to review its hooks' };
      }
      return { started: false, reason: `it could not be relaunched: ${(error as Error).message}` };
    }
    subagents.set(sessionId, []);
    hookStates.relaunched(sessionId);
    // Whatever started it, it is awake now.
    updateHibernated.run(null, null, null, sessionId);
    // A resume after a restart is normal and says nothing. Only a conversation really lost says so: an agent that never
    // had a turn has nothing to lose.
    updateNotice.run(noConversation && prompt === undefined && !fresh && row.had_turn === 1 ? NO_CONVERSATION_NOTICE : null, sessionId);
    // A cut-off turn is kept until a turn begins (`agents.ts`'s `save`), so a restart before the line is typed tells it
    // again; one started on a new conversation, or afresh on its task, has none to carry on.
    if (noConversation || fresh) updateCutOff.run(0, 0, sessionId);
    options.setState(sessionId, 'idle');
    options.unsee(sessionId);
    watchLaunched(sessionId, row.harness, row.cwd, row.worktree, bypassed, codexSessionId);
    options.log(`relaunched ${row.harness} agent ${sessionId} ${why}`);
    announce(sessionId);
    return { started: true };
  };

  const watchLaunched = (
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
    void sessions.kill(sessionId, 'a fresh start').then(() => {
      const row = getRow(sessionId);
      if (row === undefined || row.ended_at === null) return;
      const started = relaunch(row, undefined, "afresh: Codex couldn't resume its conversation", null);
      if (!started.started) {
        options.log(`could not start ${sessionId} afresh: ${started.reason}`);
        if (!closed) options.settled(sessionId);
        return;
      }
      updateNotice.run("Codex couldn't resume its conversation, so it started a new conversation in the same worktree.", sessionId);
      announce(sessionId);
    }, (error: Error) => {
      options.log(`could not start ${sessionId} afresh: ${error.message}`);
      if (!closed) options.settled(sessionId);
    });
  };

  /**
   * Drops the ended agent's pane into the user's login shell in its folder, under its last output, once its session
   * has finished exiting (and its screen is saved). Not while it is being deleted or relaunched, or the daemon closes,
   * nor for an ephemeral reviewer, which the daemon itself stops once its review is in.
   */
  const startFallbackShell = (sessionId: string) => {
    void sessions.kill(sessionId, 'its fallback shell').then(() => {
      const row = getRow(sessionId);
      if (closed || deleting.has(sessionId) || row === undefined || row.ended_at === null || row.review_of !== null || fallbackShells.has(sessionId)) return;
      // A paused agent's pane keeps its last screen: a shell there would hold what pausing freed.
      if (row.hibernated_at !== null) return;
      if (!existsSync(row.cwd)) return;
      const saved = sessions.savedScreen(sessionId);
      const size = saved === undefined ? RELAUNCH_SIZE : { cols: saved.cols, rows: saved.rows };
      const restore = saved === undefined ? '' : `${saved.data}${RESET_MODES}\r\n`;
      const shell = sessions.createShell({ ...size, cwd: row.cwd, restore, zoneId: row.zone_id });
      fallbackShells.set(sessionId, shell.id);
      fallbackOwners.set(shell.id, sessionId);
      announce(sessionId);
    })
      .catch((error: Error) => options.log(`could not open a shell for ${sessionId}: ${error.message}`))
      .then(() => {
        if (!closed) options.settled(sessionId);
      });
  };

  /** Ends the shell the agent's pane dropped into, if any, and resolves once it has exited. */
  const endFallbackShell = async (sessionId: string, why: string): Promise<void> => {
    const shellId = fallbackShells.get(sessionId);
    if (shellId === undefined) return;
    fallbackShells.delete(sessionId);
    fallbackOwners.delete(shellId);
    await sessions.kill(shellId, `its agent's ${why}`).catch((error: Error) => options.log(`could not end the shell ${shellId}: ${error.message}`));
    sessions.forget(shellId);
  };

  const stopGuard = (sessionId: string) => {
    guards.get(sessionId)?.stop();
    guards.delete(sessionId);
  };

  const shellHarnessOf = (row: AgentRow): Harness | null => {
    const shellId = fallbackShells.get(row.session_id);
    if (shellId === undefined || row.ended_at === null) return null;
    const { harness } = sessions.shellState(shellId);
    return harness === row.harness ? harness : null;
  };

  /** Keeps a copy of the review a reviewer about to be deleted left, for the follow-ups of its branch. */
  const keepReview = (sessionId: string, worktree: string) => {
    const review = selectReviewBy.get(sessionId) as BranchReviewRow | undefined;
    if (review === undefined) return;
    const file = reviewFile(worktree);
    let kept: string | null = null;
    if (file !== undefined) {
      try {
        mkdirSync(options.reviewsDir, { recursive: true });
        kept = join(options.reviewsDir, `${review.id}-${basename(file)}`);
        copyFileSync(file, kept);
      } catch (error) {
        options.log(`could not keep the review ${file}: ${(error as Error).message}`);
        kept = null;
      }
    }
    keepBranchReview.run(kept, review.id);
  };

  const stop = async (sessionId: string, why: string): Promise<Agent> => {
    const agent = requireAgent(sessionId);
    if (agent.endedAt !== null) throw invalidParams(`${agent.name} has already ended`);
    stopping.add(sessionId);
    try {
      await sessions.kill(sessionId, why);
    } finally {
      stopping.delete(sessionId);
    }
    return get(sessionId)!;
  };

  return {
    wake,

    isWaking: (sessionId) => waking.has(sessionId),

    watchLaunched,

    fallbackShell: (sessionId) => fallbackShells.get(sessionId),

    shellHarnessOf,

    checkGuard: (sessionId) => guards.get(sessionId)?.check(),

    started: (sessionId) => void codexResuming.delete(sessionId),

    stopGuard,

    shellExited(shellId) {
      const owner = fallbackOwners.get(shellId);
      if (owner === undefined) return false;
      // The shell its pane dropped into has exited: the pane shows the agent's own ended session again.
      fallbackOwners.delete(shellId);
      fallbackShells.delete(owner);
      // Forgotten once its exit has finished: its screen is saved then, and would be written back after a forget now.
      void sessions.kill(shellId, 'its exit').catch(() => {}).then(() => sessions.forget(shellId));
      announce(owner);
      options.settled(owner);
      return true;
    },

    isStopping: (sessionId) => stopping.has(sessionId),

    exited(sessionId, stoppedByRestart, lastState) {
      if (stoppedByRestart) {
        codexResuming.delete(sessionId);
        const row = getRow(sessionId);
        if (row !== undefined && cutOff(lastState, row.harness, row.transcript_path)) updateCutOff.run(1, asking(lastState), sessionId);
        return;
      }
      updateCutOff.run(0, 0, sessionId);
      if (codexResuming.delete(sessionId) && !stopping.has(sessionId)) startAfresh(sessionId);
      else startFallbackShell(sessionId);
    },

    isDeleting: (sessionId) => deleting.has(sessionId),

    async delete(sessionId, why, force, keepWorktree = false, keepBranch = false) {
      const agent = requireAgent(sessionId);
      // Its own repo, wherever its tile sits.
      const { repoRoot } = agent;
      if (!force && !keepWorktree && agent.ownsWorktree) {
        const reason = await unsavedWork(repoRoot, agent.worktree, agent.ownedBranch);
        if (reason !== undefined) throw new RpcMethodError(AGENT_ERROR.unsavedWork, `${agent.name}: ${reason}`);
      }
      stopGuard(sessionId);
      deleting.add(sessionId);
      try {
        if (agent.endedAt === null) await sessions.kill(sessionId, `its delete for ${why}`);
        await endFallbackShell(sessionId, `delete for ${why}`);
        await options.endTabs?.(sessionId);
        if (agent.reviews !== null) keepReview(sessionId, agent.worktree);
        // An agent adopted in the user's own folder takes nothing of theirs with it.
        if (agent.ownsWorktree && !keepWorktree) {
          options.beforeWorktreeRemoved?.(sessionId, agent.worktree);
          await removeWorktree(repoRoot, agent.worktree, agent.ownedBranch, keepBranch);
        }
      } finally {
        deleting.delete(sessionId);
      }
      options.onRemoving(sessionId);
      const { crew_depth: depth = 0 } = getRow(sessionId) ?? {};
      // The agents it started stay, led by no one now but kept apart from the user's: another orchestrator may take
      // them over (`orchestrator.handover`). The activity log keeps who did what.
      const children = (selectChildren.all(sessionId) as { session_id: string }[]).map((child) => child.session_id);
      const helpers = (selectHelpers.all(sessionId) as { session_id: string }[]).map((helper) => helper.session_id);
      db.exec('BEGIN');
      try {
        remove.run(sessionId);
        if (children.length > 0) keepRemovedLead.run(sessionId, agent.name, depth);
        orphanCrew.run(sessionId, sessionId);
        clearTicket.run(sessionId);
        // A removed orchestrator whose last crew agent this was has nothing left to hand over.
        dropBareLeads.run();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      for (const child of new Set([...children, ...helpers])) announce(child);
      sessions.forget(sessionId);
      subagents.delete(sessionId);
      hookStates.deleted(sessionId);
      deliveries.forget(sessionId);
      permissions.drop(sessionId);
      transcripts.forget(sessionId);
      removeLaunchSettingsFile(options.launchSettingsDir, sessionId);
      options.log(`deleted agent ${sessionId}${agent.ownsWorktree ? ` and its worktree ${agent.worktree}` : ''} for ${why}`);
      options.broadcast({ type: 'agent.removed', sessionId });
    },

    async stop(sessionId, why) {
      // A paused agent is closed as it is, never woken: a plain closed agent then, with its last screen and no shell.
      if (requireAgent(sessionId).state === 'hibernated') {
        updateHibernated.run(null, null, null, sessionId);
        options.log(`closed paused agent ${sessionId} for ${why}`);
        announce(sessionId);
        options.settled(sessionId);
        return get(sessionId)!;
      }
      return stop(sessionId, why);
    },

    hibernate(sessionId, by, why, fold) {
      updateHibernated.run(new Date().toISOString(), by, fold, sessionId);
      const pause = stop(sessionId, why).catch((error: unknown) => {
        updateHibernated.run(null, null, null, sessionId);
        throw error;
      });
      const settled = pause.then(
        () => {},
        () => {},
      );
      pausing.set(sessionId, settled);
      void settled.then(() => {
        if (pausing.get(sessionId) === settled) pausing.delete(sessionId);
      });
      return pause;
    },

    pausing: (sessionId) => pausing.get(sessionId),

    async resume(sessionId, asked, force, fresh, quiet = false) {
      const agent = requireAgent(sessionId);
      if (agent.endedAt === null) throw invalidParams(`${agent.name} is still running`);
      // The daemon ends a reviewer once its review is in, and its round with it: a restart wouldn't reopen the round.
      // A paused reviewer's round goes on: it was paused, not ended. What any wake checks (`wakeRefusal`), after its
      // session, which may still be finishing its exit a new one under the same id would collide with, is ended.
      await sessions.kill(sessionId, `its restart for ${asked}`).catch(() => {});
      const refusal = await wakeRefusal(agent, force);
      if (refusal !== undefined) {
        throw refusal.code === undefined ? invalidParams(refusal.message, refusal.reason) : new RpcMethodError(refusal.code, refusal.message, refusal.reason);
      }
      await endFallbackShell(sessionId, `restart for ${asked}`);
      let row = getRow(sessionId);
      if (row === undefined || row.ended_at === null) return requireAgent(sessionId);
      const previous = { conversation: row.harness_session_id, transcript: row.transcript_path, hadTurn: row.had_turn };
      if (fresh !== undefined) {
        // Its harness must find the new conversation on the row to launch it; put back below if it doesn't start.
        startConversation.run(row.harness === 'claude' ? randomUUID() : null, sessionId);
        row = getRow(sessionId)!;
      }
      const how =
        fresh !== undefined
          ? 'with a new conversation'
          : agent.state === 'stopped-by-restart'
            ? 'to resume it after a restart'
            : agent.state === 'hibernated'
              ? 'to wake it'
              : 'to restart it';
      const why = `${how}, for ${asked}`;
      // Told to carry on only by a resume in its own conversation, and only once; a quiet one keeps its cut-off turn.
      const carryOn = fresh === undefined && !quiet && row.turn_cut_off === 1;
      const resumed = relaunch(row, fresh?.prompt, why, fresh === undefined ? undefined : null, fresh !== undefined, carryOn, quiet);
      if (fresh !== undefined) {
        if (!resumed.started) restoreConversation.run(previous.conversation, previous.transcript, previous.hadTurn, sessionId);
        else {
          // The old conversation is kept only once the new one has started.
          const old = row.harness === 'claude' ? (previous.conversation ?? sessionId) : previous.conversation;
          if (old !== null) keepConversation.run(sessionId, old, previous.transcript);
        }
      }
      if (!resumed.started) throw invalidParams(`${agent.name} can't be resumed: ${resumed.reason}`, resumed.reason);
      return get(sessionId)!;
    },

    fallbackShellCount: () => fallbackShells.size,

    fallbackOwner: (sessionId) => fallbackOwners.get(sessionId),

    onShellChanged(shellId) {
      const owner = fallbackOwners.get(shellId);
      if (owner !== undefined) announce(owner);
    },

    close() {
      closed = true;
    },
  };
}
