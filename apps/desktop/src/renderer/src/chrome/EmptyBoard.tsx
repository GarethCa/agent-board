import { GitBranch, Plus, SquareDashed } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ArmedTool } from '../board/ToolOverlay';
import { useSimplified } from '../design';
import { Button, EmptyState } from '../ui';
import { BrandMark } from './BrandMark';
import type { ZoneSource } from './zones';

/**
 * What a board with no zones shows in its middle: what a zone is, and the two ways to add one (a repo zone, a group).
 * Under the Simplified design it is three starter cards instead (`StarterCards`).
 */
export function EmptyBoard({ onAddZone, onTool }: { onAddZone(source: ZoneSource): void; onTool(tool: ArmedTool): void }) {
  if (useSimplified()) return <StarterCards onAddZone={onAddZone} onTool={onTool} />;
  return (
    <div className="empty-board">
      <EmptyState
        data-testid="empty-board"
        title="An empty board"
        art={<BrandMark variant="plain" className="empty-board-mark" />}
        action={
          <div className="empty-board-actions">
            <Button variant="primary" icon={<GitBranch />} onClick={() => onAddZone('github')}>
              Add a repo zone
            </Button>
            <Button icon={<SquareDashed />} onClick={() => onAddZone('empty')}>
              Group
            </Button>
          </div>
        }
      >
        Put an agent or a shell straight on the board from the toolbar, or add a zone: one for a repo&rsquo;s agents, or a
        group for anything.
      </EmptyState>
    </div>
  );
}

/**
 * The Simplified design's empty board: three starter cards, each calling what Classic's empty board offers (a repo
 * zone, a group, and the toolbar's New agent, which arms the Agent tool).
 */
function StarterCards({ onAddZone, onTool }: { onAddZone(source: ZoneSource): void; onTool(tool: ArmedTool): void }) {
  return (
    <div className="empty-board">
      <EmptyState
        data-testid="empty-board"
        title="An empty board"
        art={<BrandMark variant="plain" className="empty-board-mark" />}
        action={
          <div className="empty-board-cards">
            <StarterCard icon={<GitBranch />} title="Add a repo zone" onClick={() => onAddZone('github')}>
              A place for a repo&rsquo;s agents.
            </StarterCard>
            <StarterCard icon={<SquareDashed />} title="Group" onClick={() => onAddZone('empty')}>
              A zone for anything.
            </StarterCard>
            <StarterCard icon={<Plus />} title="New agent" onClick={() => onTool('agent')}>
              Put one on the board, then click where it goes.
            </StarterCard>
          </div>
        }
      >
        Start with one of these.
      </EmptyState>
    </div>
  );
}

function StarterCard({ icon, title, children, onClick }: { icon: ReactNode; title: string; children: ReactNode; onClick(): void }) {
  return (
    <button type="button" className="empty-board-card" onClick={onClick}>
      {icon}
      <span className="empty-board-card-title">{title}</span>
      <span className="empty-board-card-body">{children}</span>
    </button>
  );
}
