import { memo, useContext, useLayoutEffect, useRef, useState } from 'react';
import { NodeToolbar, Position, useStore, type NodeProps } from '@xyflow/react';
import { Bot, Check, ChevronDown, ChevronRight, FileText, StickyNote, Undo2 } from 'lucide-react';
import type { DoneTicket } from '@agent-board/daemon/protocol';
import { doneLineData } from '@agent-board/daemon/zone-clean-up';
import { errorMessage } from '../../../../shared/errors';
import { IconButton } from '../../ui';
import { useBoardCommands } from '../commands';
import { DocumentCardsContext } from './DocumentNode';
import { ItemActionsContext, type ItemNodeType } from './items';
import { doneChipText, doneLabel, doneLineChips, donePartsOf, estimateTextWidth, type MeasureText } from './done-line';

/** A measure of text in the font of the chips inside `element`, or the estimate where there is no canvas to measure with. */
function measureIn(element: HTMLElement): MeasureText {
  const context = document.createElement('canvas').getContext('2d');
  if (context === null) return estimateTextWidth;
  const style = getComputedStyle(element);
  context.font = `${style.getPropertyValue('--font-size-xs').trim() || '11px'} ${style.fontFamily}`;
  return (text) => context.measureText(text).width;
}

/** One finished ticket's chip: its ticket, a glyph if it took notes with it, and its pull request, which opens. */
function DoneChip({ ticket, onOpen }: { ticket: DoneTicket; onOpen(url: string): void }) {
  const opens = ticket.pr?.url ?? ticket.issue?.url;
  return (
    <button
      type="button"
      className="done-line-chip nodrag"
      data-testid="done-chip"
      data-key={ticket.key}
      title={ticket.title}
      disabled={opens === undefined}
      onClick={() => opens !== undefined && onOpen(opens)}
    >
      <Check className="done-line-chip-glyph" aria-hidden="true" />
      <span className="done-line-chip-text">{doneChipText(ticket)}</span>
      {ticket.notes.length > 0 && <StickyNote className="done-line-chip-glyph" aria-label={`${ticket.notes.length} notes`} />}
      {ticket.pr !== null && <span className="done-line-chip-pr">#{ticket.pr.number}</span>}
    </button>
  );
}

/** What a ticket in the Done list holds: its agents, which open their window, and its notes and docs, which open too. */
function DoneParts({ ticket }: { ticket: DoneTicket }) {
  const nodeLookup = useStore((state) => state.nodeLookup);
  const commands = useBoardCommands();
  const cards = useContext(DocumentCardsContext);
  const [reading, setReading] = useState<string>();
  const parts = donePartsOf(ticket, (id) => nodeLookup.get(id)?.internals.userNode);
  return (
    <ul className="done-line-parts" data-testid="done-parts">
      {parts.map((part) => {
        const found = part.kind === 'doc' ? cards.find(part.sessionId, part.documentId) : undefined;
        const icon = part.kind === 'agent' ? <Bot aria-hidden="true" /> : part.kind === 'doc' ? <FileText aria-hidden="true" /> : <StickyNote aria-hidden="true" />;
        const onClick =
          part.kind === 'agent'
            ? () => void commands.openSession(part.sessionId)
            : part.kind === 'doc'
              ? () => found !== undefined && cards.open(found.agent, found.document)
              : () => setReading(reading === part.id ? undefined : part.id);
        return (
          <li key={part.id}>
            <button type="button" className="done-line-part nodrag" disabled={part.kind === 'doc' && found === undefined} aria-expanded={part.kind === 'note' ? reading === part.id : undefined} onClick={onClick}>
              {icon}
              <span>{part.label}</span>
            </button>
            {part.kind === 'note' && reading === part.id && <p className="done-line-note">{part.text}</p>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A zone's Done line: what Clean up folded away, one chip per finished ticket in a single row. The oldest fold into a
 * "+N" chip; it, or the row's label, opens the whole list, where each ticket can be put back on the board.
 */
export const DoneLineNode = memo(function DoneLineNode({ data, width }: NodeProps<ItemNodeType>) {
  const { openLink } = useContext(ItemActionsContext);
  const { item } = data;
  const { tickets } = doneLineData(item.data);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const line = useRef<HTMLDivElement>(null);
  const [measure, setMeasure] = useState<MeasureText>(() => estimateTextWidth);
  useLayoutEffect(() => {
    if (line.current !== null) setMeasure(() => measureIn(line.current!));
  }, []);
  const { shown, folded } = doneLineChips(tickets, width ?? item.width, measure);
  const toggle = (key: string) => setExpanded((now) => (now.has(key) ? new Set([...now].filter((each) => each !== key)) : new Set([...now, key])));
  const putBack = (key: string) => {
    if (item.zoneId === null) return;
    setError(undefined);
    window.agentBoard.zones.putBackDone(item.zoneId, key).catch((failure: unknown) => setError(errorMessage(failure)));
  };

  return (
    <div ref={line} className="done-line" data-testid="done-line" data-zone={item.zoneId ?? ''}>
      <button type="button" className="done-line-label nodrag" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Check className="done-line-chip-glyph" aria-hidden="true" />
        {doneLabel(tickets.length)}
      </button>
      {folded.length > 0 && (
        <button type="button" className="done-line-chip done-line-more nodrag" data-testid="done-more" aria-expanded={open} onClick={() => setOpen(!open)}>
          +{folded.length}
        </button>
      )}
      {shown.map((ticket) => (
        <DoneChip key={ticket.key} ticket={ticket} onOpen={openLink} />
      ))}
      <NodeToolbar isVisible={open} position={Position.Bottom} align="start" className="done-line-list" data-testid="done-list">
        {[...tickets].reverse().map((ticket) => (
          <div key={ticket.key} className="done-line-ticket">
            <div className="done-line-row">
              <IconButton
                icon={expanded.has(ticket.key) ? <ChevronDown /> : <ChevronRight />}
                size="sm"
                aria-label={`What ${doneChipText(ticket)} holds`}
                aria-expanded={expanded.has(ticket.key)}
                onClick={() => toggle(ticket.key)}
              />
              <DoneChip ticket={ticket} onOpen={openLink} />
              <IconButton icon={<Undo2 />} size="sm" aria-label={`Put ${doneChipText(ticket)} back`} tooltip="Put it back on the board" onClick={() => putBack(ticket.key)} />
            </div>
            {expanded.has(ticket.key) && <DoneParts ticket={ticket} />}
          </div>
        ))}
        {error !== undefined && (
          <p className="done-line-error" role="alert">
            {error}
          </p>
        )}
      </NodeToolbar>
    </div>
  );
});
