import { useEffect, useRef, useState } from 'react';
import type { Agent, ExternalResumePlan, ExternalResumeWhere, ExternalSession } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { Button, Dialog, ErrorText } from '../ui';
import { NEW_AGENT_SIZE } from './layout';
import { resumeChoices, resumeWarnings, type ResumeChoice } from './resume-external';

interface ResumeExternalDialogProps {
  session: ExternalSession;
  /** Where the board draws its tile, for one it slotted into its zone. */
  position: { x: number; y: number } | undefined;
  onResumed(agent: Agent): void;
  onClose(): void;
}

const CHOICE_LABELS: Record<ResumeChoice, string> = {
  here: 'Resume here',
  'new-worktree': 'Resume in a new worktree',
  folder: 'Choose a folder…',
};

/**
 * Asks before resuming an external session in agent-board as an agent: shows where it will work, warns if that is the
 * user's main checkout, if its folder is gone, or if it may still be running in another terminal, and offers a new
 * worktree in git. Cancel is first, so it has the focus.
 */
export function ResumeExternalDialog({ session, position, onResumed, onClose }: ResumeExternalDialogProps) {
  const [plan, setPlan] = useState<ExternalResumePlan>();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let current = true;
    window.agentBoard.external.resumePlan(session.id).then(
      (next) => current && setPlan(next),
      (error: unknown) => current && setProblem(`Could not check the session: ${errorMessage(error)}`),
    );
    return () => {
      current = false;
    };
  }, [session.id]);

  const resume = async (choice: ResumeChoice) => {
    if (plan === undefined) return;
    setProblem(undefined);
    let where: ExternalResumeWhere;
    if (choice === 'folder') {
      const folder = await window.agentBoard.zones.browseFolder(`Resume ${session.name} in`);
      if (folder === undefined) return;
      where = { folder };
    } else {
      where = choice;
    }
    setPending(true);
    try {
      // The user has seen the warning, if there was one, so a session that still looks live is resumed anyway.
      const result = await window.agentBoard.external.resume(session.id, where, { force: plan.liveElsewhere, position, ...NEW_AGENT_SIZE });
      // It started looking live since the plan: warn, back on Cancel so Enter can't resume it anyway, and only a
      // second click on the (now risky) resume does.
      if (result.status === 'live-elsewhere') {
        setPlan({ ...plan, liveElsewhere: true });
        cancel.current?.focus();
      } else {
        onResumed(result.agent);
      }
    } catch (error) {
      setProblem(`Could not resume it: ${errorMessage(error)}`);
    } finally {
      setPending(false);
    }
  };

  const choices = plan === undefined ? [] : resumeChoices(plan);
  return (
    <Dialog
      role="alertdialog"
      title={`Resume ${session.name} in agent-board?`}
      aria-label="Resume in agent-board?"
      onClose={onClose}
      data-testid="resume-external-dialog"
      footer={
        <>
          <Button ref={cancel} variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {choices.map((choice, index) => (
            <Button
              key={choice}
              // The last is the main answer; it is the risky one while the session may be running elsewhere.
              variant={index < choices.length - 1 ? 'secondary' : plan?.liveElsewhere ? 'danger' : 'primary'}
              disabled={pending}
              onClick={() => void resume(choice)}
            >
              {CHOICE_LABELS[choice]}
            </Button>
          ))}
        </>
      }
    >
      <p>
        It becomes an agent here, carrying on its {session.harness === 'claude' ? 'Claude' : 'Codex'} conversation in a terminal of its own, in{' '}
        <code className="resume-external-path">{session.cwd}</code>.
      </p>
      {plan === undefined && problem === undefined && <p className="resume-external-checking">Checking the session…</p>}
      {plan !== undefined &&
        resumeWarnings(plan).map((warning) => (
          <p key={warning} className="resume-external-warning" role="alert">
            {warning}
          </p>
        ))}
      {problem && <ErrorText>{problem}</ErrorText>}
    </Dialog>
  );
}
