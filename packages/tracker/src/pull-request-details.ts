// One pull request read whole for its PR tab: its description, checks, changed files with their diffs,
// reviews and comments, and whether the user may merge or approve it, through the user's own `gh` login.
import { runGh, type GhOptions } from './gh.ts';
import { TrackerError } from './tracker.ts';
import type { PullRequestRef } from './pull-request-ref.ts';
import { checksState, pullRequestState, type ChecksState, type PullRequestState } from './pull-requests.ts';


/** One check of a pull request: a check run, or a commit status. */
export interface PullRequestCheck {
  name: string;
  state: 'passing' | 'failing' | 'pending' | 'skipped';
  /** Its page, when GitHub gives an https one. */
  url?: string;
}

export interface PullRequestFile {
  path: string;
  /** Its path before, for a renamed file. */
  previousPath?: string;
  /** As GitHub says: `added`, `removed`, `modified`, `renamed`, `copied`, `changed` or `unchanged`. */
  status: string;
  additions: number;
  deletions: number;
  /** Its unified diff's hunks; absent for a binary file, or one GitHub or the app finds too large to show. */
  patch?: string;
  /** Set when the app left its diff out for its size. */
  patchTooLarge?: true;
}

export interface PullRequestReview {
  author: string;
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` or `DISMISSED`. */
  state: string;
  body: string;
  at: string;
}

/** A comment on its conversation, or, with `path`, on a line of its diff. */
export interface PullRequestComment {
  author: string;
  body: string;
  at: string;
  path?: string;
  line?: number;
}

/** Whether the user may do something to a pull request, and if not, why. */
export type Allowed = { allowed: true } | { allowed: false; why: string };

/** A pull request as its PR tab shows it. */
export interface PullRequestDetails extends PullRequestRef {
  title: string;
  /** Its description, as Markdown. */
  body: string;
  url: string;
  state: PullRequestState;
  author: string;
  /** Whether the gh user opened it: one of theirs, which they may merge but not approve. */
  byViewer: boolean;
  headRefName: string;
  baseRefName: string;
  /** The commit its head is at: all a merge from this view may take. */
  headCommit: string;
  checks: PullRequestCheck[];
  checksState: ChecksState;
  files: PullRequestFile[];
  /** How many of its files `files` holds: GitHub gives at most `MAX_FILES` at once. */
  filesShown: number;
  changedFiles: number;
  additions: number;
  deletions: number;
  /** Its reviews, oldest first. */
  reviews: PullRequestReview[];
  /** Its comments, on its conversation and on lines of its diff, oldest first. */
  comments: PullRequestComment[];
  merge: Allowed;
  approve: Allowed;
  /**
   * Set by agent-board's daemon, not GitHub: the agent whose pull request this is, in a zone with a merge gate.
   */
  gatedBy?: string;
  /** Set with `gatedBy` while its gate hasn't passed on the head: why. Merging then asks the user to go past it. */
  gateBlocked?: string;
}

/** What `allowedActions` decides from. */
export interface ActionFacts {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  author: string;
  mergeable: string;
  mergeStateStatus: string;
  /** The gh user's login. */
  viewer: string;
  /** The gh user's permission in the repo: `ADMIN`, `MAINTAIN`, `WRITE`, `TRIAGE` or `READ`. */
  permission: string;
  /** Whether the repo allows squash merges, the only merge the tab makes. */
  squashMergeAllowed: boolean;
}

/** Permissions that may merge. */
const CAN_MERGE = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

/** Merge states in which GitHub's own Merge button is enabled. */
const MERGEABLE_STATES = new Set(['CLEAN', 'HAS_HOOKS', 'UNSTABLE']);

/**
 * Whether GitHub lets the gh user merge and approve the pull request: squash-merge an open, non-draft one that merges
 * cleanly and nothing blocks, in a repo they can write to that allows squash merges; approve an open, non-draft one that
 * isn't their own.
 */
export function allowedActions(facts: ActionFacts): { merge: Allowed; approve: Allowed } {
  const not = (why: string): Allowed => ({ allowed: false, why });
  const shut = facts.state === 'MERGED' ? not('It is merged.') : facts.state === 'CLOSED' ? not('It is closed.') : facts.isDraft ? not('It is a draft.') : undefined;
  const approve = shut ?? (facts.author === facts.viewer ? not("You can't approve your own pull request.") : { allowed: true as const });
  if (shut !== undefined) return { merge: shut, approve };
  const merge = !CAN_MERGE.has(facts.permission)
    ? not("You can't merge in this repo.")
    : !facts.squashMergeAllowed
      ? not("This repo doesn't allow squash merges.")
      : facts.mergeable === 'CONFLICTING' || facts.mergeStateStatus === 'DIRTY'
      ? not('It has conflicts with its base.')
      : facts.mergeable === 'UNKNOWN' || facts.mergeStateStatus === 'UNKNOWN'
        ? not('GitHub is still checking whether it can be merged.')
        : facts.mergeStateStatus === 'BLOCKED'
          ? not('GitHub blocks merging it until its required reviews and checks pass.')
          : facts.mergeStateStatus === 'BEHIND'
            ? not('Its branch is behind its base.')
            : MERGEABLE_STATES.has(facts.mergeStateStatus)
              ? { allowed: true as const }
              : not(`GitHub won't merge it now (${facts.mergeStateStatus.toLowerCase()}).`);
  return { merge, approve };
}

