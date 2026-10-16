import { memo, useContext, useState, type MouseEvent, type ReactNode } from 'react';
import {
  shortIssueId,
  statusLine,
  TRACKER_PROVIDERS,
  waitsForYou,
  type Agent,
  type AgentRole,
  type AgentSchedule,
  type ChecksState,
  planPending,
  type ExternalSession,
  type PullRequest,
  type RecentFolder,
  type Shell,
} from '@agent-board/daemon/protocol';
import { paneIds } from '@agent-board/daemon/pane-layout';
import { isClosed } from '@agent-board/daemon/board-layout';
import { startBlocked } from '@agent-board/daemon/review-doc';
import { gateBadge, shortCommit } from '@agent-board/daemon/gate-rules';
import { planBadge, planStamp } from '../plan/plan-view';
import { useGateRun } from '../gate/GatesProvider';
import { gated } from '../gate/gate-view';
import { runGateShortcut } from '../session/window-keys';
import { HarnessMark } from './HarnessMark';
import { agentSetupLine, branchLine, modelLabel, roleText } from './AgentSetup';
import { useNow } from '../inbox/use-now';
import { clockBadge } from './schedule';
import { FoldVertical, ArrowUpRight, Bell, BellOff, Check, ClipboardList, Clock, Dot, Expand, FileCheck, FileSearch, Folder, GitBranch, Hammer, Hash, Maximize2, MoreHorizontal, PenLine, Pencil, Play, RefreshCw, RotateCcw, Search, ShieldCheck, SquareArrowOutUpRight, Trash2, X } from 'lucide-react';
import { toolSummary } from '../../../shared/needs-you';
import { Chip, EditableName, FlowPill, IconButton, Menu, RenameButton, StatusPill, Tag, useRenaming, type IconButtonProps, type MenuEntry } from '../ui';
import { Character } from './Character';
import { HandoffsContext } from './flow-edges';
import { badgeLine, checksLabel, foldRanking, tileFooter } from './tile-footer';
import { useFooterFold } from './use-footer-fold';
import { ResumeButton } from './RestartBanner';
import { cx } from '../ui/cx';
import { agentPill, STATE_LABELS, TILE_STATE_LABELS } from '../states';
import { SubagentPerch } from './SubagentPerch';
import { ShellsChip } from './ShellsChip';
import { windowShells } from '../session/tabs';
import { useRenameRequest } from './rename';
import { useFittedLines } from './use-fitted-lines';
import { splitReviewerName } from './tile-name';
import type { ClickOpens } from './click-opens';
import { ClickOpensContext, ShellFoldersContext, TileActionsContext, type TileData, type TileProps } from './tile';
import { CrewViewContext, lightCrew } from './crew-view';
import { folderLabel } from './folders';
import { panesLabel } from '../session/panes';
import { canRestart, endedShellLabel } from '../session/RestartAgent';
import { useReviews } from '../review/ReviewsProvider';
import { roundsOf } from '../review/reviews';
import { dropKey, dropOver as dropOverValue } from '../session/shell-moves';

/**
 * Hybrid (v1): a calm white tile with a soft shadow, sitting straight. An agent's tile shows its name, harness,
 * branch and the pull requests made from it, linked issue, task and state, with an orange outline while it waits for
 * you, and a clock badge with its next run while it has a schedule. Its subagents perch on its top edge as
 * characters.
 */
export const HybridTile = memo(function HybridTile({ id, tile }: TileProps) {
  const harness = tile.harness ?? 'shell';
  if (tile.agent !== undefined) return <AgentTile id={id} agent={tile.agent} repo={tile.repo} from={tile.from} crew={tile.crew} tabs={tile.tabs} />;
  if (tile.shell !== undefined) return <ShellTile id={id} shell={tile.shell} />;
  if (tile.external !== undefined) return <ExternalTile id={id} session={tile.external} />;
  return (
    <div
      className="hybrid-tile"
      data-representation="hybrid"
      data-harness={harness}
    >
      <span className="hybrid-tile-harness">{harness}</span>
      <span className="hybrid-tile-label">{tile.label}</span>
    </div>
  );
});

