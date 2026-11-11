import { useState } from 'react';
import { Brain, Check, ChevronDown } from 'lucide-react';
import {
  AGENT_ROLES,
  HARNESS_EFFORTS,
  isOrchestratorRole,
  MAX_ROLE_NAME_LENGTH,
  ORCHESTRATOR_ROLE,
  parseRole,
  REVIEWER_ROLES,
  type Agent,
  type AgentRole,
  type Effort,
  type Harness,
} from '@agent-board/daemon/protocol';
import { inRepoCheckout, shortCommit } from '@agent-board/daemon/gate-rules';
import { HARNESSES } from '../harness';
import { Button, Input, Menu, type MenuEntry } from '../ui';
import { HarnessMark } from './HarnessMark';
import { useTechnicalDetails } from '../technical';

/** The models offered for each harness, besides its own default; any other can be typed (Other…). */
export const MODELS: Record<Harness, string[]> = { claude: ['opus', 'sonnet', 'haiku'], codex: ['gpt-5-codex', 'gpt-5'] };

/** How each role reads in the app. */
export const ROLE_LABELS: Record<AgentRole, string> = {
  implementer: 'Implementer',
  reviewer: 'Reviewer',
  'follow-up-reviewer': 'Follow-up reviewer',
  custom: 'Custom',
};

/** How each reasoning effort reads in the app. */
export const EFFORT_LABELS: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

/** What the outer reasoning levels cost, said where one is picked: higher levels think longer and use more of the plan. */
export const EFFORT_HINTS: Partial<Record<Effort, string>> = { low: 'Fastest, least usage', max: 'Slowest, most usage' };

/**
 * What a new agent starts with besides its task: its harness, its model ('' for the harness's default), its reasoning
 * effort ('' for the default: Settings', else the harness's own) and its role, as the daemon takes it: a built-in role,
 * or a custom role's name.
 */
export interface AgentSetup {
  harness: Harness;
  model: string;
  effort: Effort | '';
  role: string | null;
}

export const DEFAULT_SETUP: AgentSetup = { harness: 'claude', model: '', effort: '', role: null };

/** A role as typed, read as the daemon reads it: null for none, or for a name it would refuse. */
const parsed = (role: string | null) => {
  if (role === null) return null;
  const read = parseRole(role);
  return 'error' in read ? null : read;
};

/** Whether an agent in `role` reviews a branch, on a detached checkout of it. */
export const reviews = (role: string | null): boolean => {
  const read = parsed(role);
  return read !== null && REVIEWER_ROLES.includes(read.role);
};

/** A role as the app shows it: a custom role's own name (`designer`), else the role's label. */
export function roleText(role: AgentRole, name: string | null): string {
  return name ?? ROLE_LABELS[role];
}

/** A role as typed, as its chip shows it. */
const typedRoleText = (role: string | null): string => {
  const read = parsed(role);
  return read === null ? 'No role' : roleText(read.role, read.name);
};

/** A model as a chip or badge shows it: Claude's offered ones by name (`Opus`), any other id as it is. */
export function modelLabel(model: string): string {
  return MODELS.claude.includes(model) ? model[0]!.toUpperCase() + model.slice(1) : model;
}

/**
 * An agent's reasoning effort in words (`High reasoning`), and when it takes it if it has yet to: after this turn, or
 * on restart. Null for its harness's own.
 */
export function effortText(agent: Pick<Agent, 'effort' | 'effortPending'>): string | null {
  if (agent.effort === null && agent.effortPending === null) return null;
  const when = agent.effortPending === 'after-turn' ? ' after this turn' : agent.effortPending === 'restart' ? ' on restart' : '';
  return `${agent.effort === null ? 'Default' : EFFORT_LABELS[agent.effort]} reasoning${when}`;
}

/** A row of a chip's menu, ticked when it is the one picked, with a line under it saying what it costs (`hint`). */
const choice = (label: string, picked: boolean, onSelect: () => void, hint?: string): MenuEntry => ({
  label,
  onSelect,
  icon: picked ? <Check aria-hidden /> : <span className="agent-setup-blank" aria-hidden />,
  ...(hint === undefined ? {} : { hint }),
});

