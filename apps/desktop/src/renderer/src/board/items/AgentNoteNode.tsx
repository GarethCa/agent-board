import { memo, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode, type Ref } from 'react';
import { NodeResizer, NodeToolbar, Position, useReactFlow, useStore, type NodeProps } from '@xyflow/react';
import { MAX_AGENT_NOTE_HEIGHT, MAX_STICKY_TEXT, MAX_AGENT_NOTE_SIZE, MIN_AGENT_NOTE_SIZE, type BoardItem } from '@agent-board/daemon/protocol';
import { Trash2 } from 'lucide-react';
import { useBoardCommands } from '../commands';
import { HarnessMark } from '../HarnessMark';
import { isZone, tileNodeId } from '../tiles';
import { IconButton, Kbd } from '../../ui';
import { acceptLabel, agentNoteData, agentNoteFooter, clockTime } from './agent-note';
import { useSuggestionActions } from '../ask/SuggestionGhosts';
import { AgentNoteLookContext, type AgentNoteLook } from './agent-note-look';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { parseMarkdown } from './sticky-text';
import { renderInline, renderMarkdown } from './StickyNode';
import { useDraftText } from './useDraftText';
import { useFitResize, useGrowToFit, useWindowFocused } from './grow-to-fit';
import { keyText } from '../../keys/registry';

/**
 * The height a note `height` tall needs for its text to show whole, at most `MAX_AGENT_NOTE_HEIGHT` (past it, it
 * scrolls), or 0 if it can't be measured. Its tab and footer keep their size, so it needs what its text overflows by.
 */
function noteHeightToFit(root: HTMLElement | null, height: number): number {
  const body = root?.querySelector<HTMLElement>('.agent-note-body');
  if (!body || body.clientHeight === 0) return 0;
  return Math.min(MAX_AGENT_NOTE_HEIGHT, Math.ceil(height + body.scrollHeight - body.clientHeight));
}

/**
 * A note an agent wrote: a dashed card under a tab, in the colour of its zone (neutral when loose), that reads NOTE and names the agent, so it is never
 * taken for a tile or a handwritten sticky. The badge in the tab (its harness's mark, its name and role) selects its
 * tile; the time is when the agent last wrote it. It is drawn as a document
 * card or a cut of a terminal, as the Agent notes setting says. The user can move, resize, delete and
 * edit it like a sticky; once they edit it, it says "edited by you" until its agent writes it again.
 */
export const AgentNoteNode = memo(function AgentNoteNode({ id, data, selected: picked, dragging, width, height }: NodeProps<ItemNodeType>) {
  const selected = useOnlySelected(picked);
  const look = useContext(AgentNoteLookContext);
  const { update, remove, openLink } = useContext(ItemActionsContext);
  const { focusSession } = useBoardCommands();
  const { updateNode } = useReactFlow<ItemNodeType>();
  const suggestions = useSuggestionActions();
  const { item } = data;
  const zoneColor = useStore((state) => {
    const node = item.zoneId === null ? undefined : state.nodeLookup.get(item.zoneId);
    return node !== undefined && isZone(node) ? node.data.zone.color : undefined;
  });
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
  // Whether there is text below what shows: a note sized shorter than its text scrolls, and says there is more.
  const [more, setMore] = useState(false);
  const checkMore = () => {
    const body = root.current?.querySelector<HTMLElement>('.agent-note-body');
    setMore(body != null && body.scrollHeight - body.scrollTop - body.clientHeight > 1);
  };
  useLayoutEffect(checkMore, [width, height, shown, look, editing, item.data.userSized]);
  // Sized by the user (dragged, or `note edit --size`): the size is theirs, so it no longer grows to its text, which
  // scrolls, and an arrange keeps it.
  const userSized = item.data.userSized === true;
  // A drag is the user's to size, as short as they like.
  const resize = useFitResize(
    () => 0,
    item.y,
    (box) => update({ id: item.id, ...box, data: { userSized: true } }),
  );
  useGrowToFit(
    (at) => (userSized ? 0 : noteHeightToFit(root.current, at)),
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
    [focused, width ?? item.width, look, editing ? draft : shown, note.asked, edits],
  );

  return (
    <AgentNoteFace
      item={item}
      look={look}
      zoneColor={zoneColor}
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
          <AgentNoteBody text={shown} look={look} openLink={openLink} more={more} onScroll={checkMore} />
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
  /** The colour of the zone it sits in; none when loose. */
  zoneColor?: string;
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
 * An agent note as it is drawn: the tab that names its agent over a card with its text, the edits it suggests and its
 * footer. The board draws it, and so does the measure of notes it doesn't draw (`AgentNoteMeasurer`), so the two agree.
 */
export function AgentNoteFace({ item, look, zoneColor, tileShown, body, onShowAgent, onAccept, onDismiss, rootRef, onDoubleClick, children, measuring }: AgentNoteFaceProps) {
  const note = agentNoteData(item.data);
  const { agent } = note;
  const footer = agentNoteFooter(note, item.createdAt);
  const terminal = look === 'terminal';
  const edits = note.suggestions?.length ?? 0;
  const badge = (
    <button
      type="button"
      className="agent-note-badge nodrag"
      title={tileShown ? 'Select its tile' : `${agent.name} is no longer on the board`}
      disabled={!tileShown}
      onClick={onShowAgent}
    >
      <span className="agent-note-label">Note</span>
      <HarnessMark harness={agent.harness} className="agent-note-mark" />
      <span className="agent-note-name">{agent.name}</span>
      {agent.role !== null && <span className="agent-note-role">· {agent.role}</span>}
    </button>
  );

  return (
    <div
      className="agent-note"
      data-testid={measuring ? undefined : 'agent-note'}
      data-look={look}
      data-zone={item.zoneId ?? ''}
      style={zoneColor === undefined ? undefined : ({ '--agent-note-zone': zoneColor } as CSSProperties)}
      ref={rootRef}
      onDoubleClick={onDoubleClick}
    >
      {children}
      <div className="agent-note-tab">{badge}</div>
      <div className="agent-note-card">
        {note.asked !== undefined && <div className="agent-note-asked">You asked: “{note.asked}”</div>}
        {body}
        {edits > 0 && (
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
        )}
        <div className="agent-note-foot">
          <time className="agent-note-time" dateTime={note.writtenAt}>
            {clockTime(note.writtenAt)}
          </time>
          {footer?.kind === 'edited' && <span className="agent-note-edited">✎ edited by you</span>}
          {footer?.kind === 'updated' && <span>updated {footer.time}</span>}
          {tileShown && (
            <button type="button" className="agent-note-show nodrag" onClick={onShowAgent}>
              {terminal ? '↗ show agent' : '↗ Show agent'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A note's text as its look draws it: markdown on a document card, prompts on a terminal card. `more` is a cue that it scrolls on. */
export function AgentNoteBody({ text, look, openLink, more, onScroll }: { text: string; look: AgentNoteLook; openLink: (url: string) => void; more?: boolean; onScroll?: () => void }) {
  return (
    <div className="agent-note-body nowheel" onScroll={onScroll}>
      {look === 'terminal' ? renderPrompts(text, openLink) : renderMarkdown(text, openLink)}
      {more === true && (
        <div className="agent-note-more" aria-hidden>
          <span data-testid="agent-note-more">↓ more</span>
        </div>
      )}
    </div>
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