function AgentTile({ id, agent, repo, from, crew, tabs }: { id: string; agent: Agent; repo?: string } & Pick<TileData, 'from' | 'crew' | 'tabs'>) {
  const crewView = useContext(CrewViewContext);
  // The crew it is of, as an orchestrator or one it started: lit while the orchestrator or a chip is hovered (BA3).
  const crewOf = crew === undefined ? from?.sessionId : agent.sessionId;
  const chip = from !== undefined && (crewView.look === 'chips' || !crewView.framed.has(agent.sessionId));
  const { setFolded, expand, openAgent, popOutAgent, deleteAgent, linkIssue, scheduleAgent, setMuted, openLink, openPullRequest, resumeAgent, restartAgent, rename, startReview, openReview, openGate, openPlan } =
    useContext(TileActionsContext);
  const gate = useGateRun(agent.sessionId);
  const clickOpens = useContext(ClickOpensContext);
  const dropOver = dropOverValue.use();
  const rounds = roundsOf(useReviews(), agent.sessionId);
  const latestRound = rounds.at(-1);
  const notStarted = startBlocked(agent, rounds);
  // A reviewer opens the review it is writing; an implementer starts its next round, or opens the last.
  const reviewEntries = (): MenuEntry[] =>
    agent.reviewOf !== null
      ? [{ label: 'Open review', icon: <FileCheck />, onSelect: () => openReview(agent.reviewOf!) }]
      : [
          ...(latestRound === undefined ? [] : [{ label: 'Open review', icon: <FileCheck />, onSelect: () => openReview(agent.sessionId) }]),
          {
            label: latestRound === undefined ? 'Review its work' : `Start review round ${latestRound.round + 1}`,
            icon: <FileSearch />,
            disabled: notStarted !== undefined,
            hint: notStarted,
            onSelect: () => startReview(agent),
          },
        ];
  const shownName = agent.reviewOf === null ? { name: agent.name } : splitReviewerName(agent.name);
  const renaming = useRenaming(agent.name, (name) => rename({ kind: 'agent', sessionId: agent.sessionId }, name));
  useRenameRequest(id, renaming);
  const handoffs = useContext(HandoffsContext);
  const shells = windowShells({ kind: 'agent', agent }, tabs ?? []);
  const { shown, folded: overflow } = tileFooter(agent, shells.length);
  const ranking = foldRanking(shown);
  const fitted = useFittedLines();
  const ask = askOf(agent);
  // A hand-off going along one of its edges shows for as long as the edge shows it, however soon it was over.
  // Never over its needing you, as in the daemon: the tile would say it no longer waits.
  const sending = handoffs.sending.has(agent.sessionId) && agent.state !== 'waiting' && agent.state !== 'needs-permission' && ask === undefined;
  const receiving = !sending && handoffs.receiving.has(agent.sessionId);
  // Seen only means something while it still waits: an ended or stopped agent shows its own state.
  const seen = agent.seen && waitsForYou(agent);
  const state = sending ? 'handing-off' : agent.state;
  const pill = receiving ? (
    <FlowPill title="Receiving a hand-off">receiving…</FlowPill>
  ) : (
    <StatusPill {...(sending ? { state, label: TILE_STATE_LABELS[state] } : agentPill(agent, TILE_STATE_LABELS))} {...(agent.shellHarness === null ? {} : { label: endedShellLabel(agent) })} title={STATE_LABELS[state]} />
  );
  // Badges that don't fit in its one line fold into the "+N", the lowest ranked first, and fold again whenever what the footer
  // says changes.
  const footer = useFooterFold({
    key: JSON.stringify([shown, shells.length, latestRound?.round, gate?.status, gate === undefined ? '' : gateBadge(gate), agent.state, receiving, sending, agent.shellSessionId, agent.endedAt]),
    badges: shown.length,
    ranking,
    plusShown: overflow.length > 0,
  });
  const folded = [...ranking.slice(0, footer.folded).map((index) => badgeLine(shown[index]!, shells.length)), ...overflow];
  return (
    <div
      className="hybrid-tile hybrid-tile-agent"
      data-testid="agent-tile"
      data-representation="hybrid"
      data-harness={agent.harness}
      data-state={agent.state}
      data-session-id={agent.sessionId}
      data-zone={agent.zoneId ?? ''}
      data-tab-drop={dropKey({ kind: 'agent', id: agent.sessionId })}
      data-drop-over={dropOver === dropKey({ kind: 'agent', id: agent.sessionId }) || undefined}
      data-muted={agent.muted}
      data-seen={seen || undefined}
      data-crowded={shown.length > 1 || undefined}
      data-handoff={sending ? 'sending' : receiving ? 'receiving' : undefined}
      data-reviewer={agent.reviewOf !== null || undefined}
      data-orchestrator={crew !== undefined || undefined}
      data-crew={crewOf}
      onMouseEnter={crew === undefined ? undefined : () => lightCrew(agent.sessionId)}
      onMouseLeave={crew === undefined ? undefined : () => lightCrew(undefined)}
      title={clickOpens === 'window' ? 'Double-click to open its session window' : 'Double-click to expand it here'}
      onDoubleClick={() => (clickOpens === 'window' ? openAgent(agent) : expand(id))}
    >
      <div className="hybrid-tile-head">
        <HarnessMark className="hybrid-tile-icon" harness={agent.harness} />
        <EditableName className={nameClass(shownName.name)} value={agent.name} title={agent.name} shown={shownName.name} renaming={renaming} label="Agent name" />
        <RenameButton renaming={renaming} />
        <TileCorner>
          <TileButton icon={<Expand />} aria-label="Expand" title="Expand it here, with its terminal" onClick={() => expand(id)} />
          <TileButton icon={<SquareArrowOutUpRight />} aria-label="Pop out" title="Open its session in its own window" onClick={() => popOutAgent(agent)} />
          {canRestart(agent) && (
            <TileButton icon={<RotateCcw />} aria-label="Restart" title="Restart it, carrying on its conversation" onClick={() => restartAgent(agent.sessionId)} />
          )}
          {agent.state === 'stopped-by-restart' && (
            <TileButton icon={<RotateCcw />} aria-label="Resume" data-testid="resume" title="Resume it, carrying on its conversation" onClick={() => void resumeAgent(agent.sessionId)} />
          )}
          <TileMenu
            entries={[
              otherOpen(clickOpens, () => expand(id), () => openAgent(agent)),
              ...(isClosed(agent) ? [{ label: 'Fold to a chip', icon: <FoldVertical />, onSelect: () => setFolded(id, true) }] : []),
              ...(canRestart(agent) ? [{ label: 'Restart agent', icon: <RotateCcw />, onSelect: () => restartAgent(agent.sessionId) }] : []),
              ...(agent.state === 'stopped-by-restart' ? [{ label: 'Resume agent', icon: <RotateCcw />, onSelect: () => void resumeAgent(agent.sessionId) }] : []),
              'separator',
              { label: 'Rename', icon: <Pencil />, shortcut: 'F2', onSelect: renaming.startSoon },
              { label: agent.schedule === null ? 'Schedule…' : 'Edit schedule…', icon: <Clock />, onSelect: () => scheduleAgent(agent) },
              { label: agent.issue === null ? 'Link issue…' : 'Change issue…', icon: <Hash />, onSelect: () => linkIssue(agent) },
              {
                label: agent.muted ? 'Unmute notifications' : 'Mute notifications',
                icon: agent.muted ? <Bell /> : <BellOff />,
                onSelect: () => setMuted(agent.sessionId, !agent.muted),
              },
              'separator',
              ...reviewEntries(),
              ...(gated(agent)
                ? [
                    {
                      label: 'Run gate',
                      icon: <ShieldCheck />,
                      shortcut: runGateShortcut(),
                      disabled: gate?.status === 'running',
                      hint: gate?.status === 'running' ? 'It is running: its Gate tab shows it' : "Run its zone's gate command in its worktree",
                      onSelect: () => openGate(agent, true),
                    },
                  ]
                : []),
              'separator',
              { label: 'Delete agent', icon: <Trash2 />, danger: true, onSelect: () => deleteAgent(agent.sessionId) },
            ]}
          />
        </TileCorner>
      </div>
      {crew !== undefined && (
        <span className="hybrid-tile-crew-count" data-testid="crew-count" title={`It started ${crew} agent${crew === 1 ? '' : 's'} on the board`}>
          {crew}
        </span>
      )}
      {shownName.subtitle !== undefined && <span className="hybrid-tile-subtitle">{shownName.subtitle}</span>}
      <span className="hybrid-tile-branch" title={agent.worktree}>
        {chip && (
          <span
            className="hybrid-tile-from"
            data-testid="from-chip"
            title={`Started by ${from.name}`}
            onMouseEnter={() => lightCrew(from.sessionId)}
            onMouseLeave={() => lightCrew(undefined)}
          >
            ↳ from {from.name}
          </span>
        )}
        {repo !== undefined && (
          // Outside every zone of its repo, the tile says which repo it works in.
          <Tag mono className="hybrid-tile-repo" data-testid="tile-repo" title={`Works in ${agent.repoRoot}`}>
            {repo}
          </Tag>
        )}
        <GitBranch aria-hidden />
        {branchLine(agent)}
      </span>
      {ask !== undefined ? (
        <span ref={fitted} className="hybrid-tile-body hybrid-tile-ask" data-testid="tile-ask" data-question={ask.question} title={ask.text}>
          <span className="hybrid-tile-text">
            {ask.tool !== undefined && <strong>{ask.tool} </strong>}
            {ask.text}
          </span>
        </span>
      ) : agent.notice !== null ? (
        <span ref={fitted} className="hybrid-tile-body hybrid-tile-notice" role="note" title={agent.notice}>
          <span className="hybrid-tile-text">{agent.notice}</span>
        </span>
      ) : (
        <span
          ref={fitted}
          className="hybrid-tile-body hybrid-tile-description"
          data-testid="tile-description"
          data-empty={(agent.status === null && agent.description === '') || undefined}
          title={agent.status === null ? agent.description : `${statusLine(agent.status)}\n\nTask: ${agent.description}`}
        >
          {agent.status === null ? agent.description || 'No task yet' : statusLine(agent.status)}
        </span>
      )}
      <span className="hybrid-tile-footer" ref={footer.ref}>
          {shown.map((badge) => {
            switch (badge.kind) {
              case 'model':
                return (
                  <Tag key="model" className="hybrid-tile-setup" data-testid="tile-model" title={agentSetupLine(agent)}>
                    <HarnessMark harness={agent.harness} />
                    <span className="hybrid-tile-badge-text">{modelLabel(badge.model)}</span>
                  </Tag>
                );
              case 'role':
                return (
                  <Tag key="role" className="hybrid-tile-setup" data-testid="tile-role" title={agentSetupLine(agent)}>
                    {ROLE_ICONS[badge.role]}
                    <span className="hybrid-tile-badge-text">{roleText(badge.role, badge.name)}</span>
                  </Tag>
                );
              case 'issue':
                return (
                  <Chip
                    key="issue"
                    tone="accent"
                    mono
                    className="nodrag"
                    data-testid="tile-issue"
                    title={`${badge.issue.title}\nOpen ${badge.issue.id} in ${TRACKER_PROVIDERS[badge.issue.provider].name}`}
                    onClick={() => openLink(badge.issue.url)}
                    onDoubleClick={stopPropagation}
                  >
                    {shortIssueId(badge.issue)}
                  </Chip>
                );
              case 'finished':
                return (
                  <Tag key="finished" className="hybrid-tile-setup" data-testid="tile-finished" title={`${badgeLine(badge, shells.length)} (${new Date(badge.at).toLocaleString()})`}>
                    <Check aria-hidden />
                    <span className="hybrid-tile-badge-text">Finished</span>
                  </Tag>
                );
              case 'pr':
                return <PullRequestChip key={badge.pr.number} pr={badge.pr} pushed={badge.pushed} open={() => openPullRequest(agent, badge.pr)} />;
              case 'schedule':
                return <ClockChip key="schedule" schedule={badge.schedule} ended={agent.endedAt !== null} open={() => scheduleAgent(agent)} />;
              case 'shells':
                return <ShellsChip key="shells" agent={agent} shells={shells} />;
              case 'muted':
                return (
                  <span key="muted" className="hybrid-tile-muted" data-testid="tile-muted" role="img" aria-label="Notifications muted" title="Notifications muted">
                    <BellOff aria-hidden />
                  </span>
                );
            }
          })}
          {latestRound !== undefined && (
            <Chip
              className="hybrid-tile-review nodrag"
              data-testid="tile-review"
              data-status={latestRound.status}
              title={`Review round ${latestRound.round}: open it`}
              onClick={() => openReview(agent.sessionId)}
              onDoubleClick={stopPropagation}
            >
              <FileCheck aria-hidden />r{latestRound.round}
            </Chip>
          )}
          {agent.plan !== null && (
            <Chip
              className="hybrid-tile-plan nodrag"
              data-testid="tile-plan"
              data-pending={planPending(agent) || undefined}
              title={`${agent.plan.title} · ${planStamp(agent.plan).label}: open its Plan tab`}
              onClick={() => openPlan(agent)}
              onDoubleClick={stopPropagation}
            >
              <ClipboardList aria-hidden />
              {planBadge(agent.plan)}
            </Chip>
          )}
          {gate !== undefined && (
            <Chip
              className="hybrid-tile-gate nodrag"
              data-testid="tile-gate"
              data-status={gate.status}
              title={`The gate, ${gate.command}, on ${shortCommit(gate.commit)}: open its Gate tab`}
              onClick={() => openGate(agent, false)}
              onDoubleClick={stopPropagation}
            >
              {gateBadge(gate)}
            </Chip>
          )}
          {/* Always drawn, so the footer can measure it; hidden while nothing is folded. A button, so the keyboard reaches it and its tooltip; it opens nothing. */}
          <Chip
            className="hybrid-tile-folded nodrag"
            data-testid="tile-folded"
            data-folded-chip=""
            title={folded.join('\n')}
            aria-label={`${folded.length} more: ${folded.join('; ')}`}
            onDoubleClick={stopPropagation}
          >
            +{folded.length}
          </Chip>
          {pill}
        </span>
      <SubagentPerch harness={agent.harness} subagents={agent.subagents} />
      {sending && (
        // Its robot, handing its payload on, perched at the top left (FlowRules).
        <span className="hybrid-tile-handoff">
          <Character harness={agent.harness} pose="handing-off" label={agent.name} />
        </span>
      )}
    </div>
  );
}

