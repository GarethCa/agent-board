import { createContext, Fragment, useContext, useEffect, useState, type KeyboardEvent } from 'react';
import {
  Asterisk,
  Bot,
  CircleCheck,
  ClipboardList,
  FileText,
  Globe,
  Hourglass,
  MessageCircleQuestion,
  Pause,
  Pencil,
  Plug,
  RefreshCw,
  Search,
  Square,
  SquareTerminal,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { continuesOnCredits, type Agent, type Harness, type PermissionDecision, type PermissionPrompt } from '@agent-board/daemon/protocol';
import { Button, ErrorText } from '../ui';
import { useAction } from '../use-action';
import { toolSummary } from '../../../shared/needs-you';
import { keepPlanning, PLAN_CHOICES, planTitle } from '../../../shared/claude-plan';
import { duration, editCounts, msBetween, startLiveClock, pastedParts, runOpen, toolKind, toolLine, type RunsMode, type ToolCall, type ToolKind } from './chat';
import type { SenderLook } from './agent-message';
import type { LiveState } from './chat-live';
import type { ChatStyle } from './chat-style';

/** What every part of one chat shares, that changes far less often than the agent's hooks. */
export interface ChatSetting {
  style: ChatStyle;
  harness: Harness;
  sessionId: string;
  onOpenLink(url: string): void;
  /** Opens the agent's plans, where the chat can. */
  onOpenPlan?(): void;
  /** How its calls and runs open, and those a click opened or closed; a subagent's own conversation has none. */
  runs?: RunsMode;
  toggled?: ReadonlyMap<string, boolean>;
  onToggle?(key: string, open: boolean): void;
  /** Whether the agent is in a turn, so its newest calls can still be running. */
  atWork: boolean;
  /** The call the live state stands for, drawn as that state in its place. */
  liveCallId?: string;
  /** A subagent's own conversation, drawn inside its call. */
  subagent?: boolean;
  /** Who a message's sender is (its ref), if the board still has them: what its bubble's character looks like. */
  senderLook?(ref: string): SenderLook | undefined;
  /** Whether the Captain stands in its tricorn, as it does under the Simplified design. */
  captainHat?: boolean;
  /** Shows the messages other agents sent again, from the line that says they are hidden. */
  onShowAgents?(): void;
}

export const ChatSettingContext = createContext<ChatSetting>({ style: 'cards', harness: 'claude', sessionId: '', onOpenLink: () => {}, atWork: false });

export const useChatSetting = () => useContext(ChatSettingContext);

/** Whether the part `key` is open: as a click left it, else as Expand all or Collapse all has it, else open while it runs. */
export function useOpen(key: string, running: boolean): [boolean, (open: boolean) => void] {
  const { runs = 'auto', toggled, onToggle } = useChatSetting();
  const [own, setOwn] = useState<boolean>();
  // A subagent's own conversation keeps its clicks to itself.
  const open = runOpen(runs, onToggle ? toggled?.get(key) : own, running);
  return [open, (next) => (onToggle ? onToggle(key, next) : setOwn(next))];
}

const TOOL_ICONS: Record<ToolKind, LucideIcon> = {
  read: FileText,
  edit: Pencil,
  write: Pencil,
  shell: SquareTerminal,
  subagent: Bot,
  search: Search,
  web: Globe,
  mcp: Plug,
  plan: ClipboardList,
  ask: MessageCircleQuestion,
  other: Wrench,
};

export function ToolIcon({ name }: { name: string }) {
  const Icon = TOOL_ICONS[toolKind(name)];
  return <Icon className="chat-tool-icon" aria-hidden />;
}

/** How a call went: done, failed, running while the agent is at it, or stopped short. */
export type CallStatus = 'done' | 'failed' | 'running' | 'stopped';

export function callStatus(call: ToolCall, going: boolean): CallStatus {
  if (call.stopped) return 'stopped';
  if (call.result) return call.result.isError ? 'failed' : 'done';
  return going ? 'running' : 'stopped';
}

/** A call's outcome on its line, a call interrupted, or no longer running with no result, saying it stopped. */
export function CallOutcome({ call, status, now }: { call: ToolCall; status: CallStatus; now?: number }) {
  if (status === 'stopped') {
    return (
      <span className="chat-tool-outcome" data-testid="chat-tool-outcome" data-tone="bad">
        stopped
      </span>
    );
  }
  const { outcome } = toolLine(call);
  const elapsed = status === 'running' && call.at !== undefined ? (now !== undefined ? msBetween(call.at, new Date(now).toISOString()) : msBetween(call.at, call.at)) : undefined;
  return (
    <span className="chat-tool-outcome" data-testid="chat-tool-outcome" data-tone={outcome.tone}>
      {status === 'running' && <span className="chat-tool-run-pulse" aria-hidden />}
      {status === 'running' ? (elapsed === undefined || call.at === undefined ? 'running…' : <span data-testid="chat-time"><LiveTime since={call.at} now={now} /></span>) : outcome.text}
    </span>
  );
}

/** What went in and came out of a call: an edit as its lines out and in, else its input and output as text. */
export function ToolBody({ call }: { call: ToolCall }) {
  const kind = toolKind(call.name);
  const fields = typeof call.input === 'object' && call.input !== null ? (call.input as Record<string, unknown>) : {};
  const edits = Array.isArray(fields.edits) ? (fields.edits as Record<string, unknown>[]) : [fields];
  const counts = editCounts(call.input);
  const diffable = kind === 'edit' && call.name !== 'NotebookEdit' && counts.added + counts.removed > 0;
  return (
    <>
      {diffable ? (
        <pre className="chat-tool-io chat-diff" aria-label="Input">
          {edits.flatMap((edit, index) => [
            ...lines(edit.old_string).map((line, at) => (
              <span key={`r${index}-${at}`} className="chat-diff-removed">
                - {line}
                {'\n'}
              </span>
            )),
            ...lines(edit.new_string).map((line, at) => (
              <span key={`a${index}-${at}`} className="chat-diff-added">
                + {line}
                {'\n'}
              </span>
            )),
          ])}
        </pre>
      ) : (
        <pre className="chat-tool-io" aria-label="Input">
          {typeof call.input === 'string' ? call.input : JSON.stringify(call.input, null, 2)}
        </pre>
      )}
      {call.result && !diffable && (
        <pre className="chat-tool-io" aria-label="Output" data-error={call.result.isError}>
          {call.result.output || '(no output)'}
        </pre>
      )}
    </>
  );
}

function lines(text: unknown): string[] {
  return typeof text === 'string' && text !== '' ? text.replace(/\n$/, '').split('\n') : [];
}

/**
 * A running span's count, ticking by itself so only this text re-renders: tenths every 100 ms up to a minute, then
 * every second. It stops when the window is hidden (and catches up when shown) and when it unmounts as the step ends.
 * `now` pins the time (a static render).
 */
export function LiveTime({ since, now }: { since: string; now?: number }) {
  const [tick, setTick] = useState(Date.now);
  useEffect(() => setTick(Date.now()), [since]);
  useEffect(() => {
    if (now !== undefined) return;
    const clock = startLiveClock(since, setTick, () => document.hidden);
    const onVisible = () => clock.resume();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clock.stop();
    };
  }, [since, now]);
  const ms = msBetween(since, new Date(now ?? tick).toISOString());
  return <>{ms === undefined ? '' : duration(ms, { live: true })}</>;
}

