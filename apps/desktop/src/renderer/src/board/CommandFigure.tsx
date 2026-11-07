import type { Agent } from '@agent-board/daemon/protocol';
import { Character } from './Character';
import { useCharacterStyle } from './characters';

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

/**
 * A tile's robot over its top edge while it hands off or waits on a command, for Off alone: with a style picked, the
 * tile's own character strikes both poses, and a second robot would say it twice.
 */
export function TileRobot({ agent, sending }: { agent: Agent; sending: boolean }) {
  if (useCharacterStyle() !== 'off') return null;
  if (!sending) return <CommandFigure agent={agent} />;
  return (
    // Its robot, handing its payload on, perched at the top left (FlowRules).
    <span className="hybrid-tile-handoff">
      <Character harness={agent.harness} pose="handing-off" label={agent.name} />
    </span>
  );
}