/** Each role's mark on its badge. */
const ROLE_ICONS: Record<AgentRole, ReactNode> = {
  implementer: <Hammer aria-hidden />,
  reviewer: <Search aria-hidden />,
  'follow-up-reviewer': <RefreshCw aria-hidden />,
  custom: <PenLine aria-hidden />,
};

/**
 * What a tile waiting for you asks, in place of its task: the tool it wants to use, the question it asks through the
 * board with its options, the plan it waits on, or its last message.
 */
function askOf(agent: Agent): { tool?: string; text: string; question?: true } | undefined {
  const prompt = agent.permissions[0];
  if (prompt !== undefined) return { tool: prompt.toolName, text: toolSummary(prompt) };
  if (agent.ask !== null) return { text: agent.ask.options.length === 0 ? agent.ask.question : `${agent.ask.question}\n${agent.ask.options.join(' · ')}`, question: true };
  if (planPending(agent)) return { text: `Waiting for you to decide on its plan: ${agent.plan.title}` };
  if (agent.state === 'waiting' && agent.lastMessage) return { text: agent.lastMessage };
  return undefined;
}

/** A shell tile: plain shells in a zone's folder, or at home loose on the board, split into panes in its session window. */
function ShellTile({ id, shell }: { id: string; shell: Shell }) {
  const { expand, openShell, popOutShell, deleteShell, resumeShell, rename } = useContext(TileActionsContext);
  const clickOpens = useContext(ClickOpensContext);
  const renaming = useRenaming(shell.name, (name) => rename({ kind: 'shell', shellId: shell.id }, name));
  const dropOver = dropOverValue.use();
  useRenameRequest(id, renaming);
  const panes = paneIds(shell.layout).length;
  const live = panes - shell.endedPanes.length;
  const stopped = shell.stoppedPanes.length;
  return (
    <div
      className="hybrid-tile hybrid-tile-agent hybrid-tile-shell"
      data-testid="shell-tile"
      data-representation="hybrid"
      data-harness="shell"
      data-shell-id={shell.id}
      data-zone={shell.zoneId ?? ''}
      data-tab-drop={dropKey({ kind: 'shell', id: shell.id })}
      data-drop-over={dropOver === dropKey({ kind: 'shell', id: shell.id }) || undefined}
      data-state={stopped > 0 ? 'stopped-by-restart' : live === 0 ? 'done' : 'idle'}
      title={clickOpens === 'window' ? 'Double-click to open its terminal window' : 'Double-click to expand it here'}
      onDoubleClick={() => (clickOpens === 'window' ? openShell(shell) : expand(id))}
    >
      <div className="hybrid-tile-head">
        <HarnessMark className="hybrid-tile-icon" harness="shell" />
        <EditableName className={nameClass(shell.name)} value={shell.name} title={shell.name} renaming={renaming} label="Shell name" />
        <RenameButton renaming={renaming} />
        <TileCorner>
          <TileButton icon={<Expand />} aria-label="Expand" title="Expand it here, with its panes" onClick={() => expand(id)} />
          <TileButton icon={<SquareArrowOutUpRight />} aria-label="Pop out" title="Open its terminal in its own window" onClick={() => popOutShell(shell)} />
          <TileMenu
            entries={[
              otherOpen(clickOpens, () => expand(id), () => openShell(shell)),
              'separator',
              { label: 'Rename', icon: <Pencil />, shortcut: 'F2', onSelect: renaming.startSoon },
              'separator',
              { label: 'Delete shell', icon: <Trash2 />, danger: true, onSelect: () => deleteShell(shell.id) },
            ]}
          />
        </TileCorner>
      </div>
      <ShellFolderChip shell={shell} />
      {stopped > 0 && <ResumeRow onResume={() => resumeShell(shell)} />}
      <span className="hybrid-tile-footer">
        <Tag className="hybrid-tile-state" data-testid="shell-tile-panes">
          {panesLabel(panes)}
          {live < panes && ` · ${live} live`}
        </Tag>
      </span>
    </div>
  );
}

