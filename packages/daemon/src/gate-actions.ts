// Open PR and Merge from an agent's session window (BM3), each only when the rules allow it (`gate-rules.ts`),
// checked here again whatever the app showed. GitHub is asked through the user's own gh login, as every GitHub call is
// (ADR-0002); merging and approving reuse the PR tab's calls. Only the user's app calls these (`BOARD_CALLER_METHODS`),
// but for an agent opening its own pull request as a draft (`board.openPullRequest`).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPullRequest, deleteRemoteBranch, mergePullRequest, pullRequestDetails, pullRequestOfUrl, shortIssueId, type PullRequest } from '@agent-board/tracker';
import { cleanupProblem, isOpenPullRequest, mergeBlocked, openPullRequestBlocked, pullRequestBody, shortCommit, type GateCleanup } from './gate-rules.ts';
import { boardCaller, type BoardCallerSources, type BoardConnection } from './board.ts';
import type { GateHost } from './gates.ts';
import { runGit } from './git.ts';
import { invalidParams, paramsObject, stringParam } from './params.ts';
import type { Agent, DaemonMethods, GateMerged, LinkedIssue } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';
import { call as trackerCall } from './trackers.ts';

export interface GateActionOptions {
  /** The `gh` executable. */
  gh: string;
  gates: Pick<GateHost, 'get' | 'command' | 'worktreeState'>;
  agent(sessionId: string): Agent | undefined;
  /** The GitHub repo (`owner/repo`) of the zone of the agent's repo, when its tracker is one; else gh infers it. */
  githubRepo(sessionId: string): string | undefined;
  /** The agent's pull requests as last seen, and asking for them again now. */
  pullRequests(sessionId: string): PullRequest[];
  refreshPullRequests(sessionId: string): Promise<void>;
  /** Ends the agent and takes it off the board, its reviewers first: its worktree and branch too, unless kept. */
  deleteAgent(sessionId: string, keep: { worktree: boolean; branch: boolean }): Promise<void>;
  comment(issue: LinkedIssue, body: string): Promise<void>;
  log(message: string): void;
  /** Who holds a board token, for `board.openPullRequest`. */
  callers: BoardCallerSources;
}

type Methods = Pick<DaemonMethods, 'gate.openPullRequest' | 'gate.merge' | 'board.openPullRequest'>;

/** Where a repo keeps its pull request template, as GitHub looks for it. */
const TEMPLATES = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md', 'docs/pull_request_template.md'];

/** The agent's handover, from which Open PR fills the template. */
const HANDOVER_PATH = '.agent-board/handover.md';

const readText = (path: string): Promise<string | undefined> => readFile(path, 'utf8').catch(() => undefined);

async function firstText(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    const text = await readText(path);
    if (text !== undefined) return text;
  }
  return undefined;
}

const CLEANUP_STEPS: (keyof GateCleanup)[] = ['close', 'worktree', 'branch', 'comment'];

function cleanupParam(fields: Record<string, unknown>): GateCleanup {
  const value = fields.cleanup;
  if (typeof value !== 'object' || value === null) throw invalidParams('cleanup must say which clean-up steps to take');
  const steps = value as Record<string, unknown>;
  for (const step of CLEANUP_STEPS) if (typeof steps[step] !== 'boolean') throw invalidParams(`cleanup.${step} must be true or false`);
  const cleanup: GateCleanup = { close: steps.close === true, worktree: steps.worktree === true, branch: steps.branch === true, comment: steps.comment === true };
  const problem = cleanupProblem(cleanup);
  if (problem !== undefined) throw invalidParams(problem);
  return cleanup;
}

