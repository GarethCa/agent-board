import { useState } from 'react';
import { Check, CircleDot, ExternalLink, GitMerge, GitPullRequest, Minus, RefreshCw, X } from 'lucide-react';
import type {
  PullRequestCheck,
  PullRequestComment,
  PullRequestDetails,
  PullRequestFile,
  PullRequestRef,
  PullRequestReview,
} from '@agent-board/daemon/protocol';
import { Button, Dialog, ErrorText } from '../ui';
import { shortWhen } from '../when';
import { Markdown } from './Markdown';
import { diffLines } from './pr-diff';
import { usePullRequest } from './use-pull-request';
import { pastGateWhy } from '@agent-board/daemon/gate-rules';

const openLink = (url: string) => void window.agentBoard.trackers.openLink(url).catch(() => {});

const STATE_LABELS: Record<PullRequestDetails['state'], string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };

const CHECK_ICONS: Record<PullRequestCheck['state'], typeof Check> = { passing: Check, failing: X, pending: CircleDot, skipped: Minus };

const REVIEW_LABELS: Record<string, string> = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'reviewed', DISMISSED: 'reviewed (dismissed)' };

/** A file's diff shorter than this shows open; a longer one is a click away, so the files after it stay in reach. */
const OPEN_DIFF_LENGTH = 20_000;

/** Which action waits for the user to say so. */
type Asking = 'approve' | 'merge';

/**
 * A PR tab: a GitHub pull request drawn by the app from what the daemon reads with gh, with no web content
 * loaded. Its description (Markdown, nothing in it loading or running, links to the OS browser), its checks, its
 * changed files each with its diff, and its reviews and comments. Read as it shows, as the app is focused, and by
 * Refresh; never on a timer. Approve and Merge show only when GitHub would allow them, and each asks first.
 */
export function PullRequestTab({ pr, visible }: { pr: PullRequestRef; visible: boolean }) {
  const state = usePullRequest(pr, visible);
  const [asking, setAsking] = useState<Asking>();
  const { details } = state;
  const answer = (confirmed: boolean) => {
    setAsking(undefined);
    if (confirmed && asking !== undefined) state.act(asking);
  };
  return (
    <div className="pr-view" data-testid="pr-view" aria-busy={state.busy}>
      <header className="pr-head">
        <div className="pr-title-row">
          <GitPullRequest aria-hidden className="pr-title-icon" />
          <h3 className="pr-title" data-testid="pr-title">
            {details?.title ?? `${pr.repo}#${pr.number}`}
            <span className="pr-number"> #{pr.number}</span>
          </h3>
        </div>
        <div className="pr-meta">
          {details !== undefined && (
            <>
              <span className="pr-state" data-state={details.state} data-testid="pr-state">
                {STATE_LABELS[details.state]}
              </span>
              <span>
                <b>{details.author}</b> wants to merge <code>{details.headRefName}</code> into <code>{details.baseRefName}</code>
              </span>
            </>
          )}
          <span className="pr-meta-end">
            <span className="pr-read" data-testid="pr-read">
              {state.busy ? 'Reading…' : state.readAt === undefined ? '' : `Read ${shortWhen(new Date(state.readAt).toISOString())}`}
            </span>
            <Button size="xs" variant="ghost" icon={<RefreshCw />} disabled={state.busy} onClick={state.refresh} data-testid="pr-refresh" tooltip="Read it from GitHub again">
              Refresh
            </Button>
            <Button size="xs" variant="ghost" icon={<ExternalLink />} onClick={() => openLink(details?.url ?? `https://github.com/${pr.repo}/pull/${pr.number}`)} tooltip="Open it in the browser">
              GitHub
            </Button>
          </span>
        </div>
        {state.error !== undefined && (
          <div data-testid="pr-error">
            <ErrorText className="pr-error">{state.error}</ErrorText>
          </div>
        )}
        {details !== undefined && <Actions details={details} busy={state.busy} onAsk={setAsking} />}
      </header>
      {details === undefined ? (
        <p className="pr-empty">{state.error === undefined ? 'Reading the pull request…' : 'Could not read the pull request.'}</p>
      ) : (
        <div className="pr-body">
          <section className="pr-section" aria-label="Description" data-testid="pr-description">
            {details.body.trim() === '' ? <p className="pr-quiet">No description.</p> : <Markdown text={details.body} onOpenLink={openLink} />}
          </section>
          <Checks checks={details.checks} />
          <Files details={details} />
          <Conversation reviews={details.reviews} comments={details.comments} />
        </div>
      )}
      {asking !== undefined && details !== undefined && <ConfirmDialog asking={asking} details={details} busy={state.busy} onAnswer={answer} />}
    </div>
  );
}

