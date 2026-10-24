import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ClipboardList } from 'lucide-react';
import type { Agent, Plan, PlanOutcome, PlanSummary } from '@agent-board/daemon/protocol';
import type { WebTabKey, WebTabState } from '../../../preload/api';
import { errorMessage } from '../../../shared/errors';
import { changedLineCount, editHint } from '../doc/doc-view';
import { binding, isActive, keyText, pressed } from '../keys/registry';
import { Markdown } from '../session/Markdown';
import { useWebViewBounds } from '../session/use-web-view';
import { Button, ErrorText, Segmented, Tag, Textarea, type SegmentedOption } from '../ui';
import { useAction } from '../use-action';
import { shortWhen } from '../when';
import { approveLabel, planStamp, shownPlan, versionAuthor } from './plan-view';
import { markUnsavedEdit, useUnsavedEdit } from './unsaved-edits';

const openLink = (url: string) => void window.agentBoard.trackers.openLink(url).catch(() => {});

/** The agent's plans, read again whenever its latest one is presented or decided. */
function usePlans(agent: Agent): { plans: Plan[] | undefined; problem: string | undefined } {
  const [plans, setPlans] = useState<Plan[]>();
  const [problem, setProblem] = useState<string>();
  const { sessionId } = agent;
  const latest = `${agent.plan?.id}:${agent.plan?.decision?.outcome}`;
  useEffect(() => {
    let current = true;
    window.agentBoard.asks.plans(sessionId).then(
      (read) => {
        if (!current) return;
        setPlans(read);
        setProblem(undefined);
      },
      (error: unknown) => current && setProblem(errorMessage(error)),
    );
    return () => {
      current = false;
    };
  }, [sessionId, latest]);
  return { plans, problem };
}

interface PlanTabProps {
  agent: Agent;
  /** Whether its pane shows it, and its window shows its body. */
  visible: boolean;
  /** An HTML plan's page took the keyboard: its pane is the window's focused one. */
  onFocus(): void;
  /** One of the window's pane keys pressed in an HTML plan's page, for its pane; false for any other key. */
  onPaneKey(key: WebTabKey): boolean;
}

type PlanMode = 'read' | 'edit';

const MODES: readonly SegmentedOption<PlanMode>[] = [
  { id: 'read', label: 'Read' },
  { id: 'edit', label: 'Edit' },
];

/**
 * The Plan tab: an agent's plans as the Review tab shows rounds. A rail of its versions, each stamped with its
 * decision and whose it is; the one picked rendered (Markdown as the PR tab renders it; HTML in a locked-down view of its
 * own); and, while the agent waits on it, comments and Reject / Request changes / Approve under it. A Markdown plan the
 * agent waits on can be edited first: Edit splits it into its source and the live render, and Save makes the user's
 * version the next one, which the decision then applies to.
 */
export function PlanTab({ agent, visible, onFocus, onPaneKey }: PlanTabProps) {
  const { plans, problem } = usePlans(agent);
  const [picked, setPicked] = useState<string>();
  const [draft, setDraft] = useState<{ planId: string; text: string; from: string }>();
  if (plans === undefined || plans.length === 0) {
    return (
      <div className="review-viewer plan-viewer" data-testid="plan-view">
        <div className="plan-doc">
          {problem !== undefined ? <ErrorText>{problem}</ErrorText> : <p className="review-meta">{plans === undefined ? 'Reading its plans…' : `${agent.name} hasn’t presented a plan.`}</p>}
        </div>
      </div>
    );
  }
  const plan = shownPlan(plans, picked)!;
  const editable = plan.decision === null && plan.format === 'markdown';
  // A draft is of the version it began on: once that one is decided or edited, it goes.
  const editing = draft !== undefined && draft.planId === plan.id && editable;
  return (
    <div className="review-viewer plan-viewer" data-testid="plan-view">
      <nav className="review-rounds" aria-label="Versions">
        <div className="review-label review-rounds-head">Versions</div>
        {[...plans].reverse().map((each) => {
          const { label, tone } = planStamp(each);
          return (
            <button key={each.id} type="button" className="review-round" aria-current={each.id === plan.id} data-testid="plan-version" onClick={() => setPicked(each.id)}>
              <b>v{each.version}</b>
              <span className="plan-version-author" data-author={each.author}>
                {versionAuthor(each)}
              </span>
              <span className="review-round-verdict" data-tone={tone}>
                {label}
              </span>
              <span className="review-round-when">{shortWhen(each.presentedAt)}</span>
            </button>
          );
        })}
      </nav>
      <div className="plan-doc">
        <article className="plan-body" aria-label={`Plan v${plan.version}`} data-testid="plan-body" data-format={plan.format}>
          <header className="plan-head">
            <ClipboardList aria-hidden />
            <h4>{plan.title}</h4>
            <Tag mono>PLAN</Tag>
            <span className="review-meta">
              v{plan.version}
              {plan.author === 'user' && ' (yours)'}
            </span>
            {editable && (
              <Segmented<PlanMode>
                aria-label="Read or edit"
                value={editing ? 'edit' : 'read'}
                onChange={(next) => setDraft(next === 'edit' ? { planId: plan.id, text: plan.body, from: plan.body } : undefined)}
                options={MODES}
              />
            )}
          </header>
          {editing ? (
            <PlanEditor
              agent={agent}
              plan={plan}
              draft={draft.text}
              from={draft.from}
              onChange={(text) => setDraft({ ...draft, text })}
              onLeave={() => setDraft(undefined)}
              onSaved={(mine) => {
                setDraft(undefined);
                setPicked(mine.id);
              }}
            />
          ) : plan.format === 'html' ? (
            <PlanPage key={plan.id} html={plan.body} visible={visible} onFocus={onFocus} onPaneKey={onPaneKey} />
          ) : (
            <div className="plan-markdown">
              <Markdown text={plan.body} onOpenLink={openLink} />
            </div>
          )}
        </article>
        {plan.decision === null ? (
          <PlanDecisionBar agent={agent} plan={plan} />
        ) : (
          <PlanDecided plan={plan} />
        )}
      </div>
    </div>
  );
}

