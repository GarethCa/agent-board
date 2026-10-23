import { useState } from 'react';
import { HARNESSES as HARNESS_IDS, type Agent, type AgentState, type ClockData, type ClockResult, type ClockRun, type ClockStatus } from '@agent-board/daemon/protocol';
import { Button, Checkbox, Dialog, ErrorText, Field, Fieldset, Hint, Input, Segmented, Select, StatusPill, Switch, Textarea } from '../ui';
import { HARNESSES } from '../harness';
import { useAction } from '../use-action';
import { CLOCK_PRESETS, clockData, presetCron, type ClockPreset } from './clocks';
import { previewCron, whenLabel } from './schedule';

/** What the editor edits: a clock on the board, or a new one for an agent, made beside its tile when saved. */
export type ClockEditing = { clockId: string; data: Record<string, unknown> } | { agent: Agent };

interface ClockDialogProps {
  editing: ClockEditing;
  status: ClockStatus | undefined;
  /** The agents a clock may message or hand a result to. */
  agents: readonly Agent[];
  /** Saves a change to the clock on the board. */
  onUpdate(id: string, data: Partial<ClockData>): void;
  onDelete(id: string): void;
  onClose(): void;
}

const RESULTS: { id: ClockResult; label: string }[] = [
  { id: 'history', label: 'History' },
  { id: 'note', label: 'History + note' },
  { id: 'handoff', label: 'Hand-off…' },
];

/** How a run's pill reads, in an agent state's colours. */
const RUN_PILLS: Record<ClockRun['outcome'], { state: AgentState; label: string }> = {
  started: { state: 'done', label: 'sent' },
  done: { state: 'done', label: 'done' },
  running: { state: 'running', label: 'running' },
  failed: { state: 'failed', label: 'failed' },
  skipped: { state: 'stopped-by-restart', label: 'skipped' },
};

