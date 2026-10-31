import { memo, useMemo, useState } from 'react';
import { Asterisk, Bot, ChevronRight, ListCollapse, RefreshCw, Square } from 'lucide-react';
import type { Agent, MessageSender } from '@agent-board/daemon/protocol';
import { HarnessMark } from '../board/HarnessMark';
import { Button } from '../ui';
import { AgentBubble, AgentMessage, HiddenAgents, useSenderTone } from './AgentMessage';
import { Markdown } from './Markdown';
import { chatItems, duration, editCounts, toolKind, toolLine, type ChatItem, type SubagentMessage, type ToolCall } from './chat';
import type { LiveState } from './chat-live';
import {
  callStatus,
  CallOutcome,
  ChatSettingContext,
  hasActions,
  LiveActions,
  LiveGlyph,
  MessageText,
  liveLine,
  ToolBody,
  ToolIcon,
  useChatSetting,
  useNow,
  useOpen,
  type CallStatus,
  type StateTone,
} from './chat-parts';
import { useTranscript } from './use-transcript';

/**
 * The conversation's items, drawn in the chat's style: the agent's messages as Markdown and the user's as typed in
 * each, and between them, as cards (a card per call, thinking, compaction or interruption), as a timeline rail (a dot
 * per event, opening on a click), or as chips under the messages (the status line's). Memoised: they change only with
 * the transcript, not with every hook the agent hears.
 */
export const ChatStream = memo(function ChatStream({ items }: { items: ChatItem[] }) {
  const { style } = useChatSetting();
  if (style === 'status-line') return <ChipStream items={items} />;
  return items.map((item, index) => {
    const last = index === items.length - 1;
    return style === 'timeline' ? <RailItem key={item.key} item={item} last={last} /> : <CardItem key={item.key} item={item} last={last} />;
  });
});

function UserMessage({ text }: { text: string }) {
  return (
    <div className="chat-user" data-testid="chat-user">
      <MessageText text={text} />
    </div>
  );
}

/** A message the user typed, or one another agent sent, drawn apart. */
function SaidMessage({ item }: { item: Extract<ChatItem, { kind: 'user' }> }) {
  return item.from === undefined ? <UserMessage text={item.text} /> : <AgentMessage text={item.text} from={item.from} />;
}

function AssistantMessage({ text }: { text: string }) {
  const { harness, subagent, onOpenLink } = useChatSetting();
  return (
    <div className="chat-assistant" data-testid="chat-assistant">
      {!subagent && <HarnessMark className="chat-assistant-mark" harness={harness} />}
      <Markdown text={text} onOpenLink={onOpenLink} />
    </div>
  );
}

/** How long the model thought, as its item says it: "Thought for 12s", or just "Thought" untimed. */
const thoughtFor = (ms: number | undefined) => (ms === undefined ? 'Thought' : `Thought for ${duration(ms)}`);

/** What a compaction left, in a few words. */
const COMPACTED = 'earlier turns summarised';

/** What an interruption stopped, if it cut a call short. */
const stoppedText = (stopped: ToolCall | undefined) => (stopped === undefined ? 'what should it do instead?' : `${toolLine(stopped).detail || stopped.name} stopped`);

// ---------- Cards ----------

function CardItem({ item, last }: { item: ChatItem; last: boolean }) {
  const { atWork, liveCallId } = useChatSetting();
  switch (item.kind) {
    case 'user':
      return <SaidMessage item={item} />;
    case 'agents-hidden':
      return <HiddenAgents count={item.count} />;
    case 'assistant':
      return <AssistantMessage text={item.text} />;
    case 'notice':
      return <p className="chat-turn-notice">{item.text}</p>;
    case 'thinking':
      return <ThinkingCard item={item} />;
    case 'compacted':
      return (
        <div className="chat-cards">
          <div className="chat-card" data-tone="think" data-testid="chat-card">
            <div className="chat-card-head">
              <RefreshCw className="chat-tool-icon" aria-hidden />
              <b>Compacted</b>
              <span className="chat-tool-detail">{COMPACTED}</span>
            </div>
          </div>
        </div>
      );
    case 'interrupted':
      return (
        <div className="chat-cards">
          <div className="chat-card" data-tone="muted" data-testid="chat-card">
            <div className="chat-card-head">
              <Square className="chat-tool-icon" aria-hidden />
              <b>Interrupted</b>
              <span className="chat-tool-detail">{stoppedText(item.stopped)}</span>
            </div>
          </div>
        </div>
      );
    case 'tools': {
      const going = atWork && last;
      // A run whose only call is the live one is drawn as the live state, at the end.
      if (item.rows.every((row) => row.kind === 'call' && row.id === liveCallId)) return null;
      return (
        <div className="chat-cards">
          {item.rows.map((row) =>
            row.kind === 'subagent-message' ? (
              <SubagentMessageRow key={row.key} message={row} />
            ) : row.id === liveCallId ? null : (
              <CallCard key={row.id} call={row} status={callStatus(row, going)} />
            ),
          )}
        </div>
      );
    }
  }
}