/**
 * A shell tile's folder chip (AK1): the folder its first live pane is in, following `cd`, `~` at home. It opens
 * a menu to start a new pane elsewhere: home, a recent folder, or one browsed for. Running panes never move.
 */
function ShellFolderChip({ shell }: { shell: Shell }) {
  const folders = useContext(ShellFoldersContext);
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  const live = paneIds(shell.layout).find((pane) => !shell.endedPanes.includes(pane));
  const folder = (live === undefined ? undefined : shell.paneFolders[live]) ?? shell.cwd;
  const elsewhere = recent.filter((each) => each.path !== folder);
  const entries: MenuEntry[] = [
    ...(folders.home === undefined || folders.home === folder
      ? []
      : [{ label: 'Home ~', icon: <Folder />, onSelect: () => folders.newPaneIn(shell, folders.home) }]),
    ...elsewhere.map((each) => ({
      label: each.branch === null ? each.name : `${each.name} (${each.branch})`,
      icon: <GitBranch />,
      hint: each.path,
      onSelect: () => folders.newPaneIn(shell, each.path),
    })),
    ...(elsewhere.length > 0 || folders.home !== folder ? ['separator' as const] : []),
    { label: 'Browse…', icon: <Folder />, onSelect: () => folders.newPaneIn(shell) },
  ];
  return (
    <Menu
      entries={entries}
      onOpenChange={(open) => {
        if (open) void folders.recent().then(setRecent, () => setRecent([]));
      }}
    >
      <Chip
        className="hybrid-tile-folder nodrag"
        icon={<Folder />}
        mono
        aria-label="Shell folder"
        data-testid="shell-folder"
        title={`${folder}: start a new pane in another folder`}
        onDoubleClick={stopPropagation}
      >
        {folderLabel(folder, folders.home)}
      </Chip>
    </Menu>
  );
}

