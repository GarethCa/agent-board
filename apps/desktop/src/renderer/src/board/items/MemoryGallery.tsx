import { MEMORY_CARD_SIZE, LIST_CARD_FOLDED_SIZE, ZONE_COLORS, type HistoryVersion, type MemoryEntry, type MemoryView } from '@agent-board/daemon/protocol';
import { PopoverPreview } from '../../ui';
import { MemoryCardView, MemoryIconView, MemoryPeek } from './MemoryCard';
import { MemoryFull } from './MemoryFull';
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

const GUIDE = [
  '# How we test',
  '',
  'Run the unit tests first, one file at a time:',
  '',
  '```',
  'pnpm vitest run packages/api/src/orders.test.ts',
  '```',
  '',
  '## Fakes',
  '',
  '- The **payments** fake answers in 50 ms',
  '- Rerun board-mcp-http once; it is _flaky_ under load',
].join('\n');

const ENTRIES = inListOrder([
  entry('e1', 'db.fixtures', 'Use seed-small; seed-full takes 4 min', impl2, at(5, 10, 40)),
  entry('e2', null, 'Staging is down until 14:00', impl3, at(5, 11, 2)),
  entry('e3', 'test.cmd', 'pnpm vitest run packages/api', lead, at(5, 9, 12)),
  entry('e4', 'style', 'Errors are Result, never throw', { kind: 'user' }, at(2, 16), { pinned: true }),
  entry('e5', 'release-notes.md', '# Release notes\n\n- Orders paginate by cursor\n- Images are cached for a day', lead, at(4, 17), { file: true }),
  entry('e6', 'deploy.day', 'Tuesdays', { kind: 'user' }, new Date(2026, 8, 20).toISOString()),
  entry('e7', 'How we test', GUIDE, impl2, at(5, 13, 10), { file: true, madeBy: lead, createdAt: at(3, 9) }),
]);

/**
 * The peek's entries: all but the guide, which the full-screen shots show. The peek sizes to its rows, and a row is not a
 * whole number of pixels high, so one more would move every gallery below it off the pixel grid.
 */
const PEEK_ENTRIES = ENTRIES.filter((each) => each.id !== 'e7');

/** Who read the gallery's memory, and its guide. */
const READERS: MemoryView['readers'] = {
  memory: { count: 14, last: { name: 'impl-3', at: at(5, 14, 57) } },
  entries: { e7: { count: 9, last: { name: 'impl-3', at: at(5, 14, 57) } }, e3: { count: 12, last: { name: 'lead', at: at(5, 14, 20) } } },
};

/** The guide's versions, newest first. */
const GUIDE_HISTORY: HistoryVersion<MemoryEntry>[] = [
  { version: 4, action: 'edit', value: ENTRIES.find((each) => each.id === 'e7') ?? null, by: impl2, at: at(5, 13, 10) },
  { version: 3, action: 'confirm', value: null, by: { kind: 'user' }, at: at(4, 18) },
  { version: 2, action: 'edit', value: entry('e7', 'How we test', 'Older text', lead, at(4, 9), { file: true }), by: lead, at: at(4, 9) },
  { version: 1, action: 'add', value: entry('e7', 'How we test', 'First text', lead, at(3, 9), { file: true }), by: lead, at: at(3, 9) },
];
const history = (id: string) => Promise.resolve(id === 'e7' ? GUIDE_HISTORY : []);
const change = () => Promise.resolve(false as const);

const noop = () => {};
/** The api zone's colour, as a zone stores it. */
const ZONE = ZONE_COLORS[0];
/** What both full-screen shots share. */
const full = { title: 'api memory', scope: 'Zone · api', zoneColor: ZONE, entries: ENTRIES, readers: READERS, now: NOW, onChange: change, history, onRemove: noop, onClose: noop, openLink: noop, inline: true } as const;
const card = { width: MEMORY_CARD_SIZE.width, height: MEMORY_CARD_SIZE.height };
const folded = { width: LIST_CARD_FOLDED_SIZE.width, height: LIST_CARD_FOLDED_SIZE.height };

/**
 * A memory in each of its looks: open with entries and empty, folded at rest, just written to and empty, its peek, and
 * full screen with a document open to write and with a fact.
 */
export function MemoryGallery() {
  return (
    <section className="listcard-gallery" data-testid="memory-gallery" aria-label="Memory">
      <div className="listcard-gallery-row">
        <div style={card} data-testid="memory-gallery-card">
          <MemoryCardView title="api memory" scope="Zone · api" zoneColor={ZONE} entries={ENTRIES} readers={READERS.memory} now={NOW} onAdd={noop} onOpen={noop} fresh="e2" />
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
            <MemoryPeek title="api memory" scope="Zone · api" zoneColor={ZONE} entries={PEEK_ENTRIES} now={NOW} onAdd={noop} onEdit={noop} onPin={noop} onRemove={noop} onFull={noop} autoFocus={false} />
          </PopoverPreview>
        </div>
      </div>
      <div className="listcard-gallery-full" data-testid="memory-gallery-full-doc">
        <MemoryFull {...full} initial={{ selected: 'e7', editing: true }} />
      </div>
      <div className="listcard-gallery-full" data-testid="memory-gallery-full-fact">
        <MemoryFull {...full} initial={{ selected: 'e6', filter: { tab: 'facts' } }} />
      </div>
    </section>
  );
}
