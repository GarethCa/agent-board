// What a ticket tile's watches read of its pull request: its reviews, conversation comments, approval and merge state
// and checks, in one `gh pr view` through the user's own login. Lean, as it is read every few minutes.
import { runGh, type GhOptions } from './gh.ts';
import { listOf, objectOf, parseJson } from './shape.ts';
import { pullRequestUrl, type PullRequestRef } from './pull-request-ref.ts';
import { checksState, pullRequestState, type ChecksState, type PullRequestState } from './pull-requests.ts';

/**
 * Who wrote a review or comment, whether GitHub marks them a bot (an app's account), and whether they are one of the
 * repo's own people (its owner, a member of its organization or a collaborator): anyone else may comment on a public
 * repo's pull request.
 */
export interface PullRequestAuthor {
  login: string;
  bot: boolean;
  trusted: boolean;
}

/** One submitted review. */
export interface PullRequestWatchReview extends PullRequestAuthor {
  /** `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED` or `DISMISSED`. */
  state: string;
  body: string;
  at: string;
}

/** One comment on its conversation. */
export interface PullRequestWatchComment extends PullRequestAuthor {
  body: string;
  at: string;
}

/** A pull request as a watch reads it. */
export interface PullRequestWatchFacts extends PullRequestRef {
  url: string;
  state: PullRequestState;
  /** Whether it merges cleanly, as GitHub says: `MERGEABLE`, `CONFLICTING` or `UNKNOWN`. */
  mergeable: string;
  /** GitHub's merge state: `CLEAN`, `BLOCKED`, `BEHIND`, `DIRTY`, `UNSTABLE`, `HAS_HOOKS` or `UNKNOWN`. */
  mergeStateStatus: string;
  /** What its reviews add up to under the repo's rules: `APPROVED`, `CHANGES_REQUESTED`, `REVIEW_REQUIRED`, or null. */
  reviewDecision: string | null;
  /** Its submitted reviews, oldest first. */
  reviews: PullRequestWatchReview[];
  /** Its conversation's comments, oldest first. */
  comments: PullRequestWatchComment[];
  checks: ChecksState;
  /** How many of its checks pass, of how many. */
  checksPassing: number;
  checksTotal: number;
}

const FIELDS = 'number,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,reviews,comments,statusCheckRollup';

/** A deleted account's login, as GitHub shows it. */
const GHOST = 'ghost';

/** The author associations of the repo's own people, as GitHub gives them. */
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/**
 * A review's or comment's author as gh gives one: `is_bot` set for an app, whose login may also end `[bot]` or start
 * `app/`, and the item's `authorAssociation` saying how they belong to the repo.
 */
function authorOf(item: Record<string, unknown>): PullRequestAuthor {
  const trusted = TRUSTED.has(item.authorAssociation as string);
  const author = item.author;
  if (author === null || typeof author !== 'object') return { login: GHOST, bot: false, trusted: false };
  const { login, is_bot: isBot } = author as { login?: unknown; is_bot?: unknown };
  const name = typeof login === 'string' && login !== '' ? login : GHOST;
  return { login: name, bot: isBot === true || name.endsWith('[bot]') || name.startsWith('app/'), trusted };
}

/**
 * Reads what pull request `ref` shows its watches now, through the user's own `gh` login, naming its repo. Failures are
 * `TrackerError`s, GitHub's rate limit among them.
 */
export async function pullRequestWatchFacts(ref: PullRequestRef, options: GhOptions & { cwd?: string } = {}): Promise<PullRequestWatchFacts> {
  const view = objectOf(
    parseJson(await runGh(['pr', 'view', String(ref.number), '--repo', ref.repo, '--json', FIELDS], options), 'GitHub'),
    'the pull request',
    'GitHub',
  );
  return watchFactsOf(ref, view);
}

/**
 * The facts in one `gh pr view --json` answer: exported for the recorded answers' tests. The pull request is `ref`, as
 * asked for, whatever number and URL the answer gives.
 */
export function watchFactsOf(ref: PullRequestRef, view: Record<string, unknown>): PullRequestWatchFacts {
  const reviews = listOf<Record<string, unknown>>(view.reviews ?? [], 'the reviews', 'GitHub');
  const comments = listOf<Record<string, unknown>>(view.comments ?? [], 'the comments', 'GitHub');
  const rollup = view.statusCheckRollup == null ? [] : listOf<Record<string, unknown>>(view.statusCheckRollup, 'the checks', 'GitHub');
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  return {
    repo: ref.repo,
    number: ref.number,
    url: pullRequestUrl(ref),
    state: pullRequestState({ state: view.state as 'OPEN' | 'CLOSED' | 'MERGED', isDraft: view.isDraft === true }),
    mergeable: text(view.mergeable) || 'UNKNOWN',
    mergeStateStatus: text(view.mergeStateStatus) || 'UNKNOWN',
    reviewDecision: text(view.reviewDecision) || null,
    reviews: reviews
      .filter((review) => review.state !== 'PENDING')
      .map((review) => ({ ...authorOf(review), state: text(review.state), body: text(review.body), at: text(review.submittedAt) })),
    comments: comments.map((comment) => ({ ...authorOf(comment), body: text(comment.body), at: text(comment.createdAt) })),
    checks: checksState(rollup),
    checksPassing: rollup.filter((check) => checksState([check]) === 'passing').length,
    checksTotal: rollup.length,
  };
}

/** The login of the user `gh` is signed in as: whose own reviews and comments are no news to them. */
export async function ghLogin(options: GhOptions = {}): Promise<string> {
  const user = objectOf(parseJson(await runGh(['api', 'user'], options), 'GitHub'), 'the GitHub user', 'GitHub');
  return typeof user.login === 'string' ? user.login : '';
}
