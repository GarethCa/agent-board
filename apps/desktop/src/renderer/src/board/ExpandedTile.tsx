import { useContext, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { NodeResizeControl, ResizeControlVariant, type ControlPosition } from '@xyflow/react';
import type { ExternalSession, Shell } from '@agent-board/daemon/protocol';
import { paneIds } from '@agent-board/daemon/pane-layout';
import { Folder, GitBranch, Maximize2, Pin, Play, SquareArrowOutUpRight, Trash2 } from 'lucide-react';
import { useLeaveKeys } from '../keys/escape-hatch';
import { useExtendedShortcuts } from '../keys/extended-shortcuts';
import { pressed } from '../keys/registry';
import { DetailsHandle } from '../session/DetailsHandle';
import { SessionBody } from '../session/SessionBody';
import { SessionDetails, useHomeDir } from '../session/SessionDetails';
import { tildify } from '../session/live-folder';
import { SessionName } from '../session/SessionName';
import { useViewSettingsLoaded } from './view-settings';
import { useSidebarCollapsed } from '../session/use-sidebar-collapsed';
import { panesLabel } from '../session/panes';
import { humanStatus } from '@agent-board/daemon/human-status';
import { useSimplified } from '../design';
import { agentPill, STATE_LABELS } from '../states';
import { useNeedsYouShows } from '../needs-you-setting';
import { Button, IconButton, StatusPill, Tag } from '../ui';
import { EXPANDED_MAX_SIZE, EXPANDED_MIN_SIZE, EXPANDED_SIZE, isNarrowTile, resizeAllowed, type ExpandedParent } from './expanded';
import { AgentView } from './agent-view/AgentView';
import type { PopUpSplitting } from './agent-view/use-agent-view-row';
import { BackToTileButton } from './BackToTile';
import { headButtons, headDoubleClick } from './expanded-head';
import { HarnessMark } from './HarnessMark';
import { CommandFigure } from './CommandFigure';
import { StatusMark } from './StatusMark';
import { SubagentPerch } from './SubagentPerch';
import { ClickOpensContext, TileActionsContext, type TileProps } from './tile';
import { dropKey } from '../session/shell-moves';
import { CAPTURE_FRAME } from './capture-mode';
import { FrostMark, FrozenOr } from './FrostMark';
import { GateControls } from '../gate/GateControls';
import { endedShellLabel } from '../session/RestartAgent';
import { gated } from '../gate/gate-view';
import { frostedClasses } from './paused';

const stopPropagation = (event: MouseEvent) => event.stopPropagation();

/** Where an expanded tile can be resized from: each corner by a handle, each edge along its length. */
const CORNERS: readonly ControlPosition[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const EDGES: readonly ControlPosition[] = ['top', 'right', 'bottom', 'left'];

/**
 * A session tile expanded in place: still a node of the board, so it pans, zooms
 * and drags (by its header) with it. An agent's is its pop-up, tile-sized: the pop-up's header with its Chat | Terminal
 * switch, its one tab row, its + and ⋯, and its body, with Pin, ⤢ (the pop-up, which splits), Pop out and Collapse in
 * the header. A shell's is a one-line header with its folder and panes, and Maximise, Pop out, Delete and Collapse, over
 * its panes. An external session has no terminal here, only its details. Its corners and edges resize it, what it would cover moving as it goes.
 */
export function ExpandedTile(props: TileProps & { parent: ExpandedParent }) {
  // Not drawn before the saved settings are read: it would draw with the defaults first, then change.
  return useViewSettingsLoaded() ? <ExpandedTileShown {...props} /> : null;
}

function ExpandedTileShown({ id, tile, parent }: TileProps & { parent: ExpandedParent }) {
  const { collapse, expand, resizeExpanded, maximise, popUp, popOutAgent, popOutShell, deleteShell, dismissExternal, setPinnedExpanded } = useContext(TileActionsContext);
  const shows = useNeedsYouShows();
  const simplified = useSimplified();
  const clickOpens = useContext(ClickOpensContext);
  // The header takes the focus (⌘J's way out) only with the extended keys on; off, a click on it leaves the focus as before.
  const extended = useExtendedShortcuts();
  /** Where its top-left was as the resize under way began, relative to its parent. */
  const resizeStart = useRef({ x: 0, y: 0 });
  const { agent, shell, external } = tile;
  const root = useRef<HTMLElement>(null);
  // Esc from its header (⌘J has the focus there), or ⌘Esc from anywhere in it: collapsed, the focus on its tile.
  useLeaveKeys(root, () => collapse(id, 'leaveKeys'));
  // A tile too narrow for the shelves beside a terminal opens them on the rail, for itself alone: the choice every window
  // and tile shares is not changed by it. Asked as its pop-up's body first lays out, before this tile's own ref is set,
  // it measures its node, which is in the page by then.
  const narrow = () => {
    const node = root.current ?? document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
    return isNarrowTile(node?.offsetWidth ?? EXPANDED_SIZE.width);
  };
  // A shell's or an external session's details strip; an agent's sidebar is its pop-up's.
  const [detailsCollapsed, setDetailsCollapsed] = useSidebarCollapsed(false, root, narrow);
  const popOut = agent ? () => popOutAgent(agent) : shell ? () => popOutShell(shell) : undefined;
  // An agent is deleted from its ⋯, as in its pop-up. An external session is only taken off the board.
  const remove = shell ? { label: 'Delete shell', run: () => deleteShell(shell.id) } : external ? { label: 'Remove from board', run: () => dismissExternal(external.id) } : undefined;

  // ⌘I shows or hides a shell's details, while the expanded tile has the keyboard; an agent's pop-up has no ⌘I.
  const onKeyDown = (event: KeyboardEvent) => {
    if (agent || !pressed('window.details', event)) return;
    event.preventDefault();
    setDetailsCollapsed((collapsed) => !collapsed);
  };

  const harness = tile.harness ?? 'shell';
  const name = agent?.name ?? shell?.name ?? external?.name ?? tile.label;
  // Pinned expanded, it stays open where it is, at its size: no drag or resize moves it, and Unpin stands where Collapse
  // was. Its window and pop-out still open, and it is back where it was, pinned, once they close.
  const pinned = agent?.pinnedExpanded === true;
  const { maximise: maximiseButton, popOut: popOutButton, closer } = headButtons(tile, clickOpens);
  const headOpens = headDoubleClick(clickOpens, tile);
  // On the header's own ground, not its buttons, its name or its chips.
  const onHeadDoubleClick = (event: MouseEvent) => {
    if (headOpens === undefined || (event.target as Element).closest('button, input, a, [contenteditable="true"]')) return;
    if (headOpens.open === 'popUp' && tile.agent !== undefined) popUp(tile.agent, headOpens.path);
    else maximise(tile, headOpens.path);
  };
  const onMaximise = maximiseButton && (() => (maximiseButton.open === 'popUp' && agent !== undefined ? popUp(agent, maximiseButton.path) : maximise(tile, maximiseButton.path)));
  // A capture window never shows what a session printed.
  const hidden =
    CAPTURE_FRAME === undefined ? undefined : (
      <div className="expanded-tile-hidden" data-testid="terminal-hidden">
        terminal hidden
      </div>
    );
  // Its window buttons, after its pop-up's own or a shell's facts: Pin, ⤢, Pop out, then Collapse (or Unpin).
  const windowButtons = (
    <>
      {/* Shown on the header's hover or focus, in the fill's room, so the buttons after it never move. */}
      {agent && !pinned && (
        <IconButton
          icon={<Pin />}
          size="sm"
          className="expanded-tile-pin nodrag"
          aria-label="Pin expanded"
          tooltip="Pin expanded: it stays open where it is, at this size"
          onClick={() => setPinnedExpanded(agent.sessionId, true)}
        />
      )}
      {maximiseButton && onMaximise && <IconButton icon={<Maximize2 />} size="sm" aria-label={maximiseButton.label} tooltip={maximiseButton.tooltip} onClick={onMaximise} />}
      {popOutButton && popOut && <IconButton icon={<SquareArrowOutUpRight />} size="sm" aria-label={popOutButton.label} tooltip={popOutButton.tooltip} onClick={popOut} />}
    </>
  );
  // Pinned, its pin, shown on, stands where Collapse was: the one way to unpin it from here.
  const closing =
    closer === 'unpin' ? (
      <IconButton
        icon={<Pin />}
        size="sm"
        variant="secondary"
        className="expanded-tile-unpin"
        aria-label="Unpin"
        tooltip="Pinned expanded. Unpin: then it can be collapsed, moved and resized"
        onClick={() => setPinnedExpanded(agent!.sessionId, false)}
      />
    ) : (
      <BackToTileButton from={root} leave={() => collapse(id, 'button')} label="Collapse" />
    );
  return (
    <section
      ref={root}
      className={agent ? frostedClasses('expanded-tile', agent, shows) : 'expanded-tile'}
      data-testid="expanded-tile"
      data-pinned={pinned || undefined}
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
      {agent ? (
        // An agent's is its pop-up, tile-sized: the same header, switch, tab row, + and ⋯, with no split.
        <AgentView
          agent={agent}
          nodeId={id}
          onClose={() => collapse(id, 'button')}
          root={root}
          splitting={NO_SPLIT}
          frame={{
            buttons: closing,
            menuEnd: [],
            // Pop out is a button in its header already.
            drops: ['pop-out'],
            notice: undefined,
            onAttachState: ignore,
            tile: {
              nodeId: id,
              headClassName: 'expanded-tile-head',
              bodyClassName: 'expanded-tile-body nodrag nowheel nopan',
              headTabIndex: extended ? -1 : undefined,
              onHeadDoubleClick,
              // Its merge gate, as in its session window, then the window buttons; not a drag handle.
              lead: (
                <>
                  {gated(agent) && (
                    <span className="nodrag">
                      <GateControls agent={agent} visible />
                    </span>
                  )}
                  {windowButtons}
                </>
              ),
              status: (
                <>
                  <FrostMark agent={agent} />
                  <FrozenOr agent={agent}>{simplified ? <StatusMark status={humanStatus(agent, shows).status} /> : <StatusPill {...agentPill(agent, shows)} />}</FrozenOr>
                  {/* Ended, its pane dropped into a shell: which, and whether its harness runs there by hand. */}
                  {agent.shellSessionId != null && (
                    <Tag className="expanded-tile-shell" data-testid="expanded-tile-shell">
                      {endedShellLabel(agent)}
                    </Tag>
                  )}
                </>
              ),
              narrow,
              standIn: hidden,
            },
          }}
        />
      ) : (
        <>
          <header className="session-window-head expanded-tile-head" tabIndex={extended ? -1 : undefined} onDoubleClick={onHeadDoubleClick}>
            <HarnessMark className="session-window-mark" harness={harness} />
            <SessionName shell={shell} name={name} title={name} nodeId={id} />
            {external && <StatusPill state={external.state} label={STATE_LABELS[external.state]} />}
            <HeadFacts simplified={simplified} shell={shell} external={external} />
            <span className="session-window-head-fill" />
            {windowButtons}
            {remove && <IconButton icon={<Trash2 />} size="sm" variant="danger" aria-label={remove.label} tooltip={remove.label} onClick={remove.run} />}
            {closing}
          </header>
          <div className="expanded-tile-body nodrag nowheel nopan">
            {hidden ??
              (shell ? (
                <SessionBody content={{ kind: 'shell', shellId: shell.id, shell }} detailsCollapsed={detailsCollapsed} onDetailsCollapsed={setDetailsCollapsed} autoFocus={false} shelves={false} chatControlsSlot={null} compactControls />
              ) : external ? (
                <ExternalBody session={external} detailsCollapsed={detailsCollapsed} onDetailsCollapsed={setDetailsCollapsed} />
              ) : null)}
          </div>
        </>
      )}
      {agent && <CommandFigure agent={agent} />}
      {(agent ?? external) && <SubagentPerch harness={(agent ?? external)!.harness} subagents={(agent ?? external)!.subagents} />}
      {/* Pinned, it keeps its size. */}
      {!pinned && [...EDGES, ...CORNERS].map((position) => {
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

/** An expanded tile's pop-up has no split: ⤢ opens the pop-up, which has. */
const NO_SPLIT: PopUpSplitting = { split: undefined, onSplit: () => {}, agents: [] };

/** A shell's or external session's header facts after its state: its branch or folder, a shell's panes. */
function HeadFacts({ simplified, shell, external }: { simplified: boolean; shell?: Shell | undefined; external?: ExternalSession | undefined }) {
  const home = useHomeDir();
  const folder = shell?.cwd ?? external?.cwd;
  // A folder with its home written as `~`, as the session window's header writes it; its title keeps the full path.
  const where = external?.branch ?? (folder === undefined ? undefined : tildify(folder, home));
  const facts: ReactNode[] = [];
  if (where !== undefined) {
    facts.push(
      <span key="where" className="session-window-where" title={external?.worktree ?? folder ?? where}>
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
  // Branch, folder and panes are the technical layer: Show technical details adds them to the header's end.
  return simplified ? (
    <span className="expanded-tile-facts" data-technical-detail="">
      {facts}
    </span>
  ) : (
    <>{facts}</>
  );
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
