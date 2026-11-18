import type { Ref } from 'react';
import { Bot, Info, Pencil } from 'lucide-react';
import type { PrefabAssumption } from '@agent-board/daemon/protocol';
import { Button } from '../ui';

interface PrefabDraftNoteProps {
  assumptions: readonly PrefabAssumption[];
  /** Who drafted it, by name. */
  drafter: string;
  onSave(): void;
  /** Selects what an assumption is about, by its id. */
  onPick(id: string): void;
  /** The note itself, so the board's fit keeps the graph clear of it. */
  ref?: Ref<HTMLElement>;
}

/** A draft's note on the prefab's board: that it is not saved yet, and what its drafter chose that the user didn't say. */
export function PrefabDraftNote({ assumptions, drafter, onSave, onPick, ref }: PrefabDraftNoteProps) {
  return (
    <section ref={ref} className="prefab-draft nodrag nowheel" aria-label="A draft" data-testid="prefab-draft">
      <div className="prefab-draft-banner">
        <Pencil aria-hidden />
        <span>A draft · not saved yet</span>
        <Button size="sm" variant="primary" data-testid="prefab-draft-save" onClick={onSave}>
          Save to library
        </Button>
      </div>
      {assumptions.length > 0 && (
        <>
          <p className="prefab-draft-cap">What {drafter} assumed</p>
          <ul className="prefab-draft-assumed">
            {assumptions.map((each, index) => (
              <li key={index}>
                {each.about === null ? (
                  <span className="prefab-draft-assumption">
                    <Info aria-hidden />
                    <span>{each.text}</span>
                  </span>
                ) : (
                  <button type="button" className="prefab-draft-assumption" title="Select what this is about" onClick={() => onPick(each.about!)}>
                    <Bot aria-hidden />
                    <span>{each.text}</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
