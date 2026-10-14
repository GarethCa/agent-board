import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Bot, ChevronRight, CircleAlert, FileText, ListCollapse, Pencil, Search, SquareTerminal, Wrench, type LucideIcon } from 'lucide-react';
import type { Agent, Harness, TranscriptChunk } from '@agent-board/daemon/protocol';
import { HarnessMark } from '../board/HarnessMark';
import { Button, EmptyState } from '../ui';
import { Markdown } from './Markdown';
import {
  agentAtWork,
  chatItems,
  mergeChunk,
  runOpen,
  toolKind,
  toolLine,
  toolRun,
  type ChatItem,
  type RunsChoice,
  type RunsMode,
  type SubagentMessage,
  type ToolCall,
  type ToolKind,
  type Transcript,
} from './chat';

/** How often the chat asks the daemon for what the transcript has gained. */
const POLL_MS = 750;
/** How close to the bottom, in pixels, still counts as reading the latest: new messages then scroll into view. */
const STICK_DISTANCE = 48;

interface ChatViewProps {
  agent: Agent;
  /** Whether it is on show: it reads the transcript only then. */
  active: boolean;
  /** Shows the terminal instead, for a transcript the chat can't read. */
  onShowTerminal(): void;
  /** How its runs of tool calls open, as Expand all or Collapse all was last pressed. */
  runs: RunsChoice;
  /** Opens an https link from a message in the OS browser. */
  onOpenLink(url: string): void;
}

/**
 * The chat view of a session window: the agent's conversation read from its
 * harness's transcript as it grows, its messages in turn (the agent's as Markdown) and each run of tool calls one row
 * that opens to a line per call, each opening on a click to show what went in and came out. A transcript its adapter can't read leaves only the terminal, saying so. It shows the
 * latest messages of a long one; the earlier ones are in the terminal.
 */
export function ChatView({ agent, active, onShowTerminal, runs, onOpenLink }: ChatViewProps) {
  const { sessionId, harness, name } = agent;
  const transcript = usePolledTranscript(active, (since, generation) => window.agentBoard.agents.transcript(sessionId, since, generation));
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // The agent re-renders this on every hook; the items change only with the transcript.
  const items = useMemo(() => (transcript?.status === 'ok' ? chatItems(transcript.entries) : []), [transcript]);
  // The runs opened or closed by a click since Expand all or Collapse all was last pressed: a press clears them.
  const [toggles, setToggles] = useState<{ at: number; open: ReadonlyMap<string, boolean> }>({ at: runs.at, open: NO_TOGGLES });
  const toggled = toggles.at === runs.at ? toggles.open : NO_TOGGLES;
  const onToggleRun = useCallback(
    (key: string, open: boolean) =>
      setToggles((current) => ({ at: runs.at, open: new Map(current.at === runs.at ? current.open : NO_TOGGLES).set(key, open) })),
    [runs.at],
  );

  // Follows the conversation while the reader is at its end; leaves them be while they read back.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [transcript, active]);

  if (transcript?.status === 'unsupported') {
    return (
      <EmptyState
        className="chat-view chat-notice"
        data-testid="chat-view"
        framed={false}
        title="Terminal only"
        action={
          <Button size="sm" onClick={onShowTerminal}>
            Show terminal
          </Button>
        }
      >
        The chat can't read this transcript ({transcript.reason}). Its terminal shows everything.
      </EmptyState>
    );
  }
  if (transcript === undefined || transcript.status === 'none' || items.length === 0) {
    return (
      <EmptyState className="chat-view" data-testid="chat-view" framed={false} title={transcript === undefined ? 'Reading the conversation…' : 'No conversation yet'}>
        {transcript !== undefined && `${name}'s messages show here once it starts.`}
      </EmptyState>
    );
  }
  return (
    <div
      ref={scroller}
      className="chat-view"
      data-testid="chat-view"
      role="log"
      aria-label={`Conversation with ${name}`}
      onScroll={(event) => {
        const element = event.currentTarget;
        atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_DISTANCE;
      }}
    >
      {transcript.earlier && <p className="chat-turn-notice">Earlier messages are in the terminal.</p>}
      <ChatItems
        items={items}
        harness={harness}
        sessionId={sessionId}
        runs={runs.mode}
        toggled={toggled}
        onToggleRun={onToggleRun}
        atWork={agentAtWork(agent)}
        onOpenLink={onOpenLink}
      />
    </div>
  );
}