/** A live line's time: a finished span as text, a running one as its own ticking count. */
export function LineTime({ line }: { line: LiveLine }) {
  return line.since !== undefined ? <LiveTime since={line.since} /> : <>{line.time}</>;
}

/** Whether a live line has a time to show. */
export const hasTime = (line: LiveLine): boolean => line.time !== undefined || line.since !== undefined;

/** The colour of a state, shared by its glyph, its card, its dot and its line. */
export type StateTone = 'think' | 'run' | 'wait' | 'limit' | 'danger' | 'muted';

/** A live state as one line: its glyph and tone, what it is, what it is about, and how long it has been going or took. */
export interface LiveLine {
  tone: StateTone;
  Icon: LucideIcon;
  label: string;
  detail?: string;
  time?: string;
  /** When a span still going began: its time then ticks by itself (`LineTime`). */
  since?: string;
  /** Whether it is still going: its glyph pulses, or spins. */
  going: boolean;
}

export function liveLine(live: LiveState): LiveLine {
  const since = (at: string | undefined) => (at === undefined || msBetween(at, at) === undefined ? {} : { since: at });
  switch (live.kind) {
    case 'permission': {
      // Claude's question tool's call asks questions: it reads as them, answered in the terminal, never as an allow.
      if (live.prompt.questions !== null) {
        const [first] = live.prompt.questions;
        return { tone: 'wait', Icon: MessageCircleQuestion, label: first?.question ?? 'Asks you questions', detail: toolSummary(live.prompt), going: false };
      }
      // Claude's plan approval reads as its plan, answered in Claude's words (`PlanActions`), never as an allow.
      if (live.prompt.plan !== null) {
        const label = live.prompt.subagent ? `Its ${live.prompt.subagent.type} subagent has a plan` : 'Plan ready';
        return { tone: 'wait', Icon: ClipboardList, label, detail: planTitle(live.prompt.plan), going: false };
      }
      const asker = live.prompt.subagent ? `Its ${live.prompt.subagent.type} subagent: allow ${live.prompt.toolName}?` : `Allow ${live.prompt.toolName}?`;
      return { tone: 'wait', Icon: Pause, label: asker, detail: toolSummary(live.prompt), going: false };
    }
    case 'ask':
      return { tone: 'wait', Icon: MessageCircleQuestion, label: live.ask.question, going: false };
    case 'plan':
      return { tone: 'wait', Icon: ClipboardList, label: 'Plan ready', detail: live.plan.title, going: false };
    case 'rate-limited':
      return { tone: 'limit', Icon: Hourglass, label: 'Usage limit', going: false };
    case 'compacting':
      return { tone: 'think', Icon: RefreshCw, label: 'Compacting…', detail: 'earlier turns summarised', going: true, ...since(live.since) };
    case 'failed':
      return { tone: 'danger', Icon: TriangleAlert, label: 'Turn failed', detail: live.text, going: false };
    case 'tool': {
      const { label, detail } = toolLine(live.call);
      const subagent = toolKind(live.call.name) === 'subagent';
      return { tone: 'run', Icon: subagent ? Bot : TOOL_ICONS[toolKind(live.call.name)], label: subagent ? 'Subagent' : label, detail, going: true, ...since(live.call.at) };
    }
    case 'thinking':
      return { tone: 'think', Icon: Asterisk, label: 'Thinking…', going: true, ...since(live.since) };
    case 'interrupted':
      return { tone: 'muted', Icon: Square, label: 'Interrupted', detail: 'what should it do instead?', going: false };
    case 'done':
      return { tone: 'run', Icon: CircleCheck, label: 'Done', going: false, ...(live.ms === undefined ? {} : { time: duration(live.ms) }) };
  }
}