function ThinkingCard({ item }: { item: Extract<ChatItem, { kind: 'thinking' }> }) {
  const [open, setOpen] = useOpen(item.key, false);
  const foldable = item.text !== '';
  const head = (
    <>
      <Asterisk className="chat-tool-icon" aria-hidden />
      <b>{thoughtFor(item.ms)}</b>
      <span className="chat-tool-detail" />
      {foldable && <ChevronRight className="chat-tool-chevron" aria-hidden />}
    </>
  );
  return (
    <div className="chat-cards">
      <div className="chat-card chat-card-thinking" data-testid="chat-thinking" data-open={foldable && open}>
        {foldable ? (
          <button type="button" className="chat-card-head" aria-expanded={open} onClick={() => setOpen(!open)}>
            {head}
          </button>
        ) : (
          <div className="chat-card-head">{head}</div>
        )}
        {foldable && open && <p className="chat-card-body chat-thinking-text">{item.text}</p>}
      </div>
    </div>
  );
}

/** The tone of a call's card, dot or chip: as it went. */
const callTone = (status: CallStatus): StateTone => (status === 'failed' || status === 'stopped' ? 'danger' : 'run');

/** A call as a card: its line, opening on a click to what went in and came out, and a subagent's own conversation. */
function CallCard({ call, status }: { call: ToolCall; status: CallStatus }) {
  const { harness, onOpenPlan } = useChatSetting();
  const [open, setOpen] = useOpen(call.id, status === 'running');
  const now = useNow(status === 'running');
  const kind = toolKind(call.name);
  const { label, detail } = toolLine(call);
  const name = kind === 'plan' ? 'Plan' : kind === 'ask' ? 'Question' : label;
  return (
    <div className="chat-card" data-testid="chat-tool" data-kind={kind} data-tone={kind === 'plan' ? 'think' : callTone(status)} data-status={status} data-open={open}>
      <button type="button" className="chat-card-head chat-tool-line" aria-expanded={open} data-testid="chat-tool-line" onClick={() => setOpen(!open)}>
        <ToolIcon name={call.name} />
        <b>{name}</b>
        <span className="chat-tool-detail">{detail}</span>
        <CallOutcome call={call} status={status} now={now} />
        <ChevronRight className="chat-tool-chevron" aria-hidden />
      </button>
      {kind === 'plan' && onOpenPlan && (
        <span className="chat-card-head-action">
          <Button size="xs" onClick={onOpenPlan}>
            Open plan
          </Button>
        </span>
      )}
      {open && (
        <div className="chat-card-body">
          {kind === 'subagent' && harness === 'claude' ? <SubagentThread call={call} /> : <ToolBody call={call} />}
        </div>
      )}
    </div>
  );
}

/** The live state as a card at the end of the stream, with its actions; a running call is its own card already. */
export function LiveCard({ agent, live, onOpenPlan, onShowTerminal }: LiveProps) {
  const line = liveLine(live, useNow(live.kind === 'thinking' || live.kind === 'compacting'));
  if (live.kind === 'tool' || live.kind === 'interrupted') return null;
  const thinking = live.kind === 'thinking';
  return (
    <div className="chat-cards">
      <div className={thinking ? 'chat-card chat-card-thinking' : 'chat-card'} data-tone={line.tone} data-live={live.kind} data-testid="chat-live">
        <div className="chat-card-head">
          <LiveGlyph line={line} />
          <b>{line.label}</b>
          <span className="chat-tool-detail">{line.detail ?? ''}</span>
          {line.time !== undefined && (
            <span className="chat-tool-outcome" data-tone={thinking ? 'pending' : 'muted'} data-testid="chat-time">
              {line.time}
            </span>
          )}
        </div>
        {hasActions(live) && (
          <div className="chat-card-body">
            {live.kind === 'permission' && line.detail && <pre className="chat-tool-io">{line.detail}</pre>}
            <LiveActions agent={agent} live={live} onOpenPlan={onOpenPlan} onShowTerminal={onShowTerminal} />
          </div>
        )}
      </div>
    </div>
  );
}