/** At most this many files, and review comments, are read: one page of GitHub's. */
const MAX_FILES = 100;

/** A file's diff longer than this is left out. */
const MAX_PATCH_LENGTH = 200_000;

/** Once the diffs shown add up to this, the rest are left out. */
const MAX_PATCHES_LENGTH = 2_000_000;

interface GhPullRequestView {
  number: number;
  title: string;
  body: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  author: { login: string } | null;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  statusCheckRollup: Record<string, unknown>[] | null;
  mergeable: string;
  mergeStateStatus: string;
  reviews: { author: { login: string } | null; state: string; body: string; submittedAt: string }[];
  comments: { author: { login: string } | null; body: string; createdAt: string }[];
  changedFiles: number;
  additions: number;
  deletions: number;
}

interface RestFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface RestReviewComment {
  user: { login: string } | null;
  path: string;
  line: number | null;
  body: string;
  created_at: string;
}

const VIEW_FIELDS = [
  ...['number', 'title', 'body', 'url', 'state', 'isDraft', 'author', 'headRefName', 'baseRefName', 'headRefOid'],
  ...['statusCheckRollup', 'mergeable', 'mergeStateStatus', 'reviews', 'comments', 'changedFiles', 'additions', 'deletions'],
].join(',');

/** A deleted account's login, as GitHub shows it. */
const GHOST = 'ghost';

/**
 * Reads the pull request whole through the user's own `gh` login: five calls at once, each naming the repo. Failures
 * are `TrackerError`s, GitHub's rate limit among them (`unavailable`).
 */
