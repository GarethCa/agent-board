import { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { AGENT_ROLES, REVIEWER_ROLES, type Agent, type AgentRole, type Harness } from '@agent-board/daemon/protocol';
import { shortCommit } from '@agent-board/daemon/gate-rules';
import { HARNESSES } from '../harness';
import { Button, Input, Menu, type MenuEntry } from '../ui';
import { HarnessMark } from './HarnessMark';

/** The models offered for each harness, besides its own default; any other can be typed (Other…). */
const MODELS: Record<Harness, string[]> = { claude: ['opus', 'sonnet', 'haiku'], codex: ['gpt-5-codex', 'gpt-5'] };

/** How each role reads in the app. */
export const ROLE_LABELS: Record<AgentRole, string> = {
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  'follow-up-reviewer': 'Follow-up reviewer',
  custom: 'Custom',
};

/** What a new agent starts with besides its task: its harness, its model ('' for the harness's default) and its role. */
export interface AgentSetup {
  harness: Harness;
  model: string;
  role: AgentRole | null;
}

export const DEFAULT_SETUP: AgentSetup = { harness: 'claude', model: '', role: null };

/** Whether an agent in `role` reviews a branch, on a detached checkout of it. */
export const reviews = (role: AgentRole | null): boolean => role !== null && REVIEWER_ROLES.includes(role);

/** A model as a chip or badge shows it: Claude's offered ones by name (`Opus`), any other id as it is. */
export function modelLabel(model: string): string {
  return MODELS.claude.includes(model) ? model[0]!.toUpperCase() + model.slice(1) : model;
}

/** A row of a chip's menu, ticked when it is the one picked. */
const choice = (label: string, picked: boolean, onSelect: () => void): MenuEntry => ({
  label,
  onSelect,
  icon: picked ? <Check aria-hidden /> : <span className="agent-setup-blank" aria-hidden />,
});

/**
 * The three chip menus always in New agent's footer (BJ3): harness ▾, model ▾ and role ▾, so what will start
 * is always on show. The model menu has Default, the harness's models, and Other… for a typed model id.
 */
export function AgentSetupChips({ setup, onChange }: { setup: AgentSetup; onChange(next: AgentSetup): void }) {
  const { harness, model, role } = setup;
  /** The model id being typed after Other…, or undefined while the chip shows. */
  const [typing, setTyping] = useState<string>();
  const set = (patch: Partial<AgentSetup>) => onChange({ ...setup, ...patch });
  const commitTyped = () => {
    if (typing !== undefined) set({ model: typing.trim() });
    setTyping(undefined);
  };

  const harnesses = (Object.keys(HARNESSES) as Harness[]).map((each) =>
    // Another harness's model means nothing to this one: back to its default.
    choice(HARNESSES[each].label, each === harness, () => each !== harness && set({ harness: each, model: '' })),
  );
  const offered = MODELS[harness];
  const models: MenuEntry[] = [
    choice('Default', model === '', () => set({ model: '' })),
    ...offered.map((each) => choice(modelLabel(each), model === each, () => set({ model: each }))),
    'separator',
    choice(model !== '' && !offered.includes(model) ? `Other: ${model}` : 'Other…', model !== '' && !offered.includes(model), () =>
      setTyping(offered.includes(model) ? '' : model),
    ),
  ];
  const roles: MenuEntry[] = [
    choice('No role', role === null, () => set({ role: null })),
    ...AGENT_ROLES.map((each) => choice(ROLE_LABELS[each], role === each, () => set({ role: each }))),
  ];

  return (
    <span className="agent-setup" role="group" aria-label="Harness, model and role">
      <Menu entries={harnesses} side="top">
        <Button size="sm" variant="ghost" className="agent-setup-chip" aria-label={`Harness: ${HARNESSES[harness].label}`} icon={<HarnessMark harness={harness} />} trailingIcon={<ChevronDown />}>
          <span className="agent-setup-text">{HARNESSES[harness].label}</span>
        </Button>
      </Menu>
      {typing === undefined ? (
        <Menu entries={models} side="top">
          <Button size="sm" variant="ghost" className="agent-setup-chip agent-setup-model-chip" aria-label={`Model: ${model || 'Default'}`} title={model || undefined} trailingIcon={<ChevronDown />}>
            <span className="agent-setup-text">{model === '' ? 'Default' : modelLabel(model)}</span>
          </Button>
        </Menu>
      ) : (
        <Input
          size="sm"
          className="agent-setup-model add-zone-mono"
          aria-label="Model id"
          placeholder="Model id"
          autoFocus
          value={typing}
          onChange={(event) => setTyping(event.target.value)}
          onBlur={commitTyped}
          onKeyDown={(event) => {
            // Its own Enter and Esc: neither starts the agent nor closes the form.
            if (event.key === 'Enter') {
              event.preventDefault();
              commitTyped();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setTyping(undefined);
            }
          }}
        />
      )}
      <Menu entries={roles} side="top">
        <Button size="sm" variant="ghost" className="agent-setup-chip" aria-label={`Role: ${role === null ? 'No role' : ROLE_LABELS[role]}`} trailingIcon={<ChevronDown />}>
          <span className="agent-setup-text">{role === null ? 'No role' : ROLE_LABELS[role]}</span>
        </Button>
      </Menu>
    </span>
  );
}

/** The one-line note under the role (BK2): the template it starts with, `whose` naming the zone (or "the repo's"). */
export function roleNote(role: AgentRole, whose: string): string {
  return `Uses ${whose} ${ROLE_LABELS[role]} template.`;
}

/** An agent's harness, model and role on one line, and what a reviewer reviews: the tile's badges' tooltip. */
export function agentSetupLine(agent: Pick<Agent, 'harness' | 'model' | 'role' | 'reviews'>): string {
  const role = agent.role === null ? 'no role' : ROLE_LABELS[agent.role];
  const line = `${HARNESSES[agent.harness].label} · ${agent.model === null ? 'default model' : modelLabel(agent.model)} · ${role}`;
  return agent.reviews === null ? line : `${line}. Reviews ${agent.reviews.branch} at ${shortCommit(agent.reviews.head)}.`;
}

/** An agent's branch as its tile and details say it: a reviewer's reads "detached @ <commit> · <branch it reviews>". */
export function branchLine(agent: Pick<Agent, 'branch' | 'reviews'>): string {
  return agent.reviews === null ? agent.branch : `detached @ ${shortCommit(agent.reviews.head)} · ${agent.reviews.branch}`;
}