/** How long a run took, briefly: `11 min`, `40 s`. */
function took(run: ClockRun): string {
  const end = run.finishedAt === null ? undefined : Date.parse(run.finishedAt);
  if (end === undefined) return '–';
  const seconds = Math.max(0, Math.round((end - Date.parse(run.firedAt)) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/**
 * A clock's editor: when it fires (a preset or a cron expression, with its next runs), what it does (messages an
 * agent, or starts a fresh one with a harness, role, model and task, closing it when it finishes), where a fresh
 * agent's result goes, whether it is on, and its runs.
 */
export function ClockDialog({ editing, status, agents, onUpdate, onDelete, onClose }: ClockDialogProps) {
  const existing = 'clockId' in editing ? { id: editing.clockId, data: editing.data } : undefined;
  const [clock, setClock] = useState<ClockData>(() =>
    existing !== undefined ? clockData(existing.data) : { ...clockData({}), agent: (editing as { agent: Agent }).agent.sessionId, prompt: (editing as { agent: Agent }).agent.description },
  );
  const { busy, error, run } = useAction();
  const now = new Date();
  const preview = previewCron(clock.cron, now);
  const change = (patch: Partial<ClockData>) => setClock((current) => ({ ...current, ...patch }));
  const fresh = clock.does === 'fresh';
  const lacking =
    'error' in preview ||
    clock.prompt.trim() === '' ||
    (!fresh && clock.agent === null) ||
    (fresh && clock.result === 'handoff' && clock.handoffTo === null);

  const save = () => {
    const data = { ...clock, cron: clock.cron.trim(), prompt: clock.prompt.trim() };
    if (existing !== undefined) {
      onUpdate(existing.id, data);
      onClose();
      return;
    }
    run(() => window.agentBoard.items.addClock(data, { beside: (editing as { agent: Agent }).agent.sessionId }), onClose);
  };

  const agentSelect = (value: string | null, label: string, onChange: (sessionId: string | null) => void) => (
    <Select aria-label={label} value={value ?? ''} onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}>
      <option value="">Pick an agent…</option>
      {agents.map((agent) => (
        <option key={agent.sessionId} value={agent.sessionId}>
          {agent.name}
        </option>
      ))}
      {value !== null && !agents.some((agent) => agent.sessionId === value) && <option value={value}>An agent no longer here</option>}
    </Select>
  );

  return (
    <Dialog
      aria-label="Clock"
      title={existing === undefined ? `Run ${(editing as { agent: Agent }).agent.name} on a schedule` : 'Clock'}
      onClose={onClose}
      footerStart={
        existing !== undefined && (
          <Button
            variant="danger"
            onClick={() => {
              onDelete(existing.id);
              onClose();
            }}
          >
            Delete
          </Button>
        )
      }
      footer={
        <>
          <Switch label="On" checked={clock.enabled} onChange={(event) => change({ enabled: event.target.checked })} />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={lacking} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <Fieldset legend="When">
        <Segmented
          aria-label="Preset"
          options={CLOCK_PRESETS.map((preset) => ({ ...preset }))}
          value={CLOCK_PRESETS.find((preset) => presetCron(preset.id, clock.cron) === clock.cron.trim())?.id ?? ('cron' as ClockPreset)}
          onChange={(preset) => change({ cron: presetCron(preset, clock.cron) })}
        />
        <Field
          label="Cron (minute hour day month weekday, or @daily, @hourly…)"
          hint={
            <span className="schedule-preview" data-testid="schedule-preview">
              {'error' in preview ? preview.error : `Next: ${preview.next.map((date) => whenLabel(date, now)).join(', ')}`}
            </span>
          }
        >
          <Input name="cron" value={clock.cron} spellCheck={false} autoFocus onChange={(event) => change({ cron: event.target.value })} />
        </Field>
      </Fieldset>
      <Fieldset legend="Does">
        <Segmented
          aria-label="Does"
          options={[
            { id: 'message', label: 'Message an agent' },
            { id: 'fresh', label: 'Start a fresh agent' },
          ]}
          value={clock.does}
          onChange={(does) => change({ does })}
        />
      </Fieldset>
      {fresh ? (
        <div className="clock-fresh">
          <Select aria-label="Harness" value={clock.fresh.harness} onChange={(event) => change({ fresh: { ...clock.fresh, harness: event.target.value as ClockData['fresh']['harness'] } })}>
            {HARNESS_IDS.map((harness) => (
              <option key={harness} value={harness}>
                {HARNESSES[harness].label}
              </option>
            ))}
          </Select>
          <Input aria-label="Role" placeholder="Role (default)" value={clock.fresh.role ?? ''} onChange={(event) => change({ fresh: { ...clock.fresh, role: event.target.value.trim() === '' ? null : event.target.value } })} />
          <Input aria-label="Model" placeholder="Model (default)" value={clock.fresh.model ?? ''} onChange={(event) => change({ fresh: { ...clock.fresh, model: event.target.value.trim() === '' ? null : event.target.value } })} />
        </div>
      ) : (
        <Field label="The agent it messages">{agentSelect(clock.agent, 'Agent', (agent) => change({ agent }))}</Field>
      )}
      <Field label={fresh ? 'Its task' : 'Each run sends it'}>
        <Textarea name="prompt" rows={3} value={clock.prompt} onChange={(event) => change({ prompt: event.target.value })} />
      </Field>
      {fresh && (
        <>
          <Checkbox label="Close it when it's finished" checked={clock.fresh.closeWhenDone} onChange={(event) => change({ fresh: { ...clock.fresh, closeWhenDone: event.target.checked } })} />
          <Fieldset legend="Result goes to">
            <Segmented aria-label="Result goes to" options={RESULTS} value={clock.result} onChange={(result) => change({ result })} />
          </Fieldset>
          {clock.result === 'handoff' && <Field label="Hand it to">{agentSelect(clock.handoffTo, 'Hand it to', (handoffTo) => change({ handoffTo }))}</Field>}
          <Hint>A fresh agent starts in the clock's zone, under it. Its run ends when its turn does, unless it ends asking you something.</Hint>
        </>
      )}
      {!fresh && (
        <Hint>
          A run starts when the agent sits at its prompt, relaunching it if its session has ended. It skips while the agent
          works, waits for you or you are typing to it.
        </Hint>
      )}
      {status !== undefined && status.runs.length > 0 && (
        <section className="clock-history" aria-label="Runs" data-testid="clock-history">
          {status.runs.map((each) => (
            <div key={each.id} className="clock-history-row">
              <StatusPill state={RUN_PILLS[each.outcome].state} label={RUN_PILLS[each.outcome].label} />
              <time dateTime={each.firedAt}>{whenLabel(new Date(each.firedAt), now)}</time>
              <span className="clock-history-took">{took(each)}</span>
              <span className="clock-history-what">
                {[each.agentName, each.result ?? each.reason].filter((part) => part !== null && part !== '').join(': ')}
              </span>
            </div>
          ))}
        </section>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </Dialog>
  );
}
