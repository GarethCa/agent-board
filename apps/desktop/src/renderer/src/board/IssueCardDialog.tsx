import { useState } from 'react';
import type { TrackerIssue, Zone } from '@agent-board/daemon/protocol';
import { Play } from 'lucide-react';
import { Button, Dialog, Hint } from '../ui';
import { IssuePicker } from './IssuePicker';

interface IssueCardDialogProps {
  zone: Zone;
  /** Why no agent can start in the zone now (unbound, cloning), or undefined if one can. */
  whyNoStart: string | undefined;
  /** Puts the issue's card in the zone: only while no agent can start in it. */
  onAddCard(issue: TrackerIssue): void;
  /** Puts the issue's card in the zone and starts an agent from it, fed by the card (R1). */
  onStartAgent(issue: TrackerIssue): void;
  onCancel(): void;
}

/**
 * Picks an issue from the zone's tracker (no bulk import, the zone starts empty) and starts an agent from it,
 * fed by the issue's card (R1). While the zone can't start agents (unbound, cloning), it puts only the card there.
 */
export function IssueCardDialog({ zone, whyNoStart, onAddCard, onStartAgent, onCancel }: IssueCardDialogProps) {
  const [issue, setIssue] = useState<TrackerIssue>();
  return (
    <Dialog
      aria-label="Add an issue"
      title={`An issue for ${zone.name}`}
      onClose={onCancel}
      onSubmit={(event) => {
        event.preventDefault();
        if (issue !== undefined && whyNoStart === undefined) onStartAgent(issue);
      }}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          {whyNoStart === undefined ? (
            <Button type="submit" variant="primary" icon={<Play />} disabled={issue === undefined}>
              Start agent
            </Button>
          ) : (
            // No agent can start here yet: the card waits in the zone, and starts one once the zone can.
            <Button variant="primary" disabled={issue === undefined} onClick={() => issue && onAddCard(issue)}>
              Add card
            </Button>
          )}
        </>
      }
    >
      <IssuePicker zone={zone} selected={issue} onSelect={setIssue} />
      {whyNoStart !== undefined && <Hint>No agent can start here yet ({whyNoStart}). Its card can wait in the zone meanwhile.</Hint>}
    </Dialog>
  );
}
