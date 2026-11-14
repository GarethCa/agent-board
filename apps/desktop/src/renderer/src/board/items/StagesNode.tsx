// A zone's stage board (`stage-boards.ts` lays it out): a block headed by its grip, then a heading per stage, Doing's
// tickets as bands its tiles are drawn on, and every other stage's as quiet cards at their natural size, Done's folded
// behind one line ("N done · Show") until it is shown, and what is put off for later at the foot of To do. A ticket that
// needs you is told by its tile's own state and Doing's count, never by an outline. Dragged by its header, it moves
// anywhere in its zone; the tiles on it move with it.
import { memo, useContext, type CSSProperties, type MouseEvent, type PointerEvent } from 'react';
import { NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { GripVertical, StickyNote, Trash2 } from 'lucide-react';
import { STAGE_BOARD_HEADER, STAGE_HEADING_HEIGHT, STAGE_HEADING_TOP, STAGE_NAMES } from '@agent-board/daemon/stage-board';
import { IconButton, Kbd } from '../../ui';
import { keyText } from '../../keys/registry';
import { useNeedsYouShows } from '../../needs-you-setting';
import { MemberLine } from '../ShelvesView';
import { doneShown, needYouLabel, type DrawnStageTicket, type StageBoardView } from '../stage-boards';
import { CrewCardBoardContext } from './CrewCardNode';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';

/** A press on a card is the card's: it neither drags the block nor selects it. */
const keep = (event: MouseEvent | PointerEvent) => event.stopPropagation();

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;

/** A quiet ticket's card: its ticket and title, a line per agent, and its pull request and notes. A click opens its agent. */
function StageCard({ ticket, onOpen }: { ticket: DrawnStageTicket; onOpen: (sessionId: string) => void }) {
  const shows = useNeedsYouShows();
  const pr = ticket.agents.flatMap((agent) => agent.pullRequests)[0];
  return (
    <button
      type="button"
      className="shelf-card stage-card nodrag nopan"
      data-testid="stage-card"
      data-stage={ticket.stage}
      data-ticket={ticket.key}
      aria-label={`${ticket.title}: ${STAGE_NAMES[ticket.stage]}, ${plural(ticket.agents.length, 'agent')}. Open it`}
      style={{ left: ticket.x, top: ticket.y, width: ticket.width, height: ticket.height }}
      onPointerDown={keep}
      onMouseDown={keep}
      onClick={(event) => {
        event.stopPropagation();
        if (ticket.members[0] !== undefined) onOpen(ticket.members[0]);
      }}
    >
      <span className="shelf-card-head">
        {ticket.ticket !== null && <span className="shelf-ticket">{ticket.ticket}</span>}
        <span className="shelf-card-title">{ticket.title}</span>
      </span>
      {ticket.agents.map((agent) => (
        <MemberLine key={agent.sessionId} agent={agent} title={ticket.title} stage={ticket.stage} shows={shows} />
      ))}
      {(pr !== undefined || ticket.notes > 0) && (
        <span className="shelf-card-foot">
          {pr !== undefined && <span>PR #{pr.number}</span>}
          {ticket.notes > 0 && (
            <span>
              <StickyNote aria-hidden="true" /> {plural(ticket.notes, 'note')}
            </span>
          )}
        </span>
      )}
    </button>
  );
}

/** The block's stages, relative to it. `onShowDone` shows Done's cards, or folds them. */
function StagesView({ view, header, onShowDone }: { view: StageBoardView; header: string; onShowDone: (shown: boolean) => void }) {
  const { openAgent } = useContext(CrewCardBoardContext);
  const { fold } = view;
  return (
    <>
      <div className="stage-board-head" data-testid="stage-board-head">
        <GripVertical aria-hidden="true" className="stage-board-grip" />
        <span className="stage-board-name">Stages</span>
        <span className="stage-board-count">{header}</span>
        <span className="stage-board-hint">Drag to move</span>
      </div>
      {view.columns.map((column) => (
        <div
          key={column.stage}
          className="shelf-heading stage-heading"
          data-testid="stage-heading"
          data-stage={column.stage}
          style={{ left: column.x, top: STAGE_BOARD_HEADER + STAGE_HEADING_TOP, width: column.width, height: STAGE_HEADING_HEIGHT }}
        >
          {STAGE_NAMES[column.stage]}
          <span className="shelf-count">{column.count}</span>
          {column.needYou > 0 && <span className="shelf-needs">· {needYouLabel(column.needYou)}</span>}
          {column.later > 0 && <span className="stage-later-count">+ {column.later} later</span>}
        </div>
      ))}
      {view.later.map((card) => (
        <div key={card.id} className="stage-later" data-testid="stage-later" style={{ left: card.x, top: card.y, width: card.width, height: card.height }}>
          <span className="stage-later-tag">Later</span>
          <span className="stage-later-text">{card.text}</span>
        </div>
      ))}
      {fold !== null && (
        <button
          type="button"
          className="shelf-done-line nodrag nopan"
          data-testid="stage-done"
          aria-expanded={fold.shown}
          style={{ left: fold.x, top: fold.y, width: fold.width, height: fold.height }}
          onPointerDown={keep}
          onMouseDown={keep}
          onClick={(event) => {
            event.stopPropagation();
            onShowDone(!fold.shown);
          }}
        >
          <span>{fold.count} done</span>
          <span className="shelf-done-toggle">{fold.shown ? 'Hide' : 'Show'}</span>
        </button>
      )}
      {view.tickets.map((ticket) =>
        ticket.folded ? null : ticket.live ? (
          <div
            key={ticket.key}
            className="stage-band"
            data-testid="stage-band"
            data-ticket={ticket.key}
            style={{ left: ticket.x, top: ticket.y, width: ticket.width, height: ticket.height }}
          >
            {ticket.ticket !== null && <span className="stage-band-label">{ticket.ticket}</span>}
          </div>
        ) : (
          <StageCard key={ticket.key} ticket={ticket} onOpen={openAgent} />
        ),
      )}
    </>
  );
}

/** A zone's stage board on the board: drawn once `withStageBoards` has laid it out. */
export const StagesNode = memo(function StagesNode({ data, selected: picked, dragging }: NodeProps<ItemNodeType>) {
  const selected = useOnlySelected(picked);
  const { remove, update } = useContext(ItemActionsContext);
  const view = data.stages;
  const tickets = view?.tickets.length ?? 0;
  return (
    <div className="stage-board" data-testid="stage-board" data-selected={selected || undefined} style={{ '--zone-color': view?.color } as CSSProperties}>
      {view !== undefined && <StagesView view={view} header={`· ${plural(tickets, 'ticket')}`} onShowDone={(shown) => {
          const change = doneShown(data.item, shown);
          // A view choice, kept on the block to last a restart, but no edit: ⌘Z never folds it again.
          update({ id: change.id, data: { ...change.data } }, undefined, { silent: true });
        }} />}
      <NodeToolbar isVisible={selected && !dragging} position={Position.Top} className="sticky-toolbar">
        <IconButton
          icon={<Trash2 />}
          size="sm"
          aria-label="Take the stage board off the board"
          tooltip={
            <>
              Take it off the board: its agents stay, where they were
              <Kbd>{keyText('edit.delete')}</Kbd>
            </>
          }
          onClick={() => remove(data.item.id)}
        />
      </NodeToolbar>
    </div>
  );
});
