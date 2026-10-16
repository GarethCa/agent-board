import { memo, useContext, useState, type MouseEvent } from 'react';
import type { Agent } from '@agent-board/daemon/protocol';
import { Trash2, UnfoldVertical } from 'lucide-react';
import { ContextMenu, StatusPill } from '../ui';
import { agentPill, STATE_LABELS, TILE_STATE_LABELS } from '../states';
import { HarnessMark } from './HarnessMark';
import { TileActionsContext } from './tile';

/**
 * What a folded chip's pill says: `merged` once all its own pull requests are, else the agent's ended state. The pill's colour is
 * the state's, so a merged one reads as done.
 */
export function chipPill(agent: Agent): { state: Agent['state']; label: string } {
  if (agent.pullRequests.length > 0 && agent.pullRequests.every((pr) => pr.state === 'merged')) return { state: 'done', label: 'merged' };
  return agentPill(agent, TILE_STATE_LABELS);
}

/**
 * A closed agent folded to a chip: its harness mark, name and final state. A click unfolds it to its full tile; the
 * tile's connector handles and edges stay (the node is the same, only smaller).
 */
export const FoldedChip = memo(function FoldedChip({ id, agent }: { id: string; agent: Agent }) {
  const { setFolded, deleteAgent } = useContext(TileActionsContext);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number }>();
  const pill = chipPill(agent);
  const unfold = () => setFolded(id, false);
  return (
    <div
      className="folded-chip"
      data-testid="agent-tile"
      data-folded
      data-harness={agent.harness}
      data-state={agent.state}
      data-session-id={agent.sessionId}
      data-zone={agent.zoneId ?? ''}
      data-reviewer={agent.reviewOf !== null || undefined}
      role="button"
      tabIndex={0}
      title={`${agent.name}: ${agent.notice ?? 'click to unfold'}`}
      onClick={unfold}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          unfold();
        }
      }}
      onContextMenu={(event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setMenuAt({ x: event.clientX, y: event.clientY });
      }}
    >
      <HarnessMark className="folded-chip-mark" harness={agent.harness} />
      <span className="folded-chip-name">{agent.name}</span>
      <StatusPill state={pill.state} label={pill.label} title={STATE_LABELS[agent.state]} />
      {menuAt !== undefined && (
        <ContextMenu
          at={menuAt}
          label={`${agent.name} chip`}
          onClose={() => setMenuAt(undefined)}
          entries={[
            { label: 'Unfold', icon: <UnfoldVertical />, onSelect: unfold },
            { label: 'Delete agent', icon: <Trash2 />, danger: true, onSelect: () => deleteAgent(agent.sessionId) },
          ]}
        />
      )}
    </div>
  );
});
