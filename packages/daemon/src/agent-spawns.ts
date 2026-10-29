import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative } from 'node:path';
import { issuePrompt, shortIssueId } from '@agent-board/tracker';
import type { AgentRecordStore } from './agent-records.ts';
import { createAgentStarts, type AgentStarts, type NewStart, type StartProgress } from './agent-starts.ts';
import type { AgentHost, AgentHostOptions, AgentRow, BranchReviewRow, ZoneRow } from './agents.ts';
import { BOARD_SESSION_ENV, BOARD_SOCKET_ENV, BOARD_TOKEN_ENV, BOARD_ZONE_ENV } from './board-env.ts';
import { CLAUDE_HOOK_EVENTS } from './claude-state.ts';
import { carryClaudeTranscript } from './claude-transcript.ts';
import { projectCodexConfig } from './codex-config-guard.ts';
import { runGit } from './git.ts';
import { CODEX_HOOK_TIMEOUTS, codexHookCommand, HOOK_ENV_PREFIX, HOOK_TOKEN_ENV, HOOK_URL_ENV } from './hook-forwarder.ts';
import { keyedQueue } from './keyed-queue.ts';
import { loginShellKind } from './login-path.ts';
import { invalidParams } from './params.ts';
import {
  AGENT_ERROR,
  MAX_ASK_WAIT_MS,
  MAX_DESCRIPTION_LENGTH,
  ORCHESTRATE_SCOPES,
  REVIEWER_ROLES,
  type Agent,
  type Harness,
  type LinkedIssue,
  type SpawnAgentParams,
  type TerminalSize,
} from './protocol.ts';
import { folderPath } from './repo-zone.ts';
import { checkNamedTemplate, fillTemplate, roleChoice, type TemplateValues } from './role-templates.ts';
import { RpcMethodError } from './rpc.ts';
import { sessionEnv, type SessionHost } from './sessions.ts';
import { frontZ } from './tile-position.ts';
import { hashToken, newToken } from './tokens.ts';
import {
  addDetachedWorktree,
  addWorktree,
  agentBranchName,
  agentWorktreePath,
  checkedBranchName,
  checkedOutBranch,
  freeBranchName,
  freeTypedBranch,
  freeWorktreePath,
  nameSlug,
  removeWorktree,
} from './worktrees.ts';
import { groupFolder, initProject, resolveZoneFolder, zoneFolder } from './zones.ts';

/** Codex's flag that runs untrusted hooks without review (ADR-0004). */
export const CODEX_BYPASS_FLAG = '--dangerously-bypass-hook-trust';

/**
 * What a model name may be (`opus`, `claude-opus-5-5[1m]`, `gpt-5-codex`): never an option of the harness's own, nor
 * whitespace, since it is passed as an argument.
 */
const MODEL_NAME = /^[\w.:@/[\]][\w.:@/[\]-]*$/;

/** Longest default name made from the task. */
const MAX_DEFAULT_NAME_LENGTH = 40;

/** How long claude waits on a hook call, in seconds. Only a held PermissionRequest takes longer. */
const HOOK_TIMEOUT_S = 5;

/** How much longer claude waits on a held PermissionRequest hook than the daemon holds it, so the daemon answers first. */
const PERMISSION_HOOK_MARGIN_S = 10;

/** The longest a step of a start may wait on another process (git, a tracker, the harness lookup) before it fails. */
const START_STEP_TIMEOUT_MS = 3 * 60_000;

/** How far a loose implementer's reviewer starts from it, down and right, in board units. */
const REVIEWER_OFFSET = 48;

/** What starting an agent reads of the host. */
interface AgentSpawnOptions
  extends Pick<
    AgentHostOptions,
    | 'db'
    | 'worktreesDir'
    | 'scratchDir'
    | 'groupsDir'
    | 'rememberFolder'
    | 'harnessPaths'
    | 'hookShimPath'
    | 'ensureHookShim'
    | 'boardCliPath'
    | 'env'
    | 'compactWindow'
    | 'clickableLinks'
    | 'shell'
    | 'shellArgs'
    | 'hookUrl'
    | 'boardMcpUrl'
    | 'permissionHoldMs'
    | 'trackers'
    | 'roleTemplates'
    | 'startStepTimeoutMs'
    | 'broadcast'
    | 'log'
  > {
  sessions: Pick<SessionHost, 'start' | 'kill' | 'forget'>;
  getRow(sessionId: string): AgentRow | undefined;
  get(sessionId: string): Agent | undefined;
  /** Every agent's row, in the order they were spawned. */
  rows(): AgentRow[];
  getZone(zoneId: string): ZoneRow | undefined;
  /** The zone of `repoRoot` that speaks for an agent of it whose tile is in `zoneId` (`repoZoneOf`). */
  repoZoneFor(zoneId: string | null, repoRoot: string): ZoneRow | undefined;
  /** Tells every client about the agent. */
  announce(sessionId: string): void;
  /** Agents' records: an agent an orchestrator starts is recorded in its crew. */
  records: Pick<AgentRecordStore, 'put'>;
  /** The agent was started with a first prompt, which its session has yet to take up. */
  promptQueued(sessionId: string): void;
  /**
   * Types `prompt` at the `harness` agent just launched as session `sessionId`, once its session is up; with none, only
   * holds what is sent to it until then.
   */
  typeFirstPrompt(sessionId: string, prompt: string | undefined, harness: Harness): void;
  /**
   * Watches the agent just launched: a bypassed Codex agent's worktree for project config, and a Codex agent carrying
   * on conversation `codexSessionId` for `codex resume` failing.
   */
  watch(
    sessionId: string,
    harness: Harness,
    cwd: string,
    worktree: string,
    bypassed: boolean,
    codexSessionId: string | null,
  ): void;
}

