import { useEffect, useState } from 'react';
import { FileText, RotateCw } from 'lucide-react';
import type { Agent } from '@agent-board/daemon/protocol';
import type { DocSurface } from '@agent-board/daemon/window-layout';
import type { WebTabKey } from '../../../preload/api';
import { errorMessage } from '../../../shared/errors';
import { ErrorText, IconButton } from '../ui';
import { PlanPage } from '../plan/PlanTab';
import { Markdown } from './Markdown';
import { docName } from './tabs';

const openLink = (url: string) => void window.agentBoard.trackers.openLink(url).catch(() => {});

/** Whether a doc is Markdown, or HTML, by its name: anything else is shown as the text it is. */
const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);
const isHtml = (path: string) => /\.html?$/i.test(path);

interface DocTabProps {
  doc: DocSurface;
  agent: Agent;
  visible: boolean;
  /** For an HTML doc's page, drawn in a view of its own: it took the focus, or a key the pane handles. */
  onFocus(): void;
  onPaneKey(key: WebTabKey): boolean;
}

/**
 * A Doc tab: one of an agent's hand-off docs or pinned files, read through the daemon when the tab shows it and again on
 * Reload, its Markdown rendered as a plan's is, and its HTML drawn as an HTML plan's page is. Read-only: the agent's
 * file is the agent's.
 */
export function DocTab({ doc, agent, visible, onFocus, onPaneKey }: DocTabProps) {
  const [text, setText] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [reads, setReads] = useState(0);
  const { sessionId, path } = doc;
  useEffect(() => {
    if (!visible) return;
    let current = true;
    window.agentBoard.agents.readDoc(sessionId, path).then(
      (read) => {
        if (!current) return;
        setText(read.text);
        setProblem(undefined);
      },
      (error: unknown) => current && setProblem(errorMessage(error)),
    );
    return () => {
      current = false;
    };
  }, [sessionId, path, visible, reads]);
  return (
    <div className="review-viewer plan-viewer" data-testid="doc-view">
      <div className="plan-doc">
        <article className="plan-body" aria-label={docName(path)} data-testid="doc-body">
          <header className="plan-head">
            <FileText aria-hidden />
            <h4>{docName(path)}</h4>
            <span className="review-meta" title={path}>
              {agent.name}
            </span>
            <IconButton icon={<RotateCw />} size="sm" aria-label="Reload" tooltip="Read the file again" onClick={() => setReads((count) => count + 1)} />
          </header>
          {problem !== undefined ? (
            <ErrorText>{problem}</ErrorText>
          ) : text === undefined ? (
            <p className="review-meta">Reading it…</p>
          ) : isHtml(path) ? (
            <PlanPage key={`${path}:${reads}`} html={text} visible={visible} onFocus={onFocus} onPaneKey={onPaneKey} />
          ) : isMarkdown(path) ? (
            <div className="plan-markdown">
              <Markdown text={text} onOpenLink={openLink} />
            </div>
          ) : (
            <pre className="doc-text">{text}</pre>
          )}
        </article>
      </div>
    </div>
  );
}
