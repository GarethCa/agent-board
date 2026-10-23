import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { CODEX_BYPASS_FLAG, reviewFile, type LaunchSpec } from './agent-spawns.ts';
import type { AgentHost, AgentHostOptions, AgentRow, BranchReviewRow, ZoneRow } from './agents.ts';
import { hasClaudeTranscript } from './claude-transcript.ts';
import { guardCodexConfig, type CodexConfigGuard } from './codex-config-guard.ts';
import type { createDeliveries } from './deliveries.ts';
import { isRunningSomething as defaultIsRunningSomething } from './foreground.ts';
import type { createHookStates } from './hook-states.ts';
import { invalidParams } from './params.ts';
import type { PermissionHolds } from './permissions.ts';
import { AGENT_ERROR, type Agent, type Harness, type SessionState, type TerminalSize } from './protocol.ts';
import { RpcMethodError } from './rpc.ts';
import type { RunStart } from './schedules.ts';
import type { SessionHost } from './sessions.ts';
import { RESET_MODES } from './shells.ts';
import type { SubagentStore } from './subagents.ts';
import type { TranscriptReader } from './transcripts.ts';
import { removeWorktree, unsavedWork } from './worktrees.ts';

/** The tile's notice for an agent relaunched without a conversation to carry on. */
const NO_CONVERSATION_NOTICE = 'No earlier conversation: started fresh';

/** The terminal a relaunched agent starts in, until a client attaches and sizes it. */
const RELAUNCH_SIZE: TerminalSize = { cols: 120, rows: 40 };