/** How to launch an agent's harness (`launch`). */
export interface LaunchSpec {
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
  /**
   * Claude carries on conversation `claudeSessionId` (else `id`) unless `claudeConversation` is false: it never had one
   * to carry on, so it starts a new one under that id.
   */
  resume?: { codexSessionId: string | null; claudeConversation?: boolean; claudeSessionId?: string };
  allowProjectCodexConfig: boolean;
  size: TerminalSize;
  /** It may change nothing: Claude starts in plan mode, Codex in its read-only sandbox. */
  readOnly?: boolean;
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
 * Starts agents: a new one in a worktree of its own, a reviewer of another's work, or a harness session started outside
 * agent-board, adopted; and launches each one's harness, as a relaunch does too.
 */
export function createAgentSpawns(
  options: AgentSpawnOptions,
): Pick<AgentHost, 'nextName' | 'spawn' | 'start' | 'starts' | 'spawnReviewer' | 'adopt'> & {
  launch(spec: LaunchSpec): boolean;
  /** The agents being started, before they are agents. */
  pending: Pick<AgentStarts, 'has' | 'retry' | 'update' | 'dismiss' | 'dismissIn'>;
  /** The first message the agent was started with, if any, while it is on the board. */
  firstMessage(sessionId: string): string | undefined;
  /** Whether the Claude agent's session was started with our `FORCE_HYPERLINK=1`; undefined when this daemon never started it. */
  hyperlinked(sessionId: string): boolean | undefined;
  /** The agent was deleted. */
  forget(sessionId: string): void;
} {
  const { db, sessions, getRow, get, rows, getZone, repoZoneFor, announce, watch } = options;
  const insert = db.prepare(
    `INSERT INTO agents (session_id, zone_id, repo_root, codex_bypass_hook_trust, model, role, role_name, name, description,
       branch, worktree, state, issue_provider, issue_id, issue_title, issue_url, x, y, z, review_of, base_commit,
       owns_worktree, harness_session_id, orchestrate, spawned_by, reviews_branch, reviews_head)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const setPlainFolder = db.prepare('UPDATE agents SET plain_folder = 1 WHERE session_id = ?');
  const selectNames = db.prepare('SELECT name FROM agents');
  const setReadOnly = db.prepare('UPDATE agents SET read_only = 1 WHERE session_id = ?');
  const setMaster = db.prepare('UPDATE agents SET master = 1 WHERE session_id = ?');
  const selectBranchReviews = db.prepare('SELECT * FROM branch_reviews WHERE repo_root = ? AND branch = ? ORDER BY id');
  const insertBranchReview = db.prepare('INSERT INTO branch_reviews (repo_root, branch, head, session_id) VALUES (?, ?, ?, ?)');
  /** One deeper than the agent that started it; its crew depth is kept even if that agent is deleted later. */
  const setCrewDepth = db.prepare(
    'UPDATE agents SET crew_depth = COALESCE((SELECT crew_depth FROM agents WHERE session_id = ?), 0) + 1 WHERE session_id = ?',
  );

  /** Whether an agent whose tile is in `zoneId` gets the board MCP server: on unless its zone turned it off. */
  const boardMcpOn = (zoneId: string | null): boolean => zoneId === null || getZone(zoneId)?.board_mcp !== 0;

  /**
   * Makes sure the harness is found before anything is made for an agent of it, once any lookup running is done,
   * and looking again if it was not.
   */
  const requireHarness = async (harness: Harness): Promise<void> => {
    await options.harnessPaths.pending(harness);
    if (options.harnessPaths.path(harness) === undefined && (await options.harnessPaths.refresh(harness)) === undefined) {
      throw invalidParams(options.harnessPaths.notFound(harness));
    }
  };

  /**
   * Starts the agent's harness in `cwd` as session `id`, with a new hook token, and `task` (if any) as its first
   * message: typed at its prompt once its session is up (Claude's `SessionStart`, Codex's composer drawn up), so that
   * no `pkill -f` naming a word of it ends the agent. Nothing else is typed at a Claude agent until then, task or not. With `resume`, Claude carries on conversation `id`, and Codex conversation `resume.codexSessionId` if it
   * is known (else it starts afresh). Returns whether Codex runs with the hook-trust bypass flag. Throws
   * `AGENT_ERROR.projectCodexConfig` for a Codex agent whose worktree has Codex config, unless allowed.
   */
  const launch = (spec: LaunchSpec): boolean => {
    const { id, harness, cwd, worktree, task } = spec;
    const harnessPath = options.harnessPaths.path(harness);
    if (harnessPath === undefined) throw invalidParams(options.harnessPaths.notFound(harness));
    const token = newToken();
    const boardCli = options.boardCliPath !== undefined && boardMcpOn(spec.zoneId) ? options.boardCliPath : undefined;
    let harnessCommand: HarnessLaunch;
    if (harness === 'claude') {
      const statusLine = configuredStatusLine([cwd, worktree], options.env);
      const settings = JSON.stringify(claudeSettings(options.hookUrl(), options.permissionHoldMs, statusLine === undefined ? undefined : 'user' in statusLine ? statusLine.user : null));
      harnessCommand = {
        command: harnessPath,
        args: [
          spec.resume && spec.resume.claudeConversation !== false ? '--resume' : '--session-id',
          spec.resume?.claudeSessionId ?? id,
          '--settings',
          settings,
          ...(boardCli === undefined ? [] : ['--mcp-config', JSON.stringify(claudeMcpConfig(options.boardMcpUrl()))]),
          ...(spec.model === null ? [] : ['--model', spec.model]),
          ...(spec.readOnly === true ? ['--permission-mode', 'plan'] : []),
        ],
      };
    } else {
      const codex = codexLaunch({
        command: harnessPath,
        hookShimPath: options.hookShimPath,
        zoneBypassHookTrust: spec.bypassHookTrust,
        boardCli,
        model: spec.model ?? undefined,
        cwd,
        worktree,
        resume: spec.resume?.codexSessionId ?? undefined,
        readOnly: spec.readOnly,
      });
      if (codex.projectConfig !== undefined && !spec.allowProjectCodexConfig) {
        throw new RpcMethodError(AGENT_ERROR.projectCodexConfig, projectConfigWarning(codex.projectConfig, options.hookShimPath));
      }
      harnessCommand = codex;
    }
    const { command, args } = harnessLaunch(options.shell, options.shellArgs, cwd, harnessCommand.command, harnessCommand.args);
    // With the PATH of the user's interactive shell, which a script harness may need to find its interpreter.
    const env = { ...options.harnessPaths.launchEnv(options.env) };
    // A daemon started from inside Claude Code must not make its agents think they are nested in it.
    delete env.CLAUDECODE;
    // Only Claude Code has a knob for it, and only when the setting is on: off leaves whatever the user's own env has.
    const compactWindow = options.compactWindow();
    if (harness === 'claude' && compactWindow > 0) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(compactWindow);
    // A `FORCE_HYPERLINK` that carries our marker was set by an agent-board this daemon was started from (inside one of
    // its Claude agents): not the user's, so it goes, and the setting decides afresh.
    if (env[FORCED_HYPERLINK_ENV] !== undefined) {
      delete env.FORCE_HYPERLINK;
      delete env[FORCED_HYPERLINK_ENV];
    }
    // Claude Code prints OSC 8 links only when it thinks the terminal wants them. A value of the user's own wins.
    if (harness === 'claude') {
      const forced = options.clickableLinks() && env.FORCE_HYPERLINK === undefined;
      if (forced) {
        env.FORCE_HYPERLINK = '1';
        env[FORCED_HYPERLINK_ENV] = '1';
      }
      hyperlinked.set(id, forced);
    }
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
    // A Claude agent with no task waits for its session too: a message typed while Claude loads sits unsent. (Codex
    // fires no hook before its first prompt, and its composer is watched only for a task.)
    if (task !== undefined || harness === 'claude') options.typeFirstPrompt(id, task, harness);
    return harness === 'codex' && harnessCommand.args.includes(CODEX_BYPASS_FLAG);
  };

  /** Choosing a free branch and creating it run one at a time per repo, so two spawns never pick the same name. */
  const inRepoQueue = keyedQueue();

  /**
   * The names of agents being started, by session id, so two starts never both take the same `new-agent-N`: held until
   * the agent is made, or its tile (a failed one too) dismissed.
   */
  const reservedNames = new Map<string, string>();

  /** The lowest `new-agent-N` no agent is called, or is being given: what an agent started with no task is named. */
  const freeAgentName = (): string => {
    const taken = new Set([...(selectNames.all() as { name: string }[]).map((row) => row.name), ...reservedNames.values()]);
    let n = 1;
    while (taken.has(`new-agent-${n}`)) n += 1;
    return `new-agent-${n}`;
  };

  /**
   * The repo a new agent's worktree is cut from, and the folder in it the agent starts in: the repo it was given (a
   * new scratch repo named after it, or a folder in a repo), else its zone's, else its group's default repo. A group
   * with none gives no repo: its agent runs in the group's own folder (see `begin`). `undo` removes a scratch repo made
   * for it, for a spawn that fails after.
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
      const found = await zoneFolder(repo.path);
      if (found.repoRoot === null) throw invalidParams(`${found.path} is not in a git repo: add a zone for it to run agents there outside git, or pick a repo`);
      return found;
    }
    if (zone === undefined) throw invalidParams('pick a repo to start the agent in');
    if (zone.repo_root !== null) return { repoRoot: zone.repo_root, folder: zone.folder };
    if (zone.clone_repo !== null) {
      throw invalidParams(`${zone.name} is still cloning ${zone.clone_repo}: start agents once it has finished`);
    }
    if (zone.default_repo !== null) return resolveZoneFolder(zone.default_repo);
    throw invalidParams(`${zone.name} has no repo: pick one to start the agent in`);
  };

  /**
   * A new agent working in the repo's own checkout: nothing is made. It owns no branch (`''`, as an adopted agent in a
   * folder of the user's), whatever is checked out there, so no pull request, push or merge of the app can name that
   * branch as its own.
   */
  const inMainCheckout = async (repoRoot: string) => {
    const head = await runGit(repoRoot, ['rev-parse', 'HEAD']);
    return { branch: '', worktree: repoRoot, baseCommit: head.ok ? head.stdout : null, reviews: null };
  };

  /**
   * What a new agent's role template is filled with. A reviewer's issue, when it starts from none, is that of the agent
   * whose branch it reviews; its round counts the reviewers of the branch before it, and its previous review is the
   * last one's review file, if it left one.
   */
  const templateValues = (agent: {
    repoRoot: string;
    branch: string;
    worktree: string;
    reviews: { branch: string } | null;
    issue: LinkedIssue | null;
  }): TemplateValues => {
    const reviewed = agent.reviews?.branch;
    const implementer =
      reviewed === undefined
        ? undefined
        : rows().findLast((row) => row.repo_root === agent.repoRoot && row.branch === reviewed);
    // Every earlier review of the branch, its reviewer on the board or not.
    const earlier = reviewed === undefined ? [] : (selectBranchReviews.all(agent.repoRoot, reviewed) as unknown as BranchReviewRow[]);
    const previous = earlier.at(-1);
    const implementerIssue = implementer?.issue_provider != null && implementer.issue_id !== null ? { provider: implementer.issue_provider, id: implementer.issue_id } : null;
    const issue = agent.issue ?? implementerIssue;
    return {
      // With no issue, "none": never its branch, which reads as an issue it isn't.
      issue: issue === null ? 'none' : shortIssueId(issue),
      branch: reviewed ?? agent.branch,
      worktree: agent.worktree,
      prev_review: (previous && previousReview(previous)) ?? 'none',
      round: String(earlier.length + 1),
      impl_worktree: reviewed === undefined ? agent.worktree : (implementer?.worktree ?? 'none'),
      prev_sha: previous?.head ?? 'none',
    };
  };

  /** An earlier review of a branch: the copy kept of it, else the file its reviewer, still on the board, left. */
  const previousReview = (review: BranchReviewRow): string | undefined => {
    if (review.review_path !== null) return review.review_path;
    const reviewer = review.session_id === null ? undefined : getRow(review.session_id);
    return reviewer === undefined ? undefined : reviewFile(reviewer.worktree);
  };

  /** The zone a new agent's issue comes from: `issueZoneId`, else its own; it must have a tracker. */
  const issueZone = (params: SpawnAgentParams, zone: ZoneRow | undefined): string => {
    const id = params.issueZoneId ?? zone?.id;
    const from = id === undefined ? undefined : getZone(id);
    if (from === undefined || from.tracker_provider === null) throw invalidParams('only a zone with a tracker starts agents from issues');
    return from.id;
  };

  const starts = createAgentStarts(options.broadcast);

  /** The first message each agent was started with, for a retry of a start whose harness exited before its first hook. */
  const firstMessages = new Map<string, string>();
  /** Whether each Claude agent's latest session got our `FORCE_HYPERLINK=1` (`DaemonSettings.clickableLinks`), by session id. */
  const hyperlinked = new Map<string, boolean>();

  /**
   * `work`, unless it takes longer than a start's step may: then the start fails, saying `what` took too long, and
   * whatever `work` made once it does finish is undone by `late`.
   */
  const within = <T>(work: Promise<T>, what: string, late?: (made: T) => Promise<void>): Promise<T> => {
    const limitMs = options.startStepTimeoutMs ?? START_STEP_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (late !== undefined) void work.then(late).catch(() => {});
        reject(invalidParams(`${what} took longer than ${limitMs >= 60_000 ? `${limitMs / 60_000} min` : `${limitMs / 1000} s`}`));
      }, limitMs);
      timer.unref();
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  };

  /**
   * Checks what a new agent is asked for, then puts its tile on the board (an `AgentStart`) and starts it: `done`
   * settles with the agent once its session runs, or with why it failed, which its tile keeps. Nothing before the tile
   * is on the board waits on another process: what needs git or the harness's path is checked as its first step.
   */
  const begin = (
    params: SpawnAgentParams,
    spawnedBy?: string,
    place?: FolderPlace,
    used?: { template: string | null },
  ): { sessionId: string; done: Promise<Agent> } => {
    const { zoneId, harness = 'claude', prompt = '', name, issueId, position } = params;
    const zone = zoneId === null ? undefined : getZone(zoneId);
    if (zoneId !== null && zone === undefined) throw invalidParams(`no zone ${zoneId}`);
    if (zoneId === null && position === undefined) throw invalidParams('an agent loose on the board needs a position');
    if (harness !== 'claude' && harness !== 'codex') throw invalidParams(`unknown harness ${String(harness)}`);
    const model = params.model?.trim() || null;
    // Passed to the harness as an argument: never an option of its own.
    if (model !== null && !MODEL_NAME.test(model)) throw invalidParams(`${model} is not a model name`);
    if (params.role !== undefined && typeof params.role !== 'string') throw invalidParams('role must be a string');
    // A built-in role, or a custom one by its name.
    const choice = params.role === undefined ? null : roleChoice(params.role);
    // A reviewer checks out the branch it reviews, detached: it has none of its own.
    const reviewer = choice !== null && REVIEWER_ROLES.includes(choice.role);
    if (reviewer && params.branch !== undefined) {
      throw invalidParams('a reviewer works on a detached checkout of the branch it reviews: it takes no branch of its own');
    }
    if (params.checkout !== undefined && params.checkout !== 'main' && params.checkout !== 'worktree') {
      throw invalidParams(`unknown checkout ${String(params.checkout)}`);
    }
    // Given no repo in a group with none, it runs in the group's own folder, outside git: no worktree, branch or review.
    const inGroup =
      place === undefined && params.repo === undefined && zone !== undefined && zone.repo_root === null && zone.clone_repo === null && zone.default_repo === null;
    if (inGroup && (reviewer || params.branch !== undefined || params.baseBranch !== undefined)) {
      throw invalidParams(`${zone.name} has no repo for a branch, base branch or reviewer: give the agent one to work in`);
    }
    // The folder outside git the group was added for, else the one the app makes for it.
    const folder = inGroup ? (zone.group_folder ?? groupFolder(options.groupsDir, zone.id)) : undefined;
    const at: FolderPlace | undefined = place ?? (folder === undefined ? undefined : { cwd: folder, repoRoot: folder, readOnly: false });
    // The repo's own checkout, with no worktree, is the user's to give (ADR-0011): an orchestrator's agents each get their own.
    const mainCheckout = params.checkout === 'main' && at === undefined;
    if (mainCheckout && spawnedBy !== undefined) throw invalidParams("an orchestrator's agents each work in a worktree of their own");
    if (mainCheckout && (reviewer || params.branch !== undefined || params.baseBranch !== undefined)) {
      throw invalidParams("an agent in the repo's own checkout takes no branch, base branch or reviewer role: it works on the branch checked out there");
    }
    if (params.orchestrate !== undefined && !ORCHESTRATE_SCOPES.includes(params.orchestrate)) {
      throw invalidParams(`unknown orchestrate scope ${String(params.orchestrate)}`);
    }
    const fromZone = issueId === undefined ? undefined : issueZone(params, zone);
    const id = randomUUID();
    // Named for now by what it was given; one started from an issue is named after it once the issue is read.
    const shownName = name?.trim() || (issueId !== undefined ? issueId : prompt.trim() === '' ? freeAgentName() : defaultName(prompt.trim()));
    // Kept until its agent is made or its tile dismissed, so no other start takes the name meanwhile.
    reservedNames.set(id, shownName);
    const shown: NewStart = { sessionId: id, zoneId, position: position ?? null, name: shownName, harness, model, spawnedBy: spawnedBy ?? null };
    const run = (progress: StartProgress, allowProjectCodexConfig: boolean) =>
      startAgent({ id, shownName, params, spawnedBy, place: at, plain: folder !== undefined, used, zone, harness, model, choice, reviewer, mainCheckout, fromZone, allowProjectCodexConfig }, progress);
    const progress = starts.open(shown, {
      retry: (again, allow) => void run(again, allow).catch(() => {}),
      dismissed: () => reservedNames.delete(id),
    });
    return { sessionId: id, done: run(progress, params.allowProjectCodexConfig ?? false) };
  };

  /**
   * Runs a start's steps, each shown on its tile as it goes: the checks that need git or the harness's path, the issue
   * read, the repo and worktree made, the harness launched. Each step that waits on another process gives up after
   * `START_STEP_TIMEOUT_MS`. What was made is undone if a later step fails (a launched harness is stopped), and when
   * the tile was dismissed, or its zone removed, before its session would run. The agent takes the name and place its
   * tile has then: the user may have renamed or moved it meanwhile.
   */
  const startAgent = async (
    start: {
      id: string;
      /** The name its tile was first shown with. */
      shownName: string;
      params: SpawnAgentParams;
      spawnedBy: string | undefined;
      place: FolderPlace | undefined;
      /** Its place is its group's own folder, outside git. */
      plain: boolean;
      used: { template: string | null } | undefined;
      zone: ZoneRow | undefined;
      harness: Harness;
      model: string | null;
      choice: ReturnType<typeof roleChoice> | null;
      reviewer: boolean;
      /** It works in the repo's own checkout: no worktree is made for it. */
      mainCheckout: boolean;
      fromZone: string | undefined;
      allowProjectCodexConfig: boolean;
    },
    progress: StartProgress,
  ): Promise<Agent> => {
    const { id, shownName, params, spawnedBy, place, plain, used, zone, harness, model, choice, reviewer, mainCheckout, fromZone, allowProjectCodexConfig } = start;
    const { zoneId, prompt = '', name, issueId, cols, rows } = params;
    const role = choice?.role ?? null;
    // A scope by hand is the user's alone (ADR-0011): an orchestrator's agents, like any, follow their zone's switch.
    const orchestrate = spawnedBy === undefined ? (params.orchestrate ?? null) : null;
    // What was made for it so far, undone if it fails to start: its harness, its worktree and branch, then any scratch repo.
    const undo: (() => Promise<void>)[] = [];
    /** Stops a start whose tile was dismissed, or whose zone went, before anything more is made for it. */
    const stillWanted = () => {
      if (progress.dismissed) throw invalidParams('its start was dismissed');
      const { zoneId: tileZone } = progress.start;
      if (tileZone !== null && getZone(tileZone) === undefined) throw invalidParams('its zone was removed');
    };
    try {
      await within(requireHarness(harness), `finding ${harness}`);
      // A typed branch is checked before anything is made for the agent, a scratch repo included.
      const typedBranch = params.branch === undefined ? undefined : await within(checkedBranchName(params.branch), 'checking its branch name').catch(wrapInvalid);
      // Its base reaches git only as `refs/heads/<base>`; checked all the same, so no name is ever read as an option.
      if (params.baseBranch !== undefined) await within(checkedBranchName(params.baseBranch), 'checking its base branch').catch(wrapInvalid);
      if (harness === 'codex') {
        try {
          options.ensureHookShim();
        } catch (error) {
          throw invalidParams(`can't write the Codex hook launcher ${options.hookShimPath}: ${(error as Error).message}`);
        }
      }
      stillWanted();
      // Started from an issue: the issue comes first in its prompt, and names its branch.
      if (fromZone !== undefined) progress.step('issue', 'now');
      const fromIssue = fromZone === undefined || issueId === undefined ? undefined : await within(options.trackers.issue(fromZone, issueId), 'reading the issue');
      if (fromIssue !== undefined) progress.step('issue', 'done', shortIssueId(fromIssue.issue));
      stillWanted();
      const task = [fromIssue && issuePrompt(fromIssue.issue), prompt.trim()].filter(Boolean).join('\n\n');
      // Named after its issue as people write it in its scope (`#34`, not `acme/app#34`), else after its task, else
      // `new-agent-N` when it starts at its prompt; unless the user renamed its tile already.
      const renamed = progress.start.name !== shownName;
      const agentName = renamed
        ? progress.start.name
        : name?.trim() ||
          (fromIssue ? defaultName(`${shortIssueId(fromIssue.issue)}: ${fromIssue.issue.title}`) : task === '' ? shownName : defaultName(task));
      reservedNames.set(id, agentName);
      if (!renamed) progress.rename(agentName);
      if (place === undefined && !mainCheckout) progress.step('worktree', 'now');
      const { repoRoot, folder, undo: undoRepo } =
        place === undefined
          ? await within(agentRepo(params, zone, agentName), 'creating the project', async (made) => made.undo?.())
          : { repoRoot: place.repoRoot, folder: '', undo: undefined };
      if (undoRepo !== undefined) undo.unshift(undoRepo);
      stillWanted();
      // Timed inside the repo's queue, so a step that gives up frees it for the next start in the repo. `owns` is whether
      // a worktree and branch were made for it, which deleting it removes.
      const { branch, worktree, baseCommit, reviews, owns } = place !== undefined ? { branch: '', worktree: place.cwd, baseCommit: null, reviews: null, owns: false } : mainCheckout ? { ...(await within(inMainCheckout(repoRoot), 'reading the checkout')), owns: false } : await inRepoQueue(repoRoot, () => within((async () => {
        if (reviewer) {
          const reviewed = params.baseBranch ?? (await checkedOutBranch(repoRoot).catch(wrapInvalid));
          const worktree = freeWorktreePath(agentWorktreePath(options.worktreesDir, repoRoot, `${reviewed}-review`));
          const head = await addDetachedWorktree(repoRoot, worktree, reviewed).catch(wrapInvalid);
          return { branch: '', worktree, baseCommit: head, reviews: { branch: reviewed, head }, owns: true };
        }
        const branch =
          typedBranch !== undefined
            ? await freeTypedBranch(repoRoot, typedBranch).catch(wrapInvalid)
            : fromIssue
              ? await freeBranchName(repoRoot, fromIssue.branch)
              : agentBranchName(agentName);
        const worktree = agentWorktreePath(options.worktreesDir, repoRoot, branch);
        // A repo with no commits yet, and a git too old to branch a worktree from none: it works in the repo's own
        // checkout instead, as an orchestrator in the main checkout does (ADR-0011). Nothing is committed for it.
        if (!(await addWorktree(repoRoot, worktree, branch, params.baseBranch).catch(wrapInvalid))) {
          // A branch asked for by name can't be had there: said so, rather than dropped.
          if (typedBranch !== undefined) {
            throw invalidParams(`${basename(repoRoot)} has no commits yet, and this git is too old (before 2.42) to start ${typedBranch} with none: update git, or start the agent without a branch`);
          }
          return { ...(await inMainCheckout(repoRoot)), owns: false };
        }
        // What its work is reviewed against: the commit it started from, or, on a branch begun with no commit
        // before it, the empty tree, as all of the branch is its work.
        const head = await runGit(worktree, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
        const base = head.ok ? head : await runGit(worktree, ['hash-object', '-t', 'tree', '/dev/null']);
        return { branch, worktree, baseCommit: base.ok ? base.stdout : null, reviews: null, owns: true };
      })(), 'creating the worktree', async (made) => {
        if (made.owns) await removeWorktree(repoRoot, made.worktree, made.branch);
      }));
      // A folder it was put in is not its own: it stays.
      if (owns) undo.unshift(() => removeWorktree(repoRoot, worktree, branch));
      if (place === undefined && !mainCheckout) progress.step('worktree', 'done', branch || basename(worktree));
      stillWanted();
      progress.step('launch', 'now');
      // The tile shows the issue already: describe the work by the typed task, else the issue's own description.
      const description =
        prompt.trim() || fromIssue?.issue.description.trim() || task || (reviews === null ? '' : `Reviews ${reviews.branch}`);
      // A role's template comes first, filled in for this agent; then the issue, then what was typed.
      const template =
        choice === null || params.noTemplate === true
          ? ''
          : fillTemplate(
              options.roleTemplates.body(zoneId ?? repoZoneFor(null, repoRoot)?.id ?? null, repoRoot, choice),
              templateValues({ repoRoot, branch, worktree, reviews, issue: fromIssue?.issue ?? null }),
            ).trim();
      // A named role's template may be an orchestrator's: checked as its text, filled in, whoever starts the agent.
      if (choice?.name != null) checkNamedTemplate(choice.name, template);
      if (used !== undefined) {
        used.template = template === '' ? null : options.roleTemplates.describe(zoneId ?? repoZoneFor(null, repoRoot)?.id ?? null, repoRoot, choice!);
      }
      const firstMessage = [template, task].filter(Boolean).join('\n\n');
      // A zone-less agent takes the bypass setting of its repo's zone, else the default (on).
      const bypassHookTrust =
        zone?.repo_root === repoRoot ? zone.codex_bypass_hook_trust : (repoZoneFor(zoneId, repoRoot)?.codex_bypass_hook_trust ?? 1);

      // A folder zone's folder may be untracked, so missing from the new worktree.
      const cwd = folder === '' ? worktree : join(worktree, folder);
      mkdirSync(cwd, { recursive: true });
      const readOnly = place?.readOnly === true;
      // Where its tile is now, and what it is called.
      const tile = progress.start;
      const bypassed = launch({
        id,
        harness,
        model,
        bypassHookTrust: bypassHookTrust === 1,
        zoneId: tile.zoneId,
        cwd,
        worktree,
        task: firstMessage === '' ? undefined : firstMessage,
        allowProjectCodexConfig,
        size: { cols, rows },
        readOnly,
      });
      // Should the agent not be made after all, its harness must not run on with no tile.
      undo.unshift(() => sessions.kill(id, 'its start failing').then(() => sessions.forget(id)));
      // The session already runs, but its hooks can't arrive before this synchronous insert. It is idle until its
      // SessionStart hook says it runs.
      insert.run(
        id,
        tile.zoneId,
        repoRoot,
        bypassHookTrust,
        model,
        role,
        choice?.name ?? null,
        tile.name,
        description.slice(0, MAX_DESCRIPTION_LENGTH),
        branch,
        worktree,
        'idle',
        ...issueColumns(fromIssue?.issue ?? null),
        tile.position?.x ?? null,
        tile.position?.y ?? null,
        tile.position === null ? null : frontZ(db),
        null,
        baseCommit,
        owns ? 1 : 0,
        null,
        orchestrate,
        spawnedBy ?? null,
        reviews?.branch ?? null,
        reviews?.head ?? null,
      );
      reservedNames.delete(id);
      if (firstMessage !== '') {
        firstMessages.set(id, firstMessage);
        options.promptQueued(id);
      }
      if (readOnly) setReadOnly.run(id);
      if (plain) setPlainFolder.run(id);
      if (place?.master === true) setMaster.run(id);
      if (spawnedBy !== undefined) {
        setCrewDepth.run(spawnedBy, id);
        options.records.put(spawnedBy, { kind: 'crew', key: id });
      }
      if (reviews !== null) insertBranchReview.run(repoRoot, reviews.branch, reviews.head, id);
      // A repo it was given is offered again, once it has an agent in it.
      if (params.repo !== undefined && 'path' in params.repo) options.rememberFolder(folderPath(repoRoot, folder));
      const agent = get(id)!;
      options.log(`spawned ${harness} agent ${id} on ${branch} in ${worktree}${bypassed ? ` with ${CODEX_BYPASS_FLAG}` : ''}`);
      // Its tile turns into the agent's: the agent first, so the board never shows neither.
      options.broadcast({ type: 'agent.updated', agent });
      if (spawnedBy !== undefined) announce(spawnedBy);
      progress.end();
      watch(id, harness, cwd, worktree, bypassed, null);
      return get(id)!;
    } catch (error) {
      for (const step of undo) await step().catch(() => {});
      progress.fail((error as Error).message, error instanceof RpcMethodError && error.code === AGENT_ERROR.projectCodexConfig);
      throw error;
    }
  };

  return {
    launch,

    nextName: freeAgentName,

    spawn: async (params, spawnedBy, place, used) => begin(params, spawnedBy, place, used).done,

    async start(params) {
      const { sessionId, done } = begin(params);
      // Whatever fails from here on stays on its tile.
      done.catch(() => {});
      return { sessionId };
    },

    starts: starts.list,

    pending: starts,

    firstMessage: (sessionId) => firstMessages.get(sessionId),

    hyperlinked: (sessionId) => hyperlinked.get(sessionId),
    forget: (sessionId) => {
      firstMessages.delete(sessionId);
      hyperlinked.delete(sessionId);
    },

    async spawnReviewer({ of, name, branch: wanted, prompt, cols, rows }) {
      const implementer = getRow(of);
      if (implementer === undefined) throw invalidParams(`no agent ${of}`);
      await requireHarness(implementer.harness);
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
        null,
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
        null,
        null,
      );
      options.promptQueued(id);
      options.log(`spawned ${implementer.harness} reviewer ${id} of ${of} on ${branch} in ${worktree}`);
      announce(id);
      return get(id)!;
    },

    async adopt({ sessionId, harness, name, description, zoneId, position, transcriptPath, place, size }) {
      if (getRow(sessionId) !== undefined) throw invalidParams(`${name} is already an agent`);
      await requireHarness(harness);
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
        null,
        null,
      );
      watch(sessionId, harness, at.cwd, at.worktree, bypassed, codexSessionId);
      options.log(`adopted ${harness} session ${sessionId} as an agent in ${at.cwd}`);
      announce(sessionId);
      return get(sessionId)!;
    },
  };
}

