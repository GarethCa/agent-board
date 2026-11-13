import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { ArrowUp, ClipboardList, MessageCircleQuestion, ShieldQuestion } from 'lucide-react';
import type { Agent, AgentAsk, PermissionPrompt, PlanSummary } from '@agent-board/daemon/protocol';
import { Button, ErrorText, IconButton, Input, Kbd } from '../ui';
import { useAskAnswer } from '../inbox/use-ask-answer';
import { PlanDecisionBar } from '../plan/PlanTab';
import { keyText, pressed } from '../keys/registry';
import { useNow } from '../inbox/use-now';
import { PermissionButtons, lowerFirst, usePermissionDecision } from '../inbox/permission-decision';
import { askAnsweredElsewhere, permissionWaitLine } from '../../../shared/needs-you';
import { permissionSentence } from '../../../shared/permission-sentence';
import { QuickAsk, type QuickAskDrafts } from '../board/QuickAsk';
import { dialogStatus, firstOpen, isDialogPrompt, type DialogPrompt } from '../board/quick-ask';
import { DialogQuickAsk } from '../board/DialogQuickAsk';
import { PlanPromptRow } from '../inbox/PlanPromptRow';
import { useQuickAskActions } from '../board/TileQuickAsk';
import { decisionId, deferDecision, deferredDecision, paneDecision, useDeferredDecisions } from './pane-decision';

interface PaneDecisionsProps {
  agent: Agent;
  /** Opens the agent's Plan tab, where the plan is read in full; absent where there are no tabs. */
  onReadPlan?(): void;
  /** Shows the agent's terminal, where the harness asks itself; absent where there is none. */
  onShowTerminal?(): void;
  /** The chat colours the cards are drawn in, as the composer under them is. */
  chatTheme?: string;
}

/**
 * The question or plan an agent waits on, above its pane's composer under the Simplified design, answered where the user
 * types: a question's numbered choices (keys 1–9 while it has focus) and, if it takes words, a reply; a plan's comments
 * and Reject · Request changes · Approve (⌘↵). Nothing is answered but by a click or a key the user presses. Decide later
 * (Esc) puts it off: it stays pending, in Needs you and on its tile, and a line above the composer brings it back. It
 * stays put off while the app runs, whether the window closes or its view changes.
 */
