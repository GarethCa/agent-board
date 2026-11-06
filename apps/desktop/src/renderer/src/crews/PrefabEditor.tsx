import { Check, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import {
  EFFORTS,
  MAX_PREFAB_MEMBERS,
  MAX_REVIEW_CAP,
  isOrchestratorRole,
  ORCHESTRATOR_ROLE,
  type CrewPrefab,
  type Effort,
  type Harness,
  type LibraryPrefab,
  type PrefabMember,
  type PrefabStart,
} from '@agent-board/daemon/protocol';
import { EFFORT_LABELS, MODELS } from '../board/AgentSetup';
import { Button, Dialog, ErrorText, Field, Hint, IconButton, Input, Segmented, Select, Textarea } from '../ui';
import { useAction } from '../use-action';
import { PrefabIcon, RoleIcon } from './icons';
import { DECISION, draftProblems, MAX_PREFAB_NAME, modelChoice, readModelChoice, flowLayout, flowSentence, memberLabel, memberModel, newMember, NODE, promptMember, type FlowNode } from './prefab-flow';

const HARNESS_NAMES: Record<Harness, string> = { claude: 'Claude', codex: 'Codex' };
/** Reasoning, short enough for one segmented row. */
const EFFORT_SHORT: Record<Effort, string> = { ...EFFORT_LABELS, xhigh: 'X-high' };
/** What the Starts row says the picked start means. */
const START_HINTS: Record<PrefabStart, string> = {
  prompt: 'It starts with your prompt.',
  handoff: "It starts on the builder's branch at each hand-off, a fresh one each round, and its review goes back to the builder.",
  lead: 'It waits for the lead to start it, when its work is ready.',
};

/** The roles the editor offers by name; any other is a named role, typed. */
const ROLES = [
  { id: 'implementer', label: 'Implementer' },
  { id: 'reviewer', label: 'Reviewer' },
  { id: 'follow-up-reviewer', label: 'Follow-up reviewer' },
  { id: ORCHESTRATOR_ROLE, label: 'Orchestrator' },
] as const;
const NAMED = '__named';

/** Whether `role` is one the editor offers by name. */
const listedRole = (role: string | null) => role === null || ROLES.some((each) => each.id === role.toLowerCase());

/** A member may carry a template of its own only in a named role, and only on the prompt. */
const mayCarryTemplate = (member: PrefabMember) => member.starts === 'prompt' && !listedRole(member.role) && member.role !== null;

export interface PrefabEditorProps {
  /** The prefab to edit, or null for a new one. A built-in is saved as a copy under a name of its own. */
  prefab: LibraryPrefab | null;
  onClose(): void;
  /** Heard once the library has saved it. */
  onSaved?(saved: LibraryPrefab): void;
  /** Drawn open in place, for the gallery, with this member picked. */
  inline?: boolean;
  picked?: string;
}

/** An empty prefab: one implementer on the prompt, one reviewer at its hand-off. */
const blank = (): CrewPrefab => ({
  name: '',
  icon: 'crew',
  purpose: '',
  roundLimit: 3,
  onBoard: 'card',
  members: [
    { id: 'builder', role: 'implementer', name: 'Builder', harness: 'claude', model: null, effort: null, template: null, starts: 'prompt', subagents: [] },
    { id: 'review', role: 'reviewer', name: 'Review', harness: 'claude', model: null, effort: null, template: null, starts: 'handoff', subagents: [] },
  ],
});

/**
 * A crew prefab's flow editor: its diagram (members as icon bubbles, who gets whose work, the stop and the loop back)
 * beside the picked member's inspector, the flow in words under them, and the prefab's round limit and how its crews
 * are drawn. Saving writes it to the app's library as its `.crew.json` file, read as strictly as an imported one.
 */
export function PrefabEditor({ prefab, onClose, onSaved, inline = false, picked: pickedAt }: PrefabEditorProps) {
  const copy = prefab?.builtIn === true;
  const [draft, setDraft] = useState<CrewPrefab>(() => {
    if (prefab === null) return blank();
    // The prefab alone: whether it is built in, and when it was saved, are the library's.
    const own: CrewPrefab = { name: prefab.name, icon: prefab.icon, purpose: prefab.purpose, roundLimit: prefab.roundLimit, onBoard: prefab.onBoard, members: prefab.members };
    return copy ? { ...own, name: `${own.name} (mine)` } : own;
  });
  const [picked, setPicked] = useState<string | undefined>(pickedAt ?? draft.members[0]?.id);
  const { busy, error, run } = useAction();
  const member = draft.members.find((each) => each.id === picked);
  // What the editor sees is missing, else why the library's own parser would refuse it (asked of main as it changes).
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const asked = setTimeout(() => {
      window.agentBoard.orchestrators.checkPrefab({ ...draft, name: draft.name.trim() }).then(
        (why) => live && setRefusal(why),
        () => {},
      );
    }, 150);
    return () => {
      live = false;
      clearTimeout(asked);
    };
  }, [draft]);
  const missing = draftProblems(draft);
  const problems = missing.length > 0 ? missing : refusal === null ? [] : [`${refusal.charAt(0).toUpperCase()}${refusal.slice(1)}.`];
  const layout = flowLayout(draft);
  // Closing with changes not saved asks first.
  const [opened] = useState(() => JSON.stringify(draft));
  const [leaving, setLeaving] = useState(false);
  const close = () => (JSON.stringify(draft) === opened ? onClose() : setLeaving(true));

  const change = (fields: Partial<CrewPrefab>) => setDraft((current) => ({ ...current, ...fields }));
  const changeMember = (id: string, fields: Partial<PrefabMember>) =>
    setDraft((current) => ({ ...current, members: current.members.map((each) => (each.id === id ? { ...each, ...fields } : each)) }));
  const add = () => {
    const added = newMember(draft);
    change({ members: [...draft.members, added] });
    setPicked(added.id);
  };
  const remove = (id: string) => {
    const left = draft.members.filter((each) => each.id !== id);
    change({ members: left });
    setPicked(left[0]?.id);
  };
  const save = () =>
    run(
      () => window.agentBoard.orchestrators.savePrefab({ ...draft, name: draft.name.trim() }, prefab === null || copy ? undefined : prefab.name),
      (saved) => {
        onSaved?.(saved);
        onClose();
      },
    );

  const origin = prefab === null ? 'New' : copy ? `A copy of the built-in ${prefab.name}` : 'Yours';
  return (
    <>
    <Dialog
      aria-label="Crew prefab"
      title={prefab === null ? 'New crew prefab' : copy ? 'Copy a crew prefab' : 'Edit crew prefab'}
      onClose={close}
      inline={inline}
      data-testid="prefab-editor"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={problems.length > 0} onClick={save}>
            {copy ? 'Save a copy' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="prefab-editor">
        <div className="prefab-editor-head">
          <span className="prefab-editor-mark" aria-hidden>
            <PrefabIcon icon={draft.icon} />
          </span>
          <span className="prefab-editor-title">
            <Input
              className="prefab-editor-name"
              aria-label="Name"
              placeholder="Name it"
              value={draft.name}
              maxLength={MAX_PREFAB_NAME}
              onChange={(event) => change({ name: event.target.value })}
            />
            <span className="prefab-editor-origin">{origin}</span>
          </span>
          <span className="prefab-editor-head-end">
            <Field label="Stop after">
              <Select aria-label="Round limit" size="sm" value={draft.roundLimit} onChange={(event) => change({ roundLimit: Number(event.target.value) })}>
                {Array.from({ length: MAX_REVIEW_CAP }, (_, n) => n + 1).map((n) => (
                  <option key={n} value={n}>
                    {n} {n === 1 ? 'round' : 'rounds'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="On the board">
              <Segmented
                aria-label="On the board"
                value={draft.onBoard}
                onChange={(onBoard) => change({ onBoard })}
                options={[
                  { id: 'card', label: 'One card' },
                  { id: 'tiles', label: 'Member tiles' },
                ]}
              />
            </Field>
          </span>
        </div>
        <Input
          className="prefab-editor-purpose"
          aria-label="What it is for"
          placeholder="What it is for, in a line"
          value={draft.purpose}
          maxLength={200}
          onChange={(event) => change({ purpose: event.target.value })}
        />
        <div className="prefab-editor-main">
          <div className="prefab-editor-canvas" role="group" aria-label="Flow">
            <div className="prefab-flow" style={{ width: layout.width, height: layout.height }}>
            <svg className="prefab-wires" width={layout.width} height={layout.height} aria-hidden>
              {layout.wires.map((wire, index) => (
                <g key={index} className={wire.loop ? 'loop' : undefined}>
                  <path d={wire.d} />
                  {wire.head !== null && <Arrowhead {...wire.head} />}
                </g>
              ))}
            </svg>
            {layout.nodes.map((node, index) => (
              <FlowPiece key={node.id ?? `${node.kind}-${index}`} node={node} draft={draft} picked={picked} onPick={setPicked} onAdd={add} end={layout.end} />
            ))}
            {layout.labels.map((label) => (
              <span key={label.text} className={`prefab-wire-label${label.loop ? ' loop' : ''}`} style={{ left: label.x, top: label.y }}>
                {label.text}
              </span>
            ))}
            </div>
          </div>
          <div className="prefab-inspector" role="group" aria-label="Member">
            {member === undefined ? (
              <Hint>Pick a member in the flow, or add one.</Hint>
            ) : (
              <Inspector member={member} draft={draft} onChange={(fields) => changeMember(member.id, fields)} onRemove={() => remove(member.id)} />
            )}
          </div>
        </div>
        <p className="prefab-sentence">
          <span className="prefab-sentence-key">In words</span>
          <span>
            {flowSentence(draft).map((words, index) => (words.bold ? <b key={index}>{words.text}</b> : <span key={index}>{words.text}</span>))}
          </span>
        </p>
        {problems.length > 0 && (
          <ul className="prefab-problems" aria-label="Before it can be saved">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        )}
        {error && <ErrorText>{error}</ErrorText>}
      </div>
    </Dialog>
    {leaving && (
      <Dialog
        role="alertdialog"
        title="Discard your changes?"
        onClose={() => setLeaving(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setLeaving(false)}>
              Keep editing
            </Button>
            <Button variant="danger" onClick={onClose}>
              Discard
            </Button>
          </>
        }
      >
        <Hint>{draft.name.trim() || 'This prefab'} isn't saved. Its changes go if you close it now.</Hint>
      </Dialog>
    )}
    </>
  );
}

function Arrowhead({ x, y, dir }: { x: number; y: number; dir: 'right' | 'up' }) {
  const points = dir === 'right' ? `${x - 8},${y - 5} ${x},${y} ${x - 8},${y + 5}` : `${x - 5},${y + 8} ${x},${y} ${x + 5},${y + 8}`;
  return <polygon points={points} />;
}

/** One piece of the diagram: a member's bubble (a button that picks it), your prompt, the stop, or where it ends. */
function FlowPiece({
  node,
  draft,
  picked,
  onPick,
  onAdd,
  end,
}: {
  node: FlowNode;
  draft: CrewPrefab;
  picked: string | undefined;
  onPick(id: string): void;
  onAdd(): void;
  end: 'Ready' | 'Done' | null;
}) {
  const at = { left: node.x, top: node.y };
  if (node.kind === 'add') {
    const full = draft.members.length >= MAX_PREFAB_MEMBERS;
    return (
      <button type="button" className="prefab-node add" style={{ ...at, width: NODE.width }} disabled={full} title={full ? `A prefab has at most ${MAX_PREFAB_MEMBERS} members` : undefined} onClick={onAdd}>
        <span className="prefab-node-bubble">
          <Plus aria-hidden />
        </span>
        <b>Add member</b>
      </button>
    );
  }
  if (node.kind === 'start') {
    return (
      <span className="prefab-pill start" style={at}>
        Your prompt
      </span>
    );
  }
  if (node.kind === 'end') {
    return (
      <span className="prefab-pill end" style={at}>
        <Check aria-hidden />
        {end}
      </span>
    );
  }
  if (node.kind === 'decision') {
    return (
      <span className="prefab-decision" style={{ ...at, width: DECISION, height: DECISION }}>
        <span className="prefab-decision-mark" aria-hidden />
        <span className="prefab-decision-label">All approve?</span>
      </span>
    );
  }
  const member = draft.members.find((each) => each.id === node.id)!;
  return (
    <button
      type="button"
      className="prefab-node"
      style={{ ...at, width: NODE.width }}
      aria-pressed={member.id === picked}
      aria-label={`${memberLabel(member)}, ${memberModel(member)}`}
      onClick={() => onPick(member.id)}
    >
      <span className="prefab-node-bubble">
        <RoleIcon member={member} />
      </span>
      <b>{memberLabel(member)}</b>
      <span className="prefab-node-model">{memberModel(member)}</span>
    </button>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ui-field prefab-row">
      <span className="ui-field-name">{label}</span>
      {children}
    </div>
  );
}

/** The picked member: its name, role, harness and model, reasoning, template (a named role's, on the prompt) and start. */
function Inspector({ member, draft, onChange, onRemove }: { member: PrefabMember; draft: CrewPrefab; onChange(fields: Partial<PrefabMember>): void; onRemove(): void }) {
  const named = !listedRole(member.role);
  const models = [...MODELS[member.harness], ...(member.model !== null && !MODELS[member.harness].includes(member.model) ? [member.model] : [])];
  const efforts = EFFORTS.filter((effort) => member.harness === 'claude' || effort !== 'max');
  const first = promptMember(draft);
  const ledBy = first !== undefined && first !== member && isOrchestratorRole(first.role);
  // Its other start is by the lead, under an orchestrator on the prompt; else after a hand-off. Its own is always offered.
  const START_LABELS: Record<PrefabStart, string> = { prompt: 'With the prompt', handoff: 'After a hand-off', lead: 'By the lead' };
  const offered = new Set<PrefabStart>(['prompt', ledBy ? 'lead' : 'handoff', member.starts]);
  const starts = (['prompt', 'handoff', 'lead'] as const).filter((start) => offered.has(start)).map((start) => ({ id: start, label: START_LABELS[start] }));
  return (
    <>
      <div className="prefab-inspector-head">
        <span className="prefab-node-bubble small" aria-hidden>
          <RoleIcon member={member} />
        </span>
        <b>{memberLabel(member)}</b>
        <IconButton className="prefab-inspector-remove" icon={<Trash2 />} aria-label={`Remove ${memberLabel(member)}`} onClick={onRemove} />
      </div>
      <Row label="Name">
        <Input aria-label="Member name" placeholder={memberLabel({ ...member, name: null })} value={member.name ?? ''} maxLength={60} onChange={(event) => onChange({ name: event.target.value === '' ? null : event.target.value })} />
      </Row>
      <Row label="Role">
        <Select
          aria-label="Role"
          value={named ? NAMED : (member.role?.toLowerCase() ?? '')}
          onChange={(event) => {
            const role = event.target.value;
            onChange(role === NAMED ? { role: 'designer' } : { role: role === '' ? null : role, template: null });
          }}
        >
          {ROLES.map((role) => (
            <option key={role.id} value={role.id}>
              {role.label}
            </option>
          ))}
          <option value="">No role</option>
          <option value={NAMED}>A named role…</option>
        </Select>
        {named && (
          <Input aria-label="Role name" placeholder="designer" value={member.role ?? ''} maxLength={24} onChange={(event) => onChange({ role: event.target.value.toLowerCase() })} />
        )}
      </Row>
      <Row label="AI and model">
        <span className="prefab-ai">
          <span className="prefab-harness-mark" data-harness={member.harness} aria-hidden />
          <Select
            aria-label="AI and model"
            value={modelChoice(member.harness, member.model)}
            onChange={(event) => {
              const { harness, model } = readModelChoice(event.target.value);
              onChange({ harness, model, effort: harness === 'codex' && member.effort === 'max' ? 'xhigh' : member.effort });
            }}
          >
            {(['claude', 'codex'] as const).map((harness) => (
              <optgroup key={harness} label={HARNESS_NAMES[harness]}>
                <option value={modelChoice(harness, null)}>{HARNESS_NAMES[harness]} · its default</option>
                {[...MODELS[harness], ...(harness === member.harness ? models.filter((model) => !MODELS[harness].includes(model)) : [])].map((model) => (
                  <option key={model} value={modelChoice(harness, model)}>
                    {HARNESS_NAMES[harness]} · {model}
                  </option>
                ))}
              </optgroup>
            ))}
          </Select>
        </span>
      </Row>
      <Row label="Reasoning">
        <Segmented<Effort | 'default'>
          className="prefab-efforts"
          aria-label="Reasoning"
          value={member.effort ?? 'default'}
          onChange={(effort) => onChange({ effort: effort === 'default' ? null : effort })}
          options={[{ id: 'default', label: 'Default' }, ...efforts.map((effort) => ({ id: effort, label: EFFORT_SHORT[effort] }))]}
        />
      </Row>
      {mayCarryTemplate(member) && (
        <Row label="Template">
          <Segmented
            aria-label="Template"
            value={member.template === null ? 'zone' : 'own'}
            onChange={(which) => onChange({ template: which === 'zone' ? null : `You are the ${member.role} for {{issue}}, on {{branch}}.` })}
            options={[
              { id: 'zone', label: `The zone's ${member.role ?? ''} template` },
              { id: 'own', label: 'Its own' },
            ]}
          />
          {member.template !== null && <Textarea aria-label="Its template" rows={4} value={member.template} onChange={(event) => onChange({ template: event.target.value })} />}
        </Row>
      )}
      <Row label="Starts">
        <Segmented<PrefabStart>
          aria-label="Starts"
          value={member.starts}
          onChange={(start) => onChange({ starts: start, ...(start === 'prompt' ? {} : { template: null }) })}
          options={starts}
        />
      </Row>
      <Hint>{START_HINTS[member.starts]}</Hint>
    </>
  );
}
