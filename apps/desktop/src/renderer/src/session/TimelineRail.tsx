import { useMemo, type ReactNode } from 'react';
import { Markdown } from './Markdown';
import { HiddenAgents } from './AgentMessage';
import { toolLine, type ChatItem, type ToolCall } from './chat';
import { callStatus, CallOutcome, LiveActions, LiveGlyph, hasTime, LineTime, liveLine, useChatSetting, useOpen, type StateTone } from './chat-parts';
import { CallBody, callTone, COMPACTED, SaidMessage, stoppedText, SubagentMessageRow, thoughtFor, type LiveProps } from './ChatStreams';
import { railTurns, type RailStep } from './timeline-rail';
import { shortWhen } from '../when';

/**
 * The Simplified design's Timeline view: what was said to the agent as it is in the chat, and between, each turn on
 * one rail with the time down the side, every step a line of its own (a call opening on a click to what it took and
 * gave) and the agent's replies in full. `after` follows the turns (messages sent and not yet in the transcript), and
 * `foot` is the live line, the last step on the rail.
 */
export function TimelineRail({ items, after, foot }: { items: ChatItem[]; after: ReactNode[]; foot?: ReactNode }) {
  const { liveCallId } = useChatSetting();
  const segments = useMemo(() => railTurns(items, liveCallId), [items, liveCallId]);
  // The live line ends the last turn, unless something said since leaves it a turn of its own.
  const footInLast = foot !== undefined && after.length === 0 && segments.at(-1)?.kind === 'turn';
  return (
    <div className="timeline-rail" data-testid="timeline-rail">
      {segments.map((segment, index) =>
        segment.kind === 'said' ? (
          <SaidMessage key={segment.item.key} item={segment.item} />
        ) : segment.kind === 'hidden' ? (
          <HiddenAgents key={segment.item.key} count={segment.item.count} />
        ) : (
          <div key={segment.key} className="timeline-turn" data-testid="timeline-turn">
            {segment.steps.map((step) => (
              <Step key={step.key} step={step} />
            ))}
            {footInLast && index === segments.length - 1 && foot}
          </div>
        ),
      )}
      {after}
      {foot !== undefined && !footInLast && (
        <div className="timeline-turn" data-testid="timeline-turn">
          {foot}
        </div>
      )}
    </div>
  );
}

/** A step's place on the rail: its time, if it shows one, then its dot and what it is. */
function Row({ at, tone, children, ...rest }: { at?: string; tone?: StateTone | 'reply'; children: ReactNode; 'data-testid'?: string; 'data-live'?: string }) {
  return (
    <>
      <span className="timeline-time" data-testid={at === undefined ? undefined : 'timeline-time'}>
        {at === undefined ? '' : shortWhen(at)}
      </span>
      <div className="timeline-step" data-tone={tone} {...rest}>
        {children}
      </div>
    </>
  );
}

function Step({ step }: { step: RailStep }) {
  switch (step.kind) {
    case 'call':
      return <CallStep call={step.call} going={step.lastRun === true} at={step.at} />;
    case 'message':
      return (
        <Row at={step.at}>
          <SubagentMessageRow message={step.message} />
        </Row>
      );
    case 'item':
      return <ItemStep item={step.item} at={step.at} />;
  }
}

function ItemStep({ item, at }: { item: Extract<RailStep, { kind: 'item' }>['item']; at?: string }) {
  const { onOpenLink } = useChatSetting();
  switch (item.kind) {
    case 'assistant':
      return (
        <Row at={at} tone="reply" data-testid="chat-assistant">
          <Markdown text={item.text} onOpenLink={onOpenLink} />
        </Row>
      );
    case 'thinking':
      return <ThinkingStep item={item} at={at} />;
    case 'notice':
      return (
        <Row at={at} tone="muted">
          <p className="timeline-line">{item.text}</p>
        </Row>
      );
    case 'compacted':
      return (
        <Row at={at} tone="muted" data-testid="chat-compacted">
          <p className="timeline-line">Compacted · {COMPACTED}</p>
        </Row>
      );
    case 'interrupted':
      return (
        <Row at={at} tone="muted">
          <p className="timeline-line">Interrupted · {stoppedText(item.stopped)}</p>
        </Row>
      );
  }
}

function ThinkingStep({ item, at }: { item: Extract<ChatItem, { kind: 'thinking' }>; at?: string }) {
  const [open, setOpen] = useOpen(item.key, false);
  const said = thoughtFor(item.ms);
  return (
    <Row at={at} tone="think" data-testid="chat-thinking">
      {item.text === '' ? (
        <p className="timeline-line">{said}</p>
      ) : (
        <button type="button" className="timeline-line" aria-expanded={open} onClick={() => setOpen(!open)}>
          {said}
        </button>
      )}
      {item.text !== '' && open && <p className="chat-pop chat-thinking-text">{item.text}</p>}
    </Row>
  );
}

/** A call as one plain line, "Read ChatStates.html", opening on a click to what went in and came out. */
function CallStep({ call, going, at }: { call: ToolCall; going: boolean; at?: string }) {
  const { atWork } = useChatSetting();
  const status = callStatus(call, atWork && going);
  const [open, setOpen] = useOpen(call.id, false);
  const { label, detail } = toolLine(call);
  return (
    <Row at={at} tone={callTone(status)} data-testid="chat-tool-run">
      <button type="button" className="timeline-line" aria-expanded={open} data-testid="chat-tool-line" onClick={() => setOpen(!open)}>
        {label} <span className="timeline-detail">{detail}</span>
        {status !== 'done' && <CallOutcome call={call} status={status} />}
      </button>
      {open && (
        <div className="chat-pop" data-testid="chat-tool">
          <CallBody call={call} />
        </div>
      )}
    </Row>
  );
}

/**
 * The live state, the rail's last step: its glyph and words in its state's colour, how long, and its actions. Not for
 * an interruption, which the rail already shows as a step.
 */
export function TimelineLive({ agent, live, onOpenPlan, onShowTerminal }: LiveProps) {
  const line = liveLine(live);
  return (
    <Row tone={line.tone} data-testid="chat-live" data-live={live.kind}>
      <p className="timeline-line timeline-live">
        <LiveGlyph line={line} />
        <span>
          {line.label}
          {line.detail !== undefined && <span className="timeline-detail"> {line.detail}</span>}
          {hasTime(line) && (
            <span data-testid="chat-time">
              {' · '}
              <LineTime line={line} />
            </span>
          )}
        </span>
      </p>
      <LiveActions agent={agent} live={live} onOpenPlan={onOpenPlan} onShowTerminal={onShowTerminal} />
    </Row>
  );
}
