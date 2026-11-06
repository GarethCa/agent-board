import { useEffect, useState } from 'react';
import { EFFORTS, type DaemonSettings, type Effort } from '@agent-board/daemon/protocol';
import { EFFORT_LABELS } from '../board/AgentSetup';
import { Field, Fieldset, Select } from '../ui';

type OnError = (action: string) => (error: unknown) => void;

/** The roles Settings gives a reasoning effort of their own, by the name an agent's role goes by. */
const ROLES = [
  { role: 'implementer', label: 'Implementers' },
  { role: 'reviewer', label: 'Reviewers' },
  { role: 'designer', label: 'Designers' },
] as const;

type Efforts = Pick<DaemonSettings, 'defaultEffort' | 'roleEfforts'>;

/**
 * The reasoning effort a new agent starts at when New agent, the CLI or an orchestrator asks for none: one for every new
 * agent, and one for each role over it. Default leaves it to the harness. Codex takes no Max: it gets Extra high.
 */
export function EffortSetting({ onError }: { onError: OnError }) {
  const [saved, setSaved] = useState<Efforts>();

  useEffect(() => {
    window.agentBoard.flowEdges.settings().then(setSaved, onError('read the reasoning settings'));
  }, [onError]);

  const save = (change: Partial<Efforts>) =>
    window.agentBoard.flowEdges.setSettings(change).then(setSaved, onError('change the reasoning settings'));

  const levels = EFFORTS.map((effort) => (
    <option key={effort} value={effort}>
      {EFFORT_LABELS[effort]}
    </option>
  ));

  const setRole = (role: string, value: string) => {
    if (saved === undefined) return;
    const others = Object.fromEntries(Object.entries(saved.roleEfforts).filter(([name]) => name !== role));
    void save({ roleEfforts: value === '' ? others : { ...others, [role]: value as Effort } });
  };

  return (
    <>
      <Field label="Reasoning for new agents" hint="When a new agent isn't given one. Higher levels think longer and use more of your plan's usage. Default leaves it to Claude Code or Codex; Codex has no Max, so it gets Extra high.">
        <Select
          size="sm"
          aria-label="Reasoning for new agents"
          value={saved?.defaultEffort ?? ''}
          disabled={saved === undefined}
          onChange={(event) => void save({ defaultEffort: event.target.value === '' ? null : (event.target.value as Effort) })}
        >
          <option value="">Default</option>
          {levels}
        </Select>
      </Field>
      <Fieldset legend="Reasoning per role">
        {ROLES.map(({ role, label }) => (
          <Field key={role} label={label} hint={role === 'designer' ? 'Agents in a custom role named designer.' : undefined}>
            <Select size="sm" aria-label={`Reasoning for ${label.toLowerCase()}`} value={saved?.roleEfforts[role] ?? ''} disabled={saved === undefined} onChange={(event) => setRole(role, event.target.value)}>
              <option value="">Same as new agents</option>
              {levels}
            </Select>
          </Field>
        ))}
      </Fieldset>
    </>
  );
}
