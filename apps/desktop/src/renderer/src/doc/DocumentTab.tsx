import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FileText } from 'lucide-react';
import type { Agent, DocumentContent, DocumentSummary } from '@agent-board/daemon/protocol';
import type { WebTabKey } from '../../../preload/api';
import { errorMessage } from '../../../shared/errors';
import { binding, isActive, keyText, pressed } from '../keys/registry';
import { PlanPage } from '../plan/PlanTab';
import { Markdown } from '../session/Markdown';
import { Button, ErrorText, Segmented, Tag, Textarea, type SegmentedOption } from '../ui';
import { useAction } from '../use-action';
import { changedLineCount, docMeta, docTypeTag, editHint } from './doc-view';

const openLink = (url: string) => void window.agentBoard.trackers.openLink(url).catch(() => {});

type DocMode = 'read' | 'edit';

const MODES: readonly SegmentedOption<DocMode>[] = [
  { id: 'read', label: 'Read' },
  { id: 'edit', label: 'Edit' },
];

/** The document's text as its file holds it, read again whenever its version moves on, unless `paused` (editing). */
function useDocText(document: DocumentSummary, paused: boolean): { content: DocumentContent | undefined; problem: string | undefined } {
  const [content, setContent] = useState<DocumentContent>();
  const [problem, setProblem] = useState<string>();
  const { id, version } = document;
  useEffect(() => {
    if (paused) return;
    let current = true;
    window.agentBoard.asks.readDoc(id).then(
      (read) => {
        if (!current) return;
        setContent(read);
        setProblem(undefined);
      },
      (error: unknown) => current && setProblem(errorMessage(error)),
    );
    return () => {
      current = false;
    };
  }, [id, version, paused]);
  return { content, problem };
}

interface DocumentTabProps {
  agent: Agent;
  document: DocumentSummary;
  /** Whether its pane shows it, and its window shows its body. */
  visible: boolean;
  /** An HTML document's page took the keyboard: its pane is the window's focused one. */
  onFocus(): void;
  /** One of the window's pane keys pressed in an HTML document's page, for its pane; false for any other key. */
  onPaneKey(key: WebTabKey): boolean;
}

/**
 * The Document tab: a document an agent showed. Read renders it (Markdown as the PR tab renders a description; HTML in a
 * locked-down view of its own, view-only, with comments for the agent). Edit, for Markdown, splits it into its source
 * and the live render; ⌘S writes the file and tells the agent what changed, esc leaves Edit. While the user edits, the
 * view stops following the file; a rewrite by the agent meanwhile is a banner, nothing lost.
 */