/**
 * The command that posts a `SessionStart` hook to the daemon. Claude runs no `http` hook for `SessionStart`, so that
 * one event is a `command` hook: curl sends its stdin to the session's hook URL with its token, both read from the
 * session's environment by the shell, so neither is on Claude's command line. `-q` (first) skips the user's
 * `~/.curlrc` and `--noproxy '*'` any proxy in their environment, either of which could lose or garble the post. It
 * prints the daemon's answer, and nothing (exiting 0) when the daemon can't be reached, so a start never fails on it.
 */
const CLAUDE_SESSION_START_COMMAND =
  `curl -q -sf --noproxy '*' -m ${HOOK_TIMEOUT_S - 1} -X POST -H 'content-type: application/json' ` +
  `-H "Authorization: Bearer $${HOOK_TOKEN_ENV}" --data-binary @- "$${HOOK_URL_ENV}" || true`;

/**
 * The status line Claude would run for an agent without ours: `project` when its project (the folder it starts in, or
 * its worktree's root, for a folder zone) sets one, which ours never stands in for, as it would run a repo's command
 * from trusted settings, past Claude's workspace trust; else the user's own command, from their settings; else none.
 */
export function configuredStatusLine(
  projects: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): { project: true } | { user: string } | undefined {
  const read = (file: string): unknown => {
    try {
      const settings: unknown = JSON.parse(readFileSync(file, 'utf8'));
      return typeof settings === 'object' && settings !== null && 'statusLine' in settings ? (settings as { statusLine: unknown }).statusLine : undefined;
    } catch {
      return undefined;
    }
  };
  const files = [...new Set(projects.filter((project) => project !== ''))].flatMap((project) => [join(project, '.claude', 'settings.local.json'), join(project, '.claude', 'settings.json')]);
  if (files.some((file) => read(file) != null)) return { project: true };
  const own = read(join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), '.claude'), 'settings.json')) as { type?: unknown; command?: unknown } | null | undefined;
  return own?.type === 'command' && typeof own.command === 'string' && own.command.trim() !== '' ? { user: own.command } : undefined;
}

