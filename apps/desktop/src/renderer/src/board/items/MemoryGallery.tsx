import { MEMORY_CARD_SIZE, LIST_CARD_FOLDED_SIZE, ZONE_COLORS, type MemoryEntry } from '@agent-board/daemon/protocol';
import { PopoverPreview } from '../../ui';
import { MemoryCardView, MemoryIconView, MemoryPeek } from './MemoryCard';
import { inListOrder } from './memory-card';

/** The gallery's clock: fixed, so its times read the same in every run. */
const NOW = new Date(2026, 10, 5, 15, 0);
const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
const lead = { kind: 'agent', sessionId: 'lead', name: 'lead' } as const;
const impl2 = { kind: 'agent', sessionId: 'impl-2', name: 'impl-2' } as const;
const impl3 = { kind: 'agent', sessionId: 'impl-3', name: 'impl-3' } as const;

function entry(id: string, key: string | null, text: string, by: MemoryEntry['changedBy'], updatedAt: string, more: Partial<MemoryEntry> = {}): MemoryEntry {
  return { id, memoryId: 'gallery', key, file: false, text, pinned: false, madeBy: by, changedBy: by, createdAt: updatedAt, updatedAt, ...more };
}

const ENTRIES = inListOrder([
  entry('e1', 'db.fixtures', 'Use seed-small; seed-full takes 4 min', impl2, at(5, 10, 40)),
  entry('e2', null, 'Staging is down until 14:00', impl3, at(5, 11, 2)),
  entry('e3', 'test.cmd', 'pnpm vitest run packages/api', lead, at(5, 9, 12)),
  entry('e4', 'style', 'Errors are Result, never throw', { kind: 'user' }, at(2, 16), { pinned: true }),
  entry('e5', 'release-notes.md', '# Release notes\n\n- Orders paginate by cursor\n- Images are cached for a day', lead, at(4, 17), { file: true }),
  entry('e6', 'deploy.day', 'Tuesdays', { kind: 'user' }, new Date(2026, 8, 20).toISOString()),
]);

const noop = () => {};
/** The api zone's colour, as a zone stores it. */
const ZONE = ZONE_COLORS[0];
const card = { width: MEMORY_CARD_SIZE.width, height: MEMORY_CARD_SIZE.height };
const folded = { width: LIST_CARD_FOLDED_SIZE.width, height: LIST_CARD_FOLDED_SIZE.height };

/** A memory in each of its looks: open with entries and empty, folded at rest, just written to and empty, and its peek. */
export function MemoryGallery() {
  return (
    <section className="listcard-gallery" data-testid="memory-gallery" aria-label="Memory">
      <div className="listcard-gallery-row">
        <div style={card} data-testid="memory-gallery-card">
          <MemoryCardView title="api memory" scope="Zone · api" zoneColor={ZONE} entries={ENTRIES} now={NOW} onAdd={noop} onOpen={noop} fresh="e2" />
        </div>
        <div style={card} data-testid="memory-gallery-empty">
          <MemoryCardView title="web memory" scope="Board" entries={[]} now={NOW} onAdd={noop} onOpen={noop} />
        </div>
      </div>
      <div className="listcard-gallery-row" data-testid="memory-gallery-icons">
        <div style={folded}>
          <MemoryIconView title="api memory" scope="Zone · api" zoneColor={ZONE} count={ENTRIES.length} onOpen={noop} />
        </div>
        <div style={folded}>
          <MemoryIconView title="api memory" scope="Zone · api" count={ENTRIES.length + 1} sub="impl-2 wrote db.fixtures" pulse onOpen={noop} />
        </div>
        <div style={folded}>
          <MemoryIconView title="web memory" scope="Board" count={0} onOpen={noop} />
        </div>
        <div style={folded}>
          <MemoryIconView title="private" scope="No agents" count={3} onOpen={noop} />
        </div>
      </div>
      <div className="listcard-gallery-row">
        <div className="listcard-gallery-peek" data-testid="memory-gallery-peek">
          <PopoverPreview aria-label="api memory: every entry" className="listcard-peek-popover">
            <MemoryPeek title="api memory" scope="Zone · api" zoneColor={ZONE} entries={ENTRIES} now={NOW} onAdd={noop} onEdit={noop} onPin={noop} onRemove={noop} autoFocus={false} />
          </PopoverPreview>
        </div>
      </div>
    </section>
  );
}