/** The glyph of a live state, pulsing or spinning while it is going. */
export function LiveGlyph({ line }: { line: LiveLine }) {
  const { Icon } = line;
  return <Icon className="chat-tool-icon chat-live-glyph" data-tone={line.tone} data-going={line.going} aria-hidden />;
}

interface LiveActionsProps {
  agent: Agent;
  live: LiveState;
  onOpenPlan?(): void;
  onShowTerminal(): void;
  /** Just the main action: the status line's room. */
  compact?: boolean;
}

/**
 * What the user can do about a live state, right where it shows: allow or deny a held permission prompt (Claude's plan
 * approval in its words), answer a question (an option, or in their own words), open or approve a plan, continue on
 * credits past a usage limit, or look at the terminal when only it can answer.
 */
export function LiveActions({ agent, live, onOpenPlan, onShowTerminal, compact = false }: LiveActionsProps) {
  const { busy, error, run } = useAction();
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState('');
  const { sessionId } = agent;
  let actions;
  switch (live.kind) {
    case 'permission': {
      const { prompt } = live;
      const decide = (behavior: 'allow' | 'deny') => run(() => window.agentBoard.agents.decidePermission(sessionId, prompt.id, { behavior }));
      // Claude's question dialog is answered in the pane or Needs you, never with Allow; else in its terminal.
      actions =
        prompt.heldUntil === null || prompt.questions !== null ? (
          <Button size="xs" variant="ghost" onClick={onShowTerminal}>
            Answer in the terminal
          </Button>
        ) : prompt.plan !== null ? (
          <PlanActions sessionId={sessionId} prompt={prompt} busy={busy} run={run} compact={compact} onShowTerminal={onShowTerminal} />
        ) : (
          <>
            <Button size="xs" variant="ghost" disabled={busy} aria-label={`Deny ${prompt.toolName}`} onClick={() => decide('deny')}>
              Deny
            </Button>
            <Button size="xs" variant="primary" disabled={busy} aria-label={`Allow ${prompt.toolName}`} onClick={() => decide('allow')}>
              Allow
            </Button>
          </>
        );
      break;
    }
    case 'ask': {
      const { ask } = live;
      const answer = (choice: { option: number } | { text: string }) => run(() => window.agentBoard.asks.answer(sessionId, ask.id, choice));
      const send = () => reply.trim() !== '' && answer({ text: reply.trim() });
      actions = compact ? (
        <Button size="xs" onClick={() => setReplying(true)}>
          Answer
        </Button>
      ) : null;
      if (!compact || replying) {
        actions = (
          <>
            {ask.options.map((option, index) => (
              <Button key={option} size="xs" disabled={busy} onClick={() => answer({ option: index })}>
                {option}
              </Button>
            ))}
            {ask.freeText &&
              (replying ? (
                <input
                  className="chat-reply"
                  aria-label="Your answer"
                  placeholder="Your answer…"
                  autoFocus
                  value={reply}
                  disabled={busy}
                  onChange={(event) => setReply(event.target.value)}
                  onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                    if (event.key === 'Enter') send();
                    if (event.key === 'Escape') setReplying(false);
                  }}
                />
              ) : (
                <Button size="xs" variant="ghost" onClick={() => setReplying(true)}>
                  Reply…
                </Button>
              ))}
          </>
        );
      }
      break;
    }
    case 'plan': {
      const { plan } = live;
      actions = (
        <>
          {onOpenPlan && (
            <Button size="xs" variant="primary" onClick={onOpenPlan}>
              Open plan
            </Button>
          )}
          {/* The status line's one action is Open plan, where there is a Plan tab to open it in. */}
          {(!compact || !onOpenPlan) && (
            <Button size="xs" disabled={busy} onClick={() => run(() => window.agentBoard.asks.decide(sessionId, plan.id, 'approved', ''))}>
              Approve
            </Button>
          )}
        </>
      );
      break;
    }
    case 'rate-limited':
      actions = continuesOnCredits(agent) && (
        <Button size="xs" variant="primary" disabled={busy} onClick={() => run(() => window.agentBoard.agents.continueOnCredits(sessionId))}>
          Continue on credits
        </Button>
      );
      break;
    case 'failed':
      actions = (
        <Button size="xs" variant="ghost" onClick={onShowTerminal}>
          Terminal
        </Button>
      );
      break;
    default:
      return null;
  }
  return (
    <>
      <span className="chat-live-actions">{actions}</span>
      {error && <ErrorText className="chat-live-error">{error}</ErrorText>}
    </>
  );
}