export function gateActionHandlers<Context extends BoardConnection>(options: GateActionOptions): RpcHandlers<Methods, Context> {
  const requireAgent = (sessionId: string): Agent => {
    const agent = options.agent(sessionId);
    if (agent === undefined) throw invalidParams(`no agent ${sessionId}`);
    return agent;
  };
  const gh = { gh: options.gh };

  /** Opens a pull request of the agent's branch, as `gate.openPullRequest` says; with `draft`, as a draft. */
  const openPullRequest = async (sessionId: string, { draft }: { draft: boolean }): Promise<PullRequest> => {
    const agent = requireAgent(sessionId);
    if (agent.branch === '') throw invalidParams(`${agent.name} has no branch to open a pull request of.`);
    const open = options.pullRequests(sessionId).find(isOpenPullRequest);
    if (open !== undefined) throw invalidParams(`${agent.name} has #${open.number} open already.`);
    const { head, branch, uncommitted } = await options.gates.worktreeState(sessionId);
    if (head === null) throw invalidParams(`${agent.name}'s worktree has no commit.`);
    // What is pushed is its branch's: a worktree on another branch, or none, would open a pull request of something else.
    if (branch !== agent.branch) throw invalidParams(`${agent.name}'s worktree is on ${branch ?? 'no branch'}, not ${agent.branch}: check it out first.`);
    const gated = options.gates.command(sessionId) !== null;
    const run = options.gates.get(sessionId);
    const blocked = openPullRequestBlocked({ run, head, uncommitted, gated });
    if (blocked !== undefined) throw invalidParams(blocked);
    const [template, handover] = await Promise.all([firstText(TEMPLATES.map((path) => join(agent.worktree, path))), readText(join(agent.worktree, HANDOVER_PATH))]);
    const issue = agent.issue === null ? undefined : shortIssueId(agent.issue);
    const body = pullRequestBody({ template, handover, run: gated ? run : undefined, issue });
    const title = agent.issue === null ? agent.name : `${shortIssueId(agent.issue)}: ${agent.issue.title}`;
    // The commit checked, whatever the branch has moved on to since; never forced, so a branch that has moved on
    // elsewhere is the user's to sort out.
    const pushed = await runGit(agent.worktree, ['push', 'origin', `${head}:refs/heads/${agent.branch}`]);
    if (!pushed.ok) throw invalidParams(`Could not push ${agent.branch}: ${pushed.stderr}`);
    // A commit pushed by its hash sets no upstream: set it, so the agent's own `git push` goes on to the same branch.
    const upstream = await runGit(agent.worktree, ['branch', `--set-upstream-to=origin/${agent.branch}`, agent.branch]);
    if (!upstream.ok) options.log(`could not set ${agent.branch}'s upstream: ${upstream.stderr}`);
    const url = await trackerCall(() =>
      createPullRequest({ ...gh, cwd: agent.worktree, repo: options.githubRepo(sessionId), head: agent.branch, title, body, draft }),
    );
    options.log(`opened ${url}${draft ? ' as a draft' : ''} for ${sessionId} on ${shortCommit(head)}`);
    await options.refreshPullRequests(sessionId);
    const made = options.pullRequests(sessionId).find((pr) => pr.url === url);
    return made ?? { number: pullRequestOfUrl(url)?.number ?? 0, title, url, state: draft ? 'draft' : 'open', checks: 'none' };
  };

  return {
    'gate.openPullRequest': (params) => openPullRequest(stringParam(paramsObject(params), 'sessionId'), { draft: false }),

    'board.openPullRequest': (params, connection) => {
      const who = boardCaller(options.callers, stringParam(paramsObject(params), 'token'), connection);
      // The agent's own session alone: a shell, a tab or an ended agent's shell is the user's, who has Open PR.
      if (who.side !== 'agent') throw invalidParams("only an agent opens a pull request this way, of its own branch, from its own session: the user has Open PR");
      return openPullRequest(who.tileId, { draft: true });
    },

    'gate.merge': async (params) => {
      const fields = paramsObject(params);
      const sessionId = stringParam(fields, 'sessionId');
      const number = fields.number;
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) throw invalidParams('number must be a positive whole number');
      const headCommit = stringParam(fields, 'headCommit');
      if (!/^[0-9a-f]{40}$/.test(headCommit)) throw invalidParams('headCommit must be a full commit hash');
      const cleanup = cleanupParam(fields);
      const agent = requireAgent(sessionId);
      const pr = options.pullRequests(sessionId).find((each) => each.number === number);
      const ref = pr === undefined ? undefined : pullRequestOfUrl(pr.url);
      if (ref === undefined) throw invalidParams(`#${number} is not one of ${agent.name}'s pull requests on GitHub.`);
      const details = await trackerCall(() => pullRequestDetails(ref, { ...gh, cwd: agent.worktree }));
      if (details.headCommit !== headCommit) {
        throw invalidParams(`#${number} has moved on to ${shortCommit(details.headCommit)} since ${shortCommit(headCommit)}, the commit shown: look again.`);
      }
      const command = options.gates.command(sessionId);
      const run = options.gates.get(sessionId);
      const blocked = mergeBlocked({ run, pr: details, gated: command !== null });
      if (blocked !== undefined) throw invalidParams(blocked);
      await trackerCall(() => mergePullRequest(number, { ...gh, cwd: agent.worktree, repo: ref.repo, headCommit }));
      options.log(`merged ${ref.repo}#${number} of ${sessionId} at ${shortCommit(headCommit)}`);
      await options.refreshPullRequests(sessionId).catch(() => {});

      // Merged: from here on, a step that fails is said, never thrown.
      const merged: GateMerged = { done: [], failed: [] };
      const fail = (step: keyof GateCleanup, why: string) => merged.failed.push({ step, why });
      const step = async (name: keyof GateCleanup, action: () => Promise<void>) => {
        try {
          await action();
          merged.done.push(name);
        } catch (error) {
          fail(name, (error as Error).message);
        }
      };
      const { issue } = agent;
      if (cleanup.comment) {
        await step('comment', async () => {
          if (issue === null) throw new Error(`${agent.name} has no linked issue`);
          const gate = command === null || run === undefined ? '' : `, after the gate \`${run.command}\` passed on \`${shortCommit(headCommit)}\``;
          await options.comment(issue, `Merged in ${details.url}${gate}.`);
        });
      }
      // Its worktree and branch go only while they hold nothing but what was merged: the agent may have gone on after the
      // pull request was opened, and a squash merge leaves its commits on no other branch, so nothing else would keep them.
      const kept = cleanup.worktree ? await whyKept(agent, headCommit) : undefined;
      const removeWorktree = cleanup.worktree && kept === undefined;
      const removeBranch = cleanup.branch && removeWorktree;
      if (cleanup.close) await step('close', () => options.deleteAgent(sessionId, { worktree: !removeWorktree, branch: !removeBranch }));
      const closed = merged.done.includes('close');
      if (cleanup.worktree) {
        if (kept !== undefined) fail('worktree', kept);
        else if (closed) merged.done.push('worktree');
        else fail('worktree', `${agent.name} could not be closed`);
      }
      // On GitHub last, and only once it has gone here: a branch is never deleted while its worktree stays.
      if (cleanup.branch) {
        if (!removeBranch || !closed) fail('branch', kept ?? `${agent.name} could not be closed`);
        else await step('branch', () => trackerCall(() => deleteRemoteBranch(ref.repo, agent.branch, gh)));
      }
      return merged;
    },
  };

  /** Why the agent's worktree and branch must stay after merging `headCommit`, or undefined when they hold nothing else. */
  async function whyKept(agent: Agent, headCommit: string): Promise<string | undefined> {
    if (!agent.ownsWorktree) return 'it works in a folder of yours, which is left as it is';
    let now;
    try {
      now = await options.gates.worktreeState(agent.sessionId);
    } catch (error) {
      return `could not read its worktree, so it is kept: ${(error as Error).message}`;
    }
    if (now.head !== headCommit) return `its worktree has moved on to ${now.head === null ? 'no commit' : shortCommit(now.head)} since the merged ${shortCommit(headCommit)}, so it is kept, with its branch`;
    if (now.uncommitted > 0) return `its worktree has ${now.uncommitted} uncommitted file${now.uncommitted === 1 ? '' : 's'}, so it is kept, with its branch`;
    if (now.branch !== agent.branch) return `its worktree is on ${now.branch ?? 'no branch'}, not ${agent.branch}, so it is kept`;
    return undefined;
  }
}
