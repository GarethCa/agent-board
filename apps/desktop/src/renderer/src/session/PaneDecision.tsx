import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { ArrowUp, ClipboardList, MessageCircleQuestion, ShieldQuestion } from 'lucide-react';
import type { Agent, AgentAsk, PermissionDecision, PermissionPrompt, PlanSummary } from '@agent-board/daemon/protocol';
import { Button, ErrorText, IconButton, Input, Kbd } from '../ui';
import { useAskAnswer } from '../inbox/use-ask-answer';
import { PlanDecisionBar } from '../plan/PlanTab';
import { keyText, pressed } from '../keys/registry';
import { useNow } from '../inbox/use-now';
import { useAction } from '../use-action';
import { secondsLeft } from '../../../shared/needs-you';
import { permissionSentence } from '../../../shared/permission-sentence';
import { decisionId, deferDecision, deferredDecision, paneDecision, useDeferredDecisions } from './pane-decision';

interface PaneDecisionsProps {
  agent: Agent;
  /** Opens the agent's Plan tab, where the plan is read in full; absent where there are no tabs. */
  onReadPlan?(): void;
  /** Shows the agent's terminal, where the harness asks itself; absent where there is none. */
  onShowTerminal?(): void;
}

/**
 * The question or plan an agent waits on, above its pane's composer under the Simplified design, answered where the user
 * types: a question's numbered choices (keys 1–9 while it has focus) and, if it takes words, a reply; a plan's comments
 * and Reject · Request changes · Approve (⌘↵). Nothing is answered but by a click or a key the user presses. Decide later
 * (Esc) puts it off: it stays pending, in Needs you and on its tile, and a line above the composer brings it back. It
 * stays put off while the app runs, whether the window closes or its view changes.
 */
export function PaneDecisions({ agent, onReadPlan, onShowTerminal }: PaneDecisionsProps) {
  const deferred = useDeferredDecisions();
  const decision = paneDecision(agent, deferred);
  const putOff = deferredDecision(agent, deferred);
  if (decision !== undefined) {
    const onDefer = () => deferDecision(decisionId(decision));
    if (decision.kind === 'permission') {
      return <PermissionCard key={decision.prompt.id} agent={agent} prompt={decision.prompt} onDefer={onDefer} onShowTerminal={onShowTerminal} />;
    }
    return decision.kind === 'ask' ? (
      <AskDecision key={decision.ask.id} agent={agent} ask={decision.ask} onDefer={onDefer} />
    ) : (
      <PlanDecision key={decision.plan.id} agent={agent} plan={decision.plan} onDefer={onDefer} onReadPlan={onReadPlan} />
    );
  }
  if (putOff === undefined) return null;
  return (
    <div className="pane-decision-later" data-testid="pane-decision-later" role="status">
      {putOff.kind === 'permission' ? <ShieldQuestion aria-hidden /> : putOff.kind === 'ask' ? <MessageCircleQuestion aria-hidden /> : <ClipboardList aria-hidden />}
      <span className="pane-decision-later-text">
        {putOff.kind === 'permission' ? `${agent.name} asked to ${lowerFirst(permissionSentence(putOff.prompt).sentence)}` : putOff.kind === 'ask' ? `${agent.name} asked you a question` : `Plan v${putOff.plan.version} waits for your decision`}
      </span>
      <Button size="xs" variant="ghost" onClick={() => deferDecision(decisionId(putOff), false)}>
        {putOff.kind === 'ask' ? 'Answer' : putOff.kind === 'plan' ? 'Decide' : 'Review'}
      </Button>
    </div>
  );
}

/**
 * Puts the keyboard on the card as it shows, so its keys (1–9, Esc, ⌘↵) work at once, unless the user is typing in a
 * field (the composer, a terminal), whose keys stay theirs. A question's card itself takes the focus, not a choice, so a
 * Return meant for elsewhere never answers it; a plan's puts it in its comments (`target`), where Return is a new line.
 */
