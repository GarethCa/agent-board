import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  cloneRepo,
  createGitHubTracker,
  createKeychainStore,
  createLinearTracker,
  mergePullRequest,
  pullRequestOfUrl,
  type CredentialStore,
} from '@agent-board/tracker';
import { pullRequestRecord } from './agent-records.ts';
import { agentHandlers, createAgentHost } from './agents.ts';
import { systemClock, type Clock } from './clock.ts';
import { externalHookFiles, externalHooksHandlers } from './external-hooks.ts';
import { createExternalSessionHost, externalHandlers, type ExternalSessionHost } from './external-sessions.ts';
import { externalResumeHandlers } from './resume-external.ts';
import { removeExternalHookFile, writeCliShim, writeExternalHookFile, writeHookShim, type CliLauncher } from './hook-forwarder.ts';
import { boardHandlers, guardBoardCallers, type BoardConnection } from './board.ts';
import { BOARD_SOCKET_ENV, BOARD_TOKEN_ENV } from './board-env.ts';
import { boardMcpHandlers } from './board-mcp.ts';
import { openBoardSession } from './board-ops.ts';
import { createCaptureHost } from './zone-captures.ts';
import { createLayoutMeasures } from './layout-measures.ts';
import { layoutHandlers, spotBesideAgent, type DaemonCall } from './orchestrator-layout.ts';
import { agentNoteAuthor } from './agent-notes.ts';
import { createOrchestratorHost, type OrchestratorHost } from './orchestrators.ts';
import { connectorHandlers } from './connectors.ts';
import { commandPlan } from './flow-approvals.ts';
import { createConditionChecker, createShellRunner } from './flow-conditions.ts';
import { createFlowEdgeHost } from './flow-edges.ts';
import { gateActionHandlers } from './gate-actions.ts';
import { gatedOwner, mergeGateBlocked } from './gate-rules.ts';
import { createGateHost } from './gates.ts';
import { createAskHost } from './asks.ts';
import { createDocumentHost } from './documents.ts';
import { createCrewFlags } from './crew-flags.ts';
import { runGit } from './git.ts';
import { itemHandlers, itemsLeavingZone } from './items.ts';
import { startHookIngress, type HookIngress } from './hook-ingress.ts';
import { hashToken, newToken } from './tokens.ts';
import { acquireDaemonLock } from './lock.ts';
import { createHarnessPaths } from './harness-path.ts';
import { adoptLoginShellPath } from './login-path.ts';
import { migrate, schemaVersion as readSchemaVersion } from './migrate.ts';
import { daemonPaths, prepareSocketDir } from './paths.ts';
import {
  DAEMON_VERSION,
  DOCUMENT_CARD_SIZE,
  PLAN_CARD_SIZE,
  eventLine,
  PROTOCOL_VERSION,
  lineSplitter,
  waitsForYou,
  type BuildInfo,
  type DaemonEvent,
  type DaemonHealth,
  type DaemonMethods,
  type DocumentCardData,
  type PlanCardData,
  type DocumentSummary,
  type Harness,
  type SessionInfo,
  type TrackerProvider,
  type ZoneTracker,
} from './protocol.ts';
import { createNodePtyBackend } from './node-pty-backend.ts';
import { dimensionParam, optionalBooleanParam, optionalStringParam, paramsObject, stringParam } from './params.ts';
import { DEFAULT_PERMISSION_HOLD_MS } from './permissions.ts';
import { fixtureFetch } from './link-fixture-fetch.ts';
import type { FetchLike } from './link-metadata.ts';
import { createSafeFetch } from './safe-fetch.ts';
import { createImageStore } from './image-store.ts';
import { createImageSweeper } from './image-sweeper.ts';
import { createLinkCards } from './link-cards.ts';
import { createRoleTemplates } from './role-templates.ts';
import { createReviewHost } from './reviews.ts';
import { createSelectionAsks } from './selection-asks.ts';
import { createBoardMaster } from './master.ts';
import { handleRpcLine, type RpcHandlers } from './rpc.ts';
import { createClockHost } from './clocks.ts';
import { createSettings } from './settings.ts';
import { createShellHost } from './shells.ts';
import { followSystemTimeZone } from './time-zone.ts';
import { createSessionHost, reconcileLostSessions, type SessionHost, type SessionSubscriber } from './sessions.ts';
import { watchPullRequests } from './pull-requests.ts';
import { createPullRequestLookup } from './agent-pull-requests.ts';
import { pullRequestTabHandlers } from './pull-request-tabs.ts';
import { createTrackerHost, trackerHandlers, type TrackerFactory } from './trackers.ts';
import { setupHandlers } from './setup-checks.ts';
import { viewStateHandlers } from './view-state.ts';
import { createZoneSources, type ZoneSources } from './zone-sources.ts';
import { linkedWorktrees, removeManagedClone, zoneDissolveHandlers } from './zone-dissolve.ts';
import { createZoneTable, inGroupFolder, zoneHandlers } from './zones.ts';

