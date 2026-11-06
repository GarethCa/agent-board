import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react';
import { continuesOnCredits, planPending, pullRequestOfUrl, shortIssueId, waitsOnUser, type Agent, type AgentAsk, type AgentFlag, type PlanSummary, type PullRequestRef, type Zone } from '@agent-board/daemon/protocol';
import { InboxQuickAsk } from './InboxQuickAsk';
import { StepsWaitBody } from './StepsWaitBody';
import { githubBlocked, isOpenPullRequest, mergeGateBlocked } from '@agent-board/daemon/gate-rules';
import { ArrowUp, CircleCheck, ClipboardList, Clock, Coins, Flag, FolderCheck, GitMerge, GitPullRequest, ListTodo, MessageCircleQuestion, MessageSquare, RotateCcw, SendHorizontal, ShieldQuestion, TriangleAlert, Undo2 } from 'lucide-react';
import { Button, EmptyState, ErrorText, IconButton, Input, Kbd, useToast } from '../ui';
import { useAction } from '../use-action';
import { PermissionRow } from './PermissionRow';
import { askAnsweredElsewhere, heldPrompts, needsYouSections, problemKey, sinceText, stepsWaitKey, stillReadyToAccept, waitLeft, type NeedsYouRow, type NeedsYouRowKind } from '../../../shared/needs-you';
import { errorMessage } from '../../../shared/errors';
import { PlanDecisionBar } from '../plan/PlanTab';
import { planSurfaceOf } from '../session/tabs';
import { requestTab } from '../session/tab-request';
import { usePullRequest } from '../session/use-pull-request';
import { useGateRun } from '../gate/GatesProvider';
import { keptCleanup } from '../gate/GateControls';
import { setChosenView } from '../session/session-view';
import { mergedText, mergePlanText } from '../gate/gate-view';
import { useNeedsYouShows } from '../needs-you-setting';
import { useNow } from './use-now';
import { acceptLater, undoAccept, usePendingAccept } from './accept-later';
import { useDismissedProblems } from './dismissed-problems';
import { useAskAnswer } from './use-ask-answer';

interface GroupedInboxProps {
  agents: readonly Agent[];
  zones: readonly Zone[];
  onOpen(agent: Agent): void;
  onSettings?(): void;
  heading?: boolean;
}

/** Each kind's glyph on its neutral tile, and its word, so the kind never rests on the glyph alone. */
const KINDS: Record<NeedsYouRowKind, { word: string; glyph: ReactNode }> = {
  asks: { word: 'Question', glyph: <MessageCircleQuestion aria-hidden /> },
  permission: { word: 'Permission', glyph: <ShieldQuestion aria-hidden /> },
  plan: { word: 'Plan to review', glyph: <ClipboardList aria-hidden /> },
  steps: { word: 'Steps', glyph: <ListTodo aria-hidden /> },
  todo: { word: 'To-do', glyph: <CircleCheck aria-hidden /> },
  flagged: { word: 'Wants a look', glyph: <Flag aria-hidden /> },
  turn: { word: 'Finished replying', glyph: <MessageSquare aria-hidden /> },
  accept: { word: 'Ready to accept', glyph: <GitPullRequest aria-hidden /> },
  problem: { word: 'Problem', glyph: <TriangleAlert aria-hidden /> },
};

/**
 * The Simplified design's Needs-you list, in sections (`needsYouSections`): what continues the work, what reaches out
 * to you, changes ready to accept, and problems. One row pattern for every kind: a neutral kind tile, the agent's name
 * (which opens it) with its zone's label, its age, a plain line of what it wants and the answers it takes. ↑ and ↓ move
 * between rows, Return on a row opens its agent and never answers, and keys 1–9 answer only a question. Its requests are
 * Classic's list's; the changes and the problems are its own.
 */
