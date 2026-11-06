// The rows of an agent's sidebar that are records (sidebar-records.ts), drawn alike wherever they are: the Full
// sidebar's sections and the shelves. A recorded row has a solid rule and a × that deletes it, with Undo; a guessed one
// a dotted rule and a "guessed" tag.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Surface } from '@agent-board/daemon/window-layout';
import { X } from 'lucide-react';
import { errorMessage } from '../../../shared/errors';
import { Hint, IconButton, PanelRow, useToast } from '../ui';
import { shortWhen } from '../when';
import { recordDeleter, type RecordDeleter } from './record-deletes';
import type { PinRow, SidebarRow, SidebarSection } from './sidebar-records';
import { docSurfaceOf } from './tabs';

/** When a recorded row was recorded, as its meta ends: `recorded 10:12`; nothing for a guess. */
export const recordedWhen = (row: SidebarRow<unknown>): string | undefined => (row.source === 'recorded' ? `recorded ${shortWhen(row.record.recordedAt)}` : undefined);

/** How long a deleted record's row stays, fading out struck through, while its Undo is up. */
const FADE_MS = 5000;

export interface RecordDeletes extends RecordDeleter {
  /** The records just deleted, still shown as gone. */
  fading: ReadonlySet<string>;
}

/** Deleting the agent's records from its sidebar, each with Undo in a toast, and bringing them back. */
export function useRecordDeletes(sessionId: string, onProblem: (problem: string | undefined) => void): RecordDeletes {
  const toasts = useToast();
  const [fading, setFading] = useState<ReadonlySet<string>>(new Set());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);
  const unfade = (key: string) => {
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    setFading((current) => new Set([...current].filter((each) => each !== key)));
  };
  const deleter = recordDeleter({
    set: (record, deleted) =>
      window.agentBoard.agents.setRecordDeleted(sessionId, record.kind, record.key, deleted).then(
        () => {},
        (error: unknown) => onProblem(`could not ${deleted ? 'delete' : 'bring back'} the record: ${errorMessage(error)}`),
      ),
    toast: (options) => void toasts.show(options),
    fade(key) {
      setFading((current) => new Set([...current, key]));
      clearTimeout(timers.current.get(key));
      timers.current.set(key, setTimeout(() => unfade(key), FADE_MS));
    },
    unfade,
  });
  return { fading, ...deleter };
}

/** What a row of a section shows: drawn as a recorded or a guessed row by `RecordList`. */
export interface RecordRowView {
  name: ReactNode;
  meta?: ReactNode;
  /** What a guessed row says after its "guessed" tag, in place of `meta`: what it was guessed from. */
  guess?: string;
  mark: ReactNode;
  end?: ReactNode;
  title?: string;
  onClick?: (() => void) | undefined;
  testId?: string;
}

/**
 * A section's rows: a recorded row with a solid rule and a × on hover that deletes it (with Undo), a guessed one with a
 * dotted rule, lighter, tagged "guessed", and no ×. Under them, what deleted records hide, and Show to bring them back.
 */
export function RecordList<T>({
  section,
  empty,
  records,
  what,
  row,
}: {
  section: SidebarSection<T>;
  /** What it says with no rows; nothing unless said (a shelf with nothing has no group). */
  empty?: string;
  records: RecordDeletes;
  what(row: SidebarRow<T>): string;
  row(row: SidebarRow<T>): RecordRowView;
}) {
  const { rows, hidden } = section;
  return (
    <>
      {rows.length === 0 ? (
        empty !== undefined && <Hint>{empty}</Hint>
      ) : (
        <ul className="details-list">
          {rows.map((each) => {
            const view = row(each);
            const gone = each.source === 'recorded' && each.gone === true;
            const meta = each.source === 'guessed' ? <><em className="details-guessed">guessed</em> {view.guess ?? view.meta}</> : gone ? 'deleted' : view.meta;
            return (
              <li key={each.key} className="details-record" data-source={each.source} data-gone={gone || undefined} data-testid={view.testId ?? 'details-record'}>
                <PanelRow
                  as={view.onClick && !gone ? 'button' : 'div'}
                  title={view.title}
                  onClick={gone ? undefined : view.onClick}
                  mark={view.mark}
                  name={view.name}
                  meta={meta}
                  end={view.end}
                />
                {each.source === 'recorded' && !gone && (
                  <IconButton
                    className="details-record-delete"
                    icon={<X />}
                    size="sm"
                    variant="danger"
                    aria-label="Delete record"
                    tooltip="Delete record"
                    onClick={() => records.remove(each.record, what(each))}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {hidden.length > 0 && (
        <p className="details-hidden" data-testid="details-hidden">
          {hidden.length} hidden ·{' '}
          <button type="button" className="details-hidden-show" title="Bring back what was deleted here" onClick={() => records.restore(hidden)}>
            Show
          </button>
        </p>
      )}
    </>
  );
}

/** What clicking a pin does, by how it opens; nothing for a note, which shows all it has. */
export function pinOpener(sessionId: string, how: { openWeb(url: string): void; openSurface?: ((surface: Surface) => void) | undefined; revealFile(path: string): void }) {
  return ({ target, opens }: PinRow): (() => void) | undefined => {
    if (target.kind === 'link') return () => how.openWeb(target.url);
    if (target.kind !== 'file') return undefined;
    if (opens === 'doc') return how.openSurface && (() => how.openSurface!(docSurfaceOf(sessionId, target.path)));
    return () => how.revealFile(target.path);
  };
}