export interface DaemonOptions {
  /** Holds the database, socket, lock and log. Created if missing. */
  dataDir: string;
  /** The build this daemon runs, reported by `daemon.health` so an app can tell it is from another build. */
  build?: BuildInfo;
  /** How long the daemon waits with no clients and no live sessions before it exits. */
  idleTimeoutMs?: number;
  /** How often it checks whether it is idle. */
  idleCheckIntervalMs?: number;
  /** How long its data dir must stay missing (ENOENT, checked on every idle tick) before it exits. */
  dataDirGraceMs?: number;
  log?: (message: string) => void;
  /**
   * The user's home directory, where a shell session with no folder starts, and every shell in an unbound zone:
   * `os.homedir()` by default. Tests point it at a temp dir.
   */
  homeDir?: string;
  /** The shell a shell session runs: `$SHELL` by default. */
  shell?: string;
  /** Its arguments: `-l` by default, a login shell as terminal apps start, so it gets the user's profile and PATH. */
  shellArgs?: string[];
  /** How long killing a session waits after SIGHUP before it sends SIGKILL. */
  killGraceMs?: number;
  /** How long a session's output must go quiet before its screen is saved (tests shorten it). */
  saveQuietMs?: number;
  /** The longest piece of a terminal snapshot sent in one event (tests shorten it). */
  snapshotChunkLength?: number;
  /**
   * Where agent worktrees go (ADR-0007): `$AGENT_BOARD_WORKTREES_DIR`, else `~/.agent-board/worktrees`.
   */
  worktreesDir?: string;
  /**
   * Where an agent started in a scratch repo gets one (ADR-0007): `$AGENT_BOARD_SCRATCH_DIR`, else
   * `~/.agent-board/scratch`.
   */
  scratchDir?: string;
  /** The environment agents' harnesses start from: the daemon's own by default. Tests point it at the fakes. */
  agentEnv?: NodeJS.ProcessEnv;
  /** Where harnesses are looked for after the shells' PATHs: the installers' places by default. Tests point it at temp dirs. */
  harnessDirs?: string[];
  /**
   * How long a PermissionRequest hook is held for an answer from the needs-you inbox before the harness's own
   * prompt takes over: `DEFAULT_PERMISSION_HOLD_MS` by default.
   */
  permissionHoldMs?: number;
  /** How long an agent may answer a message from another agent: an hour by default (`reply-paths.ts`). */
  replyWindowMs?: number;
  /** How long a picture of a zone is waited for from the app: 15 s by default (`zone-captures.ts`). */
  captureTimeoutMs?: number;
  /** How long an arrange waits for the app to measure the notes it wrote: 1.5 s by default (`layout-measures.ts`). */
  measureWaitMs?: number;
  /** How often agents at their prompt are looked at for commands left running in the background: 5 s by default. */
  backgroundPollMs?: number;
  /** How long a step of an agent's start may wait on another process: `START_STEP_TIMEOUT_MS` by default. */
  startStepTimeoutMs?: number;
  /**
   * How to run this app's `agent-board` CLI, which Codex agents' hooks run as the forwarder. When set, the daemon
   * (re)writes the shim at `hookShimPath` to run it, at start and before each Codex spawn; without it, the shim is
   * left as it is.
   */
  hookForwarder?: CliLauncher;
  /**
   * How to run this app's whole `agent-board` CLI (ADR-0010), which the daemon (re)writes as `agent-board` beside the
   * hook shim, puts first on every session's PATH and runs as agents' board MCP server: `hookForwarder` by default.
   * Without either, sessions get the board env but no CLI.
   */
  cli?: CliLauncher;
  /**
   * The stable launcher Codex's hook command names (ADR-0004): `$AGENT_BOARD_HOOK_SHIM`, else
   * `~/.agent-board/bin/agent-board-hook`.
   */
  hookShimPath?: string;
  /**
   * Where tracker credentials live: the OS keychain by default, or the macOS keychain file
   * `$AGENT_BOARD_KEYCHAIN` (for tests).
   */
  credentials?: CredentialStore;
  /**
   * The trackers zones can use: Linear, at `$AGENT_BOARD_LINEAR_API_URL` if set (for tests), and GitHub through `gh`,
   * by default.
   */
  trackers?: Partial<Record<TrackerProvider, TrackerFactory>>;
  /**
   * Where the daemon leaves its address for external sessions' global hooks, which the shim tells them:
   * `$AGENT_BOARD_EXTERNAL_HOOK_FILE`, else `external-hook.json` beside the shim's `bin` folder
   * (`~/.agent-board/external-hook.json`).
   */
  externalHookFile?: string;
  /** The global hook files `externalHooks.setEnabled` edits: `~/.claude/settings.json` and `~/.codex/hooks.json`. */
  externalHookFiles?: Record<Harness, string>;
  /** The GitHub CLI, for GitHub Issues, agents' pull requests and cloning repos: `$AGENT_BOARD_GH`, else `gh` on PATH. */
  gh?: string;
  /**
   * Where zones made from a GitHub repo clone it, as `<reposDir>/<owner>/<repo>`: `$AGENT_BOARD_REPOS_DIR`, else
   * `~/.agent-board/repos`.
   */
  reposDir?: string;
  /** The folders "Find my local copies" looks one level deep in. Default: `~/code`, `~/src`, `~/Developer`, `~/projects`, `~/GitHub`. */
  copyRoots?: string[];
  /**
   * How often it asks gh for agents' pull requests: `$AGENT_BOARD_PULL_REQUEST_POLL_MS` (for tests), else every
   * `DEFAULT_PULL_REQUEST_POLL_MS`; 0 never asks gh for them at all.
   */
  pullRequestPollMs?: number;
  /**
   * How link cards fetch their pages: by default a fetch that refuses this machine and private networks (`createSafeFetch`),
   * or the HTML file `$AGENT_BOARD_LINK_FETCH_HTML` names for every page (for the app's tests). Tests give a fake one:
   * nothing in them reaches the network.
   */
  linkFetch?: FetchLike;
  /** How long a stored image is spared by the sweep of unused ones: `DEFAULT_SWEEP_GRACE_MS` by default. */
  imageSweepGraceMs?: number;
  /** The time agents' schedules fire by: the system clock by default. Tests drive a fake one. */
  clock?: Clock;
  /**
   * How long Enter first gets to start a turn of a message typed at an agent's prompt before it is pressed again:
   * `$AGENT_BOARD_SUBMIT_CONFIRM_MS` (for tests), else `DEFAULT_SUBMIT_CONFIRM_MS`.
   */
  submitConfirmMs?: number;
  /**
   * How often hand-offs held by an edge's conditions, and deliveries it queued, are tried again:
   * `$AGENT_BOARD_FLOW_RECHECK_MS` (for tests), else `DEFAULT_FLOW_RECHECK_MS`; 0 never by itself.
   */
  flowRecheckMs?: number;
}

export interface DaemonExit {
  reason: 'idle' | 'stopped' | 'data-dir-removed';
}

