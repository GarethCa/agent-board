import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import type { Agent } from '@agent-board/daemon/protocol';
import { Button, EmptyState } from '../ui';
import { agentAtWork, chatItems, type RunsChoice } from './chat';
import { liveCallId, liveState } from './chat-live';
import { ChatSettingContext, type ChatSetting } from './chat-parts';
import { useChatStyle } from './chat-style';
import { ChatStream, LiveCard, MessageText, RailLive, StatusLine } from './ChatStreams';
import { sentLabel, sentMessages, settle, useSentMessages, type SentMessage } from './sent-messages';
import { useTranscript } from './use-transcript';
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
  /** Opens the agent's plans, from a plan's card or line; without it they have no Open plan. */
  onOpenPlan?(): void;
}

/**
 * The chat view of a session window: the agent's conversation read from its harness's transcript as it grows,
 * its messages in turn (the agent's as Markdown), and its calls, thinking and live state in the style picked for every
 * chat (`useChatStyle`): cards, a timeline rail, or chips and one status line over the message box. What the agent
 * waits on you for is answered where it shows. A transcript its adapter can't read leaves only the terminal, saying
 * so. It shows the latest messages of a long one; the earlier ones are in the terminal.
 */
export function ChatView({ agent, active, onShowTerminal, runs, onOpenLink, onOpenPlan }: ChatViewProps) {
  const { sessionId, harness, name } = agent;
  const transcript = useTranscript(active, (since, generation) => window.agentBoard.agents.transcript(sessionId, since, generation), {
    // The daemon says when the transcript changes; a change of state (its hooks) may come before it can watch the file.
    changes: (read) =>
      window.agentBoard.agents.onTranscriptChanged((change) => {
        if (change.sessionId === sessionId) read();
      }),
    poke: agent.state,
  });
  // The conversation's scroller, once it shows.
  const [log, setLog] = useState<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  // The agent re-renders this on every hook; the items change only with the transcript.
  const items = useMemo(() => (transcript?.status === 'ok' ? chatItems(transcript.entries) : []), [transcript]);
  // What was sent from the message box, shown until the transcript shows it, then swapped for its copy in one render.
  const sent = useSentMessages(sessionId);
  const { waiting, confirmed } = useMemo(() => settle(sent, transcript), [sent, transcript]);
  useEffect(() => {
    if (transcript !== undefined && transcript.status !== 'unsupported') {
      sentMessages.read(sessionId, { generation: transcript.generation, end: transcript.first + transcript.entries.length });
    }
  }, [sessionId, transcript]);
  useEffect(() => sentMessages.confirm(sessionId, confirmed), [sessionId, confirmed]);
  // A turn starting counts for the messages sent before it: one that ends with no copy of them was not seen.
  const atWork = agentAtWork(agent);
  const wasAtWork = useRef(atWork);
  useEffect(() => {
    if (atWork && !wasAtWork.current) sentMessages.turnStarted(sessionId);
    wasAtWork.current = atWork;
  }, [sessionId, atWork]);
  // The runs opened or closed by a click since Expand all or Collapse all was last pressed: a press clears them.
  const [toggles, setToggles] = useState<{ at: number; open: ReadonlyMap<string, boolean> }>({ at: runs.at, open: NO_TOGGLES });
  const toggled = toggles.at === runs.at ? toggles.open : NO_TOGGLES;
  const onToggle = useCallback(
    (key: string, open: boolean) =>
      setToggles((current) => ({ at: runs.at, open: new Map(current.at === runs.at ? current.open : NO_TOGGLES).set(key, open) })),
    [runs.at],
  );

  const style = useChatStyle();
  // What the agent is doing now, from its hooks and its transcript, at the end of the chat.
  const live = useMemo(() => liveState(agent, items, transcript?.status === 'ok' ? transcript.entries : []), [agent, items, transcript]);
  const standsAt = liveCallId(live);
  const setting = useMemo<ChatSetting>(
    () => ({ style, harness, sessionId, onOpenLink, onOpenPlan, runs: runs.mode, toggled, onToggle, atWork, liveCallId: standsAt }),
    [style, harness, sessionId, onOpenLink, onOpenPlan, runs.mode, toggled, onToggle, atWork, standsAt],
  );

  // Follows the conversation while the reader is at its end; leaves them be while they read back.
  useLayoutEffect(() => {
    if (log && atBottom.current) log.scrollTop = log.scrollHeight;
  }, [log, transcript, waiting, active, live?.kind, style]);
  // And while it shrinks, as when the Captain's For you is dragged taller: a resize moves no scroll position.
  useEffect(() => {
    if (!log) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) log.scrollTop = log.scrollHeight;
    });
    observer.observe(log);
    return () => observer.disconnect();
  }, [log]);

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
  if (waiting.length === 0 && (transcript === undefined || transcript.status === 'none' || items.length === 0)) {
    return (
      <EmptyState className="chat-view" data-testid="chat-view" framed={false} title={transcript === undefined ? 'Reading the conversation…' : 'No conversation yet'}>
        {transcript !== undefined && `${name}'s messages show here once it starts.`}
      </EmptyState>
    );
  }
  const liveProps = live && { agent, live, onOpenPlan, onShowTerminal };
  const stream = (
    <>
      <ChatSettingContext.Provider value={setting}>
        <ChatStream items={items} />
      </ChatSettingContext.Provider>
      {waiting.map((message) => (
        <SentBubble key={message.id} message={message} label={sentLabel(message, agent)} onRetry={() => void sentMessages.retry(sessionId, message.id, atWork)} onDrop={() => sentMessages.drop(sessionId, message.id)} />
      ))}
      {liveProps && style === 'cards' && <LiveCard {...liveProps} />}
      {liveProps && style === 'timeline' && <RailLive {...liveProps} />}
    </>
  );
  return (
    <div className="chat-frame" data-style={style} data-testid="chat-frame">
      <div
        ref={setLog}
        className="chat-view"
        data-testid="chat-view"
        data-style={style}
        role="log"
        aria-label={`Conversation with ${name}`}
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_DISTANCE;
        }}
      >
        {transcript?.earlier && <p className="chat-turn-notice">Earlier messages are in the terminal.</p>}
        {style === 'timeline' ? <div className="chat-rail">{stream}</div> : stream}
      </div>
      {liveProps && style === 'status-line' && <StatusLine {...liveProps} />}
    </div>
  );
}

/**
 * A message sent from the message box that the transcript doesn't show yet, saying how it is getting on. Once the
 * daemon has answered it can be discarded (the bubble only: what was delivered stays delivered); one that failed can
 * be sent again.
 */
function SentBubble({ message, label, onRetry, onDrop }: { message: SentMessage; label: string; onRetry(): void; onDrop(): void }) {
  const failed = message.status === 'failed';
  return (
    <div className="chat-user chat-sent" data-testid="chat-sent" data-failed={failed}>
      <MessageText text={message.text} />
      <span className="chat-sent-status">
        {failed && <CircleAlert className="chat-tool-icon" aria-hidden />}
        <span data-testid="chat-sent-status">{label}</span>
        {failed && (
          <Button size="xs" variant="ghost" onClick={onRetry}>
            Retry
          </Button>
        )}
        {message.status !== 'sending' && (
          <Button size="xs" variant="ghost" onClick={onDrop}>
            Discard
          </Button>
        )}
      </span>
    </div>
  );
}

const NO_TOGGLES: ReadonlyMap<string, boolean> = new Map();
