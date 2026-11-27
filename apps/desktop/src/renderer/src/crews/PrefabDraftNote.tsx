import { useState, type Ref } from 'react';
import { Bot, ChevronDown, ChevronRight, Info, Pencil, Play } from 'lucide-react';
import type { PrefabAssumption } from '@agent-board/daemon/protocol';
import { Button } from '../ui';
import type { DraftSummary } from './draft-review';

interface PrefabDraftNoteProps {
  assumptions: readonly PrefabAssumption[];
  /** Who drafted it, by name. */
  drafter: string;
  /** What it will start, said plainly, for the user to review before they start it. */
  summary?: DraftSummary;
  onSave(): void;
  /** Saves it to the library, then opens its prompt box to start a crew from it. */
  onStart?(): void;
  /** Deletes the draft for good and leaves its board. */
  onDiscard?(): void;
  /** Selects what an assumption is about, by its id. */
  onPick(id: string): void;
  /** The note itself, so the board's fit keeps the graph clear of it. */
  ref?: Ref<HTMLElement>;
}

/**
 * A draft's note on the prefab's board: that it is not saved yet, what it will start (its agents with their roles and
 * models, its inputs and its lines), and what its drafter chose that the user didn't say. Start saves it and opens its
 * prompt box, Edit folds the review away to change it on the board, and Discard deletes it, asking first.
 */
export function PrefabDraftNote({ assumptions, drafter, summary, onSave, onStart, onDiscard, onPick, ref }: PrefabDraftNoteProps) {
  const [reviewing, setReviewing] = useState(true);
  const [discarding, setDiscarding] = useState(false);
  return (
    <section ref={ref} className="prefab-draft nodrag nowheel" aria-label="A draft" data-testid="prefab-draft">
      <div className="prefab-draft-banner">
        <Pencil aria-hidden />
        <span>A draft · not saved yet</span>
        <Button size="sm" variant={onStart === undefined ? 'primary' : 'secondary'} data-testid="prefab-draft-save" onClick={onSave}>
          Save to library
        </Button>
      </div>
      {summary !== undefined && (
        <>
          <button type="button" className="prefab-draft-cap prefab-draft-fold" aria-expanded={reviewing} data-testid="prefab-draft-fold" onClick={() => setReviewing(!reviewing)}>
            {reviewing ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
            What it will start
          </button>
          {reviewing && (
            <div className="prefab-draft-review" data-testid="prefab-draft-review">
              <ul className="prefab-draft-agents" aria-label="Its agents">
                {summary.agents.map((agent) => (
                  <li key={agent.id}>
                    <button type="button" className="prefab-draft-agent" title="Select it on the board" onClick={() => onPick(agent.id)}>
                      <b>{agent.name}</b>
                      <span>
                        {agent.role} · {agent.model}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {summary.inputs.length > 0 && (
                <p className="prefab-draft-line">
                  <span className="prefab-draft-label">Inputs</span> {summary.inputs.join(', ')}
                </p>
              )}
              {summary.lines.length > 0 && (
                <ul className="prefab-draft-lines" aria-label="Its lines">
                  {summary.lines.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
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
      {(onStart !== undefined || onDiscard !== undefined) && (
        <div className="prefab-draft-actions">
          {discarding ? (
            <>
              <span className="prefab-card-ask">Discard it for good?</span>
              <Button size="sm" variant="danger" data-testid="prefab-draft-discard-yes" onClick={onDiscard}>
                Discard
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDiscarding(false)}>
                Keep
              </Button>
            </>
          ) : (
            <>
              {onStart !== undefined && (
                <Button size="sm" variant="primary" icon={<Play />} data-testid="prefab-draft-start" onClick={onStart}>
                  Start
                </Button>
              )}
              {summary !== undefined && (
                <Button size="sm" variant="ghost" data-testid="prefab-draft-edit" onClick={() => setReviewing(false)}>
                  Edit
                </Button>
              )}
              {onDiscard !== undefined && (
                <Button size="sm" variant="ghost" data-testid="prefab-draft-discard" onClick={() => setDiscarding(true)}>
                  Discard
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
