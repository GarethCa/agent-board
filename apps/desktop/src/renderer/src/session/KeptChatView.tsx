import { StrictMode, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '../ui';
import { ChatView, type ChatViewProps } from './ChatView';
import { keepingOffScreen, letGoWhenTurnedOff, timing } from './keep-off-screen';
import { keptChats, type KeptChat } from './kept-chats';

/** How many chat views a page keeps parked: past it, the longest unseen is let go. */
const KEPT_CHATS = 12;

/**
 * A chat view drawn in a root of its own, which moves from pane to pane and waits, still drawn, while it is in none. A
 * root of its own, not a portal: an event in it still reaches the handlers of the pane it is in (React hands an event
 * from a nested root on to the root around it), and the chat reads nothing from the tree around it. It has the app's
 * strict mode and tooltips; a toast from the chat would need the app's toasts, which it has none of.
 */
interface ChatRoot extends KeptChat {
  /** Draws it with the pane's props. */
  render(props: ChatViewProps): void;
  /** Shows it in `pane`, where it last was in its conversation. */
  enter(pane: HTMLElement): void;
  /** Takes it out of its pane, noting where it was in its conversation. */
  leave(): void;
}

function chatRoot(sessionId: string): ChatRoot {
  const element = document.createElement('div');
  element.className = 'kept-chat';
  const root = createRoot(element);
  /** Where its conversation was scrolled to as it left its pane: a scroller out of the page forgets it. */
  let top: number | undefined;
  const log = () => element.querySelector<HTMLElement>('[role="log"]');
  return {
    render: (props) =>
      root.render(
        <StrictMode>
          <TooltipProvider>
            <ChatView {...props} />
          </TooltipProvider>
        </StrictMode>,
      ),
    enter(pane) {
      pane.appendChild(element);
      const scroller = log();
      if (scroller !== null && top !== undefined) scroller.scrollTop = top;
    },
    leave() {
      top = log()?.scrollTop;
      element.remove();
    },
    dispose(reason) {
      // Never while React is committing the tree it left.
      setTimeout(() => root.unmount());
      timing('chat.letGo', performance.now(), { sessionId, reason });
    },
  };
}

const kept = keptChats<ChatRoot>({ limit: KEPT_CHATS, make: chatRoot });

/** From the first kept chat view: turned off, the setting lets them all go. */
const followSetting = letGoWhenTurnedOff(() => kept.forgetAll('setting'));

let followingAgents = false;

/** From the first kept chat view: an agent removed, from this page or another, takes its kept chat view with it. */
function letGoGoneChats(): void {
  if (followingAgents) return;
  followingAgents = true;
  window.agentBoard.agents.onChanged((change) => {
    if (change.type === 'agent.removed') kept.forget(change.sessionId, 'ended');
  });
}

/** Tells this page which sessions are in folded zones now (all of them): their kept chat views are let go, as their terminals are. */
export function letGoFoldedChats(sessionIds: Iterable<string>): void {
  kept.fold(sessionIds);
}

/**
 * The chat view of a pane. With the keep-sessions setting on (read as it mounts) it is kept: leaving its pane, as an
 * expanded tile panned off screen does, it is parked whole, and the next pane of its session shows it at once, scrolled
 * where it was, with no transcript to read and draw again (`kept-chats.ts`). Off, it is the plain chat view. Only one that
 * has shown is kept: a pane on its terminal holds a hidden chat view, which keeps no place from the chats read.
 */
export function KeptChatView(props: ChatViewProps) {
  const [keep] = useState(keepingOffScreen);
  const [shown, setShown] = useState(props.active);
  if (props.active && !shown) setShown(true);
  return keep && shown ? <KeptChatPane {...props} /> : <ChatView {...props} />;
}

function KeptChatPane(props: ChatViewProps) {
  const { sessionId } = props.agent;
  const pane = useRef<HTMLDivElement>(null);
  const shown = useRef<ChatRoot | null>(null);
  const latest = useRef(props);
  latest.current = props;
  // Another pane of the page shows this session's kept chat view: this one draws its own.
  const [ownChat, setOwnChat] = useState(false);

  useLayoutEffect(() => {
    const mountedAt = performance.now();
    const held = kept.show(sessionId);
    timing('chat.mount', mountedAt, { sessionId, kept: held?.reused === true });
    if (held === undefined) {
      setOwnChat(true);
      return;
    }
    followSetting();
    letGoGoneChats();
    const { chat } = held;
    chat.enter(pane.current!);
    shown.current = chat;
    return () => {
      shown.current = null;
      chat.leave();
      // Parked, it reads no more of its transcript until it shows again.
      chat.render({ ...latest.current, active: false });
      kept.park(sessionId);
      timing('chat.parked', performance.now(), { count: kept.parked() });
    };
  }, [sessionId]);

  // After the mount's effect, so a chat view coming back is drawn with this pane's props as it enters.
  useLayoutEffect(() => {
    shown.current?.render(props);
  });

  return ownChat ? <ChatView {...props} /> : <div ref={pane} className="kept-chat" data-testid="kept-chat" />;
}
