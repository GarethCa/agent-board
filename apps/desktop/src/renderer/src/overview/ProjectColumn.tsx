import { useState, type CSSProperties } from 'react';
import { WORK_CATEGORY_LABELS } from '@agent-board/daemon/work-category';
import { when, type OverviewColumn, type OverviewGroup } from './overview-model';
import { CATEGORY_GLYPHS, ThreadCard } from './ThreadCard';

/** A project's column: its name and what is on the user and on others, then its threads by category. */
export function ProjectColumn({ column, now, seenAt }: { column: OverviewColumn; now: Date; seenAt: string }) {
  return (
    <section
      className="overview-column"
      data-testid="overview-column"
      data-loose={column.id === null || undefined}
      aria-label={column.name}
      style={column.color === null ? undefined : ({ '--zone-color': column.color } as CSSProperties)}
    >
      <header className="overview-column-head">
        <div className="overview-column-title">
          <span className="overview-column-swatch" aria-hidden="true" />
          <h2>{column.name}</h2>
          <span className="overview-count">{column.count}</span>
        </div>
        <div className="overview-column-sub">
          <b data-on-you={column.onYou > 0 || undefined}>{column.onYou} on you</b> · {column.onOthers} on others
        </div>
      </header>
      {column.groups.map((group) => (group.category === 'done' ? <DoneFold key={group.category} group={group} now={now} seenAt={seenAt} /> : <Group key={group.category} group={group} now={now} />))}
    </section>
  );
}

function Group({ group, now }: { group: OverviewGroup; now: Date }) {
  return (
    <div className="overview-group" data-testid="overview-group" data-category={group.category}>
      <h3 className="overview-group-head">
        <span className="overview-group-glyph" aria-hidden="true">
          {CATEGORY_GLYPHS[group.category]}
        </span>
        {WORK_CATEGORY_LABELS[group.category]}
        <span className="overview-count">{group.threads.length}</span>
      </h3>
      {group.threads.map((thread) => (
        <ThreadCard key={thread.sessionId} thread={thread} now={now} slim={group.category === 'working'} />
      ))}
    </div>
  );
}

/** Done, folded to a line of how many finished since the last look; Show opens it into slim rows. */
function DoneFold({ group, now, seenAt }: { group: OverviewGroup; now: Date; seenAt: string }) {
  const [open, setOpen] = useState(false);
  const total = group.threads.length;
  const since = when(new Date(seenAt), now);
  const words =
    group.freshCount === total ? (
      <>
        <b>{total} done</b> since {since}
      </>
    ) : group.freshCount > 0 ? (
      <>
        <b>{total} done</b> · {group.freshCount} since {since}
      </>
    ) : (
      <b>{total} done</b>
    );
  return (
    <div className="overview-group" data-testid="overview-group" data-category="done" data-open={open || undefined}>
      <button type="button" className="overview-fold" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        <span className="overview-group-glyph" aria-hidden="true">
          {CATEGORY_GLYPHS.done}
        </span>
        <span>{words}</span>
        <span className="overview-fold-toggle">{open ? 'Hide' : 'Show'}</span>
      </button>
      {open ? group.threads.map((thread) => <ThreadCard key={thread.sessionId} thread={thread} now={now} slim />) : null}
    </div>
  );
}
