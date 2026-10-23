import { createContext, memo, useContext } from 'react';
import { NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { CLOCK_FOLDED_SIZE, CLOCK_SIZE, type ClockStatus } from '@agent-board/daemon/protocol';
import { ChevronsLeftRight, ChevronsRightLeft, Pencil, Trash2 } from 'lucide-react';
import { IconButton, Kbd } from '../../ui';
import { useNow } from '../../inbox/use-now';
import { keyText } from '../../keys/registry';
import { clockCard, clockData } from '../clocks';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';

/** What a clock needs from the board: each clock's status, the names of the agents on it, and its editor. */
export interface ClockBoard {
  statuses: ReadonlyMap<string, ClockStatus>;
  agentName(sessionId: string): string | undefined;
  /** Opens the clock's editor. */
  edit(clockId: string): void;
}

export const ClockBoardContext = createContext<ClockBoard>({ statuses: new Map(), agentName: () => undefined, edit: () => {} });

/** A clock face's hands, showing `at` (its next run, else now). */
function Face({ at, small = false }: { at: Date; small?: boolean }) {
  const minutes = at.getMinutes();
  const hours = (at.getHours() % 12) + minutes / 60;
  return (
    <span className={small ? 'clock-face clock-face-small' : 'clock-face'} aria-hidden="true">
      <i className="clock-hand clock-hand-hour" style={{ transform: `translateX(-50%) rotate(${hours * 30}deg)` }} />
      <i className="clock-hand clock-hand-minute" style={{ transform: `translateX(-50%) rotate(${minutes * 6}deg)` }} />
    </span>
  );
}

/**
 * A schedule on the board: a tile-wide card with a small clock face on its rounded left end, the schedule in words,
 * what it does and when, and a strip of its last runs. Folded, it is a pill with the face, the words and when it
 * next runs. Double-click (or Edit) opens its editor.
 */
export const ClockNode = memo(function ClockNode({ data, selected: picked, dragging }: NodeProps<ItemNodeType>) {
  const selected = useOnlySelected(picked);
  const { update, remove } = useContext(ItemActionsContext);
  const { statuses, agentName, edit } = useContext(ClockBoardContext);
  const { item } = data;
  const clock = clockData(item.data);
  const status = statuses.get(item.id);
  // Its "in 2h 40m" counts down; a second's ticks are cheap next to a terminal's.
  const now = new Date(useNow(true));
  const card = clockCard(clock, status, agentName, now);
  const next = status?.nextRunAt == null ? now : new Date(status.nextRunAt);
  const fold = (folded: boolean) => update({ id: item.id, data: { folded }, ...(folded ? CLOCK_FOLDED_SIZE : CLOCK_SIZE) });
  const title = `${card.words}: ${card.detail}`;

  return (
    <div
      className={clock.folded ? 'clock clock-pill' : 'clock clock-card'}
      data-testid="clock"
      data-folded={clock.folded}
      data-running={card.running}
      data-off={!clock.enabled}
      title={title}
      onDoubleClick={(event) => {
        // Not a new note on the board behind it.
        event.stopPropagation();
        edit(item.id);
      }}
    >
      <NodeToolbar isVisible={selected && !dragging} position={Position.Top} className="sticky-toolbar">
        <IconButton icon={<Pencil />} size="sm" aria-label="Edit clock" tooltip="Edit clock" onClick={() => edit(item.id)} />
        <IconButton
          icon={clock.folded ? <ChevronsLeftRight /> : <ChevronsRightLeft />}
          size="sm"
          aria-label={clock.folded ? 'Unfold clock' : 'Fold clock'}
          tooltip={clock.folded ? 'Unfold clock' : 'Fold clock'}
          onClick={() => fold(!clock.folded)}
        />
        <IconButton
          icon={<Trash2 />}
          size="sm"
          aria-label="Delete clock"
          tooltip={
            <>
              Delete clock
              <Kbd>{keyText('edit.delete')}</Kbd>
            </>
          }
          onClick={() => remove(item.id)}
        />
      </NodeToolbar>
      <Face at={next} small={clock.folded} />
      {clock.folded ? (
        <span className="clock-pill-text">
          <b className="clock-words">{card.words}</b>
          <small className="clock-soon" data-testid="clock-soon">
            {card.running ? '✦ running' : card.soon}
          </small>
        </span>
      ) : (
        <span className="clock-text">
          <b className="clock-words">{card.words}</b>
          <small className="clock-detail" data-testid="clock-detail">
            {card.detail}
          </small>
          {card.runs.length > 0 && (
            <span className="clock-runs" data-testid="clock-runs" aria-label={`Last ${card.runs.length} runs`}>
              {card.runs.map((mark, index) => (
                <i key={index} className="clock-run" data-mark={mark} />
              ))}
            </span>
          )}
        </span>
      )}
    </div>
  );
});