/**
 * Approve and Merge, each only while GitHub allows it; otherwise why not, quietly. A pull request a merge gate guards
 * (`gatedBy`) whose gate hasn't passed on its head says so, and its merge asks the user to go past it.
 */
function Actions({ details, busy, onAsk }: { details: PullRequestDetails; busy: boolean; onAsk(asking: Asking): void }) {
  // Why each can't be done, once each: a draft is why for both.
  const why = [
    ...new Set([
      ...[details.approve, details.merge].flatMap((allowed) => (allowed.allowed ? [] : [allowed.why])),
      ...(details.gatedBy !== undefined && details.gateBlocked !== undefined && details.merge.allowed ? [pastGateWhy(details.gatedBy, details.gateBlocked)] : []),
    ]),
  ];
  return (
    <div className="pr-actions">
      {details.approve.allowed && (
        <Button size="sm" icon={<Check />} disabled={busy} onClick={() => onAsk('approve')} data-testid="pr-approve">
          Approve
        </Button>
      )}
      {details.merge.allowed && (
        <Button size="sm" variant="primary" className="pr-merge" icon={<GitMerge />} disabled={busy} onClick={() => onAsk('merge')} data-testid="pr-merge">
          Squash and merge
        </Button>
      )}
      {why.length > 0 && (
        <span className="pr-quiet" data-testid="pr-not-allowed">
          {why.join(' ')}
        </span>
      )}
    </div>
  );
}

/** Asks before an approve or merge; it can't be confirmed while the pull request is being read or acted on. */
function ConfirmDialog({ asking, details, busy, onAnswer }: { asking: Asking; details: PullRequestDetails; busy: boolean; onAnswer(confirmed: boolean): void }) {
  const merge = asking === 'merge';
  const pastGate = merge && details.gateBlocked !== undefined;
  return (
    <Dialog
      role="alertdialog"
      title={merge ? `Merge #${details.number}?` : `Approve #${details.number}?`}
      onClose={() => onAnswer(false)}
      footer={
        <>
          <Button variant="ghost" onClick={() => onAnswer(false)}>
            Cancel
          </Button>
          <Button variant={pastGate ? 'danger' : 'primary'} disabled={busy} onClick={() => onAnswer(true)} data-testid="pr-confirm">
            {pastGate ? 'Merge past the gate' : merge ? 'Squash and merge' : 'Approve'}
          </Button>
        </>
      }
    >
      {pastGate && (
        <p className="pr-past-gate" data-testid="pr-past-gate">
          The gate hasn't passed on {details.headCommit.slice(0, 7)}, this pull request's head: {details.gateBlocked}
        </p>
      )}
      {merge
        ? `Squash-merges ${details.repo}#${details.number} into ${details.baseRefName} at ${details.headCommit.slice(0, 7)}, the commit shown here: if anything was pushed since, GitHub refuses.`
        : `Approves ${details.repo}#${details.number} on GitHub as your gh account, at ${details.headCommit.slice(0, 7)}, the commit shown here: if anything was pushed since, nothing is approved.`}
    </Dialog>
  );
}