export interface Daemon {
  socketPath: string;
  hookPort: number;
  /** Resolves once the daemon has shut down, by `stop()` or because it was idle. */
  closed: Promise<DaemonExit>;
  /** What it found as it started: the live sessions it picked up, and how many agents wait for the user. */
  startedWith: { sessions: number; waiting: number };
  stop(): Promise<void>;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 5_000;
const DEFAULT_DATA_DIR_GRACE_MS = 3_000;

/** True only when the stat fails with ENOENT: any other error (EACCES, EIO, an unmounted volume) is not "removed". */
function isMissing(path: string): boolean {
  try {
    statSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * A minute: often enough to see a PR's checks finish. One gh call per live agent (and per ended agent with an open
 * PR) per round: GitHub's 5,000 an hour leave room for dozens of them. A PR an agent opens shows at once anyway: its
 * agent is asked again when its turn ends.
 */
const DEFAULT_PULL_REQUEST_POLL_MS = 60_000;

/**
 * A minute, as for pull requests: a held hand-off's labels and scripts are checked that often, its gate only once
 * its agent commits, and its PR checks also each time they change.
 */
const DEFAULT_FLOW_RECHECK_MS = 60_000;

/**
 * The connection the daemon calls its own methods on (the layout commands'): no client's, so it presents no board
 * token, hears nothing and is never backed up.
 */
const DAEMON_ITSELF: SessionSubscriber & BoardConnection = { send: () => {}, backlog: () => 0, whenDrained: (callback) => callback() };

/**
 * Starts the daemon (ADR-0002) on `dataDir`: takes the data dir's lock, opens and migrates the database, starts the
 * hook ingress and serves JSON-RPC on the socket. Throws `DaemonAlreadyRunningError` if another daemon owns the dir.
 * It stays up while a client is connected, a session is live or an agent has an enabled schedule, and exits once none
 * has been true for `idleTimeoutMs`.
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const log = options.log ?? ((message: string) => console.log(`[agent-board daemon] ${message}`));
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const idleCheckIntervalMs = options.idleCheckIntervalMs ?? Math.min(1_000, idleTimeoutMs);
  const dataDirGraceMs = options.dataDirGraceMs ?? DEFAULT_DATA_DIR_GRACE_MS;
  const paths = daemonPaths(options.dataDir);
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  // Groups' own folders, where their agents with no repo run: made one by one, as each is first used.
  const groupsDir = join(paths.dataDir, 'groups');

  prepareSocketDir(paths);
  const releaseLock = await acquireDaemonLock(paths.lock, paths.socket);
  let db: DatabaseSync | undefined;
  let ingress: HookIngress | undefined;
  let external: ExternalSessionHost | undefined;
  try {
    db = openDatabase(paths.database);
    const liveSessions = db.prepare('SELECT count(*) AS n FROM sessions WHERE ended_at IS NULL');
    const sessionForToken = db.prepare('SELECT id FROM sessions WHERE hook_token_sha256 = ? AND ended_at IS NULL');
    // An ended agent's pane's shell is no session to the user: it neither keeps the daemon up nor stops it stopping.
    const countLiveSessions = () => (liveSessions.get() as { n: number }).n - agents.fallbackShellCount();

    const clients = new Set<Socket>();
    /** What hears every event the daemon sends, beside its clients: the orchestrators' waits, once they are made. */
    const listeners: ((event: DaemonEvent) => void)[] = [];
    const broadcast = (event: DaemonEvent) => {
      const line = eventLine(event);
      for (const client of clients) if (!client.destroyed) client.write(line);
      for (const listener of listeners) listener(event);
    };

    // Sessions a crashed daemon left live would otherwise keep this one up for good.
    const lost = reconcileLostSessions(db);
    if (lost > 0) log(`marked ${lost} session(s) left by a previous daemon as ended`);
    const shell = options.shell ?? defaultShell();
    const shellArgs = options.shellArgs ?? defaultShellArgs();
    const homeDir = options.homeDir ?? homedir();
    // Once, before anything is spawned: every CLI the daemon runs (git, gh, and the harnesses and shells of its
    // sessions) is found on its PATH, which is launchd's bare one when the app was opened from the Dock or Finder.
    const loginPath = await adoptLoginShellPath(shell, shellArgs);
    if (loginPath !== undefined) log(`using the login shell's PATH: ${process.env.PATH}`);
    else if (shellArgs.includes('-l')) log(`could not read ${shell}'s login PATH; keeping the daemon's own`);
    const hookShimPath = options.hookShimPath ?? defaultHookShimPath();
    // The agent-board CLI sessions run (ADR-0010), beside the hook shim.
    const cli = options.cli ?? options.hookForwarder;
    const cliPath = join(dirname(hookShimPath), 'agent-board');
    if (cli !== undefined) {
      try {
        writeCliShim(cliPath, cli);
      } catch (error) {
        log(`could not write the agent-board CLI ${cliPath}: ${(error as Error).message}`);
      }
    }
    // `agents` and `pullRequests` are created below, once the hook ingress has a port. No session can exit or post a
    // hook before then.
    const sessions = createSessionHost({
      db,
      scrollbackDir: join(paths.dataDir, 'scrollback'),
      saveQuietMs: options.saveQuietMs,
      snapshotChunkLength: options.snapshotChunkLength,
      backend: createNodePtyBackend({ log }),
      shell,
      shellArgs,
      homeDir,
      killGraceMs: options.killGraceMs,
      board: { socketPath: paths.socket, cliDir: dirname(cliPath) },
      broadcast,
      log,
      onCwd: (sessionId) => shells.onPaneChanged(sessionId),
      onShellState: (sessionId) => {
        shells.onPaneChanged(sessionId);
        agents.onShellChanged(sessionId);
      },
      harnessPath: (harness) => harnessPaths.path(harness),
      shellIntegrationDir: join(paths.dataDir, 'shell-integration'),
      onOutput: (sessionId) => agents.onOutput(sessionId),
      onExit: (session) => {
        agents.onExit(session);
        // After the agent reads as ended, so what it is told of a plan it left waits for it to be resumed.
        asks.end(session.id);
        reviews.onExit(session.id, session.stoppedByRestart || (agents.get(session.id)?.hibernated ?? null) !== null);
        shells.onSessionExit(session);
      },
    });

    // Late-bound: the agent host is made after, with the shells' `deleteOwned`.
    const shells = createShellHost({ db, sessions, homeDir, shell, agentDeleting: (agentId) => agents.isDeleting(agentId), broadcast, log });
    const isAgentSession = db.prepare('SELECT 1 FROM agents WHERE session_id = ?1 OR harness_session_id = ?1 UNION SELECT 1 FROM agent_conversations WHERE harness_session_id = ?1');
    const externalSessions = createExternalSessionHost({
      db,
      groupsDir,
      isAgentSession: (id) => isAgentSession.get(id) !== undefined,
      broadcast,
      log,
    });
    external = externalSessions;
    const externalToken = newToken();
    ingress = await startHookIngress({
      sessionForToken: (hash) => (sessionForToken.get(hash) as { id: string } | undefined)?.id,
      onHook: (sessionId, event, payload, signal) => {
        broadcast({ type: 'hook', sessionId, event, payload });
        // The turn has ended: the agent may just have opened a pull request.
        if (payload.hook_event_name === 'Stop') void pullRequests.refresh(sessionId);
        return agents.onHook(sessionId, payload, signal);
      },
      externalTokenSha256: hashToken(externalToken),
      onExternalHook: (harness, payload) => {
        externalSessions.onHook(harness, payload).catch((error: Error) => log(`external hook failed: ${error.message}`));
      },
      // The board MCP over HTTP (ADR-0010): each call connects to this daemon's own socket as the token's session,
      // exactly as `agent-board mcp` would, so the board-caller guard and its scope hold unchanged.
      mcpCallerFor: (token) => {
        const sessionId = sessions.sessionForBoardToken(token);
        if (sessionId === undefined) return undefined;
        const env = { [BOARD_SOCKET_ENV]: paths.socket, [BOARD_TOKEN_ENV]: token };
        const cwd = () => sessions.list().find((session) => session.id === sessionId)?.cwd ?? homeDir;
        return { sessionId, handlers: boardMcpHandlers({ openSession: () => openBoardSession(env), cwd }) };
      },
    });
    const hookPort = ingress.port;
    const gh = options.gh ?? (process.env.AGENT_BOARD_GH || 'gh');
    const externalHookFile = options.externalHookFile ?? defaultExternalHookFile(hookShimPath);
    // Checked again before each Codex spawn, which fails if it can't be written; other agents don't need it.
    const ensureHookShim = () => {
      if (options.hookForwarder) writeHookShim(hookShimPath, options.hookForwarder, externalHookFile);
    };
    try {
      writeExternalHookFile(externalHookFile, { url: `http://127.0.0.1:${hookPort}/external`, token: externalToken });
    } catch (error) {
      log(`could not write ${externalHookFile}; external sessions won't be reported: ${(error as Error).message}`);
    }
    try {
      ensureHookShim();
    } catch (error) {
      log(`could not write the Codex hook launcher ${hookShimPath}: ${(error as Error).message}`);
    }
    const trackers = createTrackerHost({
      db,
      credentials:
        options.credentials ?? createKeychainStore({ keychain: process.env.AGENT_BOARD_KEYCHAIN || undefined }),
      providers: options.trackers ?? defaultTrackers(gh),
    });
    /** The tracker of the zone of the agent's own repo, wherever its tile sits. */
    const repoZoneTracker = (sessionId: string) => {
      const zoneId = agents.repoZoneId(sessionId);
      return zoneId === undefined ? null : trackers.zoneTracker(zoneId);
    };
    /** Hears pull requests read, for the crew events: set once the orchestrators are made, below. */
    const crew: { hearsPullRequests?: OrchestratorHost['onPullRequestsRead'] } = {};
    // `agents` is created just below; the watcher's first round runs from a timer, once it exists.
    const pullRequests = watchPullRequests({
      // Not agents whose worktree is gone (removed by hand): gh can't be asked there. Nor one resumed outside git, or
      // on a detached HEAD, with no branch to have pull requests.
      agents: () =>
        agents
          .list()
          .filter((agent) => agent.branch !== '' && existsSync(agent.worktree))
          .map((agent) => ({
            sessionId: agent.sessionId,
            branch: agent.branch,
            worktree: agent.worktree,
            repo: githubRepo(repoZoneTracker(agent.sessionId)),
            ended: agent.endedAt !== null,
            recorded: agent.records.flatMap((record) => {
              const ref = record.kind === 'pr' && record.deletedAt === null ? pullRequestOfUrl(record.url) : undefined;
              return ref === undefined ? [] : [{ ...ref, recordedAt: record.recordedAt }];
            }),
          })),
      pullRequests: createPullRequestLookup({ gh, log }),
      intervalMs:
        options.pullRequestPollMs ??
        (Number(process.env.AGENT_BOARD_PULL_REQUEST_POLL_MS) || DEFAULT_PULL_REQUEST_POLL_MS),
      onChange: (sessionId) => {
        agents.announce(sessionId);
        flowEdges.recheck(sessionId);
      },
      // Its rounds start once the orchestrators' crew events hear its reads (below): a first read must reach them.
      startLater: true,
      onRead: (sessionId, own, first) => crew.hearsPullRequests?.(sessionId, own, first),
      log,
    });
    // `agents` and `handlers` are made below; a clock first fires from a timer, once they exist.
    const clocks = createClockHost({
      db,
      clock: options.clock ?? systemClock,
      agents: {
        get: (sessionId) => agents.get(sessionId),
        runScheduled: (sessionId, prompt) => agents.runScheduled(sessionId, prompt),
        spawn: (...args) => agents.spawn(...args),
        finalMessage: (sessionId) => agents.finalMessage(sessionId),
        delete: (...args) => agents.delete(...args),
        stop: (...args) => agents.stop(...args),
        deliver: (...args) => agents.deliver(...args),
        announce: (sessionId) => agents.announce(sessionId),
      },
      call: async (method, params) => handlers[method](params as never, DAEMON_ITSELF) as never,
      broadcast,
      log,
    });
    const schedules = clocks.schedules;
    // Gates and scripts an edge's conditions run, all stopped when the daemon shuts down.
    const conditionShell = createShellRunner();
    // Keeping only paths from now on drops the copies held now.
    const settings = createSettings(db, (now, was) => {
      if (now.heldPayloads === 'path' && was.heldPayloads !== 'path') flowEdges.dropCopies();
      broadcast({ type: 'settings.updated', settings: now });
    });
    // Where `claude` and `codex` are, as absolute paths: what agents launch and onboarding checks. Looked for now, in the
    // background: a start or a Restart waits for it only if it is still running (and finds nothing yet).
    const harnessEnv = options.agentEnv ?? process.env;
    const harnessPaths = createHarnessPaths({
      shell,
      shellArgs,
      env: harnessEnv,
      homeDir,
      knownDirs: options.harnessDirs ?? process.env.AGENT_BOARD_HARNESS_DIRS?.split(delimiter).filter(Boolean),
      override: (harness) => settings.get()[`${harness}Path`],
    });
    for (const harness of ['claude', 'codex'] as const) void harnessPaths.refresh(harness);
    // `agents` is created just below; nothing hands off before it exists.
    const flowEdges = createFlowEdgeHost({
      db,
      deliver: (from, to, name, text) => agents.deliver(from, to, name, text),
      finalMessage: (sessionId) => agents.finalMessage(sessionId),
      agent: (sessionId) => agents.get(sessionId),
      conditions: createConditionChecker({
        pullRequests: (sessionId) => pullRequests.get(sessionId),
        async issueLabels(sessionId) {
          const issue = agents.get(sessionId)?.issue;
          if (issue === null || issue === undefined) return 'it has no linked issue';
          return (await trackers.issueLabels(issue)) ?? `there is no ${issue.id} any more`;
        },
        plan: commandPlan,
        run: (command, cwd, timeoutMs) => conditionShell.run(command, cwd, timeoutMs),
        headCommit: async (cwd) => {
          // A group's own folder is outside git: nothing to ask it.
          if (inGroupFolder(groupsDir, cwd)) return undefined;
          const head = await runGit(cwd, ['rev-parse', 'HEAD']);
          return head.ok ? head.stdout : undefined;
        },
        now: () => new Date(),
      }),
      heldPayloads: () => settings.get().heldPayloads,
      recheckMs: options.flowRecheckMs ?? (Number(process.env.AGENT_BOARD_FLOW_RECHECK_MS) || DEFAULT_FLOW_RECHECK_MS),
      broadcast,
      log,
    });
    // Schedules fire on local time, which follows the system's.
    const stopFollowingTimeZone = followSystemTimeZone({ log });
    const roleTemplates = createRoleTemplates(db);
    // An agent's questions and plans: it is `waiting` while one waits on the user.
    const asks = createAskHost({
      db,
      changed: (sessionId, began) => agents.waitChanged(sessionId, began),
      touched: (sessionId) => agents.waitChanged(sessionId, false),
      worktree: (sessionId) => agents.get(sessionId)?.worktree,
      addCard: (sessionId) => addPlanCard(sessionId),
      wrote: (sessionId, path) => documents.userWrote(sessionId, path),
      // The decision on a plan left with the command line is typed at the agent's prompt as a document's edit is.
      told: (sessionId, text) => documents.tell(sessionId, text),
      log,
    });
    // The documents agents show the user: a file each, read live, the user's edits told to the agent at its prompt.
    const documents = createDocumentHost({
      db,
      changed: (sessionId) => agents.announce(sessionId),
      agent: (sessionId) => agents.get(sessionId),
      tell: (sessionId, text) => agents.tell(sessionId, text),
      addCard: (document) => addDocumentCard(document),
      log,
    });
    const agents = createAgentHost({
      db,
      clock: options.clock ?? systemClock,
      roleTemplates,
      sessions,
      worktreesDir: options.worktreesDir ?? defaultWorktreesDir(),
      reviewsDir: join(options.dataDir, 'reviews'),
      groupsDir,
      scratchDir: options.scratchDir ?? (process.env.AGENT_BOARD_SCRATCH_DIR || join(homedir(), '.agent-board', 'scratch')),
      // The zone table is made below; agents remember folders only once they spawn.
      rememberFolder: (path) => zoneTable.rememberFolder(path),
      harnessPaths,
      hookShimPath,
      ensureHookShim,
      boardCliPath: cli === undefined ? undefined : cliPath,
      compactWindow: () => settings.get().compactWindow,
      clickableLinks: () => settings.get().clickableLinks,
      env: options.agentEnv ?? process.env,
      shell,
      shellArgs,
      hookUrl: () => `http://127.0.0.1:${hookPort}/hooks`,
      boardMcpUrl: () => `http://127.0.0.1:${hookPort}/mcp`,
      permissionHoldMs: options.permissionHoldMs ?? DEFAULT_PERMISSION_HOLD_MS,
      backgroundPollMs: options.backgroundPollMs,
      startStepTimeoutMs: options.startStepTimeoutMs,
      submitConfirmMs: options.submitConfirmMs ?? (Number(process.env.AGENT_BOARD_SUBMIT_CONFIRM_MS) || undefined),
      trackers,
      pullRequests: (sessionId) => pullRequests.get(sessionId),
      pushedPullRequests: (sessionId) => pullRequests.pushed(sessionId),
      recordedPullRequests: (sessionId) => pullRequests.recorded(sessionId),
      schedules,
      onHandoff: (sessionId) => {
        flowEdges.handOff(sessionId);
        reviews.onHandoff(sessionId);
        const finalMessage = agents.finalMessage(sessionId);
        if (finalMessage !== undefined) void selectionAsks.finished(sessionId, finalMessage);
        clocks.turnEnded(sessionId);
      },
      endTabs: (sessionId) => shells.deleteOwned(sessionId),
      onBranchChanged: (sessionId) => void pullRequests.refresh(sessionId),
      onTurnBoundary: (sessionId) => {
        flowEdges.turnBoundary(sessionId);
        // Its turn is over, so its call is too: nothing waits on the answer now.
        asks.drop(sessionId);
      },
      onRemoving: (sessionId) => {
        flowEdges.dropAgent(sessionId);
        gates.forget(sessionId);
        asks.forget(sessionId);
        removeDocumentCards(sessionId).catch((error: unknown) => log(`could not take ${sessionId}'s document and plan cards off the board: ${(error as Error).message}`));
        documents.forget(sessionId);
        selectionAsks.forget(sessionId);
        clocks.agentRemoved(sessionId);
      },
      asks,
      documents,
      broadcast,
      log,
    });

    const reviews = createReviewHost({
      db,
      agents,
      pullRequests: (sessionId) => pullRequests.get(sessionId),
      refreshPullRequests: (sessionId) => pullRequests.refresh(sessionId),
      async merge(sessionId, number, head) {
        const agent = agents.get(sessionId)!;
        await mergePullRequest(number, { gh, cwd: agent.worktree, repo: githubRepo(repoZoneTracker(sessionId)), headCommit: head });
        await pullRequests.refresh(sessionId);
      },
      broadcast,
      log,
    });

    const images = createImageStore(paths.dataDir, { graceMs: options.imageSweepGraceMs });
    const linkFixture = process.env.AGENT_BOARD_LINK_FETCH_HTML;
    // Pages a user pasted are not trusted: by default they are fetched without reaching this machine or its network.
    const linkFetch = options.linkFetch ?? (linkFixture ? fixtureFetch(linkFixture) : createSafeFetch());
    const sweeper = createImageSweeper(db, images, log);
    const linkCards = createLinkCards({ fetch: linkFetch, images, trackers, log });
    const startedAt = new Date().toISOString();
    const schemaVersion = readSchemaVersion(db);
    const leavingZone = itemsLeavingZone(db, broadcast);
    // Sources is created just below; no clone runs before then.
    const reposDir = options.reposDir ?? (process.env.AGENT_BOARD_REPOS_DIR || join(homedir(), '.agent-board', 'repos'));
    const zoneTable = createZoneTable(db, broadcast, (id) => sources.progress(id), reposDir, groupsDir, () => settings.get().arrangeSpacing);
    const sources: ZoneSources = createZoneSources({
      db,
      zones: zoneTable,
      trackers,
      reposDir,
      copyRoots: options.copyRoots ?? ['code', 'src', 'Developer', 'projects', 'GitHub'].map((folder) => join(homedir(), folder)),
      clone: (repo, dir, clone) => cloneRepo(repo, dir, { ...clone, gh }),
      removeZone: async (id, cloneFailed) => {
        await leavingZone(id, () => zoneTable.remove(id, cloneFailed === undefined ? {} : { cloneFailed }));
        // Sessions that were in it by their folder may be in no zone now.
        externalSessions.placeUnsorted();
      },
      log,
    });
    await sources.reconcile();
    // Ask Claude about a selection: its answer is made through the daemon's own methods, as the board's are.
    const selectionAsks = createSelectionAsks({
      db,
      dir: join(paths.dataDir, 'selection-asks'),
      images,
      spawn: (params, place) => agents.spawn(params, undefined, place),
      agent: (sessionId) => agents.get(sessionId),
      finalMessage: (sessionId) => agents.finalMessage(sessionId),
      zoneRepo: (zoneId) => {
        const zone = zoneTable.list().find((each) => each.id === zoneId);
        return zone?.repoRoot ?? zone?.defaultRepo ?? null;
      },
      call: async (method, params) => handlers[method](params as never, DAEMON_ITSELF) as never,
      log,
    });
    // The Captain (ADR-0019): started only from the app, in a folder of its own.
    const boardMaster = createBoardMaster({
      dir: join(paths.dataDir, 'master'),
      spawn: (params, place) => agents.spawn(params, undefined, place),
      agents: () => agents.list(),
      zones: () => zoneTable.list(),
    });
    const gates = createGateHost({
      db,
      dir: join(paths.dataDir, 'gates'),
      agent: (sessionId) => agents.get(sessionId),
      // The zone of its own repo, wherever its tile sits; else the zone its tile is in.
      command: (sessionId) => {
        const zoneId = agents.repoZoneId(sessionId) ?? agents.get(sessionId)?.zoneId ?? undefined;
        const zone = zoneId === undefined ? undefined : zoneTable.find(zoneId);
        return { command: zone?.gateCommand ?? null, zone: zone?.name };
      },
      // As the composer's Send would: never into a permission prompt, where it would answer it, nor an ended agent.
      paste: (sessionId, text) => {
        const agent = agents.get(sessionId);
        if (agent === undefined || agent.endedAt !== null) throw new Error(`${agent?.name ?? 'the agent'} has ended`);
        if (agent.state === 'needs-permission') throw new Error(`${agent.name} is waiting on a permission prompt: answer it first`);
        // It would run on from what sits unsent there.
        if (agent.unsent !== null) throw new Error(`${agent.name} has a message typed at its prompt that was never sent: send or clear it first`);
        sessions.write(sessionId, text);
        agents.onInput(sessionId, text);
      },
      env: options.agentEnv ?? process.env,
      broadcast,
      log,
    });
    const zones = zoneHandlers<unknown>(db, zoneTable, trackers, (zoneId, on) => agents.zoneOrchestrateChanged(zoneId, on), (zoneId) =>
      agents.dismissStartsIn(zoneId),
    );
    const orchestrators = createOrchestratorHost({
      db,
      sessions,
      agents,
      shells,
      zones: () => zoneTable.list(),
      flowEdges,
      // As `agent.delete` without force: its reviewers go first.
      deleteAgent: async (sessionId, why) => {
        await reviews.deleteAgent(sessionId, why, () => agents.delete(sessionId, why, false).then(() => null));
      },
      broadcast,
      log,
      ...(options.replyWindowMs === undefined ? {} : { replyWindowMs: options.replyWindowMs }),
    });
    listeners.push((event) => orchestrators.onEvent(event));
    listeners.push((event) => clocks.onEvent(event));
    clocks.resumeRuns();
    // A crew member's flag goes to its orchestrator, typed at its prompt.
    const crewFlags = createCrewFlags({
      agent: (sessionId) => agents.get(sessionId),
      crewOf: (sessionId) => agents.list().filter((agent) => agent.spawnedBy === sessionId),
      tell: (sessionId, text) => agents.tell(sessionId, text),
      log,
    });
    listeners.push((event) => {
      if (event.type === 'agent.updated') crewFlags.observe(event.agent);
    });
    crew.hearsPullRequests = (sessionId, own, first) => orchestrators.onPullRequestsRead(sessionId, own, first);
    pullRequests.start();
    // An agent started this run has its pull requests read as it starts, not at the next round: what it opens before
    // then is new, not there at its first read.
    const readAtStart = new Set<string>();
    listeners.push((event) => {
      if (event.type === 'agent.removed') readAtStart.delete(event.sessionId);
      if (event.type !== 'agent.updated' || event.agent.createdAt < startedAt) return;
      const { sessionId } = event.agent;
      if (readAtStart.has(sessionId) || pullRequests.read(sessionId)) return;
      readAtStart.add(sessionId);
      void pullRequests.refresh(sessionId);
    });
    const orchestratorHandlers = orchestrators.handlers<SessionSubscriber & BoardConnection>();
    const captures = createCaptureHost({ ...(options.captureTimeoutMs === undefined ? {} : { timeoutMs: options.captureTimeoutMs }) });
    const measures = createLayoutMeasures({ mayReport: captures.serves, ...(options.measureWaitMs === undefined ? {} : { waitMs: options.measureWaitMs }) });
    const handlers: RpcHandlers<DaemonMethods, SessionSubscriber & BoardConnection> = {
      'daemon.health': (): DaemonHealth => ({
        version: DAEMON_VERSION,
        build: options.build ?? null,
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid,
        schemaVersion,
        hookPort,
        startedAt,
        clients: clients.size,
        liveSessions: countLiveSessions(),
        homeDir,
        cliPath: cli === undefined ? null : cliPath,
      }),
      'daemon.stop': (params, subscriber) => {
        const liveSessions = countLiveSessions();
        const stopped = optionalBooleanParam(paramsObject(params), 'force') === true || liveSessions === 0;
        // Once the answer has gone out: shutting down drops every connection, the caller's too.
        if (stopped) setImmediate(() => subscriber.whenDrained(() => void shutdown('stopped')));
        return { stopped, liveSessions };
      },
      ...sessionHandlers(sessions, {
        onInput: (sessionId, data) => agents.onInput(sessionId, data),
        onShellCreated: (session) => shells.adopt(session),
      }),
      ...shells.handlers<SessionSubscriber>(),
      ...zones,
      'zone.remove': async (params, context) => {
        const id = (params as { id?: unknown } | undefined)?.id;
        const result = await leavingZone(typeof id === 'string' ? id : undefined, () => zones['zone.remove'](params, context));
        externalSessions.placeUnsorted();
        return result;
      },
      // Sessions in its folder are in no zone now, or in another of theirs.
      'zone.unbind': async (params, context) => {
        const result = await zones['zone.unbind'](params, context);
        externalSessions.placeUnsorted();
        return result;
      },
      ...zoneDissolveHandlers<SessionSubscriber>({
        db,
        zones: zoneTable,
        agents,
        shells,
        externals: externalSessions,
        broadcast,
        removeZone: (id) => leavingZone(id, () => zoneTable.remove(id)),
        removeClone: removeManagedClone,
        linkedWorktrees,
      }),
      ...sources.handlers<SessionSubscriber>(),
      ...connectorHandlers(db, broadcast),
      ...flowEdges.handlers<SessionSubscriber>(),
      ...itemHandlers(db, broadcast, { images, sweeper, linkCards, log }),
      ...viewStateHandlers<SessionSubscriber>(db),
      ...settings.handlers<SessionSubscriber>(),
      ...roleTemplates.handlers<SessionSubscriber>(),
      ...agentHandlers(agents),
      ...boardHandlers<SessionSubscriber & BoardConnection>({
        sessions,
        agents,
        shells,
        flowEdges,
        logActivity: orchestrators.logActivity,
        checkHandoffTarget: (from, to) => orchestrators.checkHandoffTarget(from, to),
        refreshPullRequests: (sessionId) => pullRequests.refresh(sessionId),
      }),
      ...orchestratorHandlers,
      // The layout commands act through the daemon's own methods, as the board's drags and menus call them; a reviewer an
      // orchestrator starts joins its implementer's cluster.
      ...layoutHandlers<SessionSubscriber & BoardConnection>({
        db,
        access: orchestrators.access,
        call: async (method, params) => handlers[method](params as never, DAEMON_ITSELF) as never,
        spawn: async (params, connection) => orchestratorHandlers['orchestrator.spawn'](params as never, connection as SessionSubscriber & BoardConnection),
        close: async (params, connection) => orchestratorHandlers['orchestrator.close'](params as never, connection as SessionSubscriber & BoardConnection),
        capture: captures.request,
        measures,
        warn: log,
      }),
      ...captures.handlers,
      ...measures.handlers,
      ...roleTemplates.defaultRoleHandlers<SessionSubscriber & BoardConnection>(orchestrators.access, () => zoneTable.list()),
      ...asks.handlers<SessionSubscriber & BoardConnection>({ sessions, agents, shells }),
      ...documents.handlers<SessionSubscriber & BoardConnection>({ sessions, agents, shells }),
      ...selectionAsks.handlers<SessionSubscriber & BoardConnection>(),
      ...boardMaster.handlers<SessionSubscriber & BoardConnection>(),
      ...clocks.handlers<SessionSubscriber & BoardConnection>(),
      ...clocks.orchestratorHandlers<SessionSubscriber & BoardConnection>(orchestrators.access, () => zoneTable.list()),
      // Its reviewers go first, and the rounds it reviewed say it has gone, each told to every client.
      'agent.delete': (params, context) => {
        const sessionId = stringParam(paramsObject(params), 'sessionId');
        return reviews.deleteAgent(sessionId, "the app's agent.delete", async () => agentHandlers(agents)['agent.delete'](params, context));
      },
      ...reviews.handlers<SessionSubscriber>(),
      ...gates.handlers<SessionSubscriber>(),
      ...gateActionHandlers<SessionSubscriber & BoardConnection>({
        gh,
        callers: { sessions, agents, shells },
        gates,
        agent: (sessionId) => agents.get(sessionId),
        refreshBranch: (sessionId) => agents.refreshBranch(sessionId),
        githubRepo: (sessionId) => githubRepo(repoZoneTracker(sessionId)),
        pullRequests: (sessionId) => pullRequests.get(sessionId),
        refreshPullRequests: (sessionId) => pullRequests.refresh(sessionId),
        // Merged: nothing of its work is lost, so nothing stops it short. Its reviewers go first, as with `agent.delete`.
        deleteAgent: async (sessionId, keep) => {
          const why = "the merge gate's cleanup after its merge";
          await reviews.deleteAgent(sessionId, why, () => agents.delete(sessionId, why, true, keep.worktree, keep.branch).then(() => null));
        },
        comment: (issue, body) => trackers.comment(issue, body),
        recordPullRequest: (sessionId, pr) => {
          const record = pullRequestRecord(pr.url, pr.title);
          if (record === undefined) return;
          agents.records.put(sessionId, record);
          agents.announce(sessionId);
        },
        log,
      }),
      ...pullRequestTabHandlers<SessionSubscriber>({
        gh,
        cwd: homeDir,
        // The tiles showing it say so at once, not at the watcher's next round.
        changed: async ({ repo, number }) => {
          const showing = agents.list().filter((agent) =>
            [...pullRequests.get(agent.sessionId), ...pullRequests.pushed(agent.sessionId)].some(
              (pr) => pr.number === number && pullRequestOfUrl(pr.url)?.repo.toLowerCase() === repo.toLowerCase(),
            ),
          );
          await Promise.all(showing.map((agent) => pullRequests.refresh(agent.sessionId)));
        },
        // Failing closed: by the pull requests read, else by branch, and while an agent's aren't read yet, as its.
        gate: (ref, headRefName, headCommit) => {
          const owner = gatedOwner({
            ref,
            headRefName,
            agents: agents.list().map((agent) => {
              const seen = pullRequests.get(agent.sessionId);
              return {
                sessionId: agent.sessionId,
                name: agent.name,
                branch: agent.ownedBranch,
                gated: agent.ownedBranch !== '' && gates.command(agent.sessionId) !== null,
                read: pullRequests.read(agent.sessionId),
                repo: githubRepo(repoZoneTracker(agent.sessionId)) ?? seen.map((pr) => pullRequestOfUrl(pr.url)?.repo).find((repo) => repo !== undefined),
                pullRequests: seen,
              };
            }),
          });
          if (owner === undefined) return undefined;
          return { agent: owner.name, blocked: mergeGateBlocked({ run: gates.get(owner.sessionId), pr: { headCommit }, gated: true }) };
        },
      }),
      ...trackerHandlers(trackers),
      ...setupHandlers<SessionSubscriber>({ harnessEnv, harnessPaths, gh }),
      ...externalHandlers(externalSessions),
      ...externalResumeHandlers<SessionSubscriber>({ db, external: externalSessions, agents, broadcast }),
      ...externalHooksHandlers({
        files: options.externalHookFiles ?? externalHookFiles(process.env),
        shimPath: hookShimPath,
        ensureHookShim,
      }),
    };

    const call: DaemonCall = async (method, params) => handlers[method](params as never, DAEMON_ITSELF) as never;
    /** The document cards on the board, of `sessionId`'s documents or of the one document. */
    const documentCards = async (match: (data: DocumentCardData) => boolean) =>
      (await call('item.list', undefined)).filter((item) => item.kind === 'document' && match(item.data as unknown as DocumentCardData));
    /** The plan cards on the board of the agent `sessionId`'s plans. */
    const planCards = async (sessionId: string) =>
      (await call('item.list', undefined)).filter((item) => item.kind === 'plan' && (item.data as unknown as PlanCardData).agent.sessionId === sessionId);
    // A document shown on the board is a card beside its agent's tile, joined to it; one card for each document, the
    // check and the making one step for each document, so two shows at once make one card.
    const addingCards = new Set<string>();
    async function addDocumentCard(document: DocumentSummary): Promise<void> {
      if (addingCards.has(document.id)) return;
      addingCards.add(document.id);
      try {
        if ((await documentCards((data) => data.documentId === document.id)).length > 0) return;
        const agent = agents.get(document.sessionId);
        if (agent === undefined) return;
        const size = DOCUMENT_CARD_SIZE;
        const spot = (await spotBesideAgent(call, agent.sessionId, size)) ?? { zoneId: agent.zoneId, x: 0, y: 0 };
        const data: DocumentCardData = { documentId: document.id, agent: agentNoteAuthor(agent), title: document.title, format: document.format, collapsed: false };
        await call('item.create', { kind: 'document', ...spot, ...size, data: { ...data } });
      } finally {
        addingCards.delete(document.id);
      }
    }
    // A plan shown on the board is one card for the agent, beside its tile, showing its latest plan: a later version
    // updates it in place. Made one at a time for each agent, as a document's is.
    const addingPlanCards = new Set<string>();
    async function addPlanCard(sessionId: string): Promise<void> {
      if (addingPlanCards.has(sessionId)) return;
      addingPlanCards.add(sessionId);
      try {
        if ((await planCards(sessionId)).length > 0) return;
        const agent = agents.get(sessionId);
        const plan = asks.latestPlan(sessionId);
        if (agent === undefined || plan === null) return;
        const size = PLAN_CARD_SIZE;
        const spot = (await spotBesideAgent(call, sessionId, size)) ?? { zoneId: agent.zoneId, x: 0, y: 0 };
        const data: PlanCardData = { agent: agentNoteAuthor(agent), title: plan.title };
        await call('item.create', { kind: 'plan', ...spot, ...size, data: { ...data } });
      } finally {
        addingPlanCards.delete(sessionId);
      }
    }
    // An agent's document and plan cards go with it, as its documents and plans do.
    async function removeDocumentCards(sessionId: string): Promise<void> {
      const cards = [...(await documentCards((data) => data.agent.sessionId === sessionId)), ...(await planCards(sessionId))];
      for (const card of cards) await call('item.delete', { id: card.id }).catch(() => null);
    }
    listeners.push((event) => {
      if (event.type === 'agent.updated') documents.observe(event.agent);
    });
    documents.start();

    const guardedHandlers = guardBoardCallers(handlers, orchestrators);
    const server = createServer((socket) => {
      clients.add(socket);
      const closed = new AbortController();
      const subscriber: SessionSubscriber & BoardConnection = {
        closed: closed.signal,
        send: (event) => {
          if (!socket.destroyed) socket.write(eventLine(event));
        },
        backlog: () => socket.writableLength,
        whenDrained: (callback) => {
          if (socket.writableLength === 0) queueMicrotask(callback);
          else socket.once('drain', callback);
        },
      };
      socket.on('close', () => {
        clients.delete(socket);
        sessions.detachAll(subscriber);
        closed.abort();
      });
      socket.on('error', () => socket.destroy());
      const feed = lineSplitter((line) => {
        void handleRpcLine(line, guardedHandlers, subscriber).then((response) => {
          if (response !== undefined && !socket.destroyed) socket.write(`${JSON.stringify(response)}\n`);
        });
      });
      socket.setEncoding('utf8').on('data', (chunk: string) => {
        if (!feed(chunk)) socket.destroy();
      });
    });
    await listen(server, paths.socket);

    let resolveClosed!: (exit: DaemonExit) => void;
    const closed = new Promise<DaemonExit>((resolve) => (resolveClosed = resolve));
    let shuttingDown: Promise<void> | undefined;
    const shutdown = (reason: DaemonExit['reason']): Promise<void> =>
      (shuttingDown ??= (async () => {
        log(`shutting down (${reason})`);
        clearInterval(idleTimer);
        // External hooks go back to doing nothing, without even starting the app.
        removeExternalHookFile(externalHookFile, externalToken);
        externalSessions.stop();
        orchestrators.close();
        pullRequests.stop();
        flowEdges.stop();
        conditionShell.stop();
        gates.stop();
        sweeper.stop();
        clocks.close();
        stopFollowingTimeZone();
        // A clone the daemon can't see through is cancelled, and its zone and folder go with it.
        await sources.close();
        // Unlink the socket first, while it is certainly still ours: once it stops answering, a new daemon may take
        // the lock and bind a fresh socket at the same path, which a later unlink would delete.
        if (process.platform !== 'win32') rmSync(paths.socket, { force: true });
        for (const client of clients) client.destroy();
        // Kill the sessions once no client can start more: nothing would own their PTYs once we are gone. The user
        // didn't stop them, so they are stopped by restart, and the app offers to resume them.
        await Promise.all([new Promise((resolve) => server.close(resolve)), ingress!.close(), sessions.killAll({ stoppedByRestart: true })]);
        asks.close();
        documents.close();
        agents.close();
        db!.close();
        releaseLock();
        resolveClosed({ reason });
      })());

    let idleSince: number | undefined;
    let missingSince: number | undefined;
    const idleTimer = setInterval(() => {
      // Nothing can use a daemon whose data dir is gone (an e2e run's, deleted with its worktree), whatever it still
      // holds. Only a definite ENOENT that persists for the grace period counts: ending sessions is not undoable.
      missingSince = isMissing(paths.dataDir) ? (missingSince ?? Date.now()) : undefined;
      if (missingSince !== undefined && Date.now() - missingSince >= dataDirGraceMs) {
        void shutdown('data-dir-removed');
      } else if (clients.size > 0 || countLiveSessions() > 0 || schedules.hasEnabled() || sources.busy()) {
        idleSince = undefined;
      } else if (idleSince === undefined) {
        idleSince = Date.now();
      } else if (Date.now() - idleSince >= idleTimeoutMs) {
        void shutdown('idle');
      }
    }, idleCheckIntervalMs);
    idleTimer.unref();

    log(`listening on ${paths.socket}, hook ingress on 127.0.0.1:${hookPort}, schema version ${schemaVersion}`);
    const startedWith = { sessions: countLiveSessions(), waiting: agents.list().filter((agent) => waitsForYou(agent, settings.get().needsYouShows)).length };
    return { socketPath: paths.socket, hookPort, closed, startedWith, stop: () => shutdown('stopped') };
  } catch (error) {
    external?.stop();
    await ingress?.close();
    db?.close();
    releaseLock();
    throw error;
  }
}