/**
 * The status line command that posts what Claude passes it (its plan usage, `rate_limits`) to the daemon's `/usage`,
 * as `CLAUDE_SESSION_START_COMMAND` posts, beside the hook URL; then, with `own`, runs the status line Claude would
 * have run without ours on the same input, so its line, and whatever else it does, stay as they were. Nothing is
 * shown without one, as Claude shows none without a status line.
 */
export function claudeStatusLineCommand(own: string | undefined): string {
  const post =
    `in=$(cat); printf '%s' "$in" | curl -q -sf --noproxy '*' -m 1 -X POST -H 'content-type: application/json' ` +
    `-H "Authorization: Bearer $${HOOK_TOKEN_ENV}" --data-binary @- "\${${HOOK_URL_ENV}%/hooks}/usage" >/dev/null 2>&1`;
  return own === undefined ? `${post}; true` : `${post}; printf '%s' "$in" | {\n${own}\n}`;
}

/**
 * The `claude --settings` that sends every hook event to the daemon (ADR-0004): as an `http` hook, the token
 * interpolated from the session's environment by Claude so it never appears on the command line, except
 * `SessionStart`, which Claude runs only as a `command` hook (`CLAUDE_SESSION_START_COMMAND`). Claude waits on a
 * PermissionRequest hook a little longer than the daemon holds it (`permissionHoldMs`), so the daemon's no-decision
 * answer, not a timeout, is what hands the prompt back to the terminal. Its status line posts the plan usage Claude
 * passes it to the daemon (`claudeStatusLineCommand`), running the user's own `ownStatusLine` after, if they have one;
 * with `ownStatusLine` null (its project sets a status line), it has none of ours, and Claude runs the project's.
 */
