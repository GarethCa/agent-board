import { useState } from 'react';
import { Check, ChevronDown, CircleAlert, CircleCheck, FileCode, GitMerge, Play, Send } from 'lucide-react';
import type { Agent, ReviewRound } from '@agent-board/daemon/protocol';
import { mergeBlocked, openFindings, parseReviewDoc, SEVERITIES, startBlocked, type ReviewFinding, type Severity } from '@agent-board/daemon/review-doc';
import { MAX_REVIEW_CAP } from '@agent-board/daemon/protocol';
import { renderMarkdown } from '../board/items/StickyNode';
import { Button, ErrorText, Menu } from '../ui';
import { useAction } from '../use-action';
import { shortWhen } from '../when';

const SEVERITY_LABELS: Record<Severity, string> = { blocker: 'Blocker', major: 'Major', minor: 'Minor' };

/** What a round's rail entry says it came to. */
function outcome(round: ReviewRound): { label: string; tone: 'approve' | 'changes' | 'pending' | 'failed' } {
  if (round.status === 'reviewing') return { label: 'Reviewing…', tone: 'pending' };
  if (round.status === 'failed') return { label: 'No review', tone: 'failed' };
  const verdict = parseReviewDoc(round.doc!).verdict;
  if (verdict === 'approve') return { label: 'Approve', tone: 'approve' };
  if (verdict === 'changes-requested') return { label: 'Changes requested', tone: 'changes' };
  return { label: 'Review', tone: 'pending' };
}

interface ReviewViewerProps {
  implementer: Agent;
  /** Its rounds, first to last; at least one. */
  rounds: readonly ReviewRound[];
  /** Closes the Review tab, back to the terminal: its latest round was dismissed. */
  onDismissed(): void;
}

/**
 * The review doc viewer, a tab of the implementer's session window: the rounds
 * on the left, the picked round's doc in the middle (its verdict, and its findings by severity with file:line chips, or
 * the markdown as it is when not in the format), and what to do with it on the right.
 */
export function ReviewViewer({ implementer, rounds, onDismissed }: ReviewViewerProps) {
  const latest = rounds.at(-1)!;
  const [pickedId, setPickedId] = useState<string>();
  const round = rounds.find((known) => known.id === pickedId) ?? latest;
  const cap = useAction();
  return (
    <div className="review-viewer" data-testid="review-viewer">
      <nav className="review-rounds" aria-label="Rounds">
        <div className="review-label review-rounds-head">
          Rounds ·
          <Menu
            entries={Array.from({ length: MAX_REVIEW_CAP }, (_, index) => index + 1).map((to) => ({
              label: `${to} round${to === 1 ? '' : 's'}`,
              icon: to === implementer.reviewCap ? <Check /> : undefined,
              // Only rounds that left a review count against it.
              disabled: cap.busy || to < rounds.filter((known) => known.status === 'ready').length,
              onSelect: () => cap.run(() => window.agentBoard.reviews.setCap(implementer.sessionId, to)),
            }))}
          >
            <button type="button" className="review-cap" aria-label={`Cap: ${implementer.reviewCap} rounds`} data-testid="review-cap">
              cap {implementer.reviewCap}
              <ChevronDown aria-hidden />
            </button>
          </Menu>
        </div>
        {cap.error !== undefined && <ErrorText>{cap.error}</ErrorText>}
        {rounds.map((known) => {
          const { label, tone } = outcome(known);
          return (
            <button
              key={known.id}
              type="button"
              className="review-round"
              aria-current={known.id === round.id}
              data-testid="review-round"
              onClick={() => setPickedId(known.id)}
            >
              <b>Round {known.round}</b>
              <span className="review-round-verdict" data-tone={tone}>
                {label}
              </span>
              <span className="review-round-when">
                {shortWhen(known.finishedAt ?? known.createdAt)}
                {known.sentAt !== null && ' · sent'}
              </span>
            </button>
          );
        })}
      </nav>
      <ReviewDoc round={round} />
      <ReviewActions implementer={implementer} rounds={rounds} round={round} onDismissed={round.id === latest.id ? onDismissed : undefined} />
    </div>
  );
}

