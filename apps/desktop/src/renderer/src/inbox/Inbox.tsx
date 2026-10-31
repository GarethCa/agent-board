import { useState, type FormEvent } from 'react';
import { planPending, waitsOnUser, type Agent, type AgentAsk, type AgentFlag, type NeedsYouKind, type PlanSummary } from '@agent-board/daemon/protocol';
import { ClipboardList, FolderCheck, SendHorizontal, SquareArrowOutUpRight, Timer } from 'lucide-react';
import { Button, EmptyState, ErrorText, Input, Kbd } from '../ui';
import { useAction } from '../use-action';
import { PermissionRow } from './PermissionRow';
import { KIND_TAGS } from './kind-tags';
import { HarnessMark } from '../board/HarnessMark';
import { HARNESSES } from '../harness';
import { heldPrompts, needsYouEntries, secondsLeft, sinceText, waitLeft } from '../../../shared/needs-you';
import { PlanDecisionBar } from '../plan/PlanTab';
import { planSurfaceOf } from '../session/tabs';
import { requestTab } from '../session/tab-request';
import { useNeedsYouShows } from '../needs-you-setting';
import { useNow } from './use-now';
import { useAskAnswer } from './use-ask-answer';

interface InboxProps {
  agents: readonly Agent[];
  /** Opens the agent's session window. */
  onOpen(agent: Agent): void;
  /** Opens the settings, where what it lists is picked. */
  onSettings?(): void;
  /** Whether it names itself; the docked pane's own header does that instead. */
  heading?: boolean;
}

/**
 * The needs-you inbox, oldest first: what agents asked of the user (a permission prompt, a question, a plan, or a flag
 * with its reason) and, if the settings say so, every agent whose turn ended, each row tagged with its kind and
 * answerable without opening its shell. It follows the agents live, so an item goes as soon as the agent moves on,
 * however it was answered. An item whose session was opened since it began asking is read: it stays while the agent
 * waits, but no longer counts. A flag goes once its session is opened.
 */
export function Inbox({ agents, onOpen, onSettings, heading = true }: InboxProps) {
  const shows = useNeedsYouShows();
  const entries = needsYouEntries(agents, shows);
  const items = entries.map((entry) => entry.agent);
  const now = useNow(items.some((agent) => heldPrompts(agent).length > 0 || waitsOnUser(agent) || agent.flag !== null));
  return (
    <section className="inbox" data-testid="needs-you-inbox" aria-label="Needs you">
      {(heading || items.length > 1) && (
        <header className="inbox-head">
          {heading && <h2>Needs you</h2>}
          {items.length > 1 && <span className="inbox-order">oldest first</span>}
        </header>
      )}
      {items.length === 0 ? (
        <EmptyState framed={false} title="Nothing needs you.">
          {shows === 'explicit'
            ? 'Questions, permission prompts and agents that flag you show here.'
            : 'Agents waiting for an answer or a permission show here.'}
        </EmptyState>
      ) : (
        <ul className="inbox-items">
          {entries.map(({ agent, kind }) => (
            <InboxItem key={agent.sessionId} agent={agent} kind={kind} lead={agents.find((each) => each.sessionId === agent.spawnedBy)} now={now} onOpen={onOpen} />
          ))}
        </ul>
      )}
      <footer className="inbox-foot" data-testid="inbox-foot">
        <span>{shows === 'explicit' ? 'Explicit requests only' : 'Explicit requests and finished turns'}</span>
        {onSettings && (
          <>
            <span aria-hidden>·</span>
            <button type="button" className="inbox-foot-settings" onClick={onSettings}>
              Settings
            </button>
          </>
        )}
      </footer>
    </section>
  );
}

function InboxItem({ agent, kind, lead, now, onOpen }: { agent: Agent; kind: NeedsYouKind; lead: Agent | undefined; now: number; onOpen(agent: Agent): void }) {
  const asking = agent.permissions.length > 0;
  const tag = KIND_TAGS[kind];
  // A flag stands until its session is opened, so a row with one is never read while it is listed.
  const flag = agent.flag?.to === 'user' ? agent.flag : null;
  const read = flag === null && agent.seen;
  return (
    <li className="inbox-item" data-testid="inbox-item" data-session-id={agent.sessionId} data-state={agent.state} data-kind={kind} data-read={read}>
      <div className="inbox-item-head">
        <HarnessMark className="inbox-item-mark" harness={agent.harness} />
        <span className="inbox-item-name">{agent.name}</span>
        <span className="inbox-kind" data-testid="inbox-kind" data-kind={kind}>
          {tag.icon}
          {tag.label}
        </span>
        <Button size="sm" variant="ghost" className="inbox-item-open" icon={<SquareArrowOutUpRight />} aria-label={`Open ${agent.name}`} onClick={() => onOpen(agent)}>
          Open
        </Button>
      </div>
      {kind === 'permission' && lead !== undefined && (
        <p className="inbox-item-meta">
          crew of <span className="inbox-crew">◆ {lead.name}</span> · permission prompts always reach you
        </p>
      )}
      {/* A flag shows whatever else the agent asks, so a seen question never hides it. */}
      {flag !== null && <FlagRow agent={agent} flag={flag} now={now} />}
      {kind === 'flagged' ? null : asking ? (
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
  const { text, setText, busy, error, answer, submit, pick } = useAskAnswer(agent.sessionId, ask);
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

/**
 * A flag an agent raised for a look: its reason, and who it came through. It has nothing to answer: Open is the action,
 * but for Claude's trust screen, which Trust folder answers (`Agent.trustFolder`).
 */
function FlagRow({ agent, flag, now }: { agent: Agent; flag: AgentFlag; now: number }) {
  const { busy, error, run } = useAction();
  return (
    <>
      <blockquote className="inbox-item-message" data-testid="inbox-flag" title={flag.reason}>
        {flag.reason}
      </blockquote>
      <p className="inbox-item-meta">
        {flag.via !== null && (
          <>
            via <span className="inbox-crew">{flag.via}</span> ·
          </>
        )}{' '}
        {HARNESSES[agent.harness].label} · {sinceText(flag.at, now)} · {agent.trustFolder !== null ? 'clears once its folder is trusted' : agent.undelivered.length > 0 ? 'clears once it is resent or cleared' : 'clears when you open it'}
      </p>
      {agent.undelivered.length > 0 && (
        <div className="inbox-item-actions">
          <Button
            size="sm"
            variant="primary"
            icon={<SendHorizontal />}
            loading={busy}
            aria-label={`Resend what was not delivered to ${agent.name}`}
            onClick={() => run(() => window.agentBoard.agents.resendUndelivered(agent.sessionId))}
          >
            Resend
          </Button>
        </div>
      )}
      {agent.trustFolder !== null && (
        <div className="inbox-item-actions">
          <Button
            size="sm"
            variant="primary"
            icon={<FolderCheck />}
            loading={busy}
            aria-label={`Trust ${agent.name}'s folder`}
            onClick={() => run(() => window.agentBoard.agents.trustFolder(agent.sessionId))}
          >
            Trust folder
          </Button>
        </div>
      )}
      {error && <ErrorText>{error}</ErrorText>}
    </>
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
        <span>{plan.expiresAt === null ? 'Waits for your decision' : `Waits ${waitLeft(plan.expiresAt, now)} for your decision`}</span>
      </p>
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