/** A tile's Resume button, for a session stopped by a restart: nothing starts again until it is pressed. */
function ResumeRow({ onResume }: { onResume(): Promise<void> }) {
  return (
    <span className="hybrid-tile-resume" onDoubleClick={stopPropagation}>
      <ResumeButton className="nodrag" onResume={onResume} />
      Stopped by a restart
    </span>
  );
}

/**
 * A session started outside the app, reported by the global hooks: its folder's name (or the worker's issue and role),
 * branch, first prompt and state, and what its worker's status file says. It has no terminal here: it can be resumed
 * in agent-board, becoming an agent, or dismissed.
 */
function ExternalTile({ id, session }: { id: string; session: ExternalSession }) {
  const { expand, dismissExternal, resumeExternal } = useContext(TileActionsContext);
  const { status } = session;
  const fitted = useFittedLines();
  const docs = [status?.handover && `handover ${status.handover}`, status?.reviewDoc && `review ${status.reviewDoc}`].filter(Boolean);
  return (
    <div
      className="hybrid-tile hybrid-tile-agent hybrid-tile-external"
      data-testid="external-tile"
      data-representation="hybrid"
      data-harness={session.harness}
      data-state={session.state}
      data-external-id={session.id}
      data-zone={session.zoneId ?? ''}
      title={`Started outside agent-board in ${session.cwd}. Double-click for its details.`}
      onDoubleClick={() => expand(id)}
    >
      <div className="hybrid-tile-head">
        <HarnessMark className="hybrid-tile-icon" harness={session.harness} />
        <span className="hybrid-tile-name">{session.name}</span>
        <TileCorner>
          <TileButton icon={<Expand />} aria-label="Expand" title="Expand it here, with its details" onClick={() => expand(id)} />
          <TileButton
            icon={<Play />}
            aria-label="Resume in agent-board"
            title="Carry on this session here, as an agent with a terminal of its own"
            onClick={() => resumeExternal(session)}
          />
          <TileMenu
            entries={[
              { label: 'Resume in agent-board…', icon: <Play />, onSelect: () => resumeExternal(session) },
              'separator',
              { label: 'Remove from board', icon: <Trash2 />, danger: true, onSelect: () => dismissExternal(session.id) },
            ]}
          />
        </TileCorner>
      </div>
      <span className="hybrid-tile-branch" title={session.worktree ?? session.cwd}>
        {session.branch ?? session.cwd}
      </span>
      {status !== null ? (
        <span ref={fitted} className="hybrid-tile-status" data-testid="tile-status" data-status-state={status.state} title={status.summary}>
          <span className="hybrid-tile-status-state">{status.state}</span> {status.summary}
        </span>
      ) : (
        <span ref={fitted} className="hybrid-tile-body hybrid-tile-description" title={session.description}>
          {session.description}
        </span>
      )}
      {docs.length > 0 && (
        <span className="hybrid-tile-docs" data-testid="tile-docs" title={docs.join('\n')}>
          {docs.join(' · ')}
        </span>
      )}
      <span className="hybrid-tile-footer">
        <Tag>external</Tag>
        <StatusPill state={session.state} label={TILE_STATE_LABELS[session.state]} title={STATE_LABELS[session.state]} />
      </span>
      <SubagentPerch harness={session.harness} subagents={session.subagents} />
    </div>
  );
}