export interface LiveProps {
  agent: Agent;
  live: LiveState;
  onOpenPlan?(): void;
  onShowTerminal(): void;
}

// ---------- Timeline rail ----------

function RailItem({ item, last }: { item: ChatItem; last: boolean }) {
  const { atWork } = useChatSetting();
  switch (item.kind) {
    case 'user':
      return item.from === undefined ? (
        <div className="chat-ev chat-ev-user">
          <span className="chat-dot" data-hollow aria-hidden />
          <UserMessage text={item.text} />
        </div>
      ) : (
        <RailAgentMessage text={item.text} from={item.from} />
      );
    case 'agents-hidden':
      return (
        <div className="chat-ev">
          <span className="chat-dot" data-tone="muted" aria-hidden />
          <HiddenAgents count={item.count} />
        </div>
      );
    case 'assistant':
      return (
        <div className="chat-ev">
          <span className="chat-dot" data-hollow aria-hidden />
          <AssistantMessage text={item.text} />
        </div>
      );
    case 'notice':
      return (
        <div className="chat-ev">
          <span className="chat-dot" data-tone="muted" aria-hidden />
          <p className="chat-turn-notice">{item.text}</p>
        </div>
      );
    case 'thinking':
      return <RailThinking item={item} />;
    case 'compacted':
      return (
        <p className="chat-rail-break" data-testid="chat-compacted">
          compacted · {COMPACTED}
        </p>
      );
    case 'interrupted':
      return (
        <div className="chat-ev">
          <span className="chat-dot" data-tone="muted" aria-hidden />
          <p className="chat-turn-notice">Interrupted · {stoppedText(item.stopped)}</p>
        </div>
      );
    case 'tools':
      return <RailRun item={item} going={atWork && last} />;
  }
}

/** An agent's message on the rail: its dot ringed in the sender's colour. */
function RailAgentMessage({ text, from }: { text: string; from: MessageSender }) {
  const tone = useSenderTone(from);
  return (
    <div className="chat-ev" data-sender={tone}>
      <span className="chat-dot" data-hollow data-agent aria-hidden />
      <AgentBubble text={text} from={from} tone={tone} />
    </div>
  );
}

function RailThinking({ item }: { item: Extract<ChatItem, { kind: 'thinking' }> }) {
  const [open, setOpen] = useOpen(item.key, false);
  const foldable = item.text !== '';
  return (
    <div className="chat-ev" data-testid="chat-thinking">
      <span className="chat-dot" data-tone="think" aria-hidden />
      {foldable ? (
        <button type="button" className="chat-rail-line" aria-expanded={open} onClick={() => setOpen(!open)}>
          <Asterisk className="chat-tool-icon" aria-hidden />
          {thoughtFor(item.ms).toLowerCase()}
        </button>
      ) : (
        <p className="chat-rail-line">
          <Asterisk className="chat-tool-icon" aria-hidden />
          {thoughtFor(item.ms).toLowerCase()}
        </p>
      )}
      {foldable && open && <p className="chat-pop chat-thinking-text">{item.text}</p>}
    </div>
  );
}

/** At most this many dots stand for a run of calls on the rail. */
const RAIL_DOTS = 3;

/**
 * A run of calls on the rail: one call as its line, more as their dots stacked and a line summing them up. A click
 * opens it beside the rail: the call's input and output, or the run's calls, each opening the same way.
 */