function defaultWorktreesDir(): string {
  return process.env.AGENT_BOARD_WORKTREES_DIR || join(homedir(), '.agent-board', 'worktrees');
}

/** The zone's GitHub repo, if it takes its issues from one. */
function githubRepo(tracker: ZoneTracker | null): string | undefined {
  return tracker?.provider === 'github' ? tracker.scope : undefined;
}

function defaultHookShimPath(): string {
  return process.env.AGENT_BOARD_HOOK_SHIM || join(homedir(), '.agent-board', 'bin', 'agent-board-hook');
}

function defaultExternalHookFile(hookShimPath: string): string {
  return process.env.AGENT_BOARD_EXTERNAL_HOOK_FILE || join(dirname(dirname(hookShimPath)), 'external-hook.json');
}

function defaultTrackers(gh: string): Partial<Record<TrackerProvider, TrackerFactory>> {
  const apiUrl = process.env.AGENT_BOARD_LINEAR_API_URL || undefined;
  return {
    linear: (credential) => {
      if (credential === undefined) throw new Error('Linear needs its API key');
      return createLinearTracker({ credential, apiUrl });
    },
    github: () => createGitHubTracker({ gh }),
  };
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL || '/bin/sh';
}

/**
 * A login shell, so a daemon started from the Dock (with launchd's bare PATH) still gives the user their profile's
 * PATH. `AGENT_BOARD_LOGIN_SHELL=0` turns it off, so e2e tests don't depend on the developer's profile.
 */
