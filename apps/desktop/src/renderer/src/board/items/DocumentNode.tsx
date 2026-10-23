import { createContext, memo, useContext, useEffect, useState } from 'react';
import { NodeToolbar, Position, useStore, type NodeProps } from '@xyflow/react';
import { ChevronsDownUp, ChevronsUpDown, Trash2 } from 'lucide-react';
import { DOCUMENT_BAR_HEIGHT, DOCUMENT_CARD_SIZE, type Agent, type DocumentCardData, type DocumentSummary } from '@agent-board/daemon/protocol';
import { useBoardCommands } from '../commands';
import { HarnessMark } from '../HarnessMark';
import { tileNodeId } from '../tiles';
import { IconButton, Kbd } from '../../ui';
import { keyText } from '../../keys/registry';
import { docTypeTag, htmlPreview, previewLines } from '../../doc/doc-view';
import { renderMarkdown } from './StickyNode';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';

/** What a document card reads of the board: its document and agent as they are now, and how to open its Document tab. */
export interface DocumentCards {
  /** The document and its agent, while the agent is on the board and has it. */
  find(sessionId: string, documentId: string): { agent: Agent; document: DocumentSummary } | undefined;
  /** Opens the document's Document tab in its agent's window. */
  open(agent: Agent, document: DocumentSummary): void;
}

export const DocumentCardsContext = createContext<DocumentCards>({ find: () => undefined, open: () => {} });

/** A document card's data, as it was saved. */
const documentCardData = (data: Record<string, unknown>): DocumentCardData => data as unknown as DocumentCardData;

/** The first lines of the document's text, read again as its version moves on; empty until read, or for a slim bar. */
function usePreview(document: DocumentSummary | undefined, wanted: boolean): string {
  const [preview, setPreview] = useState('');
  const id = document?.id;
  const version = document?.version;
  const format = document?.format;
  useEffect(() => {
    if (id === undefined || !wanted) return;
    let current = true;
    window.agentBoard.asks.readDoc(id).then(
      (read) => current && setPreview(read.text === null ? '' : format === 'html' ? htmlPreview(read.text) : previewLines(read.text, 8, read.title)),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [id, version, format, wanted]);
  return preview;
}

/**
 * A document an agent showed on the board: a white page with a folded corner and a type tag (MD, HTML), its title
 * and its first lines fading out, tethered to its agent; or, collapsed, a slim bar of its type, title and author.
 * Double-click (or Open) opens it as a Document tab in its agent's window. "You edited" shows until the agent writes it again.
 */
export const DocumentNode = memo(function DocumentNode({ data, selected: picked, dragging }: NodeProps<ItemNodeType>) {
  const selected = useOnlySelected(picked);
  const { update, remove, openLink } = useContext(ItemActionsContext);
  const cards = useContext(DocumentCardsContext);
  const { focusSession } = useBoardCommands();
  const { item } = data;
  const card = documentCardData(item.data);
  const found = cards.find(card.agent.sessionId, card.documentId);
  const document = found?.document;
  const preview = usePreview(document, !card.collapsed);
  const tileShown = useStore((state) => state.nodeLookup.has(tileNodeId('agent', card.agent.sessionId)));
  const title = document?.title ?? card.title;
  const open = () => found !== undefined && cards.open(found.agent, found.document);
  const collapse = (collapsed: boolean) =>
    update({ id: item.id, height: collapsed ? DOCUMENT_BAR_HEIGHT : DOCUMENT_CARD_SIZE.height, data: { collapsed } });

  return (
    <div
      className="doc-card"
      data-testid="doc-card"
      data-collapsed={card.collapsed || undefined}
      data-gone={found === undefined || undefined}
      onDoubleClick={(event) => {
        // Not a new note on the board behind it.
        event.stopPropagation();
        open();
      }}
    >
      <NodeToolbar isVisible={selected && !dragging} position={Position.Top} className="sticky-toolbar">
        <IconButton
          icon={card.collapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
          size="sm"
          aria-label={card.collapsed ? 'Show the page' : 'Collapse to a bar'}
          tooltip={card.collapsed ? 'Show the page' : 'Collapse to a bar'}
          onClick={() => collapse(!card.collapsed)}
        />
        <IconButton
          icon={<Trash2 />}
          size="sm"
          aria-label="Take it off the board"
          tooltip={
            <>
              Take it off the board; it stays a tab of its agent
              <Kbd>{keyText('edit.delete')}</Kbd>
            </>
          }
          onClick={() => remove(item.id)}
        />
      </NodeToolbar>
      <div className="doc-card-head">
        <span className="doc-card-type">{docTypeTag(document?.format ?? card.format)}</span>
        <span className="doc-card-file">{document?.path.split(/[\\/]/).at(-1) ?? card.title}</span>
        {document?.writtenBy === 'user' && <span className="doc-card-edited">✎ you edited</span>}
      </div>
      <div className="doc-card-title">{title}</div>
      {!card.collapsed && (
        <div className="doc-card-body nowheel" data-testid="doc-card-preview">
          {document?.format === 'html' ? <p>{preview}</p> : renderMarkdown(preview, openLink)}
        </div>
      )}
      <div className="doc-card-foot">
        <button
          type="button"
          className="doc-card-agent nodrag"
          title={tileShown ? 'Select its tile' : `${card.agent.name} is no longer on the board`}
          disabled={!tileShown}
          onClick={() => focusSession(card.agent.sessionId)}
        >
          <HarnessMark harness={card.agent.harness} className="doc-card-mark" />
          <span>{card.agent.name}</span>
        </button>
        {document !== undefined && <span className="doc-card-version">v{document.version}</span>}
        <button type="button" className="doc-card-open nodrag" disabled={found === undefined} onClick={open}>
          Open ↗
        </button>
      </div>
    </div>
  );
});
