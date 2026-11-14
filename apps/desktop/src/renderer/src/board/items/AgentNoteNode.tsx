import { memo, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode, type Ref } from 'react';
import { NodeResizer, NodeToolbar, Position, useReactFlow, useStore, type NodeProps } from '@xyflow/react';
import { MAX_AGENT_NOTE_HEIGHT, MAX_STICKY_TEXT, MAX_AGENT_NOTE_SIZE, MIN_AGENT_NOTE_SIZE, type BoardItem } from '@agent-board/daemon/protocol';
import { Trash2 } from 'lucide-react';
import { useBoardCommands } from '../commands';
import { HarnessMark } from '../HarnessMark';
import { tileNodeId } from '../tiles';
import { IconButton, Kbd } from '../../ui';
import { HARNESSES } from '../../harness';
import { acceptLabel, agentNoteData, agentNoteFooter, lineBudget, noteStamp, noteStampFull } from './agent-note';
import { useMinute } from '../../inbox/use-minute';
import { useSuggestionActions } from '../ask/SuggestionGhosts';
import { AgentNoteLookContext, type AgentNoteLook } from './agent-note-look';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { parseMarkdown } from './sticky-text';
import { renderInline, renderMarkdown } from './StickyNode';
import { useDraftText } from './useDraftText';
import { useFitResize, useGrowToFit, useWindowFocused } from './grow-to-fit';
import { keyText } from '../../keys/registry';

/**
 * The heights the notes whose bodies are `bodies`, each as tall as `heights` says, need for their text, shorter or
 * taller, at most `MAX_AGENT_NOTE_HEIGHT` (past it, it scrolls), or 0 for one that can't be measured. A note keeps its
 * head and foot as they are, so it needs what its text's own height differs from the room its body has by. With a line
 * budget the text needs as much as its lines let it show (past that it fades into a chip), or all of it if `whole`.
 * Read all at once, then all again, so the page is laid out twice, however many notes.
 */
export function noteHeightsToFit(bodies: readonly (HTMLElement | null)[], heights: readonly number[], whole = false): number[] {
  const shown = bodies.map((body) => (body !== null && body.clientHeight > 0 ? body : null));
  const tops = shown.map((body) => body?.scrollTop ?? 0);
  // The room: the body's share of the note as it flexes, past the budget's cap, which a flexing body stops at too.
  for (const body of shown) if (body !== null) body.style.maxHeight = 'none';
  const room = shown.map((body) => body?.offsetHeight ?? 0);
  // The text being typed: a text box at its own height is as tall as its rows, not its text, so it needs what its
  // text overflows the room by.
  const typed = shown.map((body, index) => (body instanceof HTMLTextAreaElement ? room[index]! + body.scrollHeight - body.clientHeight : undefined));
  // What the text needs: the body at its own height, capped by its budget unless the whole is asked for.
  for (const body of shown) {
    if (body === null || body instanceof HTMLTextAreaElement) continue;
    body.style.flex = '0 0 auto';
    if (!whole) body.style.maxHeight = '';
  }
  const own = shown.map((body, index) => typed[index] ?? body?.offsetHeight ?? 0);
  shown.forEach((body, index) => {
    if (body === null) return;
    body.style.flex = '';
    body.style.maxHeight = '';
    body.scrollTop = tops[index]!;
  });
  return shown.map((body, index) => (body === null ? 0 : Math.min(MAX_AGENT_NOTE_HEIGHT, Math.ceil(heights[index]! + own[index]! - room[index]!))));
}

const bodyOf = (root: HTMLElement | null) => root?.querySelector<HTMLElement>('.agent-note-body') ?? null;

/** How many lines of a note's text are below what shows, or 0. */
function linesBelow(body: HTMLElement): number {
  const below = body.scrollHeight - body.scrollTop - body.clientHeight;
  if (below <= 1) return 0;
  const line = Number.parseFloat(getComputedStyle(body).lineHeight);
  return Math.max(1, Math.ceil(below / (Number.isFinite(line) && line > 0 ? line : 16)));
}