function defaultShellArgs(): string[] {
  return process.platform === 'win32' || process.env.AGENT_BOARD_LOGIN_SHELL === '0' ? [] : ['-l'];
}

type SessionMethods = Extract<keyof DaemonMethods, `session.${string}`>;

/** `onInput` hears what clients type into a session, after it is written. */
function sessionHandlers(
  sessions: SessionHost,
  hooks: {
    onInput(sessionId: string, data: string): void;
    /** A plain shell made on its own: it needs a tile. */
    onShellCreated(session: SessionInfo): void;
  },
): Pick<RpcHandlers<DaemonMethods, SessionSubscriber>, SessionMethods> {
  const sessionId = (params: unknown) => stringParam(paramsObject(params), 'sessionId');
  return {
    'session.createShell': (params) => {
      const p = paramsObject(params);
      const session = sessions.createShell({
        cols: dimensionParam(p, 'cols'),
        rows: dimensionParam(p, 'rows'),
        cwd: optionalStringParam(p, 'cwd'),
      });
      hooks.onShellCreated(session);
      return session;
    },
    'session.list': () => sessions.list(),
    'session.attach': (params, subscriber) => {
      sessions.attach(sessionId(params), subscriber);
      return null;
    },
    'session.detach': (params, subscriber) => {
      sessions.detach(sessionId(params), subscriber);
      return null;
    },
    'session.write': (params) => {
      const id = sessionId(params);
      const data = stringParam(paramsObject(params), 'data');
      sessions.write(id, data);
      hooks.onInput(id, data);
      return null;
    },
    'session.resize': (params) => {
      const p = paramsObject(params);
      sessions.resize(sessionId(p), { cols: dimensionParam(p, 'cols'), rows: dimensionParam(p, 'rows') });
      return null;
    },
    'session.kill': (params) => sessions.kill(sessionId(params), "the app's session.kill"),
    'session.cwd': async (params) => ({ cwd: await sessions.folderOf(sessionId(params)) }),
  };
}

function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    // What is deleted is overwritten, so a held payload's copy, once delivered or dropped, doesn't linger in the file.
    db.exec('PRAGMA secure_delete = ON');
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Listens on the socket, replacing a stale socket file (safe: the caller holds the data dir's lock). */
async function listen(server: Server, socketPath: string): Promise<void> {
  if (process.platform !== 'win32') rmSync(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  if (process.platform !== 'win32') chmodSync(socketPath, 0o600);
}