function useTakeFocus(frame: RefObject<HTMLElement | null>, target?: string) {
  useEffect(() => {
    const active = document.activeElement;
    const typing = active instanceof HTMLElement && (active.isContentEditable || active.matches('input, textarea, select'));
    if (typing) return;
    const card = frame.current;
    (target === undefined ? card : (card?.querySelector<HTMLElement>(target) ?? card))?.focus({ preventScroll: true });
  }, [frame, target]);
}

/** Esc, pressed in the frame, puts the decision off rather than closing the window. */
function useDecideLater(onDefer: () => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented || !pressed('window.decideLater', event)) return;
    event.preventDefault();
    event.stopPropagation();
    onDefer();
  };
}

/** Decide later, at the frame's leading edge, with its key. */
function DecideLater({ onDefer }: { onDefer(): void }) {
  return (
    <Button size="sm" variant="ghost" className="pane-decision-later-button" onClick={onDefer}>
      Decide later
      <Kbd aria-hidden>{keyText('window.decideLater')}</Kbd>
    </Button>
  );
}

/** A question: who asks and what, then a numbered row per choice, the card taking the keyboard as it shows. */
function AskDecision({ agent, ask, onDefer }: { agent: Agent; ask: AgentAsk; onDefer(): void }) {
  const { text, setText, busy, error, answer, submit, pick } = useAskAnswer(agent.sessionId, ask);
  const frame = useRef<HTMLElement>(null);
  const decideLater = useDecideLater(onDefer);
  useTakeFocus(frame);
  return (
    <section
      ref={frame}
      tabIndex={-1}
      className="pane-decision"
      data-testid="pane-decision"
      data-kind="ask"
      aria-label={`${agent.name}'s question`}
      onKeyDown={(event) => {
        decideLater(event);
        pick(event);
      }}
    >
      <p className="pane-decision-from">{agent.name} asks</p>
      <p className="pane-decision-question">{ask.question}</p>
      {ask.options.length > 0 && (
        <div className="pane-decision-choices" role="group" aria-label={`Answers for ${agent.name}`}>
          {ask.options.map((option, index) => (
            <button
              key={index}
              type="button"
              className="pane-decision-choice"
              disabled={busy}
              aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
              onClick={() => answer({ option: index })}
            >
              {index < 9 && (
                <span className="pane-decision-number" aria-hidden>
                  {index + 1}
                </span>
              )}
              <span className="pane-decision-choice-text">{option}</span>
            </button>
          ))}
        </div>
      )}
      {ask.freeText && (
        <form className="pane-decision-reply" onSubmit={submit}>
          <Input
            size="sm"
            aria-label={`Reply to ${agent.name}`}
            placeholder={ask.options.length > 0 ? 'Something else…' : 'Answer…'}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <IconButton type="submit" variant="primary" icon={<ArrowUp />} aria-label={`Send to ${agent.name}`} loading={busy} disabled={text.trim() === ''} />
        </form>
      )}
      <footer className="pane-decision-foot">
        <DecideLater onDefer={onDefer} />
      </footer>
      {error && <ErrorText>{error}</ErrorText>}
    </section>
  );
}

/** A plan: its version and title, Read the plan, then the decision bar with Reject kept and Approve trailing. */
function PlanDecision({ agent, plan, onDefer, onReadPlan }: { agent: Agent; plan: PlanSummary; onDefer(): void; onReadPlan?(): void }) {
  const decideLater = useDecideLater(onDefer);
  const frame = useRef<HTMLElement>(null);
  useTakeFocus(frame, '.plan-decision-comments');
  return (
    <section ref={frame} tabIndex={-1} className="pane-decision" data-testid="pane-decision" data-kind="plan" aria-label={`${agent.name}'s plan`} onKeyDown={decideLater}>
      <div className="pane-decision-head">
        <span className="pane-decision-kind">
          <ClipboardList aria-hidden />
          Plan v{plan.version}
        </span>
        <span className="pane-decision-title">{plan.title}</span>
        {onReadPlan && (
          <Button size="xs" variant="ghost" className="pane-decision-read" onClick={onReadPlan}>
            Read the plan ›
          </Button>
        )}
      </div>
      <PlanDecisionBar agent={agent} plan={plan} compact approveKey />
      <footer className="pane-decision-foot">
        <DecideLater onDefer={onDefer} />
      </footer>
    </section>
  );
}