export function claudeSettings(hookUrl: string, permissionHoldMs: number, ownStatusLine?: string | null) {
  const handler = (timeout: number) => ({
    type: 'http',
    url: hookUrl,
    headers: { Authorization: `Bearer $${HOOK_TOKEN_ENV}` },
    allowedEnvVars: [HOOK_TOKEN_ENV],
    timeout,
  });
  const permissionTimeout = Math.ceil(permissionHoldMs / 1000) + PERMISSION_HOOK_MARGIN_S;
  return {
    ...(ownStatusLine === null ? {} : { statusLine: { type: 'command', command: claudeStatusLineCommand(ownStatusLine) } }),
    hooks: Object.fromEntries(
      CLAUDE_HOOK_EVENTS.map((event) => [
        event,
        [
          {
            hooks: [
              event === 'SessionStart'
                ? { type: 'command', command: CLAUDE_SESSION_START_COMMAND, timeout: HOOK_TIMEOUT_S }
                : handler(event === 'PermissionRequest' ? permissionTimeout : HOOK_TIMEOUT_S),
            ],
          },
        ],
      ]),
    ),
  };
}

/** What the board MCP server is called in a harness's MCP config. */
const BOARD_MCP_SERVER = 'agent-board';

/**
 * Set beside the `FORCE_HYPERLINK=1` that agent-board gives a Claude agent, so an agent-board started from inside that
 * agent can tell its inherited `FORCE_HYPERLINK` from one the user set.
 */