/** What an agent's lifecycle reads of the host. */
interface AgentLifecycleOptions
  extends Pick<
    AgentHostOptions,
    | 'db'
    | 'reviewsDir'
    | 'harnessPaths'
    | 'ensureHookShim'
    | 'env'
    | 'onRemoving'
    | 'endTabs'
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
   * pane keeps its last screen and drops into no shell. Its caller checks it may be paused.
   */
  hibernate(sessionId: string, by: string | null, why: string): Promise<Agent>;
  /**
   * While the agent is being paused, what resolves once its session has ended (or failed to): what is sent to it
   * meanwhile then wakes it instead of being typed into a terminal that is going. Undefined while it isn't.
   */
  pausing(sessionId: string): Promise<void> | undefined;
  /**
   * Relaunches an ended agent in its worktree as a new session under the same id, back at `idle` until its
   * SessionStart hook: for a scheduled run with its `prompt` (Codex afresh), or, with no prompt, to resume it where
   * the restart stopped it. `codexSessionId` is the Codex conversation to carry on, if any.
   */
  relaunch(row: AgentRow, prompt: string | undefined, why: string, codexSessionId?: string | null, fresh?: boolean): RunStart;
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
   * pane into a login shell. Neither once its daemon went away under it.
   */
  exited(sessionId: string, stoppedByRestart: boolean): void;
  /** Opens no more shells: the daemon is closing. */
  close(): void;
} {
  const { db, sessions, getRow, get, requireAgent, repoZone, announce, subagents, permissions, transcripts, hookStates, deliveries } =
    options;
  const selectReviewBy = db.prepare('SELECT * FROM branch_reviews WHERE session_id = ?');
  const keepBranchReview = db.prepare('UPDATE branch_reviews SET review_path = ?, session_id = NULL WHERE id = ?');
  const updateNotice = db.prepare('UPDATE agents SET notice = ? WHERE session_id = ?');
  const selectChildren = db.prepare('SELECT session_id FROM agents WHERE spawned_by = ?');
  const forgetParent = db.prepare('UPDATE agents SET spawned_by = NULL WHERE spawned_by = ?');
  const keepConversation = db.prepare('INSERT INTO agent_conversations (session_id, harness_session_id, transcript_path) VALUES (?, ?, ?)');
  const startConversation = db.prepare('UPDATE agents SET harness_session_id = ?, transcript_path = NULL WHERE session_id = ?');
  const restoreConversation = db.prepare('UPDATE agents SET harness_session_id = ?, transcript_path = ? WHERE session_id = ?');
  const updateBypass = db.prepare('UPDATE agents SET codex_bypass_hook_trust = ? WHERE session_id = ?');
  const updateHibernated = db.prepare('UPDATE agents SET hibernated_at = ?, hibernated_by = ? WHERE session_id = ?');
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

  const relaunch = (
    row: AgentRow,
    prompt: string | undefined,
    why: string,
    codexSessionId = prompt === undefined ? row.harness_session_id : null,
    fresh = false,
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
    const task = prompt ?? (noConversation && row.description !== '' ? row.description : undefined);
    let bypassed: boolean;
    try {
      bypassed = options.launch({
        id: sessionId,
        harness: row.harness,
        model: row.model,
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
    updateHibernated.run(null, null, sessionId);
    updateNotice.run(noConversation && prompt === undefined && !fresh ? NO_CONVERSATION_NOTICE : null, sessionId);
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
    }).catch((error: Error) => options.log(`could not open a shell for ${sessionId}: ${error.message}`));
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
    relaunch,

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
      return true;
    },

    isStopping: (sessionId) => stopping.has(sessionId),

    exited(sessionId, stoppedByRestart) {
      if (stoppedByRestart) codexResuming.delete(sessionId);
      else if (codexResuming.delete(sessionId) && !stopping.has(sessionId)) startAfresh(sessionId);
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
        if (agent.ownsWorktree && !keepWorktree) await removeWorktree(repoRoot, agent.worktree, agent.ownedBranch, keepBranch);
      } finally {
        deleting.delete(sessionId);
      }
      options.onRemoving(sessionId);
      remove.run(sessionId);
      // The agents it started stay, started by no one now; the activity log keeps who did.
      const children = (selectChildren.all(sessionId) as { session_id: string }[]).map((child) => child.session_id);
      forgetParent.run(sessionId);
      for (const child of children) announce(child);
      sessions.forget(sessionId);
      subagents.delete(sessionId);
      hookStates.deleted(sessionId);
      deliveries.forget(sessionId);
      permissions.drop(sessionId);
      transcripts.forget(sessionId);
      options.log(`deleted agent ${sessionId}${agent.ownsWorktree ? ` and its worktree ${agent.worktree}` : ''} for ${why}`);
      options.broadcast({ type: 'agent.removed', sessionId });
    },

    async stop(sessionId, why) {
      // A paused agent is closed as it is, never woken: a plain closed agent then, with its last screen and no shell.
      if (requireAgent(sessionId).state === 'hibernated') {
        updateHibernated.run(null, null, sessionId);
        options.log(`closed paused agent ${sessionId} for ${why}`);
        announce(sessionId);
        return get(sessionId)!;
      }
      return stop(sessionId, why);
    },

    hibernate(sessionId, by, why) {
      updateHibernated.run(new Date().toISOString(), by, sessionId);
      const pause = stop(sessionId, why).catch((error: unknown) => {
        updateHibernated.run(null, null, sessionId);
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

    async resume(sessionId, asked, force, fresh) {
      const agent = requireAgent(sessionId);
      if (agent.endedAt === null) throw invalidParams(`${agent.name} is still running`);
      // The daemon ends a reviewer once its review is in, and its round with it: a restart wouldn't reopen the round.
      // A paused reviewer's round goes on: it was paused, not ended.
      if (agent.reviewOf !== null && agent.state !== 'stopped-by-restart' && agent.state !== 'hibernated') {
        throw invalidParams(`${agent.name} is a reviewer whose round is over`);
      }
      // Its session may still be finishing its exit, which a new one under the same id would collide with.
      await sessions.kill(sessionId, `its restart for ${asked}`).catch(() => {});
      const shell = sessions.list().find((session) => session.id === agent.shellSessionId);
      // Two harness instances never share its worktree: not even with `force`. Read now, not as of the last quiet save.
      if (shell !== undefined && (await sessions.shellHarnessNow(shell.id)) === agent.harness) {
        throw invalidParams(`${agent.name} can't be restarted: ${agent.harness} is running in its shell. Exit it first`);
      }
      if (shell !== undefined && !force && (await isRunningSomething(shell.pid))) {
        throw new RpcMethodError(AGENT_ERROR.shellBusy, `${agent.name}'s shell is running something`);
      }
      await endFallbackShell(sessionId, `restart for ${asked}`);
      let row = getRow(sessionId);
      if (row === undefined || row.ended_at === null) return requireAgent(sessionId);
      const previous = { conversation: row.harness_session_id, transcript: row.transcript_path };
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
      const resumed = relaunch(row, fresh?.prompt, why, fresh === undefined ? undefined : null, fresh !== undefined);
      if (fresh !== undefined) {
        if (!resumed.started) restoreConversation.run(previous.conversation, previous.transcript, sessionId);
        else {
          // The old conversation is kept only once the new one has started.
          const old = row.harness === 'claude' ? (previous.conversation ?? sessionId) : previous.conversation;
          if (old !== null) keepConversation.run(sessionId, old, previous.transcript);
        }
      }
      if (!resumed.started) throw invalidParams(`${agent.name} can't be resumed: ${resumed.reason}`);
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