export function DocumentTab({ agent, document, visible, onFocus, onPaneKey }: DocumentTabProps) {
  const [mode, setMode] = useState<DocMode>('read');
  const [draft, setDraft] = useState<{ text: string; from: string; base: number }>();
  const editing = mode === 'edit' && draft !== undefined;
  const { content, problem } = useDocText(document, editing);
  const save = useAction();
  const source = useRef<HTMLTextAreaElement>(null);
  const markdown = document.format === 'markdown';
  const keepMine = useRef<HTMLButtonElement>(null);
  // Edit takes the text as read at the version the board knows: not a read from before a newer save landed.
  const current = content !== undefined && content.text !== null && content.version === document.version;
  // The agent wrote the file again since the user began editing.
  const rewritten = editing && document.version > draft.base && document.writtenBy === 'agent';

  const startEdit = useCallback(() => {
    if (!document.editable || content?.text == null || content.version !== document.version) return;
    setDraft({ text: content.text, from: content.text, base: content.version });
    setMode('edit');
  }, [content, document.editable, document.version]);
  const leaveEdit = () => {
    setMode('read');
    setDraft(undefined);
  };
  /** Saves the draft; only Keep mine (`force`) writes over a version the agent saved meanwhile, never Save or ⌘S. */
  const saveDraft = (force = false) => {
    if (draft === undefined) return;
    save.run(() => window.agentBoard.asks.saveDoc(document.id, draft.text, draft.base, force), leaveEdit);
  };
  const takeTheirs = () =>
    window.agentBoard.asks.readDoc(document.id).then(
      (read) => read.text !== null && setDraft({ text: read.text, from: read.text, base: read.version }),
      () => {},
    );
  useEffect(() => {
    if (editing) source.current?.focus();
  }, [editing]);

  const onEditKey = (event: KeyboardEvent<HTMLElement>) => {
    if (pressed('window.saveDoc', event)) {
      event.preventDefault();
      event.stopPropagation();
      // With the agent's newer version up, ⌘S is not a choice between theirs and yours: the banner asks for one.
      if (rewritten) keepMine.current?.focus();
      else saveDraft();
    } else if (event.key === 'Escape') {
      // The editor keeps its esc, whatever the key setting: the first esc leaves Edit (when the key is on), and only the
      // next reaches the board, which collapses an expanded tile, so an unsaved draft is never collapsed away.
      event.preventDefault();
      event.stopPropagation();
      if (pressed('window.leaveDocEdit', event)) leaveEdit();
    }
  };

  const changed = draft === undefined ? 0 : changedLineCount(draft.from, draft.text);
  const text = content?.text ?? null;
  return (
    <div className="doc-viewer" data-testid="document-view" data-mode={mode} data-format={document.format}>
      <header className="doc-head">
        <div className="doc-title">
          <FileText aria-hidden />
          <h4>{document.title}</h4>
          <Tag mono>{docTypeTag(document.format)}</Tag>
        </div>
        <div className="doc-meta">
          {document.editable ? (
            <Segmented<DocMode> aria-label="Read or edit" value={mode} onChange={(next) => (next === 'edit' ? startEdit() : leaveEdit())} options={MODES} />
          ) : (
            <Tag title={markdown ? 'It is outside its agent’s worktree, so it is edited there' : undefined}>view only</Tag>
          )}
          <span className="review-meta" data-testid="doc-meta">
            {docMeta(document, agent.name)} · <code>{document.path}</code>
          </span>
        </div>
      </header>
      {problem !== undefined && <ErrorText>{problem}</ErrorText>}
      {content?.problem !== undefined && <ErrorText>{`The file can’t be shown: ${content.problem}`}</ErrorText>}
      {editing ? (
        <>
          {rewritten && (
            <div className="doc-banner" role="alert" data-testid="doc-rewritten">
              <span>{`${agent.name} saved v${document.version} while you were editing.`}</span>
              <Button size="sm" onClick={() => void takeTheirs()}>
                Take theirs
              </Button>
              <Button ref={keepMine} size="sm" variant="primary" onClick={() => saveDraft(true)}>
                Keep mine
              </Button>
            </div>
          )}
          <div className="doc-split" onKeyDown={onEditKey}>
            <Textarea
              ref={source}
              className="doc-source"
              aria-label={`Markdown of ${document.title}`}
              spellCheck={false}
              value={draft.text}
              onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            />
            <div className="doc-render doc-markdown" aria-label="Preview">
              <Markdown text={draft.text} onOpenLink={openLink} />
            </div>
          </div>
          <footer className="doc-edit-bar" data-dirty={changed > 0 || undefined}>
            <span className="review-meta" data-testid="doc-edit-hint">
              {rewritten
                ? 'Keep yours or take theirs to go on'
                : editHint(changed, isActive(binding('window.saveDoc')) ? keyText('window.saveDoc') : undefined, isActive(binding('window.leaveDocEdit')) ? keyText('window.leaveDocEdit') : undefined)}
            </span>
            {save.error && <ErrorText>{save.error}</ErrorText>}
            <Button size="sm" onClick={leaveEdit}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={save.busy || changed === 0 || rewritten} onClick={() => saveDraft()}>
              Save
            </Button>
          </footer>
        </>
      ) : text === null ? (
        <p className="review-meta doc-reading">{content === undefined && problem === undefined ? 'Reading it…' : ''}</p>
      ) : markdown ? (
        <div className="doc-render doc-markdown" data-testid="doc-body" data-current={current || undefined} onDoubleClick={startEdit}>
          <Markdown text={text} onOpenLink={openLink} />
        </div>
      ) : (
        <>
          <PlanPage key={`${document.id}:${document.version}`} html={text} visible={visible} onFocus={onFocus} onPaneKey={onPaneKey} />
          <DocComments agent={agent} document={document} />
        </>
      )}
    </div>
  );
}

/** Comments on an HTML document, which can't be edited: sent to its agent as one message, typed at its prompt. */
function DocComments({ agent, document }: { agent: Agent; document: DocumentSummary }) {
  const [comments, setComments] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();
  const send = () =>
    run(
      () => window.agentBoard.asks.commentDoc(document.id, comments),
      () => {
        setComments('');
        setSent(true);
      },
    );
  return (
    <footer className="plan-decision doc-comments" data-testid="doc-comments">
      <Textarea
        className="plan-decision-comments"
        rows={2}
        aria-label={`Comments on ${document.title} for ${agent.name}`}
        placeholder="Comments for the agent…"
        value={comments}
        onChange={(event) => {
          setComments(event.target.value);
          setSent(false);
        }}
      />
      <div className="plan-decision-actions">
        {sent && <span className="review-meta">Sent: it reads them once its turn is over.</span>}
        <Button size="sm" variant="primary" disabled={busy || comments.trim() === ''} onClick={send}>
          Send comments
        </Button>
      </div>
      {error && <ErrorText>{error}</ErrorText>}
    </footer>
  );
}