/**
 * The chip menus in New agent's footer: harness ▾, model ▾, reasoning ▾ (with `reasoning`) and role ▾, so what will
 * start is on show. With `technical` set (New agent's), the Simplified design treats all but the harness as technical
 * details: only the harness shows until Show technical details is on, and Classic shows them all. Without it they all
 * always show. The model menu has Default, the harness's models, and Other… for a typed model id; the reasoning menu
 * Default and the levels the harness takes.
 */
export function AgentSetupChips({
  setup,
  onChange,
  technical = false,
  reasoning = false,
}: {
  setup: AgentSetup;
  onChange(next: AgentSetup): void;
  technical?: boolean;
  reasoning?: boolean;
}) {
  const technicalShown = useTechnicalDetails();
  /** What marks the model and role chips as technical, for the Simplified design to leave out. */
  const detail = technical ? { 'data-technical-detail': '' } : {};
  const hidden = technical && !technicalShown;
  const { harness, model, effort, role } = setup;
  /** The model id being typed after Other…, or undefined while the chip shows. */
  const [typing, setTyping] = useState<string>();
  /** The role name being typed after Named role…, or undefined while the chip shows. */
  const [naming, setNaming] = useState<string>();
  const set = (patch: Partial<AgentSetup>) => onChange({ ...setup, ...patch });
  const commitTyped = () => {
    if (typing !== undefined) set({ model: typing.trim() });
    setTyping(undefined);
  };
  // A name the daemon would refuse (blank, control characters) leaves the role as it was.
  const commitNamed = () => {
    const read = parsed(naming ?? null);
    if (read !== null) set({ role: read.name ?? read.role });
    setNaming(undefined);
  };
  const read = parsed(role);
  const named = read?.name ?? null;

  const harnesses = (Object.keys(HARNESSES) as Harness[]).map((each) =>
    // Another harness's model means nothing to this one: back to its default, as a level it doesn't take is.
    choice(HARNESSES[each].label, each === harness, () =>
      each !== harness && set({ harness: each, model: '', effort: effort !== '' && HARNESS_EFFORTS[each].includes(effort) ? effort : '' }),
    ),
  );
  const efforts: MenuEntry[] = [
    choice('Default', effort === '', () => set({ effort: '' })),
    ...HARNESS_EFFORTS[harness].map((each) => choice(EFFORT_LABELS[each], effort === each, () => set({ effort: each }), EFFORT_HINTS[each])),
  ];
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
    choice('No role', read === null, () => set({ role: null })),
    ...AGENT_ROLES.map((each) => choice(ROLE_LABELS[each], read?.role === each && named === null, () => set({ role: each }))),
    choice('Orchestrator', isOrchestratorRole(role), () => set({ role: ORCHESTRATOR_ROLE })),
    'separator',
    choice(named === null || isOrchestratorRole(role) ? 'Named role…' : `Named: ${named}`, named !== null && !isOrchestratorRole(role), () => setNaming(named ?? '')),
  ];

  return (
    <span className="agent-setup" role="group" aria-label={hidden ? 'Harness' : reasoning ? 'Harness, model, reasoning and role' : 'Harness, model and role'}>
      <Menu entries={harnesses} side="top">
        <Button size="sm" variant="ghost" className="agent-setup-chip" aria-label={`Harness: ${HARNESSES[harness].label}`} icon={<HarnessMark harness={harness} />} trailingIcon={<ChevronDown />}>
          <span className="agent-setup-text">{HARNESSES[harness].label}</span>
        </Button>
      </Menu>
      {typing === undefined ? (
        <Menu entries={models} side="top">
          <Button size="sm" variant="ghost" className="agent-setup-chip agent-setup-model-chip" {...detail} aria-label={`Model: ${model || 'Default'}`} title={model || undefined} trailingIcon={<ChevronDown />}>
            <span className="agent-setup-text">{model === '' ? 'Default' : modelLabel(model)}</span>
          </Button>
        </Menu>
      ) : (
        <Input
          size="sm"
          className="agent-setup-model add-zone-mono"
          {...detail}
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
      {reasoning && (
        <Menu entries={efforts} side="top">
          <Button
            size="sm"
            variant="ghost"
            className="agent-setup-chip"
            {...detail}
            aria-label={`Reasoning: ${effort === '' ? 'Default' : EFFORT_LABELS[effort]}`}
            title="How hard it thinks: higher levels think longer and use more of your plan"
            icon={<Brain />}
            trailingIcon={<ChevronDown />}
          >
            <span className="agent-setup-text">{effort === '' ? 'Reasoning' : `${EFFORT_LABELS[effort]} reasoning`}</span>
          </Button>
        </Menu>
      )}
      {naming === undefined ? (
        <Menu entries={roles} side="top">
          <Button size="sm" variant="ghost" className="agent-setup-chip" {...detail} aria-label={`Role: ${typedRoleText(role)}`} title={named ?? undefined} trailingIcon={<ChevronDown />}>
            <span className="agent-setup-text">{typedRoleText(role)}</span>
          </Button>
        </Menu>
      ) : (
        <Input
          size="sm"
          className="agent-setup-model"
          {...detail}
          aria-label="Role name"
          placeholder="designer, researcher…"
          maxLength={MAX_ROLE_NAME_LENGTH}
          autoFocus
          value={naming}
          onChange={(event) => setNaming(event.target.value)}
          onBlur={commitNamed}
          onKeyDown={(event) => {
            // Its own Enter and Esc, as the model id's.
            if (event.key === 'Enter') {
              event.preventDefault();
              commitNamed();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setNaming(undefined);
            }
          }}
        />
      )}
    </span>
  );
}

/** The one-line note under the role: the template it starts with, `whose` naming the zone (or "the repo's"). */
export function roleNote(role: string, whose: string): string {
  return `Uses ${whose} ${typedRoleText(role)} template.`;
}

/**
 * An agent's harness, model, reasoning effort (when not its harness's own) and role on one line, and what a reviewer
 * reviews: the tile's badges' tooltip.
 */
export function agentSetupLine(agent: Pick<Agent, 'harness' | 'model' | 'effort' | 'effortPending' | 'role' | 'roleName' | 'reviews'>): string {
  const role = agent.role === null ? 'no role' : roleText(agent.role, agent.roleName);
  const effort = effortText(agent);
  const line = [HARNESSES[agent.harness].label, agent.model === null ? 'default model' : modelLabel(agent.model), ...(effort === null ? [] : [effort]), role].join(' · ');
  return agent.reviews === null ? line : `${line}. Reviews ${agent.reviews.branch} at ${shortCommit(agent.reviews.head)}.`;
}

/**
 * The same as the shelves say it, leaving out what isn't there: a default model, no role. The footer's branch line says
 * what a reviewer reviews.
 */
export function shelvesSetupLine(agent: Pick<Agent, 'harness' | 'model' | 'effort' | 'effortPending' | 'role' | 'roleName'>): string {
  const effort = effortText(agent);
  return [HARNESSES[agent.harness].label, ...(agent.model === null ? [] : [modelLabel(agent.model)]), ...(effort === null ? [] : [effort]), ...(agent.role === null ? [] : [roleText(agent.role, agent.roleName)])].join(' · ');
}

/**
 * Where an agent works, in plain words: the sidebar footer's first line with Show technical details off. It says whose
 * files the agent is in (the user's folder, the user's checkout, or a copy of its own), and never a branch name.
 */
export function plainWhereLine(agent: Pick<Agent, 'plainFolder' | 'reviews' | 'ownsWorktree' | 'worktree' | 'repoRoot'>): string {
  if (agent.plainFolder) return 'Working in your folder';
  if (agent.reviews !== null) return `Reviewing ${agent.reviews.branch}’s changes`;
  return inRepoCheckout(agent) ? 'Working in your checkout' : 'Working in its own copy';
}

/** An agent's branch as its tile and details say it: a reviewer's reads "detached @ <commit> · <branch it reviews>". */
export function branchLine(agent: Pick<Agent, 'branch' | 'reviews'>): string {
  return agent.reviews === null ? agent.branch : `detached @ ${shortCommit(agent.reviews.head)} · ${agent.reviews.branch}`;
}
