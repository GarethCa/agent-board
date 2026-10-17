import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { planPending, waitsOnUser, type Agent, type AgentAsk, type AskAnswer, type PermissionPrompt, type PlanSummary } from '@agent-board/daemon/protocol';
import { ClipboardList, SquareArrowOutUpRight, Timer } from 'lucide-react';
import { Button, EmptyState, ErrorText, Input, Kbd, StatusPill } from '../ui';
import { useAction } from '../use-action';
import { heldPrompts, needsYou, secondsLeft, toolSummary, waitLeft } from '../../../shared/needs-you';
import { PlanDecisionBar } from '../plan/PlanTab';
import { planSurfaceOf } from '../session/tabs';
import { requestTab } from '../session/tab-request';
import { agentPill } from '../states';
import { useNow } from './use-now';

interface InboxProps {
  agents: readonly Agent[];
  /** Opens the agent's session window. */
  onOpen(agent: Agent): void;
}

/**
 * The needs-you inbox: every agent waiting for input or needing permission, with what it last said or each tool call
 * it wants to make, answerable without opening its shell. It follows the agents live, so an item goes as soon as the
 * agent moves on, however it was answered. An item whose session was opened since it began asking is read: it stays
 * while the agent waits, but no longer counts.
 */
export function Inbox({ agents, onOpen }: InboxProps) {
  const items = needsYou(agents);
  const now = useNow(items.some((agent) => heldPrompts(agent).length > 0 || waitsOnUser(agent)));
  return (
    <section className="inbox" data-testid="needs-you-inbox" aria-label="Needs you">
      <header className="inbox-head">
        <h2>Needs you</h2>
        {items.length > 1 && <span className="inbox-order">oldest first</span>}
      </header>
      {items.length === 0 ? (
        <EmptyState framed={false} title="Nothing needs you.">
          Agents waiting for an answer or a permission show here.
        </EmptyState>
      ) : (
        <ul className="inbox-items">
          {items.map((agent) => (
            <InboxItem key={agent.sessionId} agent={agent} now={now} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </section>
  );
}

function InboxItem({ agent, now, onOpen }: { agent: Agent; now: number; onOpen(agent: Agent): void }) {
  const asking = agent.permissions.length > 0;
  return (
    <li className="inbox-item" data-testid="inbox-item" data-session-id={agent.sessionId} data-state={agent.state} data-read={agent.seen}>
      <div className="inbox-item-head">
        <span className="inbox-item-name">{agent.name}</span>
        <StatusPill {...agentPill(agent, undefined, asking ? 'needs-permission' : agent.state)} />
        <Button size="sm" variant="ghost" className="inbox-item-open" icon={<SquareArrowOutUpRight />} aria-label={`Open ${agent.name}`} onClick={() => onOpen(agent)}>
          Open
        </Button>
      </div>
      {asking ? (
        agent.permissions.map((prompt) => (
          // Keyed by request, so a new request never inherits an old one's error.
          <PermissionRow key={prompt.id} agent={agent} prompt={prompt} now={now} />
        ))
      ) : agent.state === 'needs-permission' ? (
        <p className="inbox-item-note">Asking for permission in its terminal.</p>
      ) : agent.ask !== null ? (
        // Keyed by question, so a new one never inherits an old one's reply or error.
        <AskRow key={agent.ask.id} agent={agent} ask={agent.ask} now={now} />
      ) : planPending(agent) ? (
        <PlanRow
          key={agent.plan.id}
          agent={agent}
          plan={agent.plan}
          now={now}
          onShow={() => {
            requestTab(agent.sessionId, planSurfaceOf(agent.sessionId));
            onOpen(agent);
          }}
        />
      ) : (
        <Answer agent={agent} />
      )}
    </li>
  );
}

/**
 * A question an agent asks through the board: each option a button that answers in one click (keys 1–9
 * while the card has focus), and with `freeText` a reply field and Send. A timer line says how long it waits, then
 * that it carries on without an answer, with Skip.
 */
function AskRow({ agent, ask, now }: { agent: Agent; ask: AgentAsk; now: number }) {
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  const answer = (given: AskAnswer) => run(() => window.agentBoard.asks.answer(agent.sessionId, ask.id, given));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() !== '') answer({ text });
  };
  const pick = (event: KeyboardEvent) => {
    // Digits typed into the reply field are words, not picks.
    if (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey || event.altKey) return;
    const option = Number(event.key) - 1;
    if (!Number.isInteger(option) || option < 0 || option >= ask.options.length) return;
    event.preventDefault();
    answer({ option });
  };
  return (
    <form className="inbox-ask" data-testid="inbox-ask" onSubmit={submit} onKeyDown={pick}>
      <p className="inbox-ask-question">{ask.question}</p>
      {ask.options.length > 0 && (
        <div className="inbox-ask-options" role="group" aria-label={`Answers for ${agent.name}`}>
          {ask.options.map((option, index) => (
            <Button key={index} size="sm" className="inbox-ask-option" disabled={busy} aria-keyshortcuts={index < 9 ? String(index + 1) : undefined} onClick={() => answer({ option: index })}>
              {option}
              {index < 9 && <Kbd aria-hidden>{index + 1}</Kbd>}
            </Button>
          ))}
        </div>
      )}
      {ask.freeText && (
        <div className="inbox-item-actions">
          <Input
            size="sm"
            aria-label={`Reply to ${agent.name}`}
            placeholder={ask.options.length > 0 ? 'Or reply in your own words…' : 'Answer…'}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit" size="sm" variant="primary" loading={busy} disabled={text.trim() === ''} aria-label={`Send to ${agent.name}`}>
            Send
          </Button>
        </div>
      )}
      <p className="inbox-ask-timer">
        <Timer aria-hidden />
        <span>Waits {waitLeft(ask.expiresAt, now)}, then carries on without an answer</span>
        <span aria-hidden>·</span>
        <button type="button" className="inbox-ask-skip" disabled={busy} aria-label={`Skip ${agent.name}'s question`} onClick={() => answer({ skip: true })}>
          Skip
        </button>
      </p>
      {error && <ErrorText>{error}</ErrorText>}
    </form>
  );
}

/** A plan an agent waits on: its title and version, Show plan, which opens its Plan tab, and the decision. */
function PlanRow({ agent, plan, now, onShow }: { agent: Agent; plan: PlanSummary; now: number; onShow(): void }) {
  return (
    <div className="inbox-plan" data-testid="inbox-plan">
      <div className="inbox-plan-head">
        <ClipboardList aria-hidden />
        <span className="inbox-plan-title">{plan.title}</span>
        <span className="inbox-plan-version">v{plan.version}</span>
        <Button size="sm" variant="ghost" aria-label={`Show ${agent.name}'s plan`} onClick={onShow}>
          Show plan
        </Button>
      </div>
      <PlanDecisionBar agent={agent} plan={plan} compact />
      <p className="inbox-ask-timer">
        <Timer aria-hidden />
        <span>Waits {waitLeft(plan.expiresAt, now)} for your decision</span>
      </p>
    </div>
  );
}

function PermissionRow({ agent, prompt, now }: { agent: Agent; prompt: PermissionPrompt; now: number }) {
  const { busy, error, run } = useAction();
  const decide = (behavior: 'allow' | 'deny') =>
    run(() => window.agentBoard.agents.decidePermission(agent.sessionId, prompt.id, { behavior }));
  const summary = toolSummary(prompt);
  return (
    <div className="inbox-prompt" data-testid="inbox-prompt" data-held={prompt.heldUntil !== null}>
      <p className="inbox-item-tool">
        {prompt.subagent ? `Its ${prompt.subagent.type} subagent wants` : 'Wants'} to use <strong>{prompt.toolName}</strong>
      </p>
      {summary && (
        <code className="inbox-item-input" data-testid="inbox-tool-input" title={summary}>
          {summary}
        </code>
      )}
      {prompt.heldUntil !== null ? (
        <div className="inbox-item-actions">
          <span className="inbox-prompt-countdown" title="Then its terminal asks instead">
            {secondsLeft(prompt, now)} s
          </span>
          <Button size="sm" variant="danger" disabled={busy} aria-label={`Deny ${prompt.toolName} for ${agent.name}`} onClick={() => decide('deny')}>
            Deny
          </Button>
          <Button size="sm" variant="primary" disabled={busy} aria-label={`Allow ${prompt.toolName} for ${agent.name}`} onClick={() => decide('allow')}>
            Allow
          </Button>
        </div>
      ) : (
        <p className="inbox-item-note">Asking in its terminal now: open it to answer.</p>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </div>
  );
}

function Answer({ agent }: { agent: Agent }) {
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() !== '') run(() => window.agentBoard.agents.answer(agent.sessionId, text), () => setText(''));
  };
  return (
    <form className="inbox-item-answer" onSubmit={submit}>
      {agent.lastMessage && (
        <blockquote className="inbox-item-message" data-testid="inbox-last-message" title={agent.lastMessage}>
          {agent.lastMessage}
        </blockquote>
      )}
      <div className="inbox-item-actions">
        <Input size="sm" aria-label={`Answer ${agent.name}`} placeholder="Answer…" value={text} onChange={(event) => setText(event.target.value)} />
        <Button type="submit" size="sm" variant="primary" loading={busy} disabled={text.trim() === ''} aria-label={`Send to ${agent.name}`}>
          Send
        </Button>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
    </form>
  );
}

/**
 * Says why an agent's terminal shows no permission prompt yet: the daemon is holding its request for the inbox.
 * Nothing while none is held.
 */
export function HeldPromptsNotice({ agent }: { agent: Agent }) {
  const held = heldPrompts(agent);
  const now = useNow(held.length > 0);
  if (held.length === 0) return null;
  const seconds = Math.max(...held.map((prompt) => secondsLeft(prompt, now)));
  const tools = [...new Set(held.map((prompt) => prompt.toolName))].join(', ');
  return (
    <p className="held-notice" data-testid="held-prompts-notice">
      {tools} is held for an answer in the Needs you inbox. Answer it there, or here once this terminal asks (within{' '}
      {seconds} s).
    </p>
  );
}
