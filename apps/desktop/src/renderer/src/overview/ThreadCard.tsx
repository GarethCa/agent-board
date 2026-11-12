import type { WorkCategory } from '@agent-board/daemon/protocol';
import { WORK_CATEGORY_LABELS } from '@agent-board/daemon/work-category';
import { ageText, initials, type OverviewThread } from './overview-model';

/** Each category's glyph, before its name on a group's heading and a chip. */
export const CATEGORY_GLYPHS: Record<WorkCategory, string> = {
  'needs-help': '!',
  'ready-for-review': '◎',
  blocked: '✕',
  'waiting-on-others': '⧗',
  'in-review': '◐',
  working: '●',
  done: '✓',
};

/**
 * One thread as a card: whether the agent set its category or the board guessed it (a solid dot or a dashed one), its
 * name and how long it has been there, its line, and who it waits on. The board's reason for a guess is its tooltip,
 * and is read out with its name. A Working or Done thread is a slim row: its name and its line. A dot after them
 * marks one that changed since the last look.
 */
export function ThreadCard({ thread, now, slim = false }: { thread: OverviewThread; now: Date; slim?: boolean }) {
  const age = ageText(thread.since, now);
  const ownLabel = thread.chip !== WORK_CATEGORY_LABELS[thread.category];
  const title = thread.why === null ? undefined : `The board’s guess: ${thread.why}`;
  const source = thread.source === 'agent' ? 'set by the agent' : thread.why === null ? 'the board’s guess' : `the board’s guess, ${thread.why}`;
  const label = `${thread.name}: ${thread.chip}, ${source}${thread.fresh ? ', changed since you last looked' : ''}`;
  return (
    <article
      className="overview-card"
      data-testid="overview-card"
      data-category={thread.category}
      data-source={thread.source}
      data-slim={slim || undefined}
      data-fresh={thread.fresh || undefined}
      aria-label={label}
      title={title}
    >
      <div className="overview-card-head">
        <span className="overview-card-source" aria-hidden="true" />
        <span className="overview-card-name">{thread.name}</span>
        {slim ? <span className="overview-card-line">{thread.line}</span> : null}
        {ownLabel && !slim ? <span className="overview-chip">{thread.chip}</span> : null}
        {slim ? null : (
          <time className="overview-card-age" dateTime={thread.since} data-old={age.old || undefined}>
            {age.text}
          </time>
        )}
        {thread.fresh ? <span className="overview-card-fresh" aria-hidden="true" /> : null}
      </div>
      {slim || thread.line === '' ? null : <div className="overview-card-line">{thread.line}</div>}
      {slim || thread.waitingOn === null ? null : (
        <div className="overview-card-waiting">
          <span className="overview-avatar" aria-hidden="true">
            {initials(thread.waitingOn.who)}
          </span>
          <span className="overview-card-who">
            {thread.waitingOn.who}
            {thread.waitingOn.ref === null ? null : <span className="overview-card-ref"> · {thread.waitingOn.ref}</span>}
          </span>
        </div>
      )}
    </article>
  );
}