function Checks({ checks }: { checks: readonly PullRequestCheck[] }) {
  return (
    <section className="pr-section" aria-label="Checks" data-testid="pr-checks">
      <h4 className="pr-section-head">Checks</h4>
      {checks.length === 0 ? (
        <p className="pr-quiet">No checks.</p>
      ) : (
        <ul className="pr-checks">
          {checks.map((check, index) => {
            const Icon = CHECK_ICONS[check.state];
            return (
              <li key={index} className="pr-check" data-state={check.state} data-testid="pr-check">
                <Icon aria-label={check.state} className="pr-check-icon" />
                {check.url === undefined ? (
                  <span>{check.name}</span>
                ) : (
                  <a
                    href={check.url}
                    title={check.url}
                    onClick={(event) => {
                      event.preventDefault();
                      openLink(check.url!);
                    }}
                  >
                    {check.name}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Files({ details }: { details: PullRequestDetails }) {
  const { files, filesShown, changedFiles, additions, deletions } = details;
  return (
    <section className="pr-section" aria-label="Files changed" data-testid="pr-files">
      <h4 className="pr-section-head">
        Files changed {changedFiles}
        <span className="pr-additions"> +{additions}</span>
        <span className="pr-deletions"> −{deletions}</span>
        {filesShown < changedFiles && <span className="pr-quiet"> · the first {filesShown} shown</span>}
      </h4>
      {files.map((file) => (
        <FileDiff key={file.path} file={file} />
      ))}
    </section>
  );
}

function FileDiff({ file }: { file: PullRequestFile }) {
  return (
    <details className="pr-file" data-testid="pr-file" open={file.patch !== undefined && file.patch.length < OPEN_DIFF_LENGTH}>
      <summary className="pr-file-head">
        <span className="pr-file-path">{file.previousPath === undefined ? file.path : `${file.previousPath} → ${file.path}`}</span>
        <span className="pr-additions">+{file.additions}</span>
        <span className="pr-deletions">−{file.deletions}</span>
      </summary>
      {file.patch === undefined ? (
        <p className="pr-quiet pr-file-note">{file.patchTooLarge ? 'Too large to show here: open it on GitHub.' : 'No diff to show (a binary file, or one GitHub won’t show).'}</p>
      ) : (
        <table className="pr-diff" data-testid="pr-diff">
          <tbody>
            {diffLines(file.patch).map((line, index) => (
              <tr key={index} data-kind={line.kind}>
                <td className="pr-diff-number">{'old' in line ? line.old : ''}</td>
                <td className="pr-diff-number">{'new' in line ? line.new : ''}</td>
                <td className="pr-diff-text">
                  {line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : line.kind === 'context' ? ' ' : ''}
                  {line.text}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}

/** Its reviews and comments, oldest first: a review's verdict as a line, a comment on a line of the diff with where. */
function Conversation({ reviews, comments }: { reviews: readonly PullRequestReview[]; comments: readonly PullRequestComment[] }) {
  const entries = [...reviews.map((review) => ({ review, at: review.at })), ...comments.map((comment) => ({ comment, at: comment.at }))].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <section className="pr-section" aria-label="Reviews and comments" data-testid="pr-conversation">
      <h4 className="pr-section-head">Reviews and comments</h4>
      {entries.length === 0 && <p className="pr-quiet">None yet.</p>}
      {entries.map((entry, index) =>
        'review' in entry ? (
          <article key={index} className="pr-comment" data-testid="pr-review" data-state={entry.review.state}>
            <div className="pr-comment-head">
              <b>{entry.review.author}</b> {REVIEW_LABELS[entry.review.state] ?? entry.review.state.toLowerCase()}
              <span className="pr-quiet"> · {shortWhen(entry.at)}</span>
            </div>
            {entry.review.body.trim() !== '' && <Markdown text={entry.review.body} onOpenLink={openLink} />}
          </article>
        ) : (
          <article key={index} className="pr-comment" data-testid="pr-comment">
            <div className="pr-comment-head">
              <b>{entry.comment.author}</b>
              {entry.comment.path !== undefined && (
                <code className="pr-comment-where">
                  {entry.comment.path}
                  {entry.comment.line === undefined ? '' : `:${entry.comment.line}`}
                </code>
              )}
              <span className="pr-quiet"> · {shortWhen(entry.at)}</span>
            </div>
            <Markdown text={entry.comment.body} onOpenLink={openLink} />
          </article>
        ),
      )}
    </section>
  );
}
