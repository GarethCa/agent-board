// What a PR tab asks of GitHub, through the user's own gh login: the daemon runs gh, so no GitHub token
// reaches the app, let alone its renderer. Only the user's app calls these; agents can't (`BOARD_CALLER_METHODS`).
// Merging a pull request a merge gate guards, before the gate passed on its head, takes the user's confirmation.
import { approvePullRequest, isGitHubRepo, mergePullRequest, pullRequestDetails, runGh, type PullRequestRef } from '@agent-board/tracker';
import type { DaemonMethods, PullRequestActed } from './protocol.ts';
import { pastGateWhy } from './gate-rules.ts';
import { invalidParams, optionalBooleanParam, paramsObject, stringParam } from './params.ts';
import type { RpcHandlers } from './rpc.ts';
import { call as trackerCall } from './trackers.ts';

export interface PullRequestTabOptions {
  /** The `gh` executable. */
  gh: string;
  /** Where gh runs: every call names its repo, so any folder that exists. */
  cwd: string;
  /** The pull request was merged or approved here: the agents whose pull request it is look again. */
  changed(ref: PullRequestRef): Promise<void>;
  /**
   * The agent whose pull request it is, by name, when its zone has a gate command, and why its gate doesn't
   * count for `headCommit` (`mergeGateBlocked`), undefined once it passed there. `headRefName`, the pull request's head
   * branch, finds it before its pull requests are read (`gatedOwner`, which fails closed). Undefined for any other pull
   * request.
   */
  gate(ref: PullRequestRef, headRefName: string | undefined, headCommit: string): { agent: string; blocked: string | undefined } | undefined;
}


type Methods = Pick<DaemonMethods, 'pullRequest.details' | 'pullRequest.approve' | 'pullRequest.merge'>;

/** The pull request the params name: a GitHub `owner/repo` and a positive whole number. */
function refParam(fields: Record<string, unknown>): PullRequestRef {
  const repo = stringParam(fields, 'repo');
  if (!isGitHubRepo(repo)) throw invalidParams(`repo must be a GitHub owner/repo, not ${JSON.stringify(repo)}`);
  const number = fields.number;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) throw invalidParams('number must be a positive whole number');
  return { repo, number };
}

/** The commit the user saw: a full hash. */
function headCommitParam(fields: Record<string, unknown>): string {
  const headCommit = stringParam(fields, 'headCommit');
  if (!/^[0-9a-f]{40}$/.test(headCommit)) throw invalidParams('headCommit must be a full commit hash');
  return headCommit;
}

export function pullRequestTabHandlers<Context>(options: PullRequestTabOptions): RpcHandlers<Methods, Context> {
  const gh = { gh: options.gh, cwd: options.cwd };
  /**
   * Runs an approve or merge, its failures as RPC errors; once it is done, tells the agents it is theirs and reads the
   * pull request again. A failure to read it again is said, not thrown: the action happened.
   */
  /** The pull request read whole, with the gate's say. */
  const details = async (ref: PullRequestRef) => {
    const read = await pullRequestDetails(ref, gh);
    const gate = options.gate(ref, read.headRefName, read.headCommit);
    return gate === undefined ? read : { ...read, gatedBy: gate.agent, ...(gate.blocked === undefined ? {} : { gateBlocked: gate.blocked }) };
  };
  const act = async (ref: PullRequestRef, action: () => Promise<void>): Promise<PullRequestActed> => {
    await trackerCall(action);
    await options.changed(ref);
    try {
      return { details: await details(ref) };
    } catch (error) {
      return { readError: (error as Error).message };
    }
  };
  return {
    'pullRequest.details': (params) => trackerCall(() => details(refParam(paramsObject(params)))),
    'pullRequest.approve': (params) => {
      const fields = paramsObject(params);
      const ref = refParam(fields);
      const headCommit = headCommitParam(fields);
      return act(ref, () => approvePullRequest(ref, headCommit, gh));
    },
    'pullRequest.merge': async (params) => {
      const fields = paramsObject(params);
      const ref = refParam(fields);
      const headCommit = headCommitParam(fields);
      const pastGate = optionalBooleanParam(fields, 'pastGate') ?? false;
      // Whatever a tab showed: a gated pull request whose gate hasn't passed on the commit merged goes past it only once
      // the user confirmed that. Its head branch is read first, so it is known whoever's pull requests haven't
      // been read yet.
      const head = await trackerCall(() => runGh(['pr', 'view', String(ref.number), '--repo', ref.repo, '--json', 'headRefName'], gh));
      const gate = options.gate(ref, (JSON.parse(head) as { headRefName?: string }).headRefName, headCommit);
      if (gate?.blocked !== undefined && !pastGate) throw invalidParams(pastGateWhy(gate.agent, gate.blocked));
      return act(ref, () => mergePullRequest(ref.number, { ...gh, repo: ref.repo, headCommit }));
    },
  };
}
