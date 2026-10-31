import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowRightFromLine, ChevronDown, Info, Mail, Reply, type LucideIcon } from 'lucide-react';
import type { MessageKind, MessageSender } from '@agent-board/daemon/protocol';
import { Captain, Sender } from '../board/Character';
import { agentMessageParts, isLong, messageKindLabel, senderTone, type SenderTone } from './agent-message';
import { MessageText, useChatSetting } from './chat-parts';

const KIND_ICONS: Record<MessageKind, LucideIcon> = { send: Mail, reply: Reply, 'hand-off': ArrowRightFromLine };

/** The colour family of the sender of a message, as the chat knows them. */
export function useSenderTone(from: MessageSender): SenderTone {
  return senderTone(useChatSetting().senderLook?.(from.ref));
}

/** The sender's character, standing: the Captain in its tricorn where the chat dresses it, else its harness's. */
function SenderFigure({ tone }: { tone: SenderTone }) {
  const { captainHat } = useChatSetting();
  return (
    <span className="chat-agent-figure" aria-hidden>
      {tone === 'captain' && captainHat ? <Captain size="avatar" /> : <Sender harness={tone === 'codex' ? 'codex' : 'claude'} />}
    </span>
  );
}

/**
 * A message another agent sent (its `send`, hand-off or reply), drawn apart from the user's own: the sender's
 * character beside a bubble tinted in its colour, headed "From …" and the kind it came as. Past a few lines it folds,
 * with Show all; what the board added for the receiver (how to answer, a hand-off's head) is under the info badge.
 */
export function AgentMessage({ text, from }: { text: string; from: MessageSender }) {
  return <AgentBubble text={text} from={from} tone={useSenderTone(from)} />;
}

/** `AgentMessage` for a caller that has the sender's colour already. */
export function AgentBubble({ text, from, tone }: { text: string; from: MessageSender; tone: SenderTone }) {
  const { body, aside } = agentMessageParts(text, from);
  const [open, setOpen] = useState(false);
  // Long by its lines until it shows how many it takes at the width the chat has: folded to the clamp, it overflows it.
  const [overflows, setOverflows] = useState(isLong(body));
  const long = open || overflows;
  const textRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || open) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [body, open]);
  const [told, setTold] = useState(false);
  const Kind = KIND_ICONS[from.kind];
  return (
    <div className="chat-agent" data-testid="chat-agent-message" data-sender={tone} data-kind={from.kind}>
      <SenderFigure tone={tone} />
      <div className="chat-agent-bubble">
        <div className="chat-agent-head">
          <b>From {from.name}</b>
          <span className="chat-agent-kind">
            <Kind aria-hidden />
            {messageKindLabel(from)}
          </span>
          {aside !== undefined && (
            <button type="button" className="chat-agent-info" aria-label="What the receiver was also told" aria-expanded={told} data-testid="chat-agent-info" onClick={() => setTold(!told)}>
              <Info aria-hidden />
            </button>
          )}
        </div>
        {told && aside !== undefined && <p className="chat-agent-aside" data-testid="chat-agent-aside">{aside}</p>}
        <div ref={textRef} className="chat-agent-text" data-collapsed={!open}>
          <MessageText text={body} />
        </div>
        {long && (
          <button type="button" className="chat-agent-more" aria-expanded={open} data-testid="chat-agent-more" onClick={() => setOpen(!open)}>
            {open ? 'Show less' : 'Show all'}
            <ChevronDown aria-hidden data-open={open} />
          </button>
        )}
      </div>
    </div>
  );
}

/** One line for the agents' messages a chat leaves out while it shows only the user's own. */
export function HiddenAgents({ count }: { count: number }) {
  const { onShowAgents } = useChatSetting();
  return (
    <p className="chat-agents-hidden" data-testid="chat-agents-hidden">
      {count} agent {count === 1 ? 'message' : 'messages'} hidden ·{' '}
      <button type="button" onClick={onShowAgents}>
        Show
      </button>
    </p>
  );
}
