import { useState } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { Button, Checkbox, Dialog, ErrorText, Field, Hint, Input } from '../ui';
import { useAction } from '../use-action';
import { previewCron, whenLabel } from './schedule';

interface ScheduleDialogProps {
  agent: Agent;
  onSaved(agent: Agent): void;
  onCancel(): void;
}

/**
 * Makes an agent long-lived with a cron schedule, or changes or removes its schedule. Shows the next runs of the
 * expression as it is typed.
 */
export function ScheduleDialog({ agent, onSaved, onCancel }: ScheduleDialogProps) {
  const [cron, setCron] = useState(agent.schedule?.cron ?? '0 9 * * 1-5');
  const [prompt, setPrompt] = useState(agent.schedule?.prompt ?? agent.description);
  const [enabled, setEnabled] = useState(agent.schedule?.enabled ?? true);
  const { busy, error, run } = useAction();
  const now = new Date();
  const preview = previewCron(cron, now);

  const save = (remove: boolean) =>
    run(() => window.agentBoard.agents.setSchedule(agent.sessionId, remove ? null : { cron, prompt, enabled }), onSaved);

  return (
    <Dialog
      aria-label="Schedule"
      title={`Run ${agent.name} on a schedule`}
      onClose={onCancel}
      footerStart={
        agent.schedule !== null && (
          <Button variant="danger" disabled={busy} onClick={() => save(true)}>
            Remove schedule
          </Button>
        )
      }
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={'error' in preview || prompt.trim() === ''} onClick={() => save(false)}>
            Save
          </Button>
        </>
      }
    >
      <Field
        label="Cron schedule (minute hour day month weekday, or @daily, @hourly…)"
        hint={
          <span className="schedule-preview" data-testid="schedule-preview">
            {'error' in preview ? preview.error : `Next: ${preview.next.map((date) => whenLabel(date, now)).join(', ')}`}
          </span>
        }
      >
        <Input name="cron" value={cron} spellCheck={false} autoFocus onChange={(event) => setCron(event.target.value)} />
      </Field>
      <Field label="Each run sends it">
        <Input name="prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} />
      </Field>
      <Checkbox label="On" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
      <Hint>
        A run starts when it sits at its prompt, relaunching it if its session has ended. It skips while it works, waits for
        you or you are typing to it, and a run that needs you waits in the needs-you inbox.
      </Hint>
      {error && <ErrorText>{error}</ErrorText>}
    </Dialog>
  );
}