/** Where Claude's plan approval stands in the chat: folded to one button, its choices, or the field for what to change. */
export type PlanStep = 'folded' | 'choices' | 'changing';

interface PlanChoicesProps {
  step: PlanStep;
  words: string;
  busy: boolean;
  onStep(step: PlanStep): void;
  onWords(words: string): void;
  onDecide(decision: PermissionDecision): void;
  onShowTerminal(): void;
}

/**
 * Claude's plan approval as the chat draws it, from its state alone: its choices in its words, as Needs you's plan row
 * has them (`PlanPromptRow`), the primary trailing as Allow does, and where the choices the hook can't give are. Folded,
 * for the status line's room, it is one Answer plan, as an ask's is one Answer. No, keep planning… opens a field for what
 * to change; Return sends it, Escape goes back.
 */
export function PlanChoices({ step, words, busy, onStep, onWords, onDecide, onShowTerminal }: PlanChoicesProps) {
  if (step === 'folded') {
    return (
      <Button size="xs" onClick={() => onStep('choices')}>
        Answer plan
      </Button>
    );
  }
  if (step === 'changing') {
    return (
      <>
        <input
          className="chat-reply"
          aria-label="What to change"
          placeholder="What to change…"
          autoFocus
          value={words}
          disabled={busy}
          onChange={(event) => onWords(event.target.value)}
          onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'Enter') onDecide(keepPlanning(words));
            if (event.key === 'Escape') onStep('choices');
          }}
        />
        <Button size="xs" variant="ghost" disabled={busy} onClick={() => onStep('choices')}>
          Cancel
        </Button>
        <Button size="xs" variant="primary" disabled={busy} onClick={() => onDecide(keepPlanning(words))}>
          Keep planning
        </Button>
      </>
    );
  }
  return (
    <>
      <Button size="xs" variant="ghost" disabled={busy} onClick={() => onStep('changing')}>
        No, keep planning…
      </Button>
      {PLAN_CHOICES.toReversed().map((choice) => (
        <Button key={choice.label} size="xs" variant={choice.primary ? 'primary' : 'secondary'} disabled={busy} onClick={() => onDecide(choice.decision)}>
          {choice.label}
        </Button>
      ))}
      <span className="quick-ask-where" data-testid="plan-where">
        Clear context or bypass permissions:{' '}
        <button type="button" className="quick-ask-link" onClick={onShowTerminal}>
          in its terminal
        </button>
      </span>
    </>
  );
}