function RailRun({ item, going }: { item: Extract<ChatItem, { kind: 'tools' }>; going: boolean }) {
  const { liveCallId } = useChatSetting();
  const calls = item.rows.filter((row): row is ToolCall => row.kind === 'call' && row.id !== liveCallId);
  const messages = item.rows.filter((row): row is SubagentMessage => row.kind === 'subagent-message');
  const statuses = calls.map((call) => callStatus(call, going));
  const running = statuses.includes('running');
  const [open, setOpen] = useOpen(item.key, false);
  const now = useNow(running);
  if (calls.length === 0 && messages.length === 0) return null;
  if (calls.length === 1 && messages.length === 0) {
    const call = calls[0]!;
    const status = statuses[0]!;
    const { label, detail } = toolLine(call);
    return (
      <div className="chat-ev" data-testid="chat-tool-run">
        <span className="chat-dot" data-tone={callTone(status)} data-selected={open} data-going={status === 'running'} aria-hidden />
        <button type="button" className="chat-tool-line" aria-expanded={open} data-testid="chat-tool-line" onClick={() => setOpen(!open)}>
          <ChevronRight className="chat-tool-chevron" aria-hidden />
          <ToolIcon name={call.name} />
          <b>{label}</b>
          <span className="chat-tool-detail">{detail}</span>
          <CallOutcome call={call} status={status} now={now} />
        </button>
        {open && (
          <div className="chat-pop" data-testid="chat-tool">
            <CallBody call={call} />
          </div>
        )}
      </div>
    );
  }
  const names = [...new Set(calls.map((call) => toolLine(call).label))];
  const diff = calls.filter((call) => toolKind(call.name) === 'edit' && call.result?.isError === false).map((call) => editCounts(call.input));
  const added = diff.reduce((sum, each) => sum + each.added, 0);
  const removed = diff.reduce((sum, each) => sum + each.removed, 0);
  return (
    <div className="chat-ev" data-testid="chat-tool-run">
      <span className="chat-dots" aria-hidden>
        {statuses.slice(0, RAIL_DOTS).map((status, index) => (
          <i key={index} data-tone={callTone(status)} data-going={status === 'running'} />
        ))}
      </span>
      <button type="button" className="chat-tool-line" aria-expanded={open} data-running={running} onClick={() => setOpen(!open)}>
        <ChevronRight className="chat-tool-chevron" aria-hidden />
        <ListCollapse className="chat-tool-icon" aria-hidden />
        <span className="chat-tool-run-summary">
          {names.join(', ')} · {calls.length} {calls.length === 1 ? 'call' : 'calls'}
          {messages.length > 0 && ` · ${messages.length} ${messages.length === 1 ? 'message' : 'messages'}`}
        </span>
        {diff.length > 0 && (
          <span className="chat-tool-outcome" data-tone="diff">
            +{added} −{removed}
          </span>
        )}
        {running && (
          <span className="chat-tool-outcome" data-tone="pending">
            <span className="chat-tool-run-pulse" aria-hidden />
            {toolLine(calls[statuses.indexOf('running')]!).label}…
          </span>
        )}
      </button>
      {open && (
        <div className="chat-pop chat-tools">
          {item.rows.map((row) =>
            row.kind === 'subagent-message' ? <SubagentMessageRow key={row.key} message={row} /> : row.id === liveCallId ? null : <ToolRow key={row.id} call={row} status={callStatus(row, going)} />,
          )}
        </div>
      )}
    </div>
  );
}

/** A call as one line, opening on a click to what went in and came out. */
function ToolRow({ call, status }: { call: ToolCall; status: CallStatus }) {
  const [open, setOpen] = useState(false);
  const { label, detail } = toolLine(call);
  return (
    <div className="chat-tool" data-open={open}>
      <button type="button" className="chat-tool-line" aria-expanded={open} data-testid="chat-tool" onClick={() => setOpen(!open)}>
        <ChevronRight className="chat-tool-chevron" aria-hidden />
        <ToolIcon name={call.name} />
        <b>{label}</b>
        <span className="chat-tool-detail">{detail}</span>
        <CallOutcome call={call} status={status} />
      </button>
      {open && (
        <div className="chat-tool-body">
          <CallBody call={call} />
        </div>
      )}
    </div>
  );
}

