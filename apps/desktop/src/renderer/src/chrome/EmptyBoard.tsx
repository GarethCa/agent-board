import { GitBranch, SquareDashed } from 'lucide-react';
import { Button, EmptyState } from '../ui';
import { BrandMark } from './BrandMark';
import type { ZoneSource } from './zones';

/** What a board with no zones shows in its middle: what a zone is, and the two ways to add one (a repo zone, a group). */
export function EmptyBoard({ onAddZone }: { onAddZone(source: ZoneSource): void }) {
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
