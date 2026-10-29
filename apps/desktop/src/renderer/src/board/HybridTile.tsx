import { useBoardCommands } from './commands';
import { memo, useContext, useState, type MouseEvent, type ReactNode } from 'react';
import {
  shortIssueId,
  statusLine,
  TRACKER_PROVIDERS,
  needsYouNow,
  waitsForYou,
  type Agent,
  isOrchestratorRole,
  continuesOnCredits,
  type AgentRole,
  type AgentSchedule,
  type UndeliveredMessage,
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
import { gateBadge, inRepoCheckout, shortCommit } from '@agent-board/daemon/gate-rules';
import { planBadge, planStamp } from '../plan/plan-view';
import { latestShown } from '../doc/doc-view';
import { useGateRun } from '../gate/GatesProvider';
import { gated } from '../gate/gate-view';
import { runGateShortcut } from '../session/window-keys';
import { HarnessMark } from './HarnessMark';
import { agentStartLines, StartFailedActions, StartOutput, StartSteps, StartTile } from './StartTile';
import { useCheckoutWarning } from './checkout-warning';
import { agentSetupLine, branchLine, modelLabel, roleText } from './AgentSetup';
import { useNow } from '../inbox/use-now';
import { clockBadge } from './schedule';
import { commandLine } from './command-row';
import { FoldVertical, ArrowUpRight, Bell, BellOff, Check, ClipboardList, Clock, Coins, Dot, Expand, FileCheck, FileSearch, FileText, Folder, FolderCheck, GitBranch, Hammer, Hash, Maximize2, MoreHorizontal, Network, Pause, PenLine, Pencil, Play, RefreshCw, RotateCcw, Search, SendHorizontal, ShieldCheck, SquareArrowOutUpRight, Timer, Trash2, TriangleAlert, X } from 'lucide-react';
import { toolSummary } from '../../../shared/needs-you';
import { Button, Chip, EditableName, FlowPill, HoverCard, IconButton, Menu, RenameButton, Spinner, StatusPill, Tag, useRenaming, useSlowClickRename, type IconButtonProps, type MenuEntry } from '../ui';
import { Character } from './Character';
import { CommandFigure } from './CommandFigure';
import { HandoffsContext } from './flow-edges';
import { badgeLine, checksLabel, foldRanking, isStarting, tileFooter } from './tile-footer';
import { useFooterFold } from './use-footer-fold';
import { ResumeButton } from './RestartBanner';
import { cx } from '../ui/cx';
import { agentPill, STATE_LABELS, TILE_STATE_LABELS } from '../states';
import { useNeedsYouShows } from '../needs-you-setting';
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
import { keyText } from '../keys/registry';
import { pauseControl, pausedLine } from './paused';

/**
 * Hybrid (v1): a calm white tile with a soft shadow, sitting straight. An agent's tile shows its name, harness,
 * branch and the pull requests made from it, linked issue, task and state, with an orange outline while it waits for
 * you, and a clock badge with its next run while it has a schedule. Its subagents perch on its top edge as
 * characters.
 */
export const HybridTile = memo(function HybridTile({ id, tile, selected = false }: TileProps) {
  const harness = tile.harness ?? 'shell';
  if (tile.start !== undefined) return <StartTile id={id} start={tile.start} />;
  if (tile.agent !== undefined) return <AgentTile id={id} selected={selected} agent={tile.agent} repo={tile.repo} from={tile.from} crew={tile.crew} crewFlags={tile.crewFlags} tabs={tile.tabs} />;
  if (tile.shell !== undefined) return <ShellTile id={id} shell={tile.shell} selected={selected} />;
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

function AgentTile({ id, selected, agent, repo, from, crew, crewFlags, tabs }: { id: string; selected: boolean; agent: Agent; repo?: string } & Pick<TileData, 'from' | 'crew' | 'crewFlags' | 'tabs'>) {
  const shows = useNeedsYouShows();
  const crewView = useContext(CrewViewContext);
  // The crew it is of, as an orchestrator or one it started: lit while the orchestrator or a chip is hovered.
  const crewOf = crew === undefined ? from?.sessionId : agent.sessionId;
  const chip = from !== undefined && crewView.look !== 'off' && (crewView.look === 'chips' || !crewView.framed.has(agent.sessionId));
  const { setFolded, expand, openAgent, popOutAgent, deleteAgent, linkIssue, scheduleAgent, setMuted, openLink, openPullRequest, resumeAgent, pauseAgent, sendUnsent, clearUnsent, typeFirstPrompt, trustFolder, resendUndelivered, clearUndelivered, restartAgent, rename, startReview, openReview, openGate, openPlan, openDoc, retryAgentStart, continueOnCredits } =
    useContext(TileActionsContext);
  const commands = useBoardCommands();
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
  const starting = isStarting(agent);
  // A starting reviewer has no room for a subtitle row, so its marker leads its name ("Review · r1 · Rework the…"), where a
  // long name's clamp can't cut it off.
  const split = agent.reviewOf === null ? { name: agent.name } : splitReviewerName(agent.name);
  const shownName = starting && split.subtitle !== undefined ? { name: `${split.subtitle} · ${split.name}` } : split;
  const renaming = useRenaming(agent.name, (name) => rename({ kind: 'agent', sessionId: agent.sessionId }, name));
  useRenameRequest(id, renaming);
  const nameClicks = useSlowClickRename(renaming, selected);
  const handoffs = useContext(HandoffsContext);
  const shells = windowShells({ kind: 'agent', agent }, tabs ?? []);
  const { shown, folded: overflow } = tileFooter(agent, shells.length);
  const ranking = foldRanking(shown);
  const fitted = useFittedLines();
  const ask = askOf(agent);
  // An orchestrator in the repo's own checkout says when that checkout is dirty or off its default branch, until it is not.
  // With no worktree of its own (a folder outside git, or a repo with no commits on a git too old for a worktree), it
  // shares where it works; an orchestrator in the main checkout chose that, and its Checkout row said so.
  const notIsolated = agent.plainFolder ? 'shared folder, no worktree' : inRepoCheckout(agent) && agent.branch === '' && !agent.master && !isOrchestratorRole(agent.roleName) ? 'repo checkout, no worktree' : undefined;
  const checkoutWarning = useCheckoutWarning(isOrchestratorRole(agent.roleName) && inRepoCheckout(agent) && agent.endedAt === null ? agent.repoRoot : undefined, true);
  // Until its session's first hook, the tile shows its start's steps where its task goes.
  const { startup } = agent;
  // A hand-off going along one of its edges shows for as long as the edge shows it, however soon it was over.
  // Never over its needing you, as in the daemon: the tile would say it no longer waits.
  const sending = handoffs.sending.has(agent.sessionId) && agent.state !== 'waiting' && agent.state !== 'needs-permission' && ask === undefined;
  const receiving = !sending && handoffs.receiving.has(agent.sessionId);
  // Seen only means something while it still waits: an ended or stopped agent shows its own state.
  const seen = agent.seen && waitsForYou(agent, shows);
  const state = sending ? 'handing-off' : agent.state;
  const pill = receiving ? (
    <FlowPill title="Receiving a hand-off">receiving…</FlowPill>
  ) : (
    <StatusPill {...(sending ? { state, label: TILE_STATE_LABELS[state] } : agentPill(agent, shows, TILE_STATE_LABELS))} {...(agent.shellHarness === null ? {} : { label: endedShellLabel(agent) })} title={STATE_LABELS[state]} />
  );
  // Badges that don't fit in its one line fold into the "+N", the lowest ranked first, and fold again whenever what the footer
  // says changes.
  const footer = useFooterFold({
    key: JSON.stringify([shown, shells.length, latestRound?.round, gate?.status, gate === undefined ? '' : gateBadge(gate), agent.state, receiving, sending, agent.shellSessionId, agent.endedAt, crewFlags]),
    badges: shown.length,
    ranking,
    plusShown: overflow.length > 0,
  });
  const folded = [...ranking.slice(0, footer.folded).map((index) => badgeLine(shown[index]!, shells.length)), ...overflow];
  // Its last message, a hover away, while the body says what it is doing; an ask or a notice is the body's, as it was.
  const card = lastMessageCard(agent);
  const lastMessage = card?.text;
  const pause = pauseControl(agent);
  return (
    <HoverCard label={card?.label ?? 'Last message'} content={lastMessage}>
    <div
      className="hybrid-tile hybrid-tile-agent"
      data-testid="agent-tile"
      data-representation="hybrid"
      data-harness={agent.harness}
      data-state={agent.state}
      data-start={startup === null ? undefined : startup.failed ? 'failed' : 'starting'}
      data-session-id={agent.sessionId}
      data-zone={agent.zoneId ?? ''}
      data-tab-drop={dropKey({ kind: 'agent', id: agent.sessionId })}
      data-drop-over={dropOver === dropKey({ kind: 'agent', id: agent.sessionId }) || undefined}
      data-muted={agent.muted}
      data-seen={seen || undefined}
      data-needs-you={needsYouNow(agent, shows) || undefined}
      data-crowded={shown.length > 1 || undefined}
      data-handoff={sending ? 'sending' : receiving ? 'receiving' : undefined}
      data-reviewer={agent.reviewOf !== null || undefined}
      data-orchestrator={crew !== undefined || undefined}
      data-master={agent.master || undefined}
      data-crew={crewOf}
      onMouseEnter={crew === undefined ? undefined : () => lightCrew(agent.sessionId)}
      onMouseLeave={crew === undefined ? undefined : () => lightCrew(undefined)}
      title={lastMessage !== undefined ? undefined : clickOpens === 'window' ? 'Double-click to open its session window' : 'Double-click to expand it here'}
      onDoubleClick={() => (clickOpens === 'window' ? openAgent(agent) : expand(id))}
    >
      {agent.master && (
        <span className="hybrid-tile-master-badge" data-testid="master-badge">
          CAPTAIN
        </span>
      )}
      <div className="hybrid-tile-head">
        {startup !== null && !startup.failed ? <Spinner /> : <HarnessMark className="hybrid-tile-icon" harness={agent.harness} />}
        <EditableName className={nameClass(shownName.name)} value={agent.name} title={agent.name} shown={shownName.name} renaming={renaming} clicks={nameClicks} label="Agent name" />
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
              ...(continuesOnCredits(agent) ? [{ label: 'Continue on credits', icon: <Coins />, onSelect: () => void continueOnCredits(agent.sessionId) }] : []),
              ...(pause === undefined
                ? []
                : [
                    pause.action === 'wake'
                      ? { label: 'Wake', icon: <Play />, hint: pause.hint, onSelect: () => void resumeAgent(agent.sessionId) }
                      : { label: 'Pause', icon: <Pause />, disabled: !pause.enabled, hint: pause.hint, onSelect: () => void pauseAgent(agent.sessionId) },
                  ]),
              'separator',
              { label: 'Rename', icon: <Pencil />, shortcut: keyText('tile.rename'), onSelect: renaming.startSoon },
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
      {/* Not while it starts: the tile's room is its name, its step and its footer; its crew frame or the board's zone says whose it is. */}
      {!starting && (startup === null || chip || repo !== undefined) && (
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
          {startup === null &&
            (notIsolated !== undefined ? (
              <span className="hybrid-tile-shared" data-testid="not-isolated" title={`Not isolated: it works in ${agent.worktree} itself, shared with any other agent there`}>
                <Folder aria-hidden />
                {notIsolated}
              </span>
            ) : (
              <>
                <GitBranch aria-hidden />
                {branchLine(agent)}
              </>
            ))}
        </span>
      )}
      {!starting && checkoutWarning !== undefined && (
        <span className="hybrid-tile-warning" data-testid="checkout-warning" title={`${checkoutWarning}: ${agent.repoRoot}`}>
          <TriangleAlert aria-hidden />
          {checkoutWarning}
        </span>
      )}
      {!starting && agent.trustedByZone && (
        <span className="hybrid-tile-trusted" data-testid="tile-trusted-by-zone" title="Its zone trusts its folder for new agents: Claude's trust screen was answered by that setting, not by you.">
          <ShieldCheck aria-hidden />
          trusted by this zone&apos;s setting
        </span>
      )}
      {agent.undelivered.length > 0 ? (
        // Before all else: its sender heard it was queued, and nothing else says it never went.
        <UndeliveredRow
          fitted={fitted}
          items={agent.undelivered}
          onResend={() => resendUndelivered(agent.sessionId)}
          onClear={() => clearUndelivered(agent.sessionId)}
        />
      ) : agent.trustFolder !== null ? (
        // Before its startup lines: they show the trust screen's last line, which this answers.
        <TrustRow fitted={fitted} folder={agent.trustFolder} onTrust={() => trustFolder(agent.sessionId)} />
      ) : startup !== null ? (
        <>
          {/* Starting, only the step it is on, its worktree in the tooltip; a failed start keeps the worktree step above the one that failed. */}
          <StartSteps lines={starting ? agentStartLines(agent).slice(-1) : agentStartLines(agent)} title={starting ? agent.worktree : undefined} />
          <StartOutput output={startup.output} failed={startup.failed} />
        </>
      ) : agent.untypedPrompt !== null ? (
        <UntypedRow fitted={fitted} prompt={agent.untypedPrompt} onSend={() => typeFirstPrompt(agent.sessionId)} />
      ) : // Before what it asks: the answer is what sits unsent at its prompt.
      agent.unsent !== null ? (
        <UnsentRow
          fitted={fitted}
          what={agent.unsent}
          asked={ask?.text}
          onSend={() => sendUnsent(agent.sessionId)}
          onClear={() => clearUnsent(agent.sessionId)}
        />
      ) : ask !== undefined ? (
        <span ref={fitted} className="hybrid-tile-body hybrid-tile-ask" data-testid="tile-ask" data-question={ask.question} title={ask.title ?? ask.text}>
          <span className="hybrid-tile-text">
            {ask.tool !== undefined && <strong>{ask.tool} </strong>}
            {ask.text}
          </span>
        </span>
      ) : agent.flag !== null ? (
        // Its flag: to the user, the needs-you orange; to its orchestrator, the crew's violet.
        <span ref={fitted} className="hybrid-tile-body hybrid-tile-flag" data-testid="tile-flag" data-to={agent.flag.to} title={agent.flag.reason}>
          <span className="hybrid-tile-text">
            {agent.flag.to === 'orchestrator' ? `⚑ to orchestrator: ${agent.flag.reason}` : `⚑ ${agent.flag.reason}`}
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
          title={lastMessage !== undefined ? undefined : agent.status === null ? agent.description : `${statusLine(agent.status)}\n\nTask: ${agent.description}`}
        >
          {agent.status === null ? agent.description || 'No task yet' : statusLine(agent.status)}
        </span>
      )}
      {/* A paused tile says who paused it instead: one line under the body, which yields to the body's lines. */}
      {/* Not on a start, failed either: its footer is Retry and Delete, and nothing there yields to give it room. */}
      {ask === undefined && agent.notice === null && agent.status?.setBy != null && agent.hibernated === null && startup === null && (
        <span className="hybrid-tile-byline" data-testid="tile-set-by" data-yields="">
          set by ◎ {agent.status.setBy}
        </span>
      )}
      {agent.hibernated !== null &&
        (agent.hibernated.reason === undefined ? (
          <PausedLine hibernated={agent.hibernated} />
        ) : (
          <HeldLine reason={agent.hibernated.reason} onOverride={() => resumeAgent(agent.sessionId)} />
        ))}
      {agent.state === 'on-command' && <CommandRow agent={agent} />}
      {startup?.failed === true ? (
        <StartFailedActions onRetry={() => retryAgentStart(agent.sessionId)} onDelete={() => deleteAgent(agent.sessionId)} />
      ) : (
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
                    <Tag
                      key="role"
                      className="hybrid-tile-setup"
                      data-testid="tile-role"
                      data-orchestrator-role={isOrchestratorRole(badge.name) || undefined}
                      title={agentSetupLine(agent)}
                    >
                      {isOrchestratorRole(badge.name) ? <Network aria-hidden /> : ROLE_ICONS[badge.role]}
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
                  return <ClockChip key="schedule" schedule={badge.schedule} ended={agent.endedAt !== null} open={() => commands.showClock(badge.schedule.clockId)} />;
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
            {!starting && latestRound !== undefined && (
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
            {!starting && agent.plan !== null && (
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
            {!starting && agent.docs.length > 0 && (
              <Chip
                className="hybrid-tile-docs nodrag"
                data-testid="tile-docs"
                title={`${agent.docs.map((each) => each.title).join('\n')}\nOpen the latest as a Document tab`}
                onClick={() => openDoc(agent, latestShown(agent.docs))}
                onDoubleClick={stopPropagation}
              >
                <FileText aria-hidden />
                {agent.docs.length === 1 ? '1 doc' : `${agent.docs.length} docs`}
              </Chip>
            )}
            {!starting && gate !== undefined && (
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
            {agent.queuedUntilUp > 0 && (
              <Chip className="hybrid-tile-queued" data-testid="tile-queued" title="Sent before its session was up: typed once it is, after its first prompt">
                <Timer aria-hidden />
                {agent.queuedUntilUp} queued until it&apos;s up
              </Chip>
            )}
            {!starting && crewFlags !== undefined && (
              <Chip className="hybrid-tile-crew-flags" data-testid="crew-flags" title="Crew members waiting for its answer: sending each a message clears its flag">
                ⚑ {crewFlags} crew flag{crewFlags === 1 ? '' : 's'}
              </Chip>
            )}
            {pill}
            {!sending && !receiving && continuesOnCredits(agent) && <ContinueButton onContinue={() => continueOnCredits(agent.sessionId)} />}
            {agent.state === 'hibernated' && <WakeButton onWake={() => resumeAgent(agent.sessionId)} />}
          </span>
      )}
      <SubagentPerch harness={agent.harness} subagents={agent.subagents} />
      {sending && (
        // Its robot, handing its payload on, perched at the top left (FlowRules).
        <span className="hybrid-tile-handoff">
          <Character harness={agent.harness} pose="handing-off" label={agent.name} />
        </span>
      )}
      {!sending && <CommandFigure agent={agent} />}
    </div>
    </HoverCard>
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
 * The agent's last message for the card that shows below its tile, with the time its turn ended in the card's label:
 * none while the tile's body is an ask or a notice, which take its place.
 */
export function lastMessageCard(agent: Agent): { text: string; label: string } | undefined {
  if (askOf(agent) !== undefined || agent.notice !== null || !agent.lastMessage) return undefined;
  const at = agent.finishedAt === null ? undefined : new Date(agent.finishedAt);
  const time = at === undefined || Number.isNaN(at.getTime()) ? '' : ` · ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return { text: agent.lastMessage, label: `Last message${time}` };
}

/**
 * What a tile waiting for you asks, in place of its task: the tool it wants to use, the question it asks through the
 * board with its options, or the plan it waits on. A question on its card beside the tile isn't repeated:
 * the tile points at it, the question in its tooltip. Its last message is on its hover card instead.
 */
function askOf(agent: Agent): { tool?: string; text: string; title?: string; question?: true } | undefined {
  const prompt = agent.permissions[0];
  if (prompt !== undefined) return { tool: prompt.toolName, text: toolSummary(prompt) };
  if (agent.ask?.onBoard === true) return { text: 'Asking you ↗', title: agent.ask.question, question: true };
  if (agent.ask !== null) return { text: agent.ask.options.length === 0 ? agent.ask.question : `${agent.ask.question}\n${agent.ask.options.join(' · ')}`, question: true };
  if (planPending(agent)) return { text: `Waiting for you to decide on its plan: ${agent.plan.title}` };
  return undefined;
}

/** A shell tile: plain shells in a zone's folder, or at home loose on the board, split into panes in its session window. */
function ShellTile({ id, shell, selected }: { id: string; shell: Shell; selected: boolean }) {
  const { expand, openShell, popOutShell, deleteShell, resumeShell, rename } = useContext(TileActionsContext);
  const clickOpens = useContext(ClickOpensContext);
  const renaming = useRenaming(shell.name, (name) => rename({ kind: 'shell', shellId: shell.id }, name));
  const dropOver = dropOverValue.use();
  useRenameRequest(id, renaming);
  const nameClicks = useSlowClickRename(renaming, selected);
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
        <EditableName className={nameClass(shell.name)} value={shell.name} title={shell.name} renaming={renaming} clicks={nameClicks} label="Shell name" />
        <RenameButton renaming={renaming} />
        <TileCorner>
          <TileButton icon={<Expand />} aria-label="Expand" title="Expand it here, with its panes" onClick={() => expand(id)} />
          <TileButton icon={<SquareArrowOutUpRight />} aria-label="Pop out" title="Open its terminal in its own window" onClick={() => popOutShell(shell)} />
          <TileMenu
            entries={[
              otherOpen(clickOpens, () => expand(id), () => openShell(shell)),
              'separator',
              { label: 'Rename', icon: <Pencil />, shortcut: keyText('tile.rename'), onSelect: renaming.startSoon },
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
 * A shell tile's folder chip: the folder its first live pane is in, following `cd`, `~` at home. It opens
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

/**
 * What was typed at the agent's prompt and never sent, its Enter lost however often pressed: Send presses it again,
 * and Clear clears its prompt. Nothing more is typed at the agent until one of them is done. The question the agent
 * asked, which the row hides, is in its tooltip.
 */
function UnsentRow({
  fitted,
  what,
  asked,
  onSend,
  onClear,
}: {
  fitted: (element: HTMLElement | null) => void;
  what: string;
  asked: string | undefined;
  onSend(): Promise<void>;
  onClear(): Promise<void>;
}) {
  const [pending, setPending] = useState<'send' | 'clear'>();
  const run = (action: 'send' | 'clear', act: () => Promise<void>) => {
    setPending(action);
    void act().finally(() => setPending(undefined));
  };
  const text = pending === 'send' ? `Sending ${what.charAt(0).toLowerCase()}${what.slice(1)}…` : `${what} not sent: it is typed at its prompt`;
  return (
    <span
      ref={fitted}
      className="hybrid-tile-body hybrid-tile-unsent"
      role="note"
      data-testid="tile-unsent"
      title={asked === undefined ? text : `${text}\n\nIt asked: ${asked}`}
      onDoubleClick={stopPropagation}
    >
      <span className="hybrid-tile-text">{text}</span>
      <Button size="xs" variant="primary" icon={<SendHorizontal />} className="nodrag" data-testid="send-unsent" disabled={pending !== undefined} onClick={() => run('send', onSend)}>
        Send
      </Button>
      <Button size="xs" className="nodrag" data-testid="clear-unsent" disabled={pending !== undefined} onClick={() => run('clear', onClear)}>
        Clear
      </Button>
    </span>
  );
}

/**
 * What was sent to the agent before its session was up and never typed: Resend sends it again (an ended agent starts
 * again with it), Clear forgets it.
 */
function UndeliveredRow({
  fitted,
  items,
  onResend,
  onClear,
}: {
  fitted: (element: HTMLElement | null) => void;
  items: readonly UndeliveredMessage[];
  onResend(): Promise<void>;
  onClear(): Promise<void>;
}) {
  const [pending, setPending] = useState<'resend' | 'clear'>();
  const run = (which: 'resend' | 'clear', action: () => Promise<void>) => {
    setPending(which);
    void action().finally(() => setPending(undefined));
  };
  const what = items.length === 1 ? `${items[0]!.what} not delivered:` : `${items.length} messages not delivered:`;
  return (
    <span
      ref={fitted}
      className="hybrid-tile-body hybrid-tile-unsent"
      role="note"
      data-testid="tile-undelivered"
      title={items.map((item) => `${item.what} (${item.reason}):\n${item.text}`).join('\n\n')}
      onDoubleClick={stopPropagation}
    >
      <span className="hybrid-tile-text">
        {pending === 'resend' ? (
          'Resending…'
        ) : (
          <>
            <strong>{what}</strong> {items.map((item) => item.text).join(' · ')}
          </>
        )}
      </span>
      <Button size="xs" variant="primary" icon={<SendHorizontal />} className="nodrag" data-testid="resend-undelivered" disabled={pending !== undefined} onClick={() => run('resend', onResend)}>
        Resend
      </Button>
      <Button size="xs" className="nodrag" data-testid="clear-undelivered" disabled={pending !== undefined} onClick={() => run('clear', onClear)}>
        Clear
      </Button>
    </span>
  );
}

/**
 * Claude's trust screen, which its first prompt waits on: Trust folder answers it `Yes, I trust this folder`, only on
 * the user's click; the first prompt is typed once its session is up.
 */
function TrustRow({ fitted, folder, onTrust }: { fitted: (element: HTMLElement | null) => void; folder: string; onTrust(): Promise<void> }) {
  const [pending, setPending] = useState(false);
  return (
    <span
      ref={fitted}
      className="hybrid-tile-body hybrid-tile-unsent"
      role="note"
      data-testid="tile-trust"
      title={`Claude is asking whether to trust this folder before it starts:\n${folder}\n\nTrust folder answers "Yes, I trust this folder"; its first prompt is typed once it is up.`}
      onDoubleClick={stopPropagation}
    >
      <span className="hybrid-tile-text">
        {pending ? (
          'Trusting its folder…'
        ) : (
          <>
            <strong>Claude asks to trust this folder:</strong> {folder}
          </>
        )}
      </span>
      <Button
        size="xs"
        variant="primary"
        icon={<FolderCheck />}
        className="nodrag"
        data-testid="trust-folder"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void onTrust().finally(() => setPending(false));
        }}
      >
        Trust folder
      </Button>
    </span>
  );
}

/**
 * The first prompt its session never said it was up for, so never typed: Send types it at its prompt, once the user
 * has seen its terminal is ready for it (a startup screen of its harness answered).
 */
function UntypedRow({ fitted, prompt, onSend }: { fitted: (element: HTMLElement | null) => void; prompt: string; onSend(): Promise<void> }) {
  const [pending, setPending] = useState(false);
  // What to do before Send (beside it), short enough to fit the one line a crowded tile leaves the row: Send on a
  // startup screen (trust this folder?) answers it.
  const hint = 'Answer its terminal first:';
  return (
    <span
      ref={fitted}
      className="hybrid-tile-body hybrid-tile-unsent"
      role="note"
      data-testid="tile-untyped"
      title={`Its first prompt is not typed yet: its session never said it was up. Answer its terminal first, then Send.\n\n${prompt}`}
      onDoubleClick={stopPropagation}
    >
      <span className="hybrid-tile-text">
        {pending ? (
          'Sending its first prompt…'
        ) : (
          <>
            <strong>{hint}</strong> {prompt}
          </>
        )}
      </span>
      <Button
        size="xs"
        variant="primary"
        icon={<SendHorizontal />}
        className="nodrag"
        data-testid="send-untyped"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void onSend().finally(() => setPending(false));
        }}
      >
        Send
      </Button>
    </span>
  );
}

/**
 * The rate-limited pill's button: resumes the turn on usage credits, as Claude offers in its terminal. Only shown while
 * its usage limit stops it, and pressed only by the user.
 */
function ContinueButton({ onContinue }: { onContinue(): Promise<void> }) {
  const [pending, setPending] = useState(false);
  return (
    <TileButton
      className="hybrid-tile-continue"
      data-testid="continue-on-credits"
      icon={pending ? <Spinner /> : <Coins />}
      aria-label="Continue on credits"
      title="Continue on credits: resume its turn, for your usage credits to pay for"
      disabled={pending}
      onClick={() => {
        setPending(true);
        void onContinue().finally(() => setPending(false));
      }}
    />
  );
}

/** A paused tile's line, who paused it and how long ago, kept current while it shows. */
function PausedLine({ hibernated }: { hibernated: NonNullable<Agent['hibernated']> }) {
  const { who, when } = pausedLine(hibernated, useNow(true));
  return (
    <span className="hybrid-tile-byline hybrid-tile-paused" data-testid="tile-paused" data-yields="" title={`${who}, ${new Date(hibernated.at).toLocaleString()}`}>
      <Pause aria-hidden />
      {/* A long name gives way; how long ago always shows. */}
      <span className="hybrid-tile-paused-who">{who}</span>
      <span className="hybrid-tile-paused-when">{when}</span>
    </span>
  );
}

/**
 * A tile paused for usage: why, as the Captain's digest says it, with Override, which wakes it as Wake does. Above its
 * footer, yielding to the body's lines as a paused tile's line does: its footer's Wake still wakes it.
 */
function HeldLine({ reason, onOverride }: { reason: string; onOverride(): Promise<void> }) {
  const [pending, setPending] = useState(false);
  return (
    <span className="hybrid-tile-byline hybrid-tile-held" data-testid="tile-held" data-yields="" title={`Paused for usage: ${reason}`}>
      <span className="hybrid-tile-held-why">held: {reason}</span>
      <Button
        size="xs"
        className="hybrid-tile-override nodrag"
        data-testid="override"
        title="Wake it anyway, carrying on its conversation"
        disabled={pending}
        onClick={() => {
          setPending(true);
          void onOverride().finally(() => setPending(false));
        }}
        onDoubleClick={stopPropagation}
      >
        Override
      </Button>
    </span>
  );
}

/** A paused tile's Wake, in its footer: it starts again in its conversation. */
function WakeButton({ onWake }: { onWake(): Promise<void> }) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      size="xs"
      icon={<Play />}
      className="hybrid-tile-wake nodrag"
      data-testid="wake"
      title="Start it again, carrying on its conversation"
      disabled={pending}
      onClick={() => {
        setPending(true);
        void onWake().finally(() => setPending(false));
      }}
      onDoubleClick={stopPropagation}
    >
      Wake
    </Button>
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

/**
 * What an agent on a command runs, in a row of its own under its status: the longest-running command, how many more
 * run beside it, and how long it has run.
 */
function CommandRow({ agent }: { agent: Agent }) {
  const now = useNow(true);
  const line = commandLine(agent, now);
  if (line === undefined) return null;
  const all = agent.commands.map((each) => each.command).join('\n');
  return (
    <span className="hybrid-tile-command" data-testid="tile-command" title={`Running in the background:\n${all}`}>
      <Timer aria-hidden />
      <span className="hybrid-tile-command-text">{line.command}</span>
      {line.more > 0 && <span className="hybrid-tile-command-more">+{line.more}</span>}
      <b className="hybrid-tile-command-time">{line.elapsed}</b>
    </span>
  );
}

/** A scheduled agent's clock chip: when it next runs, or that its schedule is paused or off. Selects its clock. */
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

/** The ⋯ menu's way to do, once, what a click on the tile doesn't: expand it in place, or open its window. */
function otherOpen(clickOpens: ClickOpens, expand: () => void, open: () => void): MenuEntry {
  return clickOpens === 'window'
    ? { label: 'Expand in place', icon: <Expand />, onSelect: expand }
    : { label: 'Open window', icon: <Maximize2 />, onSelect: open };
}