const NO_TOGGLES: ReadonlyMap<string, boolean> = new Map();

interface ChatItemsProps {
  items: ChatItem[];
  harness: Harness;
  sessionId: string;
  onOpenLink(url: string): void;
  /** How its runs of tool calls open, and those a click opened or closed; a subagent's own conversation has none. */
  runs?: RunsMode;
  toggled?: ReadonlyMap<string, boolean>;
  onToggleRun?(key: string, open: boolean): void;
  /** Whether the agent is in a turn, so its newest run can still be running. */
  atWork?: boolean;
  /** A subagent's own conversation, drawn inside its call. */
  subagent?: boolean;
}

/**
 * The conversation's items: the agent's messages as Markdown, the user's as typed, and each run of tool calls one row
 * that opens to its calls. Memoised: they change only with the transcript, not with every hook the agent hears.
 */
const ChatItems = memo(function ChatItems({ items, harness, sessionId, onOpenLink, runs, toggled, onToggleRun, atWork = false, subagent }: ChatItemsProps) {
  return items.map((item, index) => {
    switch (item.kind) {
      case 'user':
        return (
          <p key={item.key} className="chat-user" data-testid="chat-user">
            {item.text}
          </p>
        );
      case 'assistant':
        return (
          <div key={item.key} className="chat-assistant" data-testid="chat-assistant">
            {!subagent && <HarnessMark className="chat-assistant-mark" harness={harness} />}
            <Markdown text={item.text} onOpenLink={onOpenLink} />
          </div>
        );
      case 'notice':
        return (
          <p key={item.key} className="chat-turn-notice">
            {item.text}
          </p>
        );
      case 'tools': {
        const rows = <ToolRows rows={item.rows} harness={harness} sessionId={sessionId} onOpenLink={onOpenLink} />;
        if (runs === undefined) return <div key={item.key} className="chat-tools">{rows}</div>;
        const run = toolRun(item.rows, atWork && index === items.length - 1);
        const open = runOpen(runs, toggled?.get(item.key), run.running !== undefined);
        return (
          <div key={item.key} className="chat-tool-run" data-open={open} data-testid="chat-tool-run">
            <button
              type="button"
              className="chat-tool-line chat-tool-run-line"
              aria-expanded={open}
              data-running={run.running !== undefined}
              data-failed={run.failed}
              onClick={() => onToggleRun?.(item.key, !open)}
            >
              <ChevronRight className="chat-tool-chevron" aria-hidden />
              <ListCollapse className="chat-tool-icon" aria-hidden />
              <span className="chat-tool-run-summary">{run.summary}</span>
              {run.running !== undefined && (
                <span className="chat-tool-outcome" data-tone="pending" data-testid="chat-tool-run-running">
                  <span className="chat-tool-run-pulse" aria-hidden />
                  {run.running}…
                </span>
              )}
              {run.failed && (
                <span className="chat-tool-outcome" data-tone="bad" data-testid="chat-tool-run-failed">
                  <CircleAlert className="chat-tool-icon" aria-hidden />
                  failed
                </span>
              )}
            </button>
            {open && <div className="chat-tools">{rows}</div>}
          </div>
        );
      }
    }
  });
});

/** A run's calls, each one line, with the messages between agents among them. */
function ToolRows({ rows, harness, sessionId, onOpenLink }: { rows: (ToolCall | SubagentMessage)[]; harness: Harness; sessionId: string; onOpenLink(url: string): void }) {
  return rows.map((row) =>
    row.kind === 'call' ? (
      <ToolRow key={row.id} call={row} harness={harness} sessionId={sessionId} onOpenLink={onOpenLink} />
    ) : (
      <SubagentMessageRow key={row.key} message={row} />
    ),
  );
}

const TOOL_ICONS: Record<ToolKind, LucideIcon> = {
  read: FileText,
  edit: Pencil,
  write: Pencil,
  shell: SquareTerminal,
  subagent: Bot,
  search: Search,
  other: Wrench,
};