export function GroupedInbox({ agents, zones, onOpen, onSettings, heading = true }: GroupedInboxProps) {
  const shows = useNeedsYouShows();
  const [dismissed, dismiss] = useDismissedProblems();
  const sections = needsYouSections(agents, shows, dismissed);
  const now = useNow(sections.some(({ rows }) => rows.some(({ agent }) => heldPrompts(agent).length > 0 || waitsOnUser(agent) || agent.flag !== null)));
  return (
    <section className="inbox" data-testid="needs-you-inbox" data-grouped aria-label="Needs you">
      {heading && (
        <header className="inbox-head">
          <h2>Needs you</h2>
        </header>
      )}
      {sections.length === 0 ? (
        <EmptyState framed={false} title="All caught up">
          Nothing needs you.
        </EmptyState>
      ) : (
        sections.map((section) => (
          <section key={section.id} className="inbox-group" data-testid="inbox-group" data-section={section.id} aria-label={section.title}>
            <h3 className="inbox-group-head">
              <span className="inbox-group-name">{section.title}</span>
              <span className="inbox-group-count" aria-label={`${section.rows.length} waiting`}>
                {section.rows.length}
              </span>
            </h3>
            <ul className="inbox-items">
              {section.rows.map((row) => (
                <Row key={row.agent.sessionId} row={row} zone={zones.find((zone) => zone.id === row.agent.zoneId)} now={now} onOpen={onOpen} onDismiss={dismiss} />
              ))}
            </ul>
          </section>
        ))
      )}
      <footer className="inbox-foot" data-testid="inbox-foot" data-technical-detail>
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

/** What a row's question does with a key pressed on the row: picks a choice by its number. */
type RowKeys = MutableRefObject<((event: KeyboardEvent) => void) | null>;

/**
 * ↑ and ↓ on a row move to the row before or after it, across groups; Return opens its agent; any other key goes to
 * its question, so the 1–9 its choices show answer it from the row as from inside it.
 */
function rowKeys(event: KeyboardEvent<HTMLLIElement>, open: () => void, ask: RowKeys) {
  if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    open();
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
    ask.current?.(event);
    return;
  }
  const rows = [...(event.currentTarget.closest('.inbox')?.querySelectorAll<HTMLElement>('.inbox-row') ?? [])];
  const next = rows[rows.indexOf(event.currentTarget) + (event.key === 'ArrowDown' ? 1 : -1)];
  if (next === undefined) return;
  event.preventDefault();
  next.focus();
}

function Row({
  row: { agent, kind, since },
  zone,
  now,
  onOpen,
  onDismiss,
}: {
  row: NeedsYouRow;
  zone: Zone | undefined;
  now: number;
  onOpen(agent: Agent): void;
  onDismiss(key: string): void;
}) {
  // A flag stands until its session is opened, so a row with one is never read while it is listed.
  const flag = agent.flag?.to === 'user' ? agent.flag : null;
  const read = flag === null && agent.seen;
  const open = () => onOpen(agent);
  const askKeys: RowKeys = useRef(null);
  return (
    <li
      className="inbox-item inbox-row"
      data-testid="inbox-item"
      data-session-id={agent.sessionId}
      data-state={agent.state}
      data-kind={kind}
      data-read={read}
      tabIndex={0}
      aria-label={`${agent.name}: ${KINDS[kind].word}`}
      onKeyDown={(event) => rowKeys(event, open, askKeys)}
    >
      <span className="inbox-row-kind" data-testid="inbox-kind" data-kind={kind} title={KINDS[kind].word}>
        {KINDS[kind].glyph}
        <span className="visually-hidden">{KINDS[kind].word}</span>
      </span>
      <span className="inbox-row-title">
        <button type="button" className="inbox-row-name" aria-label={`Open ${agent.name}`} onClick={open}>
          {agent.name}
        </button>
        {zone !== undefined && (
          <span className="inbox-row-zone" data-testid="inbox-zone">
            <span className="inbox-row-zone-swatch" style={{ '--zone-color': zone.color } as CSSProperties} aria-hidden />
            {zone.name}
          </span>
        )}
      </span>
      <span className="inbox-row-age">{sinceText(since, now)}</span>
      <div className="inbox-row-body">
        {kind === 'accept' ? (
          <AcceptBody agent={agent} gated={zone?.gateCommand != null} onOpen={open} />
        ) : kind === 'problem' ? (
          <ProblemBody agent={agent} onOpen={open} onDismiss={onDismiss} />
        ) : (
          <RequestBody agent={agent} kind={kind} flag={flag} now={now} open={open} rowKeys={askKeys} />
        )}
      </div>
    </li>
  );
}

/** What a request asks, and its answers: a flag, a permission prompt, a question, a plan or a finished turn. */
function RequestBody({ agent, kind, flag, now, open, rowKeys }: { agent: Agent; kind: NeedsYouRowKind; flag: AgentFlag | null; now: number; open(): void; rowKeys: RowKeys }) {
  // Review… lets the harness ask in its terminal, so the window opens on the terminal, not on a chat view the user picked.
  const reviewInTerminal = () => {
    setChosenView(agent.sessionId, 'terminal');
    open();
  };
  return (
    <>
      {/* A flag shows whatever else the agent asks, so a seen question never hides it. */}
      {flag !== null && <FlagBody agent={agent} flag={flag} onOpen={open} />}
      {kind === 'flagged' ? null : agent.permissions.length > 0 ? (
        agent.permissions.map((prompt) => (
          // Keyed by request, so a new request never inherits an old one's error.
          <PermissionRow key={prompt.id} agent={agent} prompt={prompt} now={now} onReview={reviewInTerminal} />
        ))
      ) : agent.state === 'needs-permission' ? (
        <>
          <p className="inbox-row-what">Asks permission in its terminal.</p>
          <div className="inbox-item-actions">
            <Button size="sm" onClick={open}>
              Open
            </Button>
          </div>
        </>
      ) : agent.ask !== null ? (
        // Keyed by question, so a new one never inherits an old one's reply or error.
        agent.ask.questions.length > 1 && agent.ask.card === null ? (
          // Several questions step through in the row, as on its tile.
          <InboxQuickAsk key={agent.ask.id} agent={agent} ask={agent.ask} />
        ) : (
          <AskBody key={agent.ask.id} agent={agent} ask={agent.ask} now={now} rowKeys={rowKeys} />
        )
      ) : planPending(agent) ? (
        <PlanBody
          key={agent.plan.id}
          agent={agent}
          plan={agent.plan}
          now={now}
          onRead={() => {
            requestTab(agent.sessionId, planSurfaceOf(agent.sessionId));
            open();
          }}
        />
      ) : agent.stepsWait !== null ? (
        // Keyed by its card (and a to-do's step), so a new one starts closed, and an answer keeps the stepper open.
        <StepsWaitBody key={stepsWaitKey(agent.stepsWait)} wait={agent.stepsWait} agents={[agent]} onOpen={open} />
      ) : (
        <ReplyBody agent={agent} />
      )}
    </>
  );
}

/** A question: the question itself, a button per choice of equal weight (keys 1–9 while it has focus), a reply. */
function AskBody({ agent, ask, now, rowKeys }: { agent: Agent; ask: AgentAsk; now: number; rowKeys: RowKeys }) {
  const { text, setText, busy, error, answer, submit, pick } = useAskAnswer(agent.sessionId, ask);
  // Put on the board, or of several questions, it is answered on its card or from its tile's chip: here it says where.
  const elsewhere = askAnsweredElsewhere(ask);
  useEffect(() => {
    rowKeys.current = elsewhere === undefined ? pick : null;
    return () => {
      rowKeys.current = null;
    };
  });
  return (
    <form className="inbox-ask" data-testid="inbox-ask" onSubmit={submit} onKeyDown={elsewhere === undefined ? pick : undefined}>
      <p className="inbox-row-what">{ask.question}</p>
      {elsewhere !== undefined && <p className="inbox-row-meta">{elsewhere}</p>}
      {elsewhere === undefined && ask.options.length > 0 && (
        <div className="inbox-item-actions" role="group" aria-label={`Answers for ${agent.name}`}>
          {ask.options.map((option, index) => (
            <Button key={index} size="sm" className="inbox-ask-option" disabled={busy} aria-keyshortcuts={index < 9 ? String(index + 1) : undefined} onClick={() => answer({ option: index })}>
              {option}
              {index < 9 && <Kbd aria-hidden>{index + 1}</Kbd>}
            </Button>
          ))}
        </div>
      )}
      {elsewhere === undefined && ask.freeText && (
        <div className="inbox-row-reply">
          <Input
            size="sm"
            aria-label={`Reply to ${agent.name}`}
            placeholder="Reply…"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <IconButton type="submit" variant="primary" icon={<ArrowUp />} aria-label={`Send to ${agent.name}`} loading={busy} disabled={text.trim() === ''} />
        </div>
      )}
      <p className="inbox-row-meta">
        <Clock aria-hidden />
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

/** A plan: its version and title, Read the plan, which opens its Plan tab, and the decision. */
function PlanBody({ agent, plan, now, onRead }: { agent: Agent; plan: PlanSummary; now: number; onRead(): void }) {
  return (
    <div className="inbox-plan" data-testid="inbox-plan">
      <p className="inbox-row-what">
        Plan v{plan.version}: {plan.title}
      </p>
      <PlanDecisionBar agent={agent} plan={plan} compact />
      <p className="inbox-row-meta">
        <Clock aria-hidden />
        <span>{plan.expiresAt === null ? 'Waits for your decision' : `Waits ${waitLeft(plan.expiresAt, now)} for your decision`}</span>
        <span aria-hidden>·</span>
        <button type="button" className="inbox-ask-skip" aria-label={`Show ${agent.name}'s plan`} onClick={onRead}>
          Read the plan ›
        </button>
      </p>
    </div>
  );
}

/**
 * A flag raised for a look: its reason, who passed it on, and its one action. That is Open, but for what was never
 * delivered (Resend) and Claude's trust screen (Trust folder).
 */
function FlagBody({ agent, flag, onOpen }: { agent: Agent; flag: AgentFlag; onOpen(): void }) {
  const { busy, error, run } = useAction();
  return (
    <>
      <p className="inbox-row-what" data-testid="inbox-flag" title={flag.reason}>
        {flag.reason}
      </p>
      <div className="inbox-item-actions">
        {agent.undelivered.length > 0 ? (
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
        ) : agent.trustFolder !== null ? (
          <Button size="sm" variant="primary" icon={<FolderCheck />} loading={busy} aria-label={`Trust ${agent.name}'s folder`} onClick={() => run(() => window.agentBoard.agents.trustFolder(agent.sessionId))}>
            Trust folder
          </Button>
        ) : (
          <Button size="sm" onClick={onOpen}>
            Open
          </Button>
        )}
      </div>
      {flag.via !== null && <p className="inbox-row-meta">Passed on by {flag.via}</p>}
      {error && <ErrorText>{error}</ErrorText>}
    </>
  );
}

/** A finished turn: its last message, and a reply. */
function ReplyBody({ agent }: { agent: Agent }) {
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim() !== '') run(() => window.agentBoard.agents.answer(agent.sessionId, text), () => setText(''));
  };
  return (
    <form className="inbox-item-answer" onSubmit={submit}>
      {agent.lastMessage && (
        <p className="inbox-row-what inbox-row-message" data-testid="inbox-last-message" title={agent.lastMessage}>
          {agent.lastMessage}
        </p>
      )}
      <div className="inbox-row-reply">
        <Input size="sm" aria-label={`Answer ${agent.name}`} placeholder="Reply…" value={text} onChange={(event) => setText(event.target.value)} />
        <IconButton type="submit" variant="primary" icon={<ArrowUp />} aria-label={`Send to ${agent.name}`} loading={busy} disabled={text.trim() === ''} />
      </div>
      {error && <ErrorText>{error}</ErrorText>}
    </form>
  );
}

/**
 * Changes ready to accept: its open pull request, and Accept changes, which squash-merges it at the commit shown with
 * the clean-up its zone's merges last used, `ACCEPT_AFTER_MS` after the click. Undo stops it before then; nothing ever
 * reverts a merge that has run. Accept waits for what Merge waits for (the gate, in a zone with one, and GitHub), and
 * isn't offered on someone else's pull request.
 */
function AcceptBody({ agent, gated, onOpen }: { agent: Agent; gated: boolean; onOpen(): void }) {
  const pr = agent.pullRequests.find(isOpenPullRequest)!;
  const ref = pullRequestOfUrl(pr.url);
  return (
    <>
      <p className="inbox-row-what" data-testid="inbox-accept-line">
        {/* The title only where it says more than the agent's name, which the row shows already. */}
        Pull request #{pr.number}
        {pr.title.trim() === agent.name.trim() ? '' : `, ${pr.title},`} is ready to merge.
      </p>
      {ref === undefined ? (
        <div className="inbox-item-actions">
          <Button size="sm" onClick={onOpen}>
            Open
          </Button>
        </div>
      ) : (
        <AcceptActions agent={agent} number={pr.number} pullRef={ref} gated={gated} onOpen={onOpen} />
      )}
    </>
  );
}

function AcceptActions({ agent, number, pullRef, gated, onOpen }: { agent: Agent; number: number; pullRef: PullRequestRef; gated: boolean; onOpen(): void }) {
  const { details, error } = usePullRequest(pullRef, true);
  const run = useGateRun(agent.sessionId);
  const toast = useToast();
  const shows = useNeedsYouShows();
  const until = usePendingAccept(agent.sessionId);
  const now = useNow(until !== undefined);
  const head = details?.headCommit as string | null | undefined;
  const why =
    details === undefined
      ? (error ?? 'Reading it from GitHub…')
      : !details.byViewer
        ? 'It isn’t your pull request: approve it from its window.'
        : head == null
          ? 'GitHub gave no commit to merge at: open it to look again.'
          : (mergeGateBlocked({ run, pr: details, gated }) ?? githubBlocked(details));
  const issue = agent.issue === null ? undefined : shortIssueId(agent.issue);
  const cleanup = keptCleanup(agent.zoneId);
  const accept = () => {
    if (details === undefined || head == null) return;
    const clicked = agent;
    acceptLater(agent.sessionId, async () => {
      // The agent as it is now: a reply sent meanwhile, or anything it asks, means the user wants more, not the merge.
      let latest: Agent | undefined;
      try {
        latest = (await window.agentBoard.agents.list()).find((each) => each.sessionId === clicked.sessionId);
      } catch (failure: unknown) {
        toast.show({ tone: 'error', message: `Didn't merge #${number}: could not read ${clicked.name} to check it: ${errorMessage(failure)}` });
        return;
      }
      if (!stillReadyToAccept(clicked, latest, shows)) {
        toast.show({ tone: 'info', message: `Didn't merge #${number}: ${clicked.name} has moved on since you accepted it.` });
        return;
      }
      await window.agentBoard.gates.merge(agent.sessionId, number, head, { ...cleanup, comment: cleanup.comment && issue !== undefined }).then(
        (merged) =>
          toast.show({
            tone: merged.failed.length === 0 ? 'success' : 'error',
            message: mergedText(number, details.baseRefName, merged, { agent: agent.name, branch: agent.branch, issue }),
          }),
        (failure: unknown) => toast.show({ tone: 'error', message: `Could not merge #${number}: ${errorMessage(failure)}` }),
      );
    }, window.agentBoard.windows.acceptAfterMs);
  };
  if (until !== undefined) {
    const seconds = Math.max(1, Math.ceil((until - now) / 1000));
    return (
      <>
        <div className="inbox-item-actions">
          <Button size="sm" variant="primary" icon={<Undo2 />} aria-label={`Undo accepting ${agent.name}'s changes`} onClick={() => undoAccept(agent.sessionId)}>
            Undo
          </Button>
        </div>
        <p className="inbox-row-meta" data-testid="inbox-accept-wait">
          Merging in {seconds} second{seconds === 1 ? '' : 's'}. Undo stops it; nothing is merged until then.
        </p>
      </>
    );
  }
  return (
    <>
      <div className="inbox-item-actions">
        <Button size="sm" variant="primary" icon={<GitMerge />} disabled={why !== undefined} aria-label={`Accept ${agent.name}'s changes`} onClick={accept}>
          Accept changes
        </Button>
        <Button size="sm" onClick={onOpen}>
          Open
        </Button>
      </div>
      <p className="inbox-row-meta" data-testid="inbox-accept-why">
        {why ?? mergePlanText({ ...cleanup, comment: cleanup.comment && issue !== undefined }, { agent: agent.name, branch: agent.branch, issue })}
      </p>
    </>
  );
}

/**
 * A crashed or stuck agent: what happened in a line, and the one thing that gets it going again, where there is one. A
 * failed agent's has Dismiss, as nothing here gets it going again.
 */
function ProblemBody({ agent, onOpen, onDismiss }: { agent: Agent; onOpen(): void; onDismiss(key: string): void }) {
  const { busy, error, run } = useAction();
  const key = problemKey(agent);
  const line =
    agent.state === 'stopped-by-restart'
      ? 'It stopped when the app restarted.'
      : agent.state === 'rate-limited'
        ? 'It hit its usage limit and waits for it to reset.'
        : `It stopped with an error${agent.exitCode === null || agent.exitCode === 0 ? '' : ` (exit ${agent.exitCode})`}.`;
  return (
    <>
      <p className="inbox-row-what" data-testid="inbox-problem-line">
        {line}
      </p>
      <div className="inbox-item-actions">
        {agent.state === 'stopped-by-restart' ? (
          <Button size="sm" variant="primary" icon={<RotateCcw />} loading={busy} aria-label={`Resume ${agent.name}`} onClick={() => run(() => window.agentBoard.agents.resume(agent.sessionId))}>
            Resume
          </Button>
        ) : (
          continuesOnCredits(agent) && (
            <Button size="sm" variant="primary" icon={<Coins />} loading={busy} onClick={() => run(() => window.agentBoard.agents.continueOnCredits(agent.sessionId))}>
              Continue on credits
            </Button>
          )
        )}
        <Button size="sm" onClick={onOpen}>
          Open
        </Button>
        {key !== undefined && (
          <Button size="sm" variant="ghost" aria-label={`Dismiss ${agent.name}'s problem`} onClick={() => onDismiss(key)}>
            Dismiss
          </Button>
        )}
      </div>
      {error && <ErrorText>{error}</ErrorText>}
    </>
  );
}
