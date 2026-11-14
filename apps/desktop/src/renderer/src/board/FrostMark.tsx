import { Snowflake } from 'lucide-react';
import type { Agent } from '@agent-board/daemon/protocol';

/** A paused agent's snowflake, in its tile's head beside its name: none while it runs. Its status says Paused already, so a screen reader skips it. */
export function FrostMark({ agent }: { agent: Pick<Agent, 'state'> }) {
  if (agent.state !== 'hibernated') return null;
  return (
    <span className="tile-frost-mark" data-testid="tile-frost-mark" aria-hidden title="Paused: Wake, or a message, starts it again">
      <Snowflake aria-hidden />
    </span>
  );
}