/** A tool call as one line; a click opens what went in and what came out, and a Claude subagent's own conversation. */
function ToolRow({ call, harness, sessionId, onOpenLink }: { call: ToolCall; harness: Harness; sessionId: string; onOpenLink(url: string): void }) {
  const [open, setOpen] = useState(false);
  const { detail, outcome } = toolLine(call);
  const kind = toolKind(call.name);
  const Icon = TOOL_ICONS[kind];
  return (
    <div className="chat-tool" data-open={open}>
      <button type="button" className="chat-tool-line" aria-expanded={open} data-testid="chat-tool" onClick={() => setOpen(!open)}>
        <ChevronRight className="chat-tool-chevron" aria-hidden />
        <Icon className="chat-tool-icon" aria-hidden />
        <b>{call.name}</b>
        <span className="chat-tool-detail">{detail}</span>
        <span className="chat-tool-outcome" data-testid="chat-tool-outcome" data-tone={outcome.tone}>
          {outcome.text}
        </span>
      </button>
      {open && (
        <div className="chat-tool-body">
          <pre className="chat-tool-io" aria-label="Input">
            {typeof call.input === 'string' ? call.input : JSON.stringify(call.input, null, 2)}
          </pre>
          {call.result && (
            <pre className="chat-tool-io" aria-label="Output" data-error={call.result.isError}>
              {call.result.output || '(no output)'}
            </pre>
          )}
          {kind === 'subagent' && harness === 'claude' && <SubagentThread sessionId={sessionId} call={call} onOpenLink={onOpenLink} />}
        </div>
      )}
    </div>
  );
}

/** A Claude subagent's own conversation, read as its call opens and followed until the call has its result. */
function SubagentThread({ sessionId, call, onOpenLink }: { sessionId: string; call: ToolCall; onOpenLink(url: string): void }) {
  const agentId = call.result?.agentId;
  const transcript = usePolledTranscript(true, () => window.agentBoard.agents.subagentTranscript(sessionId, call.id, agentId), call.result === undefined);
  const items = useMemo(() => (transcript?.status === 'ok' ? chatItems(transcript.entries) : []), [transcript]);
  if (transcript === undefined) return null;
  if (items.length === 0) return <p className="chat-turn-notice">Its own conversation isn't in a transcript the chat can read.</p>;
  return (
    <div className="chat-subagent" aria-label="Subagent conversation" data-testid="chat-subagent">
      {transcript.earlier && <p className="chat-turn-notice">Its earlier messages are in the terminal.</p>}
      <ChatItems items={items} harness="claude" sessionId={sessionId} onOpenLink={onOpenLink} subagent />
    </div>
  );
}

/** A message between Codex agents: a task handed on (encrypted in the rollout) or an answer. */
function SubagentMessageRow({ message }: { message: SubagentMessage }) {
  return (
    <p className="chat-subagent-message" data-testid="chat-subagent-message">
      <Bot className="chat-tool-icon" aria-hidden />
      <b>{message.from}</b>
      <span className="chat-tool-detail">{message.text === '' ? `handed a task to ${message.to}` : message.text}</span>
    </p>
  );
}

/**
 * A transcript as the chat has it, read with `read` while `active`: again every `POLL_MS` while `follow`, merging in
 * what it gained. `read` is called with where the last read stopped.
 */
function usePolledTranscript(
  active: boolean,
  read: (since: number, generation?: number) => Promise<TranscriptChunk>,
  follow = true,
): Transcript | undefined {
  const [transcript, setTranscript] = useState<Transcript>();
  const latest = useRef<Transcript>(undefined);
  const reader = useRef(read);
  reader.current = read;
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const current = latest.current;
      try {
        const chunk = await reader.current(current ? current.first + current.entries.length : 0, current?.generation);
        const next = mergeChunk(current, chunk);
        if (!stopped && next !== current) {
          latest.current = next;
          setTranscript(next);
        }
      } catch {
        // The daemon is away for a moment: the next poll tries again.
      }
      if (!stopped && follow) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [active, follow]);
  return transcript;
}
