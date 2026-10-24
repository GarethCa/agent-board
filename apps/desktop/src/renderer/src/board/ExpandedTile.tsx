import { useContext, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { NodeResizeControl, ResizeControlVariant, type ControlPosition } from '@xyflow/react';
import { shortIssueId, TRACKER_PROVIDERS, type Agent, type ExternalSession, type PullRequest, type Shell } from '@agent-board/daemon/protocol';
import { paneIds } from '@agent-board/daemon/pane-layout';
import { Folder, GitBranch, Maximize2, Minimize2, Play, SquareArrowOutUpRight, Trash2 } from 'lucide-react';
import { pressed } from '../keys/registry';
import { DetailsHandle } from '../session/DetailsHandle';
import { GateControls } from '../gate/GateControls';
import { gated } from '../gate/gate-view';
import { SessionBody, type WindowContent } from '../session/SessionBody';
import { SessionDetails } from '../session/SessionDetails';
import { SessionName } from '../session/SessionName';
import { panesLabel } from '../session/panes';
import { agentPill, STATE_LABELS } from '../states';
import { useNeedsYouShows } from '../needs-you-setting';
import { Button, Chip, IconButton, StatusPill, Tag } from '../ui';
import { EXPANDED_MAX_SIZE, EXPANDED_MIN_SIZE, resizeAllowed, type ExpandedParent } from './expanded';
import { HarnessMark } from './HarnessMark';
import { CommandFigure } from './CommandFigure';
import { PullRequestChip } from './HybridTile';
import { SubagentPerch } from './SubagentPerch';
import { TileActionsContext, type TileProps } from './tile';
import { dropKey } from '../session/shell-moves';
import { CAPTURE_FRAME } from './capture-mode';

const stopPropagation = (event: MouseEvent) => event.stopPropagation();

/** Where an expanded tile can be resized from: each corner by a handle, each edge along its length. */
const CORNERS: readonly ControlPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const EDGES: readonly ControlPosition[] = ['top', 'right', 'bottom', 'left'];

/**
 * A session tile expanded in place: still a node of the board, so it pans, zooms
 * and drags (by its header) with it. A one-line header with the session's name, state, branch, issue and pull
 * requests, and Maximise, Pop out, Delete and Collapse; under it the session window's body, with the details strip on the
 * LEFT and the live terminal (or a shell's panes) taking input. An external session has no terminal here, only its
 * details. Its corners and edges resize it, what it would cover moving as it goes.
 */
export function ExpandedTile({ id, tile, parent }: TileProps & { parent: ExpandedParent }) {
  const { collapse, expand, resizeExpanded, maximise, popOutAgent, popOutShell, deleteAgent, deleteShell, dismissExternal, openLink, openPullRequest } = useContext(TileActionsContext);
  const [detailsCollapsed, setDetailsCollapsed] = useState(true);
  const shows = useNeedsYouShows();
  /** Where its top-left was as the resize under way began, relative to its parent. */
  const resizeStart = useRef({ x: 0, y: 0 });
  const { agent, shell, external } = tile;
  const content: WindowContent | undefined = agent
    ? { kind: 'session', sessionId: agent.sessionId, agent }
    : shell
      ? { kind: 'shell', shellId: shell.id, shell }
      : undefined;
  const popOut = agent ? () => popOutAgent(agent) : shell ? () => popOutShell(shell) : undefined;
  // As its tile's ⋯ menu deletes it, asking the same first. An external session is only taken off the board.
  const remove = agent
    ? { label: 'Delete agent', run: () => deleteAgent(agent.sessionId) }
    : shell
      ? { label: 'Delete shell', run: () => deleteShell(shell.id) }
      : external
        ? { label: 'Remove from board', run: () => dismissExternal(external.id) }
        : undefined;

  // ⌘I shows or hides the details, while the expanded tile has the keyboard.
  const onKeyDown = (event: KeyboardEvent) => {
    if (!pressed('window.details', event)) return;
    event.preventDefault();
    setDetailsCollapsed((collapsed) => !collapsed);
  };

  const harness = tile.harness ?? 'shell';
  const name = agent?.name ?? shell?.name ?? external?.name ?? tile.label;
  return (
    <section
      className="expanded-tile"
      data-testid="expanded-tile"
      data-harness={harness}
      data-session-id={agent?.sessionId}
      data-shell-id={shell?.id}
      data-external-id={external?.id}
      // A tab, pane or shell tile dropped on it, header too, joins its tabs.
      data-tab-drop={agent ? dropKey({ kind: 'agent', id: agent.sessionId }) : shell ? dropKey({ kind: 'shell', id: shell.id }) : undefined}
      aria-label={`${name}, expanded`}
      onPointerDownCapture={() => expand(id)}
      // Not for the board: a double-click in the terminal selects a word.
      onDoubleClick={stopPropagation}
      onKeyDown={onKeyDown}
    >
      <header className="session-window-head expanded-tile-head">
        <HarnessMark className="session-window-mark" harness={harness} />
        <SessionName agent={agent} shell={shell} name={name} title={name} nodeId={id} />
        {agent && <StatusPill {...agentPill(agent, shows)} />}
        {external && <StatusPill state={external.state} label={STATE_LABELS[external.state]} />}
        <HeadFacts agent={agent} shell={shell} external={external} openLink={openLink} openPullRequest={openPullRequest} />
        <span className="session-window-head-fill" />
        {/* Its merge gate, as in its session window; not a drag handle. */}
        {agent && gated(agent) && (
          <span className="nodrag">
            <GateControls agent={agent} visible />
          </span>
        )}
        {content && <IconButton icon={<Maximize2 />} size="sm" aria-label="Maximise" tooltip="Maximise into its session window" onClick={() => maximise(tile)} />}
        {popOut && <IconButton icon={<SquareArrowOutUpRight />} size="sm" aria-label="Pop out" tooltip="Into its own window" onClick={popOut} />}
        {remove && <IconButton icon={<Trash2 />} size="sm" variant="danger" aria-label={remove.label} tooltip={remove.label} onClick={remove.run} />}
        <IconButton icon={<Minimize2 />} size="sm" variant="secondary" aria-label="Collapse" tooltip="Back to its tile; the session keeps running" onClick={() => collapse(id)} />
      </header>
      <div className="expanded-tile-body nodrag nowheel nopan">
        {CAPTURE_FRAME !== undefined ? (
          // A capture window never shows what a session printed.
          <div className="expanded-tile-hidden" data-testid="terminal-hidden">
            terminal hidden
          </div>
        ) : content ? (
          <SessionBody content={content} detailsCollapsed={detailsCollapsed} onDetailsCollapsed={setDetailsCollapsed} autoFocus={false} />
        ) : external ? (
          <ExternalBody session={external} detailsCollapsed={detailsCollapsed} onDetailsCollapsed={setDetailsCollapsed} />
        ) : null}
      </div>
      {agent && <CommandFigure agent={agent} />}
      {(agent ?? external) && <SubagentPerch harness={(agent ?? external)!.harness} subagents={(agent ?? external)!.subagents} />}
      {[...EDGES, ...CORNERS].map((position) => {
        const corner = CORNERS.includes(position);
        return (
          <NodeResizeControl
            key={position}
            position={position}
            variant={corner ? ResizeControlVariant.Handle : ResizeControlVariant.Line}
            minWidth={EXPANDED_MIN_SIZE.width}
            minHeight={EXPANDED_MIN_SIZE.height}
            maxWidth={EXPANDED_MAX_SIZE.width}
            maxHeight={EXPANDED_MAX_SIZE.height}
            className={corner ? 'item-resize-handle expanded-tile-resize' : 'item-resize-line expanded-tile-resize'}
            onResizeStart={(_event, { x, y }) => {
              resizeStart.current = { x, y };
            }}
            shouldResize={(_event, next) => resizeAllowed(next, resizeStart.current, parent)}
            // Where it is drawn as it is let go, relative to its parent: the board saves it if that isn't where it was.
            onResizeEnd={(_event, { x, y, width, height }) => resizeExpanded(id, { width, height }, { x, y })}
          />
        );
      })}
    </section>
  );
}

/** The header's facts after the state: the branch (or a shell's folder), and an agent's issue and pull requests. */
function HeadFacts({
  agent,
  shell,
  external,
  openLink,
  openPullRequest,
}: {
  agent?: Agent;
  shell?: Shell;
  external?: ExternalSession;
  openLink(url: string): void;
  openPullRequest(agent: Agent, pr: PullRequest): void;
}) {
  const where = agent?.branch ?? external?.branch ?? shell?.cwd ?? external?.cwd;
  const facts: ReactNode[] = [];
  if (where !== undefined) {
    facts.push(
      <span key="where" className="session-window-where" title={agent?.worktree ?? external?.worktree ?? where}>
        {shell || (external && external.branch === null) ? <Folder aria-hidden /> : <GitBranch aria-hidden />}
        {where}
      </span>,
    );
  }
  if (shell) {
    const panes = paneIds(shell.layout).length;
    facts.push(<Tag key="panes">{panesLabel(panes)}</Tag>);
  }
  if (external) facts.push(<Tag key="external">external</Tag>);
  if (agent?.issue) {
    const { issue } = agent;
    facts.push(
      <Chip key="issue" tone="accent" mono title={`${issue.title}\nOpen ${issue.id} in ${TRACKER_PROVIDERS[issue.provider].name}`} onClick={() => openLink(issue.url)}>
        {shortIssueId(issue)}
      </Chip>,
    );
  }
  if (agent) for (const pr of agent.pullRequests) facts.push(<PullRequestChip key={pr.number} pr={pr} open={() => openPullRequest(agent, pr)} />);
  if (agent) for (const pr of agent.pushedPullRequests) facts.push(<PullRequestChip key={pr.number} pr={pr} pushed open={() => openPullRequest(agent, pr)} />);
  return <>{facts}</>;
}

/**
 * An expanded external session: its details, in the shared strip. Its terminal is wherever it was started, so the
 * column that holds one elsewhere says so, and offers to resume it here.
 */
function ExternalBody({
  session,
  detailsCollapsed,
  onDetailsCollapsed,
}: {
  session: ExternalSession;
  detailsCollapsed: boolean;
  onDetailsCollapsed(collapsed: boolean): void;
}) {
  const { resumeExternal } = useContext(TileActionsContext);
  return (
    <div className="session-window-body">
      <SessionDetails
        sessionId={undefined}
        external={session}
        live={false}
        onProblem={ignore}
        collapsed={detailsCollapsed}
        onCollapsed={onDetailsCollapsed}
        onOpenLink={ignore}
      />
      <DetailsHandle collapsed={detailsCollapsed} onCollapsed={onDetailsCollapsed} />
      <div className="session-window-main expanded-tile-elsewhere" data-surface="window">
        <p>Started outside agent-board, in {session.cwd}. Its terminal is wherever it was started.</p>
        <Button variant="primary" size="sm" icon={<Play />} data-testid="resume-external" onClick={() => resumeExternal(session)}>
          Resume in agent-board
        </Button>
      </div>
    </div>
  );
}

/** For what an external session's details never call: it has no controls, panes or links. */
const ignore = () => {};
