import type { Agent } from '@agent-board/daemon/protocol';
import { Character } from './Character';

/**
 * The robot of an agent waiting on a command it left running, perched at its tile's top left where a hand-off's would
 * be. Shared by the compact tile and the expanded one, so both show it; nothing for any other state.
 */
export function CommandFigure({ agent }: { agent: Agent }) {
  if (agent.state !== 'on-command') return null;
  return (
    <span className="hybrid-tile-handoff" data-pose="on-command">
      <Character harness={agent.harness} pose="on-command" label={agent.name} />
    </span>
  );
}