/** A name this long fills both of its lines, so the rename pencil laid over its end would hide letters: it leaves room. */
const LONG_NAME = 24;
const nameClass = (name: string) => (name.length > LONG_NAME ? 'hybrid-tile-name hybrid-tile-name-long' : 'hybrid-tile-name');

/** Keeps a double-click on a tile's control from also opening its session. */
const stopPropagation = (event: MouseEvent) => event.stopPropagation();

/** An icon button in a tile's head: small, and kept from dragging the tile or opening its session. */
function TileButton(props: Omit<IconButtonProps, 'size'>) {
  return <IconButton size="xs" {...props} className={cx('nodrag', props.className)} onDoubleClick={stopPropagation} />;
}

/** A tile's More button and its menu of the rarer actions. */
function TileMenu({ entries }: { entries: MenuEntry[] }) {
  return (
    <Menu entries={entries} align="end">
      <TileButton icon={<MoreHorizontal />} aria-label="More" title="More actions" />
    </Menu>
  );
}

/**
 * The corner of a tile's head: its actions, unseen until the tile is hovered or holds the focus, but always there
 * for the keyboard, which shows them as it reaches them. Only their opacity changes, so nothing on the tile moves
 *; the state lives in the footer.
 */
function TileCorner({ children }: { children: ReactNode }) {
  return (
    <span className="hybrid-tile-corner">
      <span className="hybrid-tile-actions">{children}</span>
    </span>
  );
}