export const FORCED_HYPERLINK_ENV = 'AGENT_BOARD_FORCED_HYPERLINK';

/** The status line Codex draws under its composer for an agent: its model and reasoning effort, then its folder. */
const CODEX_STATUS_LINE = '["model-with-reasoning","current-dir"]';

/** The board env Codex passes its stdio board MCP server (ADR-0010). */
const BOARD_MCP_ENV = [BOARD_SOCKET_ENV, BOARD_TOKEN_ENV, BOARD_SESSION_ENV, BOARD_ZONE_ENV];

/** How long Codex lets a board MCP tool call run: past the longest a question or plan waits (`MAX_ASK_WAIT_MS`). */
const BOARD_MCP_TOOL_TIMEOUT_SEC = MAX_ASK_WAIT_MS / 1000 + 60;

/**
 * The `claude --mcp-config` that reaches the board MCP in the daemon over HTTP (ADR-0010), with the session's board
 * token, which Claude fills in from its own env: so nothing is started per agent, and the token is in no argv.
 */
function claudeMcpConfig(url: string) {
  const headers = { Authorization: `Bearer \${${BOARD_TOKEN_ENV}}` };
  return { mcpServers: { [BOARD_MCP_SERVER]: { type: 'http', url, headers } } };
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
  /**
   * The `agent-board` CLI launcher, to run as the board MCP server over stdio (ADR-0010); none without. Codex keeps
   * stdio until a real Codex has been seen to call the daemon's HTTP MCP; Claude's agents use that.
   */
  boardCli?: string;
  /** Where Codex starts, and the worktree it is in. */
  cwd: string;
  worktree: string;
  /** Codex's id for a conversation to carry on (`codex resume <id>`); a new one without. */
  resume?: string;
  /** Its model (`-m`); Codex's default without. */
  model?: string;
  /** In Codex's read-only sandbox (`-s read-only`). */
  readOnly?: boolean;
}