/** Claude's plan approval held for the board, answered from the chat through its hook (`PlanChoices`). */
function PlanActions({ sessionId, prompt, busy, run, compact, onShowTerminal }: { sessionId: string; prompt: PermissionPrompt; busy: boolean; run: ReturnType<typeof useAction>['run']; compact: boolean; onShowTerminal(): void }) {
  const [step, setStep] = useState<PlanStep>(compact ? 'folded' : 'choices');
  const [words, setWords] = useState('');
  const decide = (decision: PermissionDecision) => run(() => window.agentBoard.agents.decidePermission(sessionId, prompt.id, decision));
  return <PlanChoices step={step} words={words} busy={busy} onStep={setStep} onWords={setWords} onDecide={decide} onShowTerminal={onShowTerminal} />;
}

/** A live state's actions, if it has any: the kinds that wait on the user, or that the user can move on. */
export function hasActions(live: LiveState): boolean {
  return live.kind === 'permission' || live.kind === 'ask' || live.kind === 'plan' || live.kind === 'rate-limited' || live.kind === 'failed';
}

/** A user's message as typed, each block pasted into it folded to its line count, opening to what was pasted. */
export function MessageText({ text }: { text: string }) {
  return pastedParts(text).map((part, index) =>
    part.kind === 'text' ? (
      <Fragment key={index}>{part.text}</Fragment>
    ) : (
      <details key={index} className="chat-pasted" data-testid="chat-pasted">
        <summary>
          Pasted text ({part.lines} {part.lines === 1 ? 'line' : 'lines'})
        </summary>
        <pre className="chat-pasted-text">{part.text}</pre>
      </details>
    ),
  );
}
