import { useState, type FormEvent } from 'react';
import { shortIssueId, type Agent, type Zone } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { HARNESSES } from '../harness';
import { Button, Checkbox, Dialog, ErrorText, Field, Fieldset, Hint, Input, Kbd, Select, Textarea } from '../ui';
import { AgentSetupChips, DEFAULT_SETUP, reviews, roleNote, type AgentSetup } from './AgentSetup';
import { bypassNoticeSeen, CodexBypassExplanation, markBypassNoticeSeen } from './codex-notice';
import { NEW_AGENT_SIZE } from '@agent-board/daemon/board-layout';
import { IssuePicker, type PickedIssue } from './IssuePicker';
import { reviewable, reviewSpawn } from './review-target';
import { repoName } from './tiles';

interface NewAgentDialogProps {
  zone: Zone;
  /** The agents on the board: a reviewer reviews the branch of one of its zone's repo. */
  agents: readonly Agent[];
  /** The issue to start from, picked already (from an issue card). */
  issue?: PickedIssue;
  /** Its name, filled in already (from ⌘K). */
  name?: string;
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
 * Asks for a new agent's task and name (optional), with its harness, model and role in the footer's chips
 * (BJ3), then starts it in the zone. A reviewer picks the agent whose branch it reviews. In a zone with a
 * tracker it can start from an issue instead: the issue becomes its prompt (the task, if any, follows it) and names
 * its branch. The zone's Codex setting is saved only when a Codex agent starts, so Cancel leaves it as it was.
 */
export function NewAgentDialog({ zone, agents, issue: initialIssue, name: initialName = '', onStarted, onCancel, onZoneChanged }: NewAgentDialogProps) {
  const [setup, setSetup] = useState<AgentSetup>(DEFAULT_SETUP);
  const { harness, model, role } = setup;
  const candidates = reviewable(zone, agents);
  /** The agent whose branch a reviewer reviews, by session id: '' for the zone's repo's checked-out branch. */
  const [reviewed, setReviewed] = useState(candidates[0]?.sessionId ?? '');
  /** A group with no default repo has no checked-out branch of its own to review. */
  const ownBranch = zone.repoRoot !== null || zone.defaultRepo !== null;
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState(initialName);
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
        model: model || undefined,
        role: role ?? undefined,
        ...(reviews(role) ? reviewSpawn(zone, candidates.find((agent) => agent.sessionId === reviewed)) : {}),
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
      footerStart={<AgentSetupChips setup={setup} onChange={setSetup} />}
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
      {reviews(role) && (
        <Field label="Reviews">
          <Select value={reviewed} onChange={(event) => setReviewed(event.target.value)}>
            {candidates.map((agent) => (
              <option key={agent.sessionId} value={agent.sessionId}>
                {agent.name} · {agent.branch}
                {agent.repoRoot === zone.repoRoot ? '' : ` (${repoName(agent.repoRoot)})`}
              </option>
            ))}
            {ownBranch && <option value="">The repo&apos;s checked-out branch</option>}
          </Select>
        </Field>
      )}
      {role !== null && (
        <Hint>
          {roleNote(role, `${zone.name}'s`)}
          {reviews(role) && ' It starts on a detached checkout of that branch, in a worktree of its own.'}
        </Hint>
      )}
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