function ReviewDoc({ round }: { round: ReviewRound }) {
  if (round.status === 'reviewing') {
    return (
      <article className="review-doc" aria-label={`Round ${round.round}`}>
        <p className="review-meta">The reviewer is at work. Its review shows here once it has left it.</p>
      </article>
    );
  }
  if (round.doc === null) {
    return (
      <article className="review-doc" aria-label={`Round ${round.round}`}>
        <p className="review-meta">{round.failedBecause}</p>
      </article>
    );
  }
  const doc = parseReviewDoc(round.doc);
  const open = openFindings(doc);
  const left = SEVERITIES.filter((severity) => open[severity] > 0).map((severity) => `${open[severity]} ${severity}`);
  return (
    <article className="review-doc" aria-label={`Round ${round.round}`} data-testid="review-doc">
      {doc.title !== null && <h4>{doc.title}</h4>}
      <div className="review-meta">Round {round.round}</div>
      {doc.verdict !== null && (
        <div className="review-verdict" data-verdict={doc.verdict} data-testid="review-verdict">
          {doc.verdict === 'approve' ? <CircleCheck aria-hidden /> : <CircleAlert aria-hidden />}
          {doc.verdict === 'approve' ? 'Approve' : 'Changes requested'}
          <span className="review-verdict-count">{left.length === 0 ? 'nothing left' : `${left.join(' · ')} left`}</span>
        </div>
      )}
      {doc.findings.length === 0 ? (
        <div className="review-markdown">{renderMarkdown(round.doc, (url) => void window.agentBoard.trackers.openLink(url))}</div>
      ) : (
        SEVERITIES.map((severity) => {
          const findings = doc.findings.filter((finding) => finding.severity === severity);
          if (findings.length === 0) return null;
          const resolved = findings.length - open[severity];
          return (
            <section key={severity} className="review-group" data-severity={severity} aria-label={SEVERITY_LABELS[severity]}>
              <div className="review-group-head">
                <span className="review-group-count">{open[severity]}</span>
                {SEVERITY_LABELS[severity]}
                {resolved > 0 && <span className="review-group-resolved">{resolved} resolved</span>}
              </div>
              {findings.map((finding, index) => (
                <Finding key={index} finding={finding} />
              ))}
            </section>
          );
        })
      )}
    </article>
  );
}

function Finding({ finding }: { finding: ReviewFinding }) {
  const [copied, setCopied] = useState(false);
  const location = finding.location && `${finding.location.path}:${finding.location.line}`;
  return (
    <div className="review-finding" data-resolved={finding.resolved} data-testid="review-finding">
      <span className="review-finding-title">{finding.title}</span>
      {finding.detail !== '' && <span className="review-finding-detail">{finding.detail}</span>}
      {location !== null && (
        <button
          type="button"
          className="review-location"
          title={copied ? 'Copied' : `Copy ${location}`}
          onClick={() =>
            void navigator.clipboard.writeText(location).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          <FileCode aria-hidden />
          {location}
        </button>
      )}
    </div>
  );
}

interface ReviewActionsProps {
  implementer: Agent;
  rounds: readonly ReviewRound[];
  round: ReviewRound;
  /** Called once `round` is dismissed, if it is the latest. */
  onDismissed?(): void;
}

function ReviewActions({ implementer, rounds, round, onDismissed }: ReviewActionsProps) {
  const { busy, error, run } = useAction();
  const notStarted = startBlocked(implementer, rounds);
  const notMerged = mergeBlocked(implementer, rounds, round);
  const pr = implementer.pullRequests.find((known) => known.state === 'open');
  const merge = (
    <Button
      size="sm"
      variant={notMerged === undefined ? 'primary' : 'secondary'}
      className="review-approve"
      icon={<GitMerge />}
      disabled={busy || notMerged !== undefined}
      aria-describedby={notMerged === undefined ? undefined : 'review-merge-why'}
      onClick={() => run(() => window.agentBoard.reviews.merge(round.id))}
    >
      Approve and merge
    </Button>
  );
  return (
    <aside className="review-actions" aria-label="Review actions">
      <div className="review-label">Actions</div>
      {notMerged === undefined && merge}
      <Button
        size="sm"
        variant={notMerged === undefined ? 'secondary' : 'primary'}
        icon={<Send />}
        disabled={busy || round.doc === null}
        onClick={() => run(() => window.agentBoard.reviews.send(round.id))}
      >
        Send to implementer
      </Button>
      <Button
        size="sm"
        icon={<Play />}
        disabled={busy || notStarted !== undefined}
        tooltip={notStarted}
        onClick={() => run(() => window.agentBoard.reviews.start(implementer.sessionId))}
      >
        Start round {rounds.at(-1)!.round + 1}
      </Button>
      {notMerged !== undefined && (
        <>
          {merge}
          <span id="review-merge-why" className="review-meta">
            {notMerged}
          </span>
        </>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy || round.dismissedAt !== null}
        onClick={() => run(() => window.agentBoard.reviews.dismiss(round.id), onDismissed)}
      >
        Dismiss
      </Button>
      {error !== undefined && <ErrorText>{error}</ErrorText>}
      <div className="review-meta review-actions-foot">
        {notMerged === undefined && pr !== undefined ? (
          <>
            Squash-merges #{pr.number} at the commit this round reviewed{pr.checks === 'none' ? '; it has no checks' : ', its checks green'}.
          </>
        ) : (
          <>
            Goes to <b>{implementer.name}</b> as its next message.
          </>
        )}
      </div>
    </aside>
  );
}
