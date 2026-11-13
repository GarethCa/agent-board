import { UserRound, Users } from 'lucide-react';
import { ToolButton } from '../ui';
import { setIncludeAgents, useHasAgentMessages, useIncludeAgents } from './chat-filter';

/** The switch over a chat, once it holds a message from an agent, between only the user's own messages and every one, as one button: pressed while it shows only the user's own. This chat only. */
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
