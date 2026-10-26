import { memo, useContext, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { NodeResizer, NodeToolbar, Position, useReactFlow, useStore, type NodeProps } from '@xyflow/react';
import { MAX_AGENT_NOTE_HEIGHT, MAX_STICKY_TEXT } from '@agent-board/daemon/protocol';
import { Trash2 } from 'lucide-react';
import { useBoardCommands } from '../commands';
import { HarnessMark } from '../HarnessMark';
import { isZone, tileNodeId } from '../tiles';
import { IconButton, Kbd } from '../../ui';
import { acceptLabel, agentNoteData, agentNoteFooter, clockTime } from './agent-note';
import { useSuggestionActions } from '../ask/SuggestionGhosts';
import { AgentNoteLookContext } from './agent-note-look';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { parseMarkdown } from './sticky-text';
import { renderInline, renderMarkdown } from './StickyNode';
import { useDraftText } from './useDraftText';
import { useFitResize, useGrowToFit, useWindowFocused } from './grow-to-fit';
import { noteFitContext, reportNoteFit } from '../measured-boxes';
import { keyText } from '../../keys/registry';

const MIN_AGENT_NOTE_WIDTH = 200;
const MIN_AGENT_NOTE_HEIGHT = 96;

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
 * The height a note `height` tall needs for its text, shorter or taller (at most `MAX_AGENT_NOTE_HEIGHT`), or 0 if it
 * can't be measured: its text laid out at its own height for a moment, never drawn so. No least: what holds it sets that.
 */
function noteHeightForText(root: HTMLElement | null, height: number): number {
  const body = root?.querySelector<HTMLElement>('.agent-note-body');
  if (!body || body.clientHeight === 0) return 0;
  const drawn = body.offsetHeight;
  const flex = body.style.flex;
  body.style.flex = '0 0 auto';
  const own = body.offsetHeight;
  body.style.flex = flex;
  return Math.min(MAX_AGENT_NOTE_HEIGHT, Math.ceil(height + own - drawn));
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
  const footer = agentNoteFooter(note, item.createdAt);
  const showAgent = () => focusSession(agent.sessionId);
  const terminal = look === 'terminal';
  const edits = note.suggestions?.length ?? 0;
  const root = useRef<HTMLDivElement>(null);
  const focused = useWindowFocused();
  // Dragged shorter than its text needs, it keeps what the text needs, up to where it scrolls.
  const resize = useFitResize((at) => noteHeightToFit(root.current, at), item.y, (box) => update({ id: item.id, ...box }));
  useGrowToFit(
    (at) => noteHeightToFit(root.current, at),
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
  // The height its text needs, for an arrange to size it to: shorter as well as taller than it is.
  useLayoutEffect(() => {
    if (editing) return;
    const fits = noteHeightForText(root.current, height ?? item.height);
    if (fits > 0) reportNoteFit(id, { width: width ?? item.width, height: fits, text: note.text, context: noteFitContext(look, item.data) });
  }, [id, editing, width ?? item.width, height ?? item.height, look, note.text, note.asked, edits]);

  const badge = (
    <button
      type="button"
      className="agent-note-badge nodrag"
      title={tileShown ? 'Select its tile' : `${agent.name} is no longer on the board`}
      disabled={!tileShown}
      onClick={showAgent}
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
      data-testid="agent-note"
      data-look={look}
      data-zone={item.zoneId ?? ''}
      style={zoneColor === undefined ? undefined : ({ '--agent-note-zone': zoneColor } as CSSProperties)}
      ref={root}
      onDoubleClick={(event) => {
        // Not a new note on the board behind it.
        event.stopPropagation();
        if (!editing) startEditing();
      }}
    >
      <NodeResizer
        isVisible={selected && !editing}
        color="var(--sticky-resizer)"
        minWidth={MIN_AGENT_NOTE_WIDTH}
        minHeight={MIN_AGENT_NOTE_HEIGHT}
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
      <div className="agent-note-tab">{badge}</div>
      <div className="agent-note-card">
        {note.asked !== undefined && <div className="agent-note-asked">You asked: “{note.asked}”</div>}
        {editing ? (
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
          <div className="agent-note-body nowheel">{terminal ? renderPrompts(shown, openLink) : renderMarkdown(shown, openLink)}</div>
        )}
        {edits > 0 && (
          <div className="agent-note-edits" data-testid="agent-note-edits">
            <span>
              {edits} {edits === 1 ? 'edit' : 'edits'} on the diagram
            </span>
            <button type="button" className="agent-note-accept nodrag" onClick={() => suggestions.accept(item.id)}>
              {acceptLabel(edits)}
            </button>
            <button type="button" className="agent-note-dismiss nodrag" onClick={() => suggestions.dismiss(item.id)}>
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
            <button type="button" className="agent-note-show nodrag" onClick={showAgent}>
              {terminal ? '↗ show agent' : '↗ Show agent'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
});

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
