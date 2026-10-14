import { useState, type FormEvent } from 'react';
import type { Agent, PermissionPrompt } from '@agent-board/daemon/protocol';
import { SquareArrowOutUpRight } from 'lucide-react';
import { Button, EmptyState, ErrorText, Input, StatusPill } from '../ui';
import { useAction } from '../use-action';
import { heldPrompts, needsYou, secondsLeft, toolSummary } from '../../../shared/needs-you';
import { STATE_LABELS } from '../states';
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
  const now = useNow(items.some((agent) => heldPrompts(agent).length > 0));
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
        <StatusPill state={agent.seen ? 'idle' : asking ? 'needs-permission' : agent.state} label={agent.seen ? STATE_LABELS[asking ? 'needs-permission' : agent.state] : undefined} />
        <Button size="sm" variant="ghost" className="inbox-item-open" icon={<SquareArrowOutUpRight />} onClick={() => onOpen(agent)}>
          Open
        </Button>
      </div>
      {asking ? (
        agent.permissions.map((prompt) => (
          // Keyed by request, so a new request never inherits an old one's error.
          <PermissionRow key={prompt.id} sessionId={agent.sessionId} prompt={prompt} now={now} />
        ))
      ) : agent.state === 'needs-permission' ? (
        <p className="inbox-item-note">Asking for permission in its terminal.</p>
      ) : (
        <Answer agent={agent} />
      )}
    </li>
  );
}

function PermissionRow({ sessionId, prompt, now }: { sessionId: string; prompt: PermissionPrompt; now: number }) {
  const { busy, error, run } = useAction();
  const decide = (behavior: 'allow' | 'deny') =>
    run(() => window.agentBoard.agents.decidePermission(sessionId, prompt.id, { behavior }));
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
          <Button size="sm" variant="danger" disabled={busy} onClick={() => decide('deny')}>
            Deny
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => decide('allow')}>
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
        <Input size="sm" aria-label="Answer" placeholder="Answer…" value={text} onChange={(event) => setText(event.target.value)} />
        <Button type="submit" size="sm" variant="primary" loading={busy} disabled={text.trim() === ''}>
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