/**
 * How to start `codex` for an agent (ADR-0004): every hook event as a `-c` override running the forwarder, the
 * `AGENT_BOARD_HOOK_*` env (hook URL and token) hidden from the model's shell commands, the board MCP server
 * (ADR-0010) over stdio when it has `boardCli`, and the hook-trust bypass flag when the zone has it on. Never a prompt: one
 * on its command line would let any `pkill -f` naming a word of it end the agent. Use it for every launch of a Codex
 * agent, a resume included.
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
  // Its first prompt is typed once its screen shows the composer with this line under it (`codexComposerUp`): the
  // user's own `[tui] status_line` may draw another, or none, so the board sets it.
  args.push('-c', `tui.status_line=${CODEX_STATUS_LINE}`);
  if (options.boardCli !== undefined) {
    // Codex gives an MCP server only a few env vars of its own unless told which others to pass.
    args.push(
      '-c',
      `mcp_servers.${BOARD_MCP_SERVER}.command=${JSON.stringify(options.boardCli)}`,
      '-c',
      `mcp_servers.${BOARD_MCP_SERVER}.args=["mcp"]`,
      '-c',
      `mcp_servers.${BOARD_MCP_SERVER}.env_vars=${JSON.stringify(BOARD_MCP_ENV)}`,
      // A question or plan blocks its call until the user answers: longer than Codex's 60 s by default.
      '-c',
      `mcp_servers.${BOARD_MCP_SERVER}.tool_timeout_sec=${BOARD_MCP_TOOL_TIMEOUT_SEC}`,
    );
  }
  const projectConfig = projectCodexConfig(options.cwd, options.worktree);
  if (options.zoneBypassHookTrust && projectConfig === undefined) args.push(CODEX_BYPASS_FLAG);
  if (options.model !== undefined) args.push('-m', options.model);
  if (options.readOnly === true) args.push('-s', 'read-only');
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
 * xonsh, tcsh…) is skipped, and the harness is started directly. `command` is the harness's absolute path
 * (`harness-path.ts`), so the shell looks nothing up: it is there for its environment, not its PATH.
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

/** The `issue_provider`, `issue_id`, `issue_title` and `issue_url` columns for an agent's issue, all null for none. */
export function issueColumns(issue: LinkedIssue | null): [string | null, string | null, string | null, string | null] {
  return issue === null ? [null, null, null, null] : [issue.provider, issue.id, issue.title, issue.url];
}

/** A failure of git's, or of a check, as the spawn's refusal. */
function wrapInvalid(error: Error): never {
  throw invalidParams(error.message);
}

/** The review a reviewer left in its worktree: the newest `.agent-board/review*.md`, or undefined for none. */
export function reviewFile(worktree: string): string | undefined {
  const dir = join(worktree, '.agent-board');
  try {
    return readdirSync(dir)
      .filter((name) => /^review.*\.md$/.test(name))
      .map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0]?.path;
  } catch {
    return undefined;
  }
}
