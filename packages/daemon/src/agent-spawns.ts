import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { issuePrompt, shortIssueId } from '@agent-board/tracker';
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
import { initProject, resolveZoneFolder } from './zones.ts';

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

/** How far a loose implementer's reviewer starts from it, down and right, in board units. */
const REVIEWER_OFFSET = 48;

/** What starting an agent reads of the host. */
interface AgentSpawnOptions
  extends Pick<
    AgentHostOptions,
    | 'db'
    | 'worktreesDir'
    | 'scratchDir'
    | 'rememberFolder'
    | 'harnessPaths'
    | 'hookShimPath'
    | 'ensureHookShim'
    | 'boardCliPath'
    | 'env'
    | 'compactWindow'
    | 'shell'
    | 'shellArgs'
    | 'hookUrl'
    | 'boardMcpUrl'
    | 'permissionHoldMs'
    | 'trackers'
    | 'roleTemplates'
    | 'broadcast'
    | 'log'
  > {
  sessions: Pick<SessionHost, 'start'>;
  getRow(sessionId: string): AgentRow | undefined;
  get(sessionId: string): Agent | undefined;
  /** Every agent's row, in the order they were spawned. */
  rows(): AgentRow[];
  getZone(zoneId: string): ZoneRow | undefined;
  /** The zone of `repoRoot` that speaks for an agent of it whose tile is in `zoneId` (`repoZoneOf`). */
  repoZoneFor(zoneId: string | null, repoRoot: string): ZoneRow | undefined;
  /** Tells every client about the agent. */
  announce(sessionId: string): void;
  /** The agent was started with a first prompt, which its session has yet to take up. */
  promptQueued(sessionId: string): void;
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
}

/**
 * Starts agents: a new one in a worktree of its own, a reviewer of another's work, or a harness session started outside
 * agent-board, adopted; and launches each one's harness, as a relaunch does too.
 */
