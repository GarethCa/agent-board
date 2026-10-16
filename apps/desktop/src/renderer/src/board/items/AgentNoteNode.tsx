import { memo, useContext, type ReactNode } from 'react';
import { NodeResizer, NodeToolbar, Position, useStore, type NodeProps } from '@xyflow/react';
import { MAX_STICKY_TEXT } from '@agent-board/daemon/protocol';
import { Trash2 } from 'lucide-react';
import { useBoardCommands } from '../commands';
import { HarnessMark } from '../HarnessMark';
import { tileNodeId } from '../tiles';
import { IconButton, Kbd } from '../../ui';
import { acceptLabel, agentNoteData, agentNoteFooter, clockTime } from './agent-note';
import { useSuggestionActions } from '../ask/SuggestionGhosts';
import { AgentNoteLookContext } from './agent-note-look';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { parseMarkdown } from './sticky-text';
import { renderInline, renderMarkdown } from './StickyNode';
import { useDraftText } from './useDraftText';

const MIN_AGENT_NOTE_WIDTH = 200;
const MIN_AGENT_NOTE_HEIGHT = 96;

/**
 * A note an agent wrote: a typed card, never a handwritten sticky. Its badge names the agent (its harness's
 * mark, its name and role) and selects its tile; the time is when the agent last wrote it. It is drawn as a document
 * card (CO2) or a cut of a terminal (CO1), as the Agent notes setting says. The user can move, resize, delete and
 * edit it like a sticky; once they edit it, it says "edited by you" until its agent writes it again.
 */
export const AgentNoteNode = memo(function AgentNoteNode({ id, data, selected: picked, dragging }: NodeProps<ItemNodeType>) {
  const selected = useOnlySelected(picked);
  const look = useContext(AgentNoteLookContext);
  const { update, remove, openLink } = useContext(ItemActionsContext);
  const { focusSession } = useBoardCommands();
  const suggestions = useSuggestionActions();
  const { item } = data;
  const note = agentNoteData(item.data);
  const { agent } = note;
  // "Show agent" only while its tile is on the board.
  const tileShown = useStore((state) => agent.sessionId !== '' && state.nodeLookup.has(tileNodeId('agent', agent.sessionId)));
  const editing = data.editing === true;
  const { shown, draft, startEditing, type, finishEditing } = useDraftText(id, editing, note.text, (typed) =>
    update({ id: item.id, data: { text: typed, editedByUser: true } }),
  );
  const footer = agentNoteFooter(note, item.createdAt);
  const showAgent = () => focusSession(agent.sessionId);
  const terminal = look === 'terminal';
  const edits = note.suggestions?.length ?? 0;

  const badge = (
    <button
      type="button"
      className="agent-note-badge nodrag"
      title={tileShown ? 'Select its tile' : `${agent.name} is no longer on the board`}
      disabled={!tileShown}
      onClick={showAgent}
    >
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
        onResizeEnd={(_event, { x, y, width, height }) => update({ id: item.id, x, y, width, height })}
      />
      <NodeToolbar isVisible={selected && !dragging && !editing} position={Position.Top} className="sticky-toolbar">
        <IconButton
          icon={<Trash2 />}
          size="sm"
          aria-label="Delete note"
          tooltip={
            <>
              Delete note
              <Kbd>⌫</Kbd>
            </>
          }
          onClick={() => remove(item.id)}
        />
      </NodeToolbar>
      <div className="agent-note-head">
        {badge}
        <time className="agent-note-time" dateTime={note.writtenAt}>
          {clockTime(note.writtenAt)}
        </time>
      </div>
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
        {footer?.kind === 'edited' && <span className="agent-note-edited">✎ edited by you</span>}
        {footer?.kind === 'updated' && <span>updated {footer.time}</span>}
        {tileShown && (
          <button type="button" className="agent-note-show nodrag" onClick={showAgent}>
            {terminal ? '↗ show agent' : '↗ Show agent'}
          </button>
        )}
      </div>
    </div>
  );
});

/** A note's markdown as the terminal card draws it (CO1): each paragraph's line on a `❯` prompt, each list item a dash. */
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
