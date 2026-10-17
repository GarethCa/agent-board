import { useCallback, useEffect, useState } from 'react';
import type { Agent, OrchestratorActivity } from '@agent-board/daemon/protocol';
import { Button, ErrorText } from '../ui';
import { errorMessage } from '../../../shared/errors';
import { shortWhen } from '../when';
import { activityText, mayHaveOlder, withLogged, withOlder } from './activity';

/** An orchestrator's lines of the activity log as read so far, and how to read older ones. */
export interface Activity {
  /** Newest first. */
  lines: readonly OrchestratorActivity[];
  /** Whether there may be older lines than these: the last page read was full. */
  older: boolean;
  /** Reads the page of lines older than these. */
  readOlder(): void;
  busy: boolean;
  error?: string;
}

/**
 * The orchestrator's lines of the activity log, newest first, as the daemon has them and adds to them, a page at a
 * time; none for no agent (a shell's window).
 */
export function useActivity(orchestratorId: string | undefined): Activity {
  const [lines, setLines] = useState<readonly OrchestratorActivity[]>([]);
  const [older, setOlder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Subscribed before the list: a line that crossed it is added again on top.
  useEffect(() => {
    let backlog: OrchestratorActivity[] | undefined = [];
    let cancelled = false;
    setLines([]);
    setOlder(false);
    setError(undefined);
    if (orchestratorId === undefined) return;
    const unsubscribe = window.agentBoard.orchestrators.onLogged(({ entry }) => {
      if (backlog !== undefined) backlog.push(entry);
      else setLines((current) => withLogged(current, orchestratorId, entry));
    });
    window.agentBoard.orchestrators.activity(orchestratorId).then(
      (listed) => {
        if (cancelled) return;
        setLines(backlog!.reduce((current, entry) => withLogged(current, orchestratorId, entry), listed as readonly OrchestratorActivity[]));
        setOlder(mayHaveOlder(listed.length));
        backlog = undefined;
      },
      (failure: unknown) => {
        if (cancelled) return;
        setError(`could not read its activity: ${errorMessage(failure)}`);
        backlog = undefined;
      },
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [orchestratorId]);
  const oldest = lines.at(-1)?.id;
  const readOlder = useCallback(() => {
    if (orchestratorId === undefined || oldest === undefined) return;
    setBusy(true);
    window.agentBoard.orchestrators
      .activity(orchestratorId, oldest)
      .then(
        (page) => {
          setLines((current) => withOlder(current, page));
          setOlder(mayHaveOlder(page.length));
          setError(undefined);
        },
        (failure: unknown) => setError(`could not read its older activity: ${errorMessage(failure)}`),
      )
      .finally(() => setBusy(false));
  }, [orchestratorId, oldest]);
  return { lines, older, readOlder, busy, error };
}

/**
 * The Activity tab of an orchestrator's session window: every agent it started, message it sent, and
 * agent it interrupted or closed, with times, and what it tried and was refused, with why; older pages on asking.
 * Reads and waits change nothing, so the daemon doesn't log them (ADR-0011).
 */
export function ActivityLog({ orchestrator, activity }: { orchestrator: Agent; activity: Activity }) {
  const { lines, older, readOlder, busy, error } = activity;
  return (
    <div className="activity-log" data-testid="activity-log">
      <h3 className="activity-log-head">
        {orchestrator.name} · Activity{' '}
        <span className="activity-log-count" data-testid="activity-count">
          {older ? `latest ${lines.length}` : lines.length}
        </span>
      </h3>
      {error !== undefined && <ErrorText>{error}</ErrorText>}
      {lines.length === 0 ? (
        <p className="activity-log-empty">Nothing yet. The agents it starts, messages, interrupts and closes show here, with the edges it makes and the hand-offs it sends, and anything it tries and is refused.</p>
      ) : (
        <ol className="activity-log-lines">
          {lines.map((line) => (
            <li key={line.id} className="activity-line" data-outcome={line.outcome} data-testid="activity-line">
              <time dateTime={line.at} title={new Date(line.at).toLocaleString()}>
                {shortWhen(line.at)}
              </time>
              <span className="activity-line-what">
                <span className="activity-line-text">{activityText(line)}</span>
                {line.detail !== '' && <span className="activity-line-detail">{line.detail}</span>}
                {line.outcome === 'refused' && <span className="activity-line-reason">Refused: {line.reason ?? 'no reason given'}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
      {older && (
        <Button size="sm" className="activity-log-older" disabled={busy} onClick={readOlder}>
          Show older
        </Button>
      )}
    </div>
  );
}