/**
 * A note an agent wrote: a speech bubble from the agent's face (its harness's mark in a round face, ringed in the
 * harness's colour), so it is never taken for a tile or a handwritten sticky. The face selects its tile; the bubble's
 * first line names the agent and its role, and the time it last wrote it. It is drawn as a document card or with a cut
 * of a terminal, as the Agent notes setting says. Given a line budget, its text past that many lines fades into a
 * "more lines" chip that shows the rest. The user can move, resize, delete and edit it like a sticky; once they edit
 * it, it says "edited by you" until its agent writes it again.
 */
export const AgentNoteNode = memo(function AgentNoteNode({ id, data, selected: picked, dragging, width, height }: NodeProps<ItemNodeType>) {
  const selected = useOnlySelected(picked);
  const look = useContext(AgentNoteLookContext);
  const { update, remove, openLink } = useContext(ItemActionsContext);
  const { focusSession } = useBoardCommands();
  const { updateNode } = useReactFlow<ItemNodeType>();
  const suggestions = useSuggestionActions();
  const { item } = data;
  const note = agentNoteData(item.data);
  const { agent } = note;
  // "Show agent" only while its tile is on the board.
  const tileShown = useStore((state) => agent.sessionId !== '' && state.nodeLookup.has(tileNodeId('agent', agent.sessionId)));
  const editing = data.editing === true;
  // What the text being typed needs, drawn as it is typed and saved with the text; none at the start of each edit.
  const typedFit = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    typedFit.current = undefined;
  }, [editing]);
  const { shown, draft, startEditing, type, finishEditing } = useDraftText(id, editing, note.text, (typed) => {
    const fit = typedFit.current;
    typedFit.current = undefined;
    update({ id: item.id, data: { text: typed, editedByUser: true }, ...(fit !== undefined && fit > item.height ? { height: fit } : {}) });
  });
  const showAgent = () => focusSession(agent.sessionId);
  const edits = note.suggestions?.length ?? 0;
  const root = useRef<HTMLDivElement>(null);
  const focused = useWindowFocused();
  // How many lines are below what shows: past a note's line budget, or in a note sized shorter than its text (which
  // scrolls), a chip says how many more there are.
  const [more, setMore] = useState(0);
  const budget = lineBudget(item.data);
  const checkMore = () => {
    const body = bodyOf(root.current);
    setMore(body === null ? 0 : linesBelow(body));
  };
  useLayoutEffect(checkMore, [width, height, shown, look, editing, item.data.userSized, budget]);
  // Sized by the user (dragged, or `note edit --size`): the size is theirs, so it no longer grows to its text, which
  // scrolls, and an arrange keeps it.
  const userSized = item.data.userSized === true;
  // A drag is the user's to size, as short as they like; it wins over a line budget, which it takes away.
  const unbudgeted = budget === undefined ? {} : { lines: null };
  const resize = useFitResize(
    () => 0,
    item.y,
    (box) => update({ id: item.id, ...box, data: { userSized: true, ...unbudgeted } }),
  );
  // The chip shows the rest: the note grows to its text (as far as a note grows), as the user's size.
  const showMore = () => {
    const body = bodyOf(root.current);
    if (!body) return;
    const at = height ?? item.height;
    const [whole = 0] = noteHeightsToFit([body], [at], true);
    if (whole > at) update({ id: item.id, height: whole, data: { userSized: true, ...unbudgeted } });
    else body.scrollBy({ top: body.clientHeight });
  };
  // A note with a line budget is as tall as its lines, shorter as well as taller, so it has no empty foot; one with none
  // only grows.
  const fitted = (at: number) => {
    const [needs = 0] = noteHeightsToFit([bodyOf(root.current)], [at]);
    return needs === 0 ? 0 : Math.max(MIN_AGENT_NOTE_SIZE.height, needs);
  };
  useGrowToFit(
    (at) => (userSized ? 0 : fitted(at)),
    height ?? item.height,
    resize.paused,
    (taller) => {
      if (editing) {
        typedFit.current = taller;
        return updateNode(id, { height: taller });
      }
      // Not a step of the user's (a note written by its agent, or drawn for the first time): the window in front saves
      // it for all.
      if (focused) update({ id: item.id, height: taller }, undefined, { silent: true });
    },
    [focused, width ?? item.width, look, editing ? draft : shown, note.asked, edits, budget],
    budget !== undefined && !editing,
  );

  return (
    <AgentNoteFace
      item={item}
      look={look}
      tileShown={tileShown}
      onShowAgent={showAgent}
      onAccept={() => suggestions.accept(item.id)}
      onDismiss={() => suggestions.dismiss(item.id)}
      rootRef={root}
      onDoubleClick={(event) => {
        // Not a new note on the board behind it.
        event.stopPropagation();
        if (!editing) startEditing();
      }}
      body={
        editing ? (
          <textarea
            className="agent-note-body agent-note-editor nodrag nowheel nopan"
            aria-label="Note text"
            value={draft}
            maxLength={MAX_STICKY_TEXT}
            autoFocus
            onFocus={(event) => event.currentTarget.setSelectionRange(event.currentTarget.value.length, event.currentTarget.value.length)}
            onChange={(event) => type(event.target.value)}
            onBlur={finishEditing}
            onKeyDown={(event) => {
              if (event.key === 'Escape') event.currentTarget.blur();
            }}
          />
        ) : (
          <AgentNoteBody text={shown} look={look} openLink={openLink} lines={budget} more={more} onMore={showMore} onScroll={checkMore} />
        )
      }
    >
      <NodeResizer
        isVisible={selected && !editing}
        color="var(--sticky-resizer)"
        minWidth={MIN_AGENT_NOTE_SIZE.width}
        minHeight={MIN_AGENT_NOTE_SIZE.height}
        maxWidth={MAX_AGENT_NOTE_SIZE.width}
        maxHeight={MAX_AGENT_NOTE_SIZE.height}
        onResizeStart={resize.onResizeStart}
        onResizeEnd={resize.onResizeEnd}
      />
      <NodeToolbar isVisible={selected && !dragging && !editing} position={Position.Top} className="sticky-toolbar">
        <IconButton
          icon={<Trash2 />}
          size="sm"
          aria-label="Delete note"
          tooltip={
            <>
              Delete note
              <Kbd>{keyText('edit.delete')}</Kbd>
            </>
          }
          onClick={() => remove(item.id)}
        />
      </NodeToolbar>
    </AgentNoteFace>
  );
});