interface PlanEditorProps {
  agent: Agent;
  plan: PlanSummary;
  draft: string;
  /** The text the draft began from. */
  from: string;
  onChange(text: string): void;
  onLeave(): void;
  /** Saved as the user's version, `mine`. */
  onSaved(mine: PlanSummary): void;
}

/**
 * Edit, for a Markdown plan the agent waits on: its source beside the live render. ⌘S saves it as the user's version,
 * the plan's next, and esc leaves Edit, as in a document.
 */
function PlanEditor({ agent, plan, draft, from, onChange, onLeave, onSaved }: PlanEditorProps) {
  const save = useAction();
  const source = useRef<HTMLTextAreaElement>(null);
  useEffect(() => source.current?.focus(), []);
  const changed = changedLineCount(from, draft);
  // A changed draft holds every decision on this version, wherever it is made, until it is saved or dropped.
  const { sessionId } = agent;
  const unsaved = changed > 0;
  useEffect(() => {
    markUnsavedEdit(sessionId, plan.id, unsaved);
    return () => markUnsavedEdit(sessionId, plan.id, false);
  }, [sessionId, plan.id, unsaved]);
  const saveDraft = () => {
    if (changed > 0) save.run(() => window.agentBoard.asks.editPlan(agent.sessionId, plan.id, draft), onSaved);
  };
  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (pressed('window.saveDoc', event)) {
      event.preventDefault();
      event.stopPropagation();
      saveDraft();
    } else if (event.key === 'Escape') {
      // Kept from the board whatever the key setting, as in a document: an unsaved draft is never collapsed away.
      event.preventDefault();
      event.stopPropagation();
      if (pressed('window.leaveDocEdit', event)) onLeave();
    }
  };
  const saveKey = isActive(binding('window.saveDoc')) ? keyText('window.saveDoc') : undefined;
  const leaveKey = isActive(binding('window.leaveDocEdit')) ? keyText('window.leaveDocEdit') : undefined;
  return (
    <>
      <div className="doc-split plan-split" onKeyDown={onKey}>
        <Textarea ref={source} className="doc-source" aria-label={`Markdown of ${plan.title}`} spellCheck={false} value={draft} onChange={(event) => onChange(event.target.value)} />
        <div className="doc-render doc-markdown" aria-label="Preview">
          <Markdown text={draft} onOpenLink={openLink} />
        </div>
      </div>
      <footer className="doc-edit-bar" data-dirty={changed > 0 || undefined}>
        <span className="review-meta" data-testid="plan-edit-hint">
          {editHint(changed, saveKey, leaveKey, `makes it v${plan.version + 1}, yours`)}
        </span>
        {save.error && <ErrorText>{save.error}</ErrorText>}
        <Button size="sm" onClick={onLeave}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={save.busy || changed === 0} onClick={saveDraft}>
          Save
        </Button>
      </footer>
    </>
  );
}

/** What was decided on a version, and the comments sent with it. */
function PlanDecided({ plan }: { plan: PlanSummary }) {
  const decision = plan.decision!;
  const { label, tone } = planStamp(plan);
  return (
    <footer className="plan-decided" data-testid="plan-decided">
      <span className="review-round-verdict" data-tone={tone}>
        {label}
      </span>
      <span className="review-meta">{shortWhen(decision.decidedAt)}</span>
      {decision.comments !== '' && <blockquote className="plan-comments">{decision.comments}</blockquote>}
    </footer>
  );
}