export async function pullRequestDetails(ref: PullRequestRef, options: GhOptions & { cwd?: string } = {}): Promise<PullRequestDetails> {
  const json = async <T>(args: string[]) => JSON.parse(await runGh(args, options)) as T;
  const pulls = `repos/${ref.repo}/pulls/${ref.number}`;
  const [view, files, inline, { viewerPermission, squashMergeAllowed }, { login }] = await firstFailure([
    json<GhPullRequestView>(['pr', 'view', String(ref.number), '--repo', ref.repo, '--json', VIEW_FIELDS]),
    json<RestFile[]>(['api', `${pulls}/files?per_page=${MAX_FILES}`]),
    json<RestReviewComment[]>(['api', `${pulls}/comments?per_page=${MAX_FILES}`]),
    json<{ viewerPermission: string; squashMergeAllowed: boolean }>(['repo', 'view', ref.repo, '--json', 'viewerPermission,squashMergeAllowed']),
    json<{ login: string }>(['api', 'user']),
  ] as const);
  const author = view.author?.login ?? GHOST;
  const rollup = view.statusCheckRollup ?? [];
  const comments: PullRequestComment[] = [
    ...view.comments.map((comment) => ({ author: comment.author?.login ?? GHOST, body: comment.body, at: comment.createdAt })),
    ...inline.map((comment) => ({
      author: comment.user?.login ?? GHOST,
      body: comment.body,
      at: comment.created_at,
      path: comment.path,
      ...(comment.line === null ? {} : { line: comment.line }),
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return {
    repo: ref.repo,
    number: view.number,
    title: view.title,
    body: view.body,
    url: view.url,
    state: pullRequestState(view),
    author,
    byViewer: author === login,
    headRefName: view.headRefName,
    baseRefName: view.baseRefName,
    headCommit: view.headRefOid,
    checks: rollup.map(checkOf),
    checksState: checksState(rollup),
    files: filesOf(files),
    filesShown: files.length,
    changedFiles: view.changedFiles,
    additions: view.additions,
    deletions: view.deletions,
    reviews: view.reviews
      .filter((review) => review.state !== 'PENDING')
      .map((review) => ({ author: review.author?.login ?? GHOST, state: review.state, body: review.body, at: review.submittedAt })),
    comments,
    ...allowedActions({ ...view, author, viewer: login, permission: viewerPermission, squashMergeAllowed }),
  };
}

/**
 * Waits for every call, then fails with the first in order to fail, if any: the pull request's own (an unknown number)
 * says more than the others' 404s.
 */
async function firstFailure<T extends readonly unknown[]>(calls: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
  const settled = await Promise.allSettled(calls);
  const failed = settled.find((result) => result.status === 'rejected');
  if (failed !== undefined) throw failed.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}

/** The files as shown: each diff kept while it, and all of them together, stay small enough to show. */
function filesOf(files: readonly RestFile[]): PullRequestFile[] {
  let budget = MAX_PATCHES_LENGTH;
  return files.map((file) => {
    const shown: PullRequestFile = {
      path: file.filename,
      ...(file.previous_filename === undefined ? {} : { previousPath: file.previous_filename }),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    };
    if (file.patch === undefined) return shown;
    if (file.patch.length > MAX_PATCH_LENGTH || file.patch.length > budget) return { ...shown, patchTooLarge: true };
    budget -= file.patch.length;
    return { ...shown, patch: file.patch };
  });
}

/** Conclusions of a finished check run that count as neither passing nor failing. */
const SKIPPED_CONCLUSIONS = new Set(['SKIPPED', 'NEUTRAL', 'STALE']);

/** One check of a `statusCheckRollup`, as `checksState` counts it. */
function checkOf(check: Record<string, unknown>): PullRequestCheck {
  const status = check.__typename === 'StatusContext';
  const name = String((status ? check.context : check.name) ?? 'check');
  const link = String((status ? check.targetUrl : check.detailsUrl) ?? '');
  const state = SKIPPED_CONCLUSIONS.has(String(check.conclusion)) ? 'skipped' : checksState([check]);
  return { name, state: state === 'none' ? 'passing' : state, ...(link.startsWith('https://') ? { url: link } : {}) };
}

/**
 * Approves the pull request as the gh user at `headCommit`, the commit they saw: refused, as a `TrackerError`, if its
 * head has moved on since, so an approval never covers code they didn't see. GitHub's own refusals, such as of one
 * that is their own, are `TrackerError`s too.
 */
export async function approvePullRequest(ref: PullRequestRef, headCommit: string, options: GhOptions & { cwd?: string } = {}): Promise<void> {
  const { headRefOid } = JSON.parse(await runGh(['pr', 'view', String(ref.number), '--repo', ref.repo, '--json', 'headRefOid'], options)) as { headRefOid: string };
  if (headRefOid !== headCommit) {
    throw new TrackerError('rejected', `${ref.repo}#${ref.number} has moved on to ${headRefOid.slice(0, 7)} since ${headCommit.slice(0, 7)}, the commit shown: read it again`);
  }
  // `gh pr review` can't name a commit; the REST API pins the review to it.
  const reviews = `repos/${ref.repo}/pulls/${ref.number}/reviews`;
  await runGh(['api', reviews, '-X', 'POST', '-f', 'event=APPROVE', '-f', `commit_id=${headCommit}`], options);
}
