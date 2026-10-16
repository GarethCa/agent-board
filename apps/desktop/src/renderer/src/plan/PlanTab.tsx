import { useEffect, useRef, useState } from 'react';
import { ClipboardList } from 'lucide-react';
import type { Agent, Plan, PlanOutcome, PlanSummary } from '@agent-board/daemon/protocol';
import type { WebTabKey, WebTabState } from '../../../preload/api';
import { errorMessage } from '../../../shared/errors';
import { Markdown } from '../session/Markdown';
import { useWebViewBounds } from '../session/use-web-view';
import { Button, ErrorText, Textarea } from '../ui';
import { useAction } from '../use-action';
import { shortWhen } from '../when';
import { planStamp, shownPlan } from './plan-view';

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

/**
 * The Plan tab (BO2): an agent's plans as the Review tab shows rounds. A rail of its versions, each stamped
 * with its decision; the one picked rendered (Markdown as the PR tab renders it; HTML in a locked-down view of its own);
 * and, while the agent waits on it, comments and Reject / Request changes / Approve under it.
 */
export function PlanTab({ agent, visible, onFocus, onPaneKey }: PlanTabProps) {
  const { plans, problem } = usePlans(agent);
  const [picked, setPicked] = useState<string>();
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
  return (
    <div className="review-viewer plan-viewer" data-testid="plan-view">
      <nav className="review-rounds" aria-label="Versions">
        <div className="review-label review-rounds-head">Versions</div>
        {[...plans].reverse().map((each) => {
          const { label, tone } = planStamp(each);
          return (
            <button key={each.id} type="button" className="review-round" aria-current={each.id === plan.id} data-testid="plan-version" onClick={() => setPicked(each.id)}>
              <b>v{each.version}</b>
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
            <span className="review-meta">v{plan.version}</span>
          </header>
          {plan.format === 'html' ? (
            <PlanPage key={plan.id} html={plan.body} visible={visible} onFocus={onFocus} onPaneKey={onPaneKey} />
          ) : (
            <div className="plan-markdown">
              <Markdown text={plan.body} onOpenLink={openLink} />
            </div>
          )}
        </article>
        {plan.decision === null ? <PlanDecisionBar agent={agent} plan={plan} /> : <PlanDecided plan={plan} />}
      </div>
    </div>
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
 * them. Request changes needs comments. Shared by the Plan tab and the inbox.
 */
export function PlanDecisionBar({ agent, plan, compact = false }: PlanDecisionBarProps) {
  const [comments, setComments] = useState('');
  const { busy, error, run } = useAction();
  const decide = (outcome: PlanOutcome) => run(() => window.agentBoard.asks.decide(agent.sessionId, plan.id, outcome, comments).then(() => {}), () => setComments(''));
  const named = `plan v${plan.version} for ${agent.name}`;
  return (
    <footer className="plan-decision" data-compact={compact || undefined} data-testid="plan-decision">
      <Textarea
        className="plan-decision-comments"
        rows={compact ? 1 : 3}
        aria-label={`Comments on ${named}`}
        placeholder="Comments for the agent…"
        value={comments}
        onChange={(event) => setComments(event.target.value)}
      />
      <div className="plan-decision-actions">
        <Button size="sm" variant="danger" disabled={busy} aria-label={`Reject ${named}`} onClick={() => decide('rejected')}>
          Reject
        </Button>
        <Button
          size="sm"
          disabled={busy || comments.trim() === ''}
          tooltip={comments.trim() === '' ? 'Say what to change in the comments first' : undefined}
          aria-label={`Request changes to ${named}`}
          onClick={() => decide('changes-requested')}
        >
          Request changes
        </Button>
        <Button size="sm" variant="primary" disabled={busy} aria-label={`Approve ${named}`} onClick={() => decide('approved')}>
          Approve
        </Button>
      </div>
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
function PlanPage({ html, visible, onFocus, onPaneKey }: PlanPageProps) {
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