export function createAgentSpawns(
  options: AgentSpawnOptions,
): Pick<AgentHost, 'nextName' | 'spawn' | 'spawnReviewer' | 'adopt'> & { launch(spec: LaunchSpec): boolean } {
  const { db, sessions, getRow, get, rows, getZone, repoZoneFor, announce, watch } = options;
  const insert = db.prepare(
    `INSERT INTO agents (session_id, zone_id, repo_root, codex_bypass_hook_trust, model, role, role_name, name, description,
       branch, worktree, state, issue_provider, issue_id, issue_title, issue_url, x, y, z, review_of, base_commit,
       owns_worktree, harness_session_id, orchestrate, spawned_by, reviews_branch, reviews_head)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectNames = db.prepare('SELECT name FROM agents');
  const setReadOnly = db.prepare('UPDATE agents SET read_only = 1 WHERE session_id = ?');
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
   * message. With `resume`, Claude carries on conversation `id`, and Codex conversation `resume.codexSessionId` if it
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
      const settings = JSON.stringify(claudeSettings(options.hookUrl(), options.permissionHoldMs));
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
          ...(task === undefined ? [] : ['--', task]),
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
        prompt: task,
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

  return {
    launch,

    nextName: freeAgentName,

    async spawn(params, spawnedBy, place, used) {
      const { zoneId, harness = 'claude', prompt = '', name, issueId, allowProjectCodexConfig = false, position, cols, rows } = params;
      const zone = zoneId === null ? undefined : getZone(zoneId);
      if (zoneId !== null && zone === undefined) throw invalidParams(`no zone ${zoneId}`);
      if (zoneId === null && position === undefined) throw invalidParams('an agent loose on the board needs a position');
      if (harness !== 'claude' && harness !== 'codex') throw invalidParams(`unknown harness ${String(harness)}`);
      await requireHarness(harness);
      const model = params.model?.trim() || null;
      // Passed to the harness as an argument: never an option of its own.
      if (model !== null && !MODEL_NAME.test(model)) throw invalidParams(`${model} is not a model name`);
      if (params.role !== undefined && typeof params.role !== 'string') throw invalidParams('role must be a string');
      // A built-in role, or a custom one by its name.
      const choice = params.role === undefined ? null : roleChoice(params.role);
      const role = choice?.role ?? null;
      // A reviewer checks out the branch it reviews, detached: it has none of its own.
      const reviewer = role !== null && REVIEWER_ROLES.includes(role);
      if (reviewer && params.branch !== undefined) {
        throw invalidParams('a reviewer works on a detached checkout of the branch it reviews: it takes no branch of its own');
      }
      if (params.orchestrate !== undefined && !ORCHESTRATE_SCOPES.includes(params.orchestrate)) {
        throw invalidParams(`unknown orchestrate scope ${String(params.orchestrate)}`);
      }
      // A scope by hand is the user's alone (ADR-0011): an orchestrator's agents, like any, follow their zone's switch.
      const orchestrate = spawnedBy === undefined ? (params.orchestrate ?? null) : null;
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
        const { repoRoot, folder, undo: undoRepo } = place === undefined ? await agentRepo(params, zone, agentName) : { repoRoot: place.repoRoot, folder: '', undo: undefined };
        if (undoRepo !== undefined) undo.unshift(undoRepo);
        const { branch, worktree, baseCommit, reviews } = place !== undefined ? { branch: '', worktree: place.cwd, baseCommit: null, reviews: null } : await inRepoQueue(repoRoot, async () => {
          if (reviewer) {
            const reviewed = params.baseBranch ?? (await checkedOutBranch(repoRoot).catch(wrapInvalid));
            const worktree = freeWorktreePath(agentWorktreePath(options.worktreesDir, repoRoot, `${reviewed}-review`));
            const head = await addDetachedWorktree(repoRoot, worktree, reviewed).catch(wrapInvalid);
            return { branch: '', worktree, baseCommit: head, reviews: { branch: reviewed, head } };
          }
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
          return { branch, worktree, baseCommit: head.ok ? head.stdout : null, reviews: null };
        });
        // A folder it was put in is not its own: it stays.
        if (place === undefined) undo.unshift(() => removeWorktree(repoRoot, worktree, branch));
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

        const id = randomUUID();
        // A folder zone's folder may be untracked, so missing from the new worktree.
        const cwd = folder === '' ? worktree : join(worktree, folder);
        mkdirSync(cwd, { recursive: true });
        const readOnly = place?.readOnly === true;
        const bypassed = launch({
          id,
          harness,
          model,
          bypassHookTrust: bypassHookTrust === 1,
          zoneId,
          cwd,
          worktree,
          task: firstMessage === '' ? undefined : firstMessage,
          allowProjectCodexConfig,
          size: { cols, rows },
          readOnly,
        });
        // The session already runs, but its hooks can't arrive before this synchronous insert. It is idle until its
        // SessionStart hook says it runs.
        insert.run(
          id,
          zoneId,
          repoRoot,
          bypassHookTrust,
          model,
          role,
          choice?.name ?? null,
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
          place === undefined ? 1 : 0,
          null,
          orchestrate,
          spawnedBy ?? null,
          reviews?.branch ?? null,
          reviews?.head ?? null,
        );
        if (firstMessage !== '') options.promptQueued(id);
        if (readOnly) setReadOnly.run(id);
        if (spawnedBy !== undefined) setCrewDepth.run(spawnedBy, id);
        if (reviews !== null) insertBranchReview.run(repoRoot, reviews.branch, reviews.head, id);
        // A repo it was given is offered again, once it has an agent in it.
        if (params.repo !== undefined && 'path' in params.repo) options.rememberFolder(folderPath(repoRoot, folder));
        const agent = get(id)!;
        options.log(`spawned ${harness} agent ${id} on ${branch} in ${worktree}${bypassed ? ` with ${CODEX_BYPASS_FLAG}` : ''}`);
        options.broadcast({ type: 'agent.updated', agent });
        watch(id, harness, cwd, worktree, bypassed, null);
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
  /** The first message; none leaves Codex at its prompt. */
  prompt?: string;
}

/**
 * How to start `codex` for an agent (ADR-0004): every hook event as a `-c` override running the forwarder, the
 * `AGENT_BOARD_HOOK_*` env (hook URL and token) hidden from the model's shell commands, the board MCP server
 * (ADR-0010) over stdio when it has `boardCli`, and the hook-trust bypass flag when the zone has it on. Use it for every launch of a Codex agent, a resume included.
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
      // A question or plan blocks its call until the user answers: longer than Codex's 60 s by default.
      '-c',
      `mcp_servers.${BOARD_MCP_SERVER}.tool_timeout_sec=${BOARD_MCP_TOOL_TIMEOUT_SEC}`,
    );
  }
  const projectConfig = projectCodexConfig(options.cwd, options.worktree);
  if (options.zoneBypassHookTrust && projectConfig === undefined) args.push(CODEX_BYPASS_FLAG);
  if (options.model !== undefined) args.push('-m', options.model);
  if (options.readOnly === true) args.push('-s', 'read-only');
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
