import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import {
  ArrowRight,
  Bot,
  ChevronDown,
  CircleCheck,
  FileJson,
  FileText,
  GitPullRequest,
  Pause,
  Play,
  Plus,
  Send,
  ShieldCheck,
  Tag,
  Terminal,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import type {
  FlowCommandApproval,
  FlowCondition,
  FlowConditionCheck,
  FlowDeliveredPayload,
  FlowEdge,
  FlowEdgePayload,
  FlowPayloadPreview,
} from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';
import { Button, Dialog, FlowPill, IconButton, Input, Menu, Radio, SectionLabel, Segmented } from '../ui';
import type { FlowEdgeActions } from './FlowEdge';
import { conditionName, edgeLabel, heldLabel, historyLine } from './flow-edges';
import { whenLabel } from './schedule';

interface EdgeRulesProps {
  edge: FlowEdge;
  /** The names of the agents at its ends. */
  fromName: string;
  toName: string;
  /** The orchestrator that made it, if an agent did and is still on the board. */
  madeByName?: string;
  /** Changes whenever its `from` agent finishes a turn, so the preview of its final message is read again. */
  fromRevision: string | null;
  /** Just drawn: the panel says it's new. */
  drawn: boolean;
  /** A hand-off is going along it now. */
  live: boolean;
  actions: FlowEdgeActions;
  onDelete(): void;
  onClose(): void;
}

/** The payloads, as the panel's switch names them. */
const PAYLOAD_CHOICES: { payload: FlowEdgePayload; name: string; icon?: LucideIcon }[] = [
  { payload: 'final-message', name: 'Final message' },
  { payload: 'handover', name: 'handover.md', icon: FileText },
  { payload: 'json', name: 'JSON', icon: FileJson },
];

/** What each payload hands on, under the switch. */
const PAYLOAD_HINTS: Record<FlowEdgePayload, (from: string) => string> = {
  'final-message': (from) => `${from}'s last message, from the turn it just finished.`,
  handover: (from) => `A markdown file in ${from}'s worktree, as it is when ${from} is done.`,
  json: (from) => `A JSON file in ${from}'s worktree, checked and sent on one line.`,
};

/** The conditions Add condition offers (FlowRules), each with what it needs typed, if anything. */
const CONDITION_CHOICES: {
  kind: FlowCondition['kind'];
  label: string;
  hint: string;
  icon: LucideIcon;
  /** What the user types for it: a command or a label. */
  ask?: { name: string; placeholder: string };
}[] = [
  { kind: 'gate-green', label: 'Gate is green', hint: 'your gate command passes', icon: ShieldCheck, ask: { name: 'Gate command', placeholder: 'pnpm check:local' } },
  { kind: 'pr-checks', label: 'PR checks passing', hint: 'uses gh pr checks', icon: GitPullRequest },
  { kind: 'issue-label', label: 'A label on the issue', hint: 'Linear or GitHub', icon: Tag, ask: { name: 'Label', placeholder: 'ready-for-agent' } },
  { kind: 'script', label: 'Custom script', hint: 'exit 0 to pass', icon: Terminal, ask: { name: 'Script', placeholder: './ready.sh' } },
];
const choiceOf = (kind: FlowCondition['kind']) => CONDITION_CHOICES.find((choice) => choice.kind === kind)!;

/** A condition from what was typed for it. */
function conditionOf(kind: FlowCondition['kind'], text: string): FlowCondition {
  switch (kind) {
    case 'pr-checks':
      return { kind };
    case 'issue-label':
      return { kind, label: text };
    default:
      return { kind, command: text };
  }
}

/** How a condition did when last checked, briefly: "passed 14:01", or what it saw. */
function checkLabel(check: FlowConditionCheck | null, now: Date): string {
  if (check === null) return 'not checked yet';
  return check.passed ? `passed ${whenLabel(new Date(check.at), now)}` : check.detail;
}

/** What the edge would carry now, as the daemon reads it; undefined until it has said. */
function usePreview(edge: FlowEdge, fromRevision: string | null): FlowPayloadPreview | undefined {
  const [preview, setPreview] = useState<FlowPayloadPreview>();
  const read = edge.history[0]?.at;
  useEffect(() => {
    let cancelled = false;
    window.agentBoard.flowEdges.preview(edge.id).then(
      (next) => !cancelled && setPreview(next),
      (error: unknown) => !cancelled && setPreview({ name: 'payload', problem: errorMessage(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [edge.id, edge.payload, edge.path, read, fromRevision]);
  return preview;
}

/**
 * What the edge last delivered, as the daemon remembers it (null when it doesn't: none yet, or since it restarted);
 * undefined until it has said. Read again with each delivery.
 */
function useLastPayload(edge: FlowEdge): FlowDeliveredPayload | null | undefined {
  const [payload, setPayload] = useState<FlowDeliveredPayload | null>();
  const at = edge.lastDelivery?.delivered === true ? edge.lastDelivery.at : undefined;
  useEffect(() => {
    if (at === undefined) return setPayload(null);
    let cancelled = false;
    window.agentBoard.flowEdges.lastPayload(edge.id).then(
      (next) => !cancelled && setPayload(next),
      () => !cancelled && setPayload(null),
    );
    return () => {
      cancelled = true;
    };
  }, [edge.id, at]);
  return payload;
}

/**
 * What each of the edge's gates and scripts runs now, and whether it is approved, by command: read again whenever the
 * edge changes, as a check may have found it changed.
 */
function useCommands(edge: FlowEdge): Map<string, FlowCommandApproval> {
  const [commands, setCommands] = useState(new Map<string, FlowCommandApproval>());
  const runs = edge.conditions.some((condition) => 'command' in condition);
  useEffect(() => {
    if (!runs) return setCommands(new Map());
    let cancelled = false;
    window.agentBoard.flowEdges.commands(edge.id).then(
      (next) => !cancelled && setCommands(new Map(next.map((plan) => [plan.command, plan]))),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [edge.id, edge.updatedAt, edge.checks, runs]);
  return commands;
}

/** Asks you to approve exactly what a gate or script will run in the agent's worktree, before it ever does. */
function ApproveCommand({ plan, fromName, onApprove, onClose }: { plan: FlowCommandApproval; fromName: string; onApprove(): void; onClose(): void }) {
  return (
    <Dialog
      role="alertdialog"
      title={plan.approval === 'changed' ? 'This command has changed' : 'Run this command?'}
      onClose={onClose}
      data-testid="approve-command"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button variant="primary" icon={<ShieldCheck />} onClick={onApprove}>
            Approve
          </Button>
        </>
      }
    >
      <p className="edge-rules-hint">
        Before each hand-off along this edge, agent-board runs this in {fromName}'s worktree, as you. {fromName} can edit
        these files, so this asks again whenever any of them change.
      </p>
      <pre className="edge-rules-preview edge-rules-plan">{plan.shown}</pre>
    </Dialog>
  );
}

/**
 * The Edge rules panel (FlowDraw AB2, FlowRules AC): on the right of the board, for the flow edge selected, and opened
 * on one as soon as it is drawn. It sets what the edge carries (its final message, a markdown file or JSON from its
 * agent's worktree), its trigger, how it delivers to a busy agent and its conditions, previews the payload, lists the
 * edge's history, and pauses, sends or deletes it.
 */
export function EdgeRules({ edge, fromName, toName, madeByName, fromRevision, drawn, live, actions, onDelete, onClose }: EdgeRulesProps) {
  const id = useId();
  const now = new Date();
  const preview = usePreview(edge, fromRevision);
  const delivered = useLastPayload(edge);
  const [path, setPath] = useState(edge.path ?? '');
  const [adding, setAdding] = useState<{ kind: FlowCondition['kind']; text: string }>();
  const commands = useCommands(edge);
  // The command whose approval is being asked for: one just added, or one whose Approve was pressed.
  const [confirming, setConfirming] = useState<string>();
  const confirm = confirming === undefined ? undefined : commands.get(confirming);
  const kept = edge.held ?? edge.queued;
  // Its file as the daemon has it, once it says, unless being typed.
  useEffect(() => setPath(edge.path ?? ''), [edge.path]);
  const held = heldLabel(edge);
  const savePath = () => {
    if (path.trim() !== '' && path !== edge.path) actions.update(edge.id, { path });
    else setPath(edge.path ?? '');
  };
  const setConditions = (conditions: FlowCondition[]) => actions.update(edge.id, { conditions });
  const addCondition = () => {
    if (adding === undefined) return;
    const condition = conditionOf(adding.kind, adding.text.trim());
    if (adding.text.trim() !== '') {
      setConditions([...edge.conditions, condition]);
      if ('command' in condition) setConfirming(condition.command);
    }
    setAdding(undefined);
  };
  const pick = (kind: FlowCondition['kind']) => {
    if (choiceOf(kind).ask === undefined) setConditions([...edge.conditions, conditionOf(kind, '')]);
    else setAdding({ kind, text: '' });
  };
  const keys = (save: () => void, cancel: () => void) => (event: KeyboardEvent) => {
    if (event.key === 'Enter') save();
    else if (event.key === 'Escape') cancel();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  const ask = adding === undefined ? undefined : choiceOf(adding.kind).ask;
  const lines = preview !== undefined && 'text' in preview ? preview.text.replace(/\n$/, '').split('\n').length : 0;

  return (
    <aside className="edge-rules" aria-label="Edge rules" data-testid="edge-rules">
      <header className="edge-rules-head">
        <div className="edge-rules-title">
          <span className="edge-rules-swatch" aria-hidden />
          <h2>Edge rules</h2>
          {live ? (
            <FlowPill>sending now</FlowPill>
          ) : edge.paused ? (
            <span className="edge-rules-held">paused</span>
          ) : held !== undefined ? (
            <span className="edge-rules-held">{held}</span>
          ) : edge.queued !== null ? (
            <FlowPill>queued</FlowPill>
          ) : (
            drawn && <FlowPill>new</FlowPill>
          )}
          <IconButton className="edge-rules-close" variant="ghost" size="sm" icon={<X />} aria-label="Close edge rules" onClick={onClose} />
        </div>
        <p className="edge-rules-ends">
          <span>{fromName}</span>
          <ArrowRight aria-label="to" />
          <span>{toName}</span>
        </p>
        {edge.madeBy !== null && (
          <p className="edge-rules-made-by" data-testid="edge-rules-made-by">
            <Bot aria-hidden />
            Made by {madeByName ?? 'an orchestrator since deleted'}. You can change or delete it like any other.
          </p>
        )}
      </header>
      <div className="edge-rules-body">
        <section className="edge-rules-section" aria-labelledby={`${id}-payload`}>
          <SectionLabel>
            <span id={`${id}-payload`}>Payload</span>
          </SectionLabel>
          <Segmented
            aria-label="Payload"
            value={edge.payload}
            onChange={(payload) => actions.update(edge.id, { payload })}
            options={PAYLOAD_CHOICES.map(({ payload, name, icon: Icon }) => ({ id: payload, label: name, icon: Icon && <Icon aria-hidden /> }))}
          />
          {edge.payload !== 'final-message' && (
            <label className="edge-rules-file">
              <Input
                size="sm"
                className="edge-rules-mono"
                value={path}
                aria-label={`File in ${fromName}'s worktree`}
                spellCheck={false}
                onChange={(event) => setPath(event.target.value)}
                onBlur={savePath}
                onKeyDown={keys(savePath, () => setPath(edge.path ?? ''))}
              />
              <span className="edge-rules-hint">in {fromName}'s worktree</span>
            </label>
          )}
          <p className="edge-rules-hint">{PAYLOAD_HINTS[edge.payload](fromName)}</p>
        </section>

        <section className="edge-rules-section edge-rules-pair">
          <div role="radiogroup" aria-labelledby={`${id}-trigger`}>
            <SectionLabel>
              <span id={`${id}-trigger`}>Trigger</span>
            </SectionLabel>
            <Radio
              name={`${id}-trigger`}
              label={`Auto when ${fromName} is done`}
              checked={edge.trigger === 'auto'}
              onChange={() => actions.update(edge.id, { trigger: 'auto' })}
            />
            <Radio
              name={`${id}-trigger`}
              label="Manual, with a Send button"
              checked={edge.trigger === 'manual'}
              onChange={() => actions.update(edge.id, { trigger: 'manual' })}
            />
          </div>
          <div role="radiogroup" aria-labelledby={`${id}-deliver`}>
            <SectionLabel>
              <span id={`${id}-deliver`}>Deliver as</span>
            </SectionLabel>
            <Radio
              name={`${id}-deliver`}
              label="New message"
              checked={edge.deliverAs === 'message'}
              onChange={() => actions.update(edge.id, { deliverAs: 'message' })}
            />
            <Radio
              name={`${id}-deliver`}
              label="Queue after turn"
              checked={edge.deliverAs === 'queue'}
              onChange={() => actions.update(edge.id, { deliverAs: 'queue' })}
            />
          </div>
          <p className="edge-rules-hint">
            {edge.deliverAs === 'queue'
              ? `If ${toName} is busy, it waits until ${toName}'s turn ends.`
              : `If ${toName} is busy, it is skipped.`}
          </p>
        </section>

        <section className="edge-rules-section" aria-labelledby={`${id}-conditions`}>
          <SectionLabel>
            <span id={`${id}-conditions`}>Conditions</span>
            <span className="edge-rules-aside">all must pass</span>
          </SectionLabel>
          {edge.conditions.length > 0 && (
            <ul className="edge-rules-conditions">
              {edge.conditions.map((condition, index) => {
                const check = edge.checks[index] ?? null;
                const Icon = choiceOf(condition.kind).icon;
                const name = conditionName(condition);
                const plan = 'command' in condition ? commands.get(condition.command) : undefined;
                return (
                  <li key={index} className="edge-rules-condition" data-passed={check?.passed}>
                    {check?.passed ? <CircleCheck aria-hidden /> : <Icon aria-hidden />}
                    <span className="edge-rules-condition-name" title={name}>
                      {name}
                    </span>
                    {plan !== undefined && plan.approval !== 'approved' ? (
                      <Button size="sm" variant="ghost" icon={<ShieldCheck />} onClick={() => setConfirming(plan.command)}>
                        Approve
                      </Button>
                    ) : (
                      <span className="edge-rules-condition-check" title={check?.detail}>
                        {checkLabel(check, now)}
                      </span>
                    )}
                    <IconButton
                      variant="ghost"
                      size="sm"
                      icon={<X />}
                      aria-label={`Remove ${name} condition`}
                      onClick={() => setConditions(edge.conditions.filter((_, kept) => kept !== index))}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {adding !== undefined && ask !== undefined && (
            <div className="edge-rules-adding">
              <Input
                size="sm"
                className="edge-rules-mono"
                autoFocus
                value={adding.text}
                placeholder={ask.placeholder}
                aria-label={ask.name}
                spellCheck={false}
                onChange={(event) => setAdding({ ...adding, text: event.target.value })}
                onKeyDown={keys(addCondition, () => setAdding(undefined))}
              />
              <Button size="sm" variant="primary" disabled={adding.text.trim() === ''} onClick={addCondition}>
                Add
              </Button>
              <IconButton variant="ghost" size="sm" icon={<X />} aria-label="Cancel" onClick={() => setAdding(undefined)} />
            </div>
          )}
          <Menu
            entries={CONDITION_CHOICES.map(({ kind, label, hint, icon: Icon }) => ({
              label,
              hint: kind === 'pr-checks' && edge.conditions.some((known) => known.kind === kind) ? 'added' : hint,
              icon: <Icon />,
              disabled: kind === 'pr-checks' && edge.conditions.some((known) => known.kind === kind),
              onSelect: () => pick(kind),
            }))}
          >
            <Button size="sm" className="edge-rules-add" icon={<Plus />}>
              Add condition
              <ChevronDown aria-hidden />
            </Button>
          </Menu>
          <p className="edge-rules-hint">Held until they pass, then sent. Send now sends anyway.</p>
        </section>

        {edge.lastDelivery?.delivered === true && (
          <section className="edge-rules-section" aria-labelledby={`${id}-delivered`}>
            <SectionLabel>
              <span id={`${id}-delivered`}>Last hand-off</span>
              <span className="edge-rules-aside edge-rules-mono">
                {delivered?.name ?? edgeLabel(edge)} · {whenLabel(new Date(edge.lastDelivery.at), now)}
              </span>
            </SectionLabel>
            {delivered === undefined ? null : delivered === null ? (
              <p className="edge-rules-hint" data-testid="edge-rules-delivered">
                What it carried isn't kept once agent-board restarts.
              </p>
            ) : (
              <pre className="edge-rules-preview" data-testid="edge-rules-delivered">
                {delivered.text}
              </pre>
            )}
          </section>
        )}

        <section className="edge-rules-section" aria-labelledby={`${id}-preview`}>
          <SectionLabel>
            <span id={`${id}-preview`}>Preview</span>
            {preview !== undefined && 'text' in preview && (
              <span className="edge-rules-aside edge-rules-mono">
                {preview.name} · {lines} {lines === 1 ? 'line' : 'lines'}
              </span>
            )}
          </SectionLabel>
          {preview === undefined ? null : 'text' in preview ? (
            <pre className="edge-rules-preview" data-testid="edge-rules-preview">
              {preview.text}
            </pre>
          ) : (
            <p className="edge-rules-hint" data-testid="edge-rules-preview">
              {preview.problem}
            </p>
          )}
        </section>

        <section className="edge-rules-section" aria-labelledby={`${id}-history`}>
          <SectionLabel>
            <span id={`${id}-history`}>History</span>
            <span className="edge-rules-aside">
              {edge.deliveries === 0 ? 'never fired' : `fired ${edge.deliveries} ${edge.deliveries === 1 ? 'time' : 'times'}`}
            </span>
          </SectionLabel>
          {kept !== null && (
            <p className="edge-rules-kept" data-testid="edge-rules-kept">
              <span>
                {edge.held !== null ? 'Holding' : 'Queued'} <span className="edge-rules-mono">{kept.name}</span>
                {kept.copy ? ', a copy kept' : ', read again when sent'}
              </span>
              <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => actions.drop(edge.id)}>
                Drop
              </Button>
            </p>
          )}
          {edge.history.length === 0 ? (
            <p className="edge-rules-hint">Nothing yet</p>
          ) : (
            <ol className="edge-rules-history">
              {edge.history.map((event, index) => (
                <li key={`${event.at}-${index}`} data-kind={event.kind}>
                  <time dateTime={event.at}>{whenLabel(new Date(event.at), now)}</time>
                  <span className="edge-rules-history-dot" aria-hidden />
                  <span>{historyLine(event, toName)}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
      <footer className="edge-rules-foot">
        <Button
          size="sm"
          icon={edge.paused ? <Play /> : <Pause />}
          onClick={() => actions.update(edge.id, { paused: !edge.paused })}
        >
          {edge.paused ? 'Resume edge' : 'Pause edge'}
        </Button>
        <Button size="sm" variant="danger" icon={<Trash2 />} onClick={onDelete}>
          Delete
        </Button>
        <Button size="sm" variant="primary" className="edge-rules-send" icon={<Send />} onClick={() => actions.send(edge.id)}>
          Send now
        </Button>
      </footer>
      {confirm !== undefined && confirm.approval !== 'approved' && (
        <ApproveCommand
          plan={confirm}
          fromName={fromName}
          onApprove={() => {
            actions.approve(edge.id, confirm.command, confirm.fingerprint);
            setConfirming(undefined);
          }}
          onClose={() => setConfirming(undefined)}
        />
      )}
    </aside>
  );
}