/** `text` with its first letter lower-cased, to carry on a sentence; the rest, a tool's name or a path, is as it is. */
const lowerFirst = (text: string): string => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

/** How long a card that has just shown ignores clicks, so a second click meant for the last one can't answer it unread. */
const ARM_AFTER_MS = 400;

/**
 * A permission prompt the board holds the harness's hook for: what the call does in a plain sentence, what it does it to,
 * and the buttons its TUI menu has: Deny, Allow for this session (only where the harness suggested a rule to allow) and
 * Allow once at the trailing edge. A destructive command (`permissionSentence`) has Deny and Review… only, no Allow and
 * no default: Review… shows the terminal, where the harness asks as its own menu does once the hold lapses (the countdown
 * says when). The card only relays a click; it never answers on its own, and Esc only puts it off.
 */
function PermissionCard({ agent, prompt, onDefer, onShowTerminal }: { agent: Agent; prompt: PermissionPrompt; onDefer(): void; onShowTerminal?(): void }) {
  const { busy, error, run } = useAction();
  const now = useNow(true);
  const frame = useRef<HTMLElement>(null);
  const decideLater = useDecideLater(onDefer);
  useTakeFocus(frame);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ARM_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  const call = permissionSentence(prompt);
  const decide = (decision: PermissionDecision) => run(() => window.agentBoard.agents.decidePermission(agent.sessionId, prompt.id, decision));
  // Review… lets the harness ask now rather than when the hold lapses, then shows where it asks.
  const review = () => run(() => window.agentBoard.agents.releasePermission(agent.sessionId, prompt.id), onShowTerminal);
  return (
    <section
      ref={frame}
      tabIndex={-1}
      className="pane-decision"
      data-testid="pane-decision"
      data-kind="permission"
      data-destructive={call.destructive || undefined}
      aria-label={`${agent.name}'s permission request`}
      onKeyDown={decideLater}
    >
      <p className="pane-decision-from">{prompt.subagent ? `${agent.name}'s ${prompt.subagent.type} subagent wants to` : `${agent.name} wants to`}</p>
      <p className="pane-decision-question" data-testid="permission-sentence">
        {call.sentence}
      </p>
      {call.detail !== '' && (
        <code className="pane-decision-detail" data-testid="permission-detail" title={call.detail}>
          {call.detail}
        </code>
      )}
      <p className="pane-decision-countdown" data-testid="permission-countdown">
        {call.destructive ? 'This can’t be undone. ' : ''}
        {prompt.asksInTerminal ? 'Its terminal asks too' : `Then its terminal asks · ${secondsLeft(prompt, now)} s`}
      </p>
      <footer className="pane-decision-foot pane-decision-actions">
        <DecideLater onDefer={onDefer} />
        <Button size="sm" variant="danger" disabled={busy || !armed} aria-label={`Deny ${prompt.toolName} for ${agent.name}`} onClick={() => decide({ behavior: 'deny' })}>
          Deny
        </Button>
        {call.destructive ? (
          onShowTerminal && (
            <Button size="sm" variant="primary" disabled={busy || !armed} onClick={review}>
              Review…
            </Button>
          )
        ) : (
          <>
            {prompt.sessionGrant !== null && (
              <Button size="sm" className="pane-decision-grant" disabled={busy || !armed} title={`Allow ${prompt.sessionGrant} for this session`} onClick={() => decide({ behavior: 'allow', scope: 'session' })}>
                Allow {prompt.sessionGrant} for this session
              </Button>
            )}
            <Button size="sm" variant="primary" disabled={busy || !armed} onClick={() => decide({ behavior: 'allow' })}>
              Allow once
            </Button>
          </>
        )}
      </footer>
      {error && <ErrorText>{error}</ErrorText>}
    </section>
  );
}