interface AgentNoteFaceProps {
  item: BoardItem;
  look: AgentNoteLook;
  /** Whether its agent's tile is on the board, to show. */
  tileShown: boolean;
  /** Its text, or the field it is typed in. */
  body: ReactNode;
  onShowAgent?(): void;
  onAccept?(): void;
  onDismiss?(): void;
  rootRef?: Ref<HTMLDivElement>;
  onDoubleClick?(event: MouseEvent): void;
  /** Drawn first, over it: its resize handles and toolbar on the board. */
  children?: ReactNode;
  /** Laid out out of sight, to be measured: not a note to find on the board. */
  measuring?: boolean;
}

/**
 * An agent note as it is drawn: its agent's face beside a bubble whose first line names the agent, over its text, the
 * edits it suggests and its footer. The board draws it, and so does the measure of notes it doesn't draw
 * (`AgentNoteMeasurer`), so the two agree.
 */
export function AgentNoteFace({ item, look, tileShown, body, onShowAgent, onAccept, onDismiss, rootRef, onDoubleClick, children, measuring }: AgentNoteFaceProps) {
  const note = agentNoteData(item.data);
  const { agent } = note;
  const footer = agentNoteFooter(note, item.createdAt);
  const terminal = look === 'terminal';
  const edits = note.suggestions?.length ?? 0;
  const suggested = edits > 0 && (
    <div className="agent-note-edits" data-testid={measuring ? undefined : 'agent-note-edits'}>
      <span>
        {edits} {edits === 1 ? 'edit' : 'edits'} on the diagram
      </span>
      <button type="button" className="agent-note-accept nodrag" onClick={onAccept}>
        {acceptLabel(edits)}
      </button>
      <button type="button" className="agent-note-dismiss nodrag" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );

  // An agent whose name isn't known is not named: its face is a plain one, with no harness's mark and the border's
  // ring, and its first line reads Note.
  const named = agent.name.trim() !== '';
  return (
    <div className="agent-note" data-testid={measuring ? undefined : 'agent-note'} data-look={look} data-zone={item.zoneId ?? ''} ref={rootRef} onDoubleClick={onDoubleClick}>
      {children}
      <button
        type="button"
        className="agent-note-face nodrag"
        aria-label={named ? `Note by ${agent.name}` : 'Note'}
        title={tileShown ? 'Select its tile' : named ? `${agent.name} is no longer on the board` : undefined}
        disabled={!tileShown}
        onClick={onShowAgent}
        style={{ '--agent-note-harness': named ? HARNESSES[agent.harness].color : 'var(--border)' } as CSSProperties}
      >
        {named && <HarnessMark harness={agent.harness} className="agent-note-mark" />}
      </button>
      <div className="agent-note-bubble">
        <div className="agent-note-head">
          <span className="agent-note-name">{named ? agent.name : 'Note'}</span>
          {named && agent.role !== null && <span className="agent-note-role">· {agent.role}</span>}
          <NoteStamp writtenAt={note.writtenAt} />
        </div>
        <div className="agent-note-card">
          {note.asked !== undefined && <div className="agent-note-asked">You asked: “{note.asked}”</div>}
          {body}
          {suggested}
          <div className="agent-note-foot">
            {footer?.kind === 'edited' && (
              <span className="agent-note-edited" title="Edited by you">
                ✎<span className="agent-note-edited-text"> edited by you</span>
              </span>
            )}
            {footer?.kind === 'updated' && <span>updated</span>}
            {tileShown && (
              <button type="button" className="agent-note-show nodrag" onClick={onShowAgent}>
                {terminal ? '↗ show agent' : '↗ Show agent'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** When an agent wrote a note: the day and time ("Yesterday 07:51"), and the full date and time on hover and as its accessible name. */
function NoteStamp({ writtenAt }: { writtenAt: string }) {
  const full = noteStampFull(writtenAt);
  return (
    <time className="agent-note-time" dateTime={writtenAt} title={full} aria-label={full}>
      {noteStamp(writtenAt, useMinute())}
    </time>
  );
}

/**
 * A note's text as its look draws it: markdown on a document card, prompts on a terminal card. With a line budget
 * (`lines`) it shows that many lines; `more`, the lines below what shows, fade into a chip that shows them (`onMore`).
 */
export function AgentNoteBody({
  text,
  look,
  openLink,
  lines,
  more = 0,
  onMore,
  onScroll,
}: {
  text: string;
  look: AgentNoteLook;
  openLink: (url: string) => void;
  lines?: number;
  more?: number;
  onMore?: () => void;
  onScroll?: () => void;
}) {
  return (
    <>
      <div
        className="agent-note-body nowheel"
        data-budget={lines === undefined ? undefined : ''}
        style={lines === undefined ? undefined : ({ '--agent-note-lines': lines } as CSSProperties)}
        onScroll={onScroll}
      >
        {look === 'terminal' ? renderPrompts(text, openLink) : renderMarkdown(text, openLink)}
      </div>
      {more > 0 && (
        <div className="agent-note-more">
          <button type="button" className="agent-note-chip nodrag" data-testid="agent-note-more" aria-label={`Show ${more} more ${more === 1 ? 'line' : 'lines'}`} onClick={onMore}>
            ↓ {more} more {more === 1 ? 'line' : 'lines'}
          </button>
        </div>
      )}
    </>
  );
}

/** A note's markdown as the terminal card draws it: each paragraph's line on a `❯` prompt, each list item a dash. */
function renderPrompts(text: string, openLink: (url: string) => void): ReactNode {
  return parseMarkdown(text).flatMap((block, index) => {
    const lines = block.type === 'paragraph' ? block.lines : block.items;
    return lines.map((line, n) => (
      <div key={`${index}:${n}`} className={block.type === 'paragraph' ? 'agent-note-line' : 'agent-note-line agent-note-item'}>
        <span>{renderInline(line, openLink)}</span>
      </div>
    ));
  });
}