/** What a call took and gave, and a Claude subagent's own conversation. */
function CallBody({ call }: { call: ToolCall }) {
  const { harness } = useChatSetting();
  return (
    <>
      <ToolBody call={call} />
      {toolKind(call.name) === 'subagent' && harness === 'claude' && <SubagentThread call={call} />}
    </>
  );
}

/** The live state at the foot of the rail, its dot ringed while it is going, with its actions. */
export function RailLive({ agent, live, onOpenPlan, onShowTerminal }: LiveProps) {
  const line = liveLine(live, useNow(live.kind === 'thinking' || live.kind === 'compacting' || live.kind === 'tool'));
  if (live.kind === 'interrupted') return null;
  const ringed = live.kind !== 'done';
  return (
    <div className="chat-ev chat-rail-live" data-tone={line.tone} data-ringed={ringed} data-live={live.kind} data-testid="chat-live">
      <span className="chat-dot" data-tone={line.tone} aria-hidden />
      <span className="chat-rail-live-label" data-tone={line.tone}>
        <LiveGlyph line={line} />
        {line.label}
      </span>
      {line.detail !== undefined && <span className="chat-rail-live-detail">{line.detail}</span>}
      {line.time !== undefined && (
        <span className="chat-rail-live-detail" data-testid="chat-time">
          {line.time}
        </span>
      )}
      <LiveActions agent={agent} live={live} onOpenPlan={onOpenPlan} onShowTerminal={onShowTerminal} />
    </div>
  );
}

// ---------- Status line ----------

/** What the status line's stream draws: a message, or the thinking and calls between two messages as one row of chips. */
type ChipSegment = { kind: 'item'; item: ChatItem } | { kind: 'chips'; key: string; parts: Extract<ChatItem, { kind: 'thinking' | 'tools' }>[]; last: boolean };

function ChipStream({ items }: { items: ChatItem[] }) {
  const segments = useMemo(() => {
    const out: ChipSegment[] = [];
    items.forEach((item, index) => {
      const last = index === items.length - 1;
      if (item.kind === 'thinking' || item.kind === 'tools') {
        const previous = out.at(-1);
        if (previous?.kind === 'chips') {
          previous.parts.push(item);
          previous.last = last;
        } else out.push({ kind: 'chips', key: item.key, parts: [item], last });
      } else out.push({ kind: 'item', item });
    });
    return out;
  }, [items]);
  return segments.map((segment) => {
    if (segment.kind === 'chips') return <ChipRow key={segment.key} parts={segment.parts} last={segment.last} />;
    const { item } = segment;
    switch (item.kind) {
      case 'user':
        return <SaidMessage key={item.key} item={item} />;
      case 'agents-hidden':
        return <HiddenAgents key={item.key} count={item.count} />;
      case 'assistant':
        return <AssistantMessage key={item.key} text={item.text} />;
      case 'compacted':
        return (
          <p key={item.key} className="chat-divider" data-testid="chat-compacted">
            compacted · {COMPACTED}
          </p>
        );
      case 'interrupted':
        return (
          <p key={item.key} className="chat-turn-notice">
            Interrupted · {stoppedText(item.stopped)}
          </p>
        );
      default:
        return (
          <p key={item.key} className="chat-turn-notice">
            {'text' in item ? item.text : ''}
          </p>
        );
    }
  });
}

/**
 * The thinking and finished calls between two messages, a chip each; a click on a call's chip opens what went in and
 * came out under the row. A call still running is the status line's, not a chip.
 */