export function PaneDecisions({ agent, onReadPlan, onShowTerminal, chatTheme }: PaneDecisionsProps) {
  const deferred = useDeferredDecisions();
  const decision = paneDecision(agent, deferred);
  const putOff = deferredDecision(agent, deferred);
  if (decision !== undefined) {
    const onDefer = () => deferDecision(decisionId(decision));
    if (decision.kind === 'permission' && isDialogPrompt(decision.prompt) && dialogStatus(decision.prompt) !== 'terminal') {
      return <DialogDecision key={decision.prompt.id} agent={agent} prompt={decision.prompt} onDefer={onDefer} onShowTerminal={onShowTerminal} chatTheme={chatTheme} />;
    }
    if (decision.kind === 'permission' && decision.prompt.plan !== null) {
      return <ClaudePlanDecision key={decision.prompt.id} agent={agent} prompt={decision.prompt} plan={decision.prompt.plan} onDefer={onDefer} onShowTerminal={onShowTerminal} chatTheme={chatTheme} />;
    }
    if (decision.kind === 'permission') {
      return <PermissionCard key={decision.prompt.id} agent={agent} prompt={decision.prompt} onDefer={onDefer} onShowTerminal={onShowTerminal} chatTheme={chatTheme} />;
    }
    return decision.kind === 'ask' ? (
      <AskDecision key={decision.ask.id} agent={agent} ask={decision.ask} onDefer={onDefer} chatTheme={chatTheme} />
    ) : (
      <PlanDecision key={decision.plan.id} agent={agent} plan={decision.plan} onDefer={onDefer} onReadPlan={onReadPlan} chatTheme={chatTheme} />
    );
  }
  if (putOff === undefined) return null;
  return (
    <div className="pane-decision-later" data-chat-theme={chatTheme} data-testid="pane-decision-later" role="status">
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
function AskDecision({ agent, ask, onDefer, chatTheme }: { agent: Agent; ask: AgentAsk; onDefer(): void; chatTheme?: string }) {
  // Several questions are stepped through here as on its tile; one on the board is answered on its card.
  if (ask.card === null && ask.questions.length > 1) return <QuickAskDecision agent={agent} ask={ask} onDefer={onDefer} chatTheme={chatTheme} />;
  return <OneAskDecision agent={agent} ask={ask} onDefer={onDefer} chatTheme={chatTheme} />;
}

/** Claude's own question dialog: the quick ask, as for an ask, sending to its dialog. */
function DialogDecision({ agent, prompt, onDefer, onShowTerminal, chatTheme }: { agent: Agent; prompt: DialogPrompt; onDefer(): void; onShowTerminal?(): void; chatTheme?: string }) {
  const decideLater = useDecideLater(onDefer);
  return (
    <section className="pane-decision" data-chat-theme={chatTheme} data-testid="pane-decision" data-kind="dialog" aria-label={`${agent.name}'s questions`} onKeyDown={decideLater}>
      <DialogQuickAsk sessionId={agent.sessionId} name={agent.name} prompt={prompt} onOpen={onShowTerminal} still={false} />
      <footer className="pane-decision-foot">
        <DecideLater onDefer={onDefer} />
      </footer>
    </section>
  );
}

/** Claude's plan approval, in its words (P1): the row Needs you draws, with Decide later. */
function ClaudePlanDecision({ agent, prompt, plan, onDefer, onShowTerminal, chatTheme }: { agent: Agent; prompt: PermissionPrompt; plan: string; onDefer(): void; onShowTerminal?(): void; chatTheme?: string }) {
  const decideLater = useDecideLater(onDefer);
  return (
    <section className="pane-decision" data-chat-theme={chatTheme} data-testid="pane-decision" data-kind="claude-plan" aria-label={`${agent.name}'s plan`} onKeyDown={decideLater}>
      <PlanPromptRow agent={agent} prompt={prompt} plan={plan} onOpen={onShowTerminal} />
      <footer className="pane-decision-foot">
        <DecideLater onDefer={onDefer} />
      </footer>
    </section>
  );
}

/** An ask of several questions: the quick ask itself, one question at a time, then the answers and Send. */
function QuickAskDecision({ agent, ask, onDefer, chatTheme }: { agent: Agent; ask: AgentAsk; onDefer(): void; chatTheme?: string }) {
  const [at, setAt] = useState(() => firstOpen(ask));
  const { actions, error, busy } = useQuickAskActions(agent.sessionId, ask.id);
  const decideLater = useDecideLater(onDefer);
  // Keyed by its ask, the pane is new for each: what is typed but not given lasts as long as it does.
  const [drafts] = useState<QuickAskDrafts>(() => new Map());
  return (
    <section
      className="pane-decision"
      data-chat-theme={chatTheme}
      data-testid="pane-decision"
      data-kind="ask"
      aria-label={`${agent.name}'s questions`}
      onKeyDown={decideLater}
    >
      <QuickAsk name={agent.name} ask={ask} at={Math.min(at, ask.questions.length)} onAt={setAt} actions={actions} busy={busy} drafts={drafts} />
      <footer className="pane-decision-foot">
        <DecideLater onDefer={onDefer} />
      </footer>
      {error && <ErrorText>{error}</ErrorText>}
    </section>
  );
}

function OneAskDecision({ agent, ask, onDefer, chatTheme }: { agent: Agent; ask: AgentAsk; onDefer(): void; chatTheme?: string }) {
  const { text, setText, busy, error, answer, submit, pick } = useAskAnswer(agent.sessionId, ask);
  const elsewhere = askAnsweredElsewhere(ask);
  const frame = useRef<HTMLElement>(null);
  const decideLater = useDecideLater(onDefer);
  useTakeFocus(frame);
  return (
    <section
      ref={frame}
      tabIndex={-1}
      className="pane-decision"
      data-chat-theme={chatTheme}
      data-testid="pane-decision"
      data-kind="ask"
      aria-label={`${agent.name}'s question`}
      onKeyDown={(event) => {
        decideLater(event);
        if (elsewhere === undefined) pick(event);
      }}
    >
      <p className="pane-decision-from">{agent.name} asks</p>
      <p className="pane-decision-question">{ask.question}</p>
      {elsewhere !== undefined && <p className="pane-decision-from">{elsewhere}</p>}
      {elsewhere === undefined && ask.options.length > 0 && (
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
      {elsewhere === undefined && ask.freeText && (
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
function PlanDecision({ agent, plan, onDefer, onReadPlan, chatTheme }: { agent: Agent; plan: PlanSummary; onDefer(): void; onReadPlan?(): void; chatTheme?: string }) {
  const decideLater = useDecideLater(onDefer);
  const frame = useRef<HTMLElement>(null);
  useTakeFocus(frame, '.plan-decision-comments');
  return (
    <section ref={frame} tabIndex={-1} className="pane-decision" data-chat-theme={chatTheme} data-testid="pane-decision" data-kind="plan" aria-label={`${agent.name}'s plan`} onKeyDown={decideLater}>
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

/**
 * A permission prompt the board holds the harness's hook for: what the call does in a plain sentence, what it does it to,
 * and the buttons its TUI menu has (`PermissionButtons`, shared with the Needs-you list). A destructive command
 * (`permissionSentence`) has Deny and Review… only, no Allow and no default: Review… shows the terminal, where the
 * harness asks as its own menu does once the hold lapses (the countdown says when). The card only relays a click; it
 * never answers on its own, and Esc only puts it off.
 */
function PermissionCard({ agent, prompt, onDefer, onShowTerminal, chatTheme }: { agent: Agent; prompt: PermissionPrompt; onDefer(): void; onShowTerminal?(): void; chatTheme?: string }) {
  const state = usePermissionDecision(agent, prompt);
  const now = useNow(true);
  const frame = useRef<HTMLElement>(null);
  const decideLater = useDecideLater(onDefer);
  useTakeFocus(frame);
  const { call, error } = state;
  return (
    <section
      ref={frame}
      tabIndex={-1}
      className="pane-decision"
      data-chat-theme={chatTheme}
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
        {permissionWaitLine(prompt, agent.name, now)}
      </p>
      <footer className="pane-decision-foot pane-decision-actions">
        <DecideLater onDefer={onDefer} />
        <PermissionButtons agent={agent} prompt={prompt} state={state} onReview={onShowTerminal} />
      </footer>
      {error && <ErrorText>{error}</ErrorText>}
    </section>
  );
}
