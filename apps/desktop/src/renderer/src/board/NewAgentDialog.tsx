import { useState, type FormEvent } from 'react';
import { shortIssueId, type Agent, type Harness, type Zone } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { HARNESSES } from '../harness';
import { Button, Checkbox, Choice, Choices, Dialog, ErrorText, Field, Fieldset, Hint, Input, Kbd, Textarea } from '../ui';
import { bypassNoticeSeen, CodexBypassExplanation, markBypassNoticeSeen } from './codex-notice';
import { HarnessMark } from './HarnessMark';
import { NEW_AGENT_SIZE } from './layout';
import { IssuePicker, type PickedIssue } from './IssuePicker';


/** What each harness runs, under its name on the harness cards. */
const HARNESS_DETAILS: Record<Harness, string> = { claude: 'Claude Code CLI', codex: 'Codex CLI' };

interface NewAgentDialogProps {
  zone: Zone;
  /** The issue to start from, picked already (from an issue card). */
  issue?: PickedIssue;
  onStarted(agent: Agent): void;
  onCancel(): void;
  /** The zone's settings changed. */
  onZoneChanged(zone: Zone): void;
}

/**
 * What the dialog shows: the form; the one-time explanation of Codex's hook-trust bypass, before the first Codex
 * agent that would use it; or the daemon's warning that the new worktree has Codex config of its own.
 */
type Step = { kind: 'form' } | { kind: 'bypass-notice' } | { kind: 'project-config'; message: string };

/**
 * Asks for a new agent's harness (and optionally its task and name), then starts it in the zone. In a zone with a
 * tracker it can start from an issue instead: the issue becomes its prompt (the task, if any, follows it) and names
 * its branch. The zone's Codex setting is saved only when a Codex agent starts, so Cancel leaves it as it was.
 */
export function NewAgentDialog({ zone, issue: initialIssue, onStarted, onCancel, onZoneChanged }: NewAgentDialogProps) {
  const [harness, setHarness] = useState<Harness>('claude');
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [issue, setIssue] = useState<PickedIssue | undefined>(initialIssue);
  const [bypass, setBypass] = useState(zone.codexBypassHookTrust);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const [step, setStep] = useState<Step>({ kind: 'form' });

  const start = async (options: { allowProjectCodexConfig?: boolean; bypassNoticeShown?: boolean } = {}) => {
    setStep({ kind: 'form' });
    setStarting(true);
    setError(undefined);
    try {
      // The daemon reads the setting from the zone when it spawns.
      if (harness === 'codex' && bypass !== zone.codexBypassHookTrust) {
        onZoneChanged(await window.agentBoard.zones.configure(zone.id, { codexBypassHookTrust: bypass }));
      }
      const result = await window.agentBoard.agents.spawn({
        zoneId: zone.id,
        harness,
        prompt,
        name: name.trim() || undefined,
        issueId: issue?.id,
        allowProjectCodexConfig: options.allowProjectCodexConfig,
        ...NEW_AGENT_SIZE,
      });
      if (result.status === 'confirm') {
        setStarting(false);
        setStep({ kind: 'project-config', message: result.message });
        return;
      }
      if (options.bypassNoticeShown) markBypassNoticeSeen();
      onStarted(result.agent);
    } catch (failure) {
      setError(errorMessage(failure));
      setStarting(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (harness === 'codex' && bypass && !bypassNoticeSeen()) setStep({ kind: 'bypass-notice' });
    else void start();
  };

  const back = (
    <Button variant="ghost" onClick={() => setStep({ kind: 'form' })}>
      Back
    </Button>
  );

  if (step.kind === 'bypass-notice') {
    return (
      <Dialog
        aria-label="About Codex hooks"
        title="Codex agents skip hook review"
        onClose={onCancel}
        footer={
          <>
            {back}
            <Button variant="primary" autoFocus onClick={() => void start({ bypassNoticeShown: true })}>
              Start
            </Button>
          </>
        }
      >
        <CodexBypassExplanation />
        <p>
          To review agent-board&apos;s hooks once instead, turn off &ldquo;Skip Codex&apos;s hook review&rdquo; for the
          zone. Codex then asks in the agent&apos;s terminal, and until you trust its hooks the tile can&apos;t show
          what the agent is doing.
        </p>
      </Dialog>
    );
  }

  if (step.kind === 'project-config') {
    return (
      <Dialog
        role="alertdialog"
        aria-label="Codex config in this repo"
        title="This repo has its own Codex config"
        onClose={() => setStep({ kind: 'form' })}
        footer={
          <>
            {back}
            <Button variant="primary" onClick={() => void start({ allowProjectCodexConfig: true })}>
              Start anyway
            </Button>
          </>
        }
      >
        <p>{step.message}</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      aria-label="New agent"
      title={
        <>
          New {HARNESSES[harness].label} agent in <span className="new-agent-zone">{zone.name}</span>
        </>
      }
      onClose={onCancel}
      onSubmit={submit}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={starting}>
            {starting ? 'Starting…' : 'Start'}
            <Kbd aria-hidden>⌘⏎</Kbd>
          </Button>
        </>
      }
    >
      <Choices aria-label="Harness">
        {(['claude', 'codex'] as const).map((choice) => (
          <Choice
            key={choice}
            name="harness"
            label={HARNESSES[choice].label}
            detail={HARNESS_DETAILS[choice]}
            mark={<HarnessMark harness={choice} />}
            checked={harness === choice}
            onChange={() => setHarness(choice)}
          />
        ))}
      </Choices>
      {zone.tracker !== null && (
        <Fieldset legend="Start from an issue (optional)">
          <IssuePicker zone={zone} selected={issue} onSelect={setIssue} />
        </Fieldset>
      )}
      <Field label="Task">
        <Textarea
          rows={3}
          value={prompt}
          placeholder={issue === undefined ? 'Task (optional)… or type it in the terminal' : 'Task (optional, after the issue)…'}
          autoFocus={zone.tracker === null}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.currentTarget.form?.requestSubmit();
          }}
        />
      </Field>
      <Field label="Name (optional)">
        <Input
          value={name}
          placeholder={issue === undefined ? 'From the task' : `${shortIssueId(issue)}: ${issue.title}`}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      {harness === 'codex' && (
        <>
          <Checkbox label="Skip Codex's hook review in this zone" checked={bypass} onChange={(event) => setBypass(event.target.checked)} />
          {!bypass && (
            <Hint>
              Codex asks you to review agent-board&apos;s hooks in the agent&apos;s terminal. Until you trust them, the
              tile stays idle.
            </Hint>
          )}
        </>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </Dialog>
  );
}