interface PlanDecisionBarProps {
  agent: Agent;
  plan: PlanSummary;
  /** The inbox's single row, with a one-line field; the tab's field is taller. */
  compact?: boolean;
}

/**
 * The decision on a plan the agent waits on: comments for it, then Reject, Request changes and Approve, which each send
 * them. Request changes needs comments, unless the version is the user's own edit, whose diff says what to change; and
 * Approve then approves their edits. Held while the Plan tab has an unsaved edit of it. Shared by the Plan tab, the
 * inbox and a plan card.
 */
export function PlanDecisionBar({ agent, plan, compact = false }: PlanDecisionBarProps) {
  const [comments, setComments] = useState('');
  const { busy, error, run } = useAction();
  const decide = (outcome: PlanOutcome) => run(() => window.agentBoard.asks.decide(agent.sessionId, plan.id, outcome, comments).then(() => {}), () => setComments(''));
  const named = `plan v${plan.version} for ${agent.name}`;
  const mine = plan.author === 'user';
  const unsaid = comments.trim() === '' && !mine;
  // Never decided past an edit the user hasn't saved: the decision would drop it.
  const held = useUnsavedEdit(agent.sessionId, plan.id) ? 'Save or cancel your edit in the Plan tab first' : undefined;
  const stopped = busy || held !== undefined;
  return (
    <footer className="plan-decision" data-compact={compact || undefined} data-testid="plan-decision" data-author={plan.author}>
      <Textarea
        className="plan-decision-comments"
        rows={compact ? 1 : 3}
        aria-label={`Comments on ${named}`}
        placeholder={mine ? 'Comments (optional)…' : 'Comments for the agent…'}
        value={comments}
        onChange={(event) => setComments(event.target.value)}
      />
      <div className="plan-decision-actions">
        <Button size="sm" variant="danger" disabled={stopped} tooltip={held} aria-label={`Reject ${named}`} onClick={() => decide('rejected')}>
          Reject
        </Button>
        <Button
          size="sm"
          disabled={stopped || unsaid}
          tooltip={held ?? (unsaid ? 'Say what to change in the comments first' : undefined)}
          aria-label={`Request changes to ${named}`}
          onClick={() => decide('changes-requested')}
        >
          Request changes
        </Button>
        <Button size="sm" variant="primary" disabled={stopped} tooltip={held} aria-label={`Approve ${named}`} onClick={() => decide('approved')}>
          {approveLabel(plan)}
        </Button>
      </div>
      {held !== undefined && (
        <p className="review-meta plan-decision-note" data-testid="plan-held" role="status">
          You have an unsaved edit of this plan in its Plan tab: save or cancel it there to decide.
        </p>
      )}
      {mine && (
        <p className="review-meta plan-decision-note" data-testid="plan-mine">
          Approving approves your version (v{plan.version}), and the agent gets the diff.
        </p>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </footer>
  );
}

interface PlanPageProps {
  html: string;
  visible: boolean;
  onFocus(): void;
  onPaneKey(key: WebTabKey): boolean;
}

/**
 * An HTML plan's page: untrusted, so the main process draws it in a locked-down view of its own over this area, as a
 * web tab's page is drawn, served from memory, offline, going nowhere and opening nothing. Its scripts run there alone.
 * Each one is a view of its own, gone with its cookies and storage as it goes.
 */
export function PlanPage({ html, visible, onFocus, onPaneKey }: PlanPageProps) {
  const host = useRef<HTMLDivElement>(null);
  const [id] = useState(() => `plan-${crypto.randomUUID()}`);
  const [state, setState] = useState<WebTabState>();
  const latest = useRef({ onFocus, onPaneKey });
  latest.current = { onFocus, onPaneKey };
  const drawn = useWebViewBounds(id, host, visible);
  useEffect(() => {
    const close = window.agentBoard.webTabs.openPlan(id, html, {
      onState: (next) => {
        setState(next);
        if (next.focused) latest.current.onFocus();
      },
      onKey: (key) => {
        if (!latest.current.onPaneKey(key)) host.current?.dispatchEvent(new KeyboardEvent('keydown', { ...key, bubbles: true, cancelable: true }));
      },
    });
    return () => {
      close();
      void window.agentBoard.webTabs.forget(id).catch(() => {});
    };
    // Its page is the plan it was opened with: another version is another page.
  }, [id]);
  return (
    <>
      {state?.problem !== undefined && (
        <div className="web-problem plan-problem" data-testid="plan-problem">
          <ErrorText>{state.problem}</ErrorText>
        </div>
      )}
      <div className="web-page plan-page" ref={host} data-testid="plan-page" data-plan-view={id} data-web-tab={id} data-drawn={drawn || undefined}>
        <span className="web-page-under" aria-hidden>
          <ClipboardList />
          {state?.title || 'Plan'}
        </span>
      </div>
    </>
  );
}
