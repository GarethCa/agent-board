import { useState } from 'react';
import { shortIssueId, type Agent, type TrackerIssue, type Zone } from '@agent-board/daemon/protocol';
import { IssuePicker } from './IssuePicker';
import { Button, Dialog, ErrorText } from '../ui';
import { useAction } from '../use-action';

interface LinkIssueDialogProps {
  agent: Agent;
  /** The agent's zone, which has a tracker. */
  zone: Zone;
  onLinked(agent: Agent): void;
  onCancel(): void;
}

/** Links an agent to an issue in its zone's tracker, or unlinks it. Its branch stays as it is. */
export function LinkIssueDialog({ agent, zone, onLinked, onCancel }: LinkIssueDialogProps) {
  const [issue, setIssue] = useState<TrackerIssue>();
  const { busy, error, run } = useAction();

  const link = (issueId: string | null) => run(() => window.agentBoard.agents.link(agent.sessionId, issueId), onLinked);

  return (
    <Dialog
      aria-label="Link issue"
      title={`Link ${agent.name} to an issue`}
      onClose={onCancel}
      footerStart={
        agent.issue !== null && (
          <Button variant="danger" disabled={busy} onClick={() => link(null)}>
            Unlink
          </Button>
        )
      }
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={issue === undefined} onClick={() => issue && link(issue.id)}>
            Link
          </Button>
        </>
      }
    >
      {agent.issue !== null && (
        <p>
          Linked to {shortIssueId(agent.issue)}: {agent.issue.title}
        </p>
      )}
      <IssuePicker zone={zone} selected={issue} onSelect={setIssue} />
      {error && <ErrorText>{error}</ErrorText>}
    </Dialog>
  );
}