/** A scheduled agent's clock chip: when it next runs, or that its schedule is paused or off. Opens its schedule. */
function ClockChip({ schedule, ended, open }: { schedule: AgentSchedule; ended: boolean; open(): void }) {
  // Re-rendered every second, so "tomorrow 09:00" turns into "09:00" at midnight.
  const now = useNow(true);
  const { label, title } = clockBadge(schedule, ended, new Date(now));
  return (
    <Chip
      icon={<Clock />}
      className="hybrid-tile-clock nodrag"
      data-testid="tile-clock"
      data-enabled={schedule.enabled}
      aria-label={`Schedule: ${label}`}
      title={title}
      onClick={open}
      onDoubleClick={stopPropagation}
    >
      {label}
    </Chip>
  );
}

const CHECK_MARKS: Record<ChecksState, ReactNode> = {
  passing: <Check aria-hidden />,
  failing: <X aria-hidden />,
  pending: <Dot aria-hidden />,
  none: null,
};

/**
 * A pull request made from the agent's branch: its number in its state's colour, and a mark for its checks. One of a
 * branch it `pushed` to leads with an arrow and says so; it is only shown, as it isn't the agent's own.
 */
export function PullRequestChip({ pr, pushed = false, open }: { pr: PullRequest; pushed?: boolean; open(): void }) {
  const checks = checksLabel(pr);
  return (
    <Chip
      mono
      icon={pushed ? <ArrowUpRight aria-hidden /> : undefined}
      className="hybrid-tile-pr nodrag"
      data-testid="tile-pr"
      data-state={pr.state}
      data-checks={pr.checks}
      data-pushed={pushed || undefined}
      aria-label={`${pushed ? 'Pushed to pull request' : 'Pull request'} #${pr.number}, ${pr.state}, ${checks}`}
      title={`${pushed ? 'Pushed to ' : ''}#${pr.number} ${pr.title}\n${pr.state}, ${checks}. Open it in a PR tab.`}
      onClick={open}
      onDoubleClick={stopPropagation}
    >
      #{pr.number}
      {pr.checks !== 'none' && <span className="hybrid-tile-pr-checks">{CHECK_MARKS[pr.checks]}</span>}
    </Chip>
  );
}

/** The ⋯ menu's way to do, once, what a click on the tile doesn't (AM1): expand it in place, or open its window. */
function otherOpen(clickOpens: ClickOpens, expand: () => void, open: () => void): MenuEntry {
  return clickOpens === 'window'
    ? { label: 'Expand in place', icon: <Expand />, onSelect: expand }
    : { label: 'Open window', icon: <Maximize2 />, onSelect: open };
}
