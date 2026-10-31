import { UserRound, Users } from 'lucide-react';
import { ToolButton } from '../ui';
import { setIncludeAgents, useHasAgentMessages, useIncludeAgents } from './chat-filter';

/** The switch over a chat, once it holds a message from an agent, between "Only my messages" and "Include agents", beside the style switch: this chat only. */
export function ChatAgentsSwitch({ sessionId }: { sessionId: string }) {
  const include = useIncludeAgents(sessionId);
  const held = useHasAgentMessages(sessionId);
  if (!held) return null;
  return (
    <span className="chat-style-switch chat-agents-switch" role="group" aria-label="Messages shown">
      <button type="button" aria-pressed={!include} onClick={() => setIncludeAgents(sessionId, false)}>
        Only my messages
      </button>
      <button type="button" aria-pressed={include} onClick={() => setIncludeAgents(sessionId, true)}>
        Include agents
      </button>
    </span>
  );
}

/** The same choice as one button, for a header short of room (the Captain's panel): pressed while it shows only the user's own. */
export function ChatAgentsButton({ sessionId }: { sessionId: string }) {
  const include = useIncludeAgents(sessionId);
  const held = useHasAgentMessages(sessionId);
  if (!held) return null;
  return (
    <ToolButton
      size="sm"
      icon={include ? <Users /> : <UserRound />}
      label="Only my messages"
      pressed={!include}
      hint="Leave out the messages other agents sent, in this chat"
      onClick={() => setIncludeAgents(sessionId, !include)}
    />
  );
}
