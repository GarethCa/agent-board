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
import { continuesOnCredits, type Agent, type Harness } from '@agent-board/daemon/protocol';
import { Button, ErrorText } from '../ui';
import { useAction } from '../use-action';
import { toolSummary } from '../../../shared/needs-you';
import { duration, editCounts, msBetween, pastedParts, runOpen, toolKind, toolLine, type RunsMode, type ToolCall, type ToolKind } from './chat';
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
  const elapsed = status === 'running' && now !== undefined && call.at !== undefined ? msBetween(call.at, new Date(now).toISOString()) : undefined;
  return (
    <span className="chat-tool-outcome" data-testid="chat-tool-outcome" data-tone={outcome.tone}>
      {status === 'running' && <span className="chat-tool-run-pulse" aria-hidden />}
      {status === 'running' ? (elapsed === undefined ? 'running…' : <span data-testid="chat-time">{duration(elapsed)}</span>) : outcome.text}
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

/** The time now, once a second while `ticking`, for the live state's count. */
export function useNow(ticking: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

/** The colour of a state, shared by its glyph, its card, its dot and its line. */
export type StateTone = 'think' | 'run' | 'wait' | 'limit' | 'danger' | 'muted';

/** A live state as one line: its glyph and tone, what it is, what it is about, and how long it has been going or took. */
export interface LiveLine {
  tone: StateTone;
  Icon: LucideIcon;
  label: string;
  detail?: string;
  time?: string;
  /** Whether it is still going: its glyph pulses, or spins. */
  going: boolean;
}

export function liveLine(live: LiveState, now: number): LiveLine {
  const since = (at: string | undefined) => {
    const ms = msBetween(at, new Date(now).toISOString());
    return ms === undefined ? {} : { time: duration(ms) };
  };
  switch (live.kind) {
    case 'permission': {
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
 * What the user can do about a live state, right where it shows: allow or deny a held permission prompt, answer a
 * question (an option, or in their own words), open or approve a plan, continue on credits past a usage limit, or
 * look at the terminal when only it can answer.
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
      actions =
        prompt.heldUntil === null ? (
          <Button size="xs" variant="ghost" onClick={onShowTerminal}>
            Answer in the terminal
          </Button>
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