function ChipRow({ parts, last }: { parts: Extract<ChatItem, { kind: 'thinking' | 'tools' }>[]; last: boolean }) {
  const { atWork } = useChatSetting();
  const [open, setOpen] = useState<string>();
  const going = atWork && last;
  const calls = parts.flatMap((part) => (part.kind === 'tools' ? part.rows : [])).filter((row): row is ToolCall => row.kind === 'call');
  const opened = calls.find((call) => call.id === open);
  const thought = parts.find((part): part is Extract<ChatItem, { kind: 'thinking' }> => part.kind === 'thinking' && part.key === open);
  return (
    <div className="chat-chip-run" data-testid="chat-tool-run">
      <div className="chat-chips">
        {parts.flatMap((part) => {
          if (part.kind === 'thinking') {
            const said = (
              <>
                <Asterisk className="chat-tool-icon" aria-hidden />
                {thoughtFor(part.ms).toLowerCase()}
              </>
            );
            // Thinking whose text Claude kept to itself has nothing to open.
            return [
              part.text === '' ? (
                <span key={part.key} className="chat-chip" data-testid="chat-thinking">
                  {said}
                </span>
              ) : (
                <button key={part.key} type="button" className="chat-chip" data-testid="chat-thinking" aria-expanded={open === part.key} onClick={() => setOpen(open === part.key ? undefined : part.key)}>
                  {said}
                </button>
              ),
            ];
          }
          return part.rows.map((row) => {
            if (row.kind === 'subagent-message') {
              return (
                <span key={row.key} className="chat-chip" data-testid="chat-subagent-message">
                  <Bot className="chat-tool-icon" aria-hidden />
                  <b>{row.from}</b> {row.text === '' ? `handed a task to ${row.to}` : row.text}
                </span>
              );
            }
            const status = callStatus(row, going);
            if (status === 'running') return null;
            const { label, detail, outcome } = toolLine(row);
            return (
              <button
                key={row.id}
                type="button"
                className="chat-chip"
                data-testid="chat-tool"
                data-tone={callTone(status)}
                aria-expanded={open === row.id}
                onClick={() => setOpen(open === row.id ? undefined : row.id)}
              >
                <b>{label}</b>
                {detail !== '' && <span className="chat-chip-detail">{detail}</span>}
                <span className="chat-tool-outcome" data-testid="chat-tool-outcome" data-tone={status === 'stopped' ? 'bad' : outcome.tone}>
                  {status === 'stopped' ? 'stopped' : outcome.text}
                </span>
              </button>
            );
          });
        })}
      </div>
      {opened && (
        <div className="chat-chip-body">
          <CallBody call={opened} />
        </div>
      )}
      {thought && <p className="chat-chip-body chat-thinking-text">{thought.text}</p>}
    </div>
  );
}

/** One live line over the message box: the state now, with its time and its main actions. */
export function StatusLine({ agent, live, onOpenPlan, onShowTerminal }: LiveProps) {
  const line = liveLine(live, useNow(live.kind === 'thinking' || live.kind === 'compacting' || live.kind === 'tool'));
  return (
    <div className="chat-status-line" data-tone={line.tone} data-live={live.kind} data-testid="chat-live">
      <LiveGlyph line={line} />
      {/* Read out as the state changes; its time, counting every second, and its actions are left out. */}
      <span className="chat-status-said" role="status">
        <span className="chat-status-label">{line.label}</span>
        {line.detail !== undefined && <span className="chat-status-detail">{line.detail}</span>}
      </span>
      {line.time !== undefined && (
        <span className="chat-status-time" data-testid="chat-time">
          {line.time}
        </span>
      )}
      <LiveActions agent={agent} live={live} onOpenPlan={onOpenPlan} onShowTerminal={onShowTerminal} compact />
    </div>
  );
}

// ---------- Shared ----------

/** A Claude subagent's own conversation, read as its call opens and followed until the call has its result. */
function SubagentThread({ call }: { call: ToolCall }) {
  const setting = useChatSetting();
  const agentId = call.result?.agentId;
  const transcript = useTranscript(true, () => window.agentBoard.agents.subagentTranscript(setting.sessionId, call.id, agentId), { follow: call.result === undefined });
  const items = useMemo(() => (transcript?.status === 'ok' ? chatItems(transcript.entries) : []), [transcript]);
  const inner = useMemo(
    () => ({ style: setting.style, harness: 'claude' as const, sessionId: setting.sessionId, onOpenLink: setting.onOpenLink, atWork: call.result === undefined, subagent: true }),
    [setting.style, setting.sessionId, setting.onOpenLink, call.result],
  );
  if (transcript === undefined) return null;
  if (items.length === 0) return <p className="chat-turn-notice">Its own conversation isn't in a transcript the chat can read.</p>;
  return (
    <div className="chat-subagent" data-style={setting.style} aria-label="Subagent conversation" data-testid="chat-subagent">
      {transcript.earlier && <p className="chat-turn-notice">Its earlier messages are in the terminal.</p>}
      <ChatSettingContext.Provider value={inner}>
        <ChatStream items={items} />
      </ChatSettingContext.Provider>
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
