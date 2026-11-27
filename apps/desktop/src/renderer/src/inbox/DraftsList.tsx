import { Shapes, SquareArrowOutUpRight } from 'lucide-react';
import type { PrefabDraft } from '@agent-board/daemon/protocol';
import { Button } from '../ui';
import { draftedBy, draftNeedsYou, draftsToReview } from '../crews/draft-review';
import { usePrefabDrafts } from '../crews/prefab-drafts';
import { useMinute } from './use-minute';

/** The drafts waiting for the user, as Needs you lists them: newest first. */
export const useDraftsToReview = (): PrefabDraft[] => draftsToReview(usePrefabDrafts().drafts);

/**
 * The crews agents drafted for the user, newest first, apart from what they asked: each row says who drafted which
 * crew and when, and Open shows it on its board, in the board's window, to start, change or discard. No request, so it
 * counts toward no badge; a row goes once its draft is saved or discarded. `onOpened` hears that one was opened, for a
 * popover to close.
 */
export function DraftsList({ drafts, onOpened }: { drafts: readonly PrefabDraft[]; onOpened?(): void }) {
  const now = useMinute().getTime();
  if (drafts.length === 0) return null;
  const open = (id: string) => {
    onOpened?.();
    void window.agentBoard.windows.requestBoard({ kind: 'prefabDraft', id });
  };
  return (
    <section className="inbox-group" data-testid="inbox-group" data-section="drafts" aria-label="Drafts">
      <h3 className="inbox-group-head">
        <span className="inbox-group-name">Drafts</span>
        <span className="inbox-group-count" aria-label={`${drafts.length} to review`}>
          {drafts.length}
        </span>
      </h3>
      <ul className="inbox-items">
        {drafts.map((draft) => {
          const row = draftNeedsYou(draft);
          return (
            <li key={draft.id} className="inbox-item" data-testid="inbox-draft" data-draft-id={draft.id} data-kind="draft">
              <div className="inbox-item-head">
                <Shapes className="inbox-item-mark" aria-hidden />
                <span className="inbox-item-name" title={row.text}>
                  {row.text}
                </span>
                <span className="inbox-kind" data-testid="inbox-kind" data-kind="draft">
                  Draft
                </span>
                <Button size="sm" variant="ghost" className="inbox-item-open" icon={<SquareArrowOutUpRight />} aria-label={`Open ${draft.prefab.name}`} onClick={() => open(draft.id)}>
                  Open
                </Button>
              </div>
              <p className="inbox-item-note">{draftedBy(draft, now)}</p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
