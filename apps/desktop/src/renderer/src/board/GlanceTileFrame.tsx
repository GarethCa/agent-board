import { useContext, type CSSProperties, type ReactNode } from 'react';
import { needsYouNow, shortIssueId, TRACKER_PROVIDERS, waitsForYou, type Agent, type Harness } from '@agent-board/daemon/protocol';
import type { HumanStatus } from '@agent-board/daemon/human-status';
import { lookShown, type CharacterLook } from '@agent-board/daemon/character';
import { Chip, EditableName, HoverCard, Spinner, useRenaming, useSlowClickRename } from '../ui';
import { useNeedsYouShows } from '../needs-you-setting';
import { dropKey, dropOver as dropOverValue } from '../session/shell-moves';
import { CalmButton } from './CalmTile';
import { TileRobot } from './CommandFigure';
import { HandoffsContext } from './flow-edges';
import { glanceFace, type GlanceFace } from './glance-tile';
import { ticketTileAsk } from './ticket-tile';
import { JobTicket, useHeldJobs } from './items/taken-jobs';
import { useJobDropOver } from './items/queue-board';
import { useBoardCommands } from './commands';
import { useAgentTileMenu } from './agent-tile-menu';
import { useMenuBarSection } from '../keys/menu-bar-bridge';
import { useNowForSince, useNowToward } from '../inbox/use-now';
import { calmTimes, QUIET_TILE, tileProgress } from './tile-shows';
import { useRenameRequest } from './rename';
import { ReviewerMark } from './ReviewerMark';
import { poseOfStatus } from './tile-pose';
import { PullRequestChip } from './PullRequestChip';
import { SubagentPerch } from './SubagentPerch';
import { ClickOpensContext, TileActionsContext, type TileData } from './tile';
import { lastMessageCard, stopPropagation, TileMenu, TrustRow, UndeliveredRow, UnsentRow, UntypedRow } from './tile-parts';
import { useFittedLines } from './use-fitted-lines';
import { quickAskOf, tileDialogOf } from './quick-ask';
import { TileQuickAsk } from './TileQuickAsk';
import { TileDialogAsk } from './DialogQuickAsk';
import { HandPlacedMark } from './HandPlacedMark';
import { FrostMark } from './FrostMark';
import { frostedClasses } from './paused';

export type GlanceTileProps = { id: string; selected: boolean; agent: Agent } & Pick<TileData, 'repo' | 'from' | 'crew' | 'crewFlags' | 'implementer' | 'helpers'>;

/** What a glance design draws, each part wired already, so a design only lays them out. */
export interface GlanceParts {
  agent: Agent;
  face: GlanceFace;
  /** Its status in the six the app names everywhere, for its glyph. */
  status: HumanStatus;
  /** Its character's look, as its status and its own pose say. */
  look: CharacterLook & { harness: Harness };
  /** Its name, which a slow click renames, with its starting spinner and its marks. */
  name: ReactNode;
  /** A reviewer's mark, which follows its state word: nothing for an agent that reviews nothing. */
  reviewer: ReactNode;
  /** Its ⋯ menu. */
  menu: ReactNode;
  expand(): void;
  /** What waits on the user's click to reach the agent, with its own buttons, drawn in its line's place; null for none. */
  prompt: ReactNode;
  /** Its one action: its ask's chip, else its button; null for none. */
  action: ReactNode;
  /** How long it has been in its state, and its next run, in words. */
  times: string | undefined;
  /** Its repo, when it works outside every zone of it. */
  repo: ReactNode;
  /** Its ticket and its pull request (the open one, else the latest), each a chip that opens it. */
  tags: ReactNode;
  /** For the element that holds its line, so the line takes the room left and no more. */
  fitted: ReturnType<typeof useFittedLines>;
  /** Its crew's flags and the jobs it holds. */
  extras: ReactNode;
}

/**
 * The board's side of an agent's glance tile, whichever design draws it: the root the board finds, drops onto and
 * measures (the same data as today's tile), its hover card of its last message, double-click to open, rename, its menu,
 * its crew, its progress and its perched subagents. The design draws the rest from `parts`.
 */
export function GlanceTileFrame({
  id,
  selected,
  agent,
  repo,
  from,
  crew,
  crewFlags,
  implementer,
  helpers,
  design,
  children,
}: GlanceTileProps & { design: string; children(parts: GlanceParts): ReactNode }) {
  const shows = useNeedsYouShows();
  const tileActions = useContext(TileActionsContext);
  const { expand, openAgent, rename, sendUnsent, clearUnsent, typeFirstPrompt, trustFolder, resendUndelivered, clearUndelivered } = tileActions;
  const clickOpens = useContext(ClickOpensContext);
  const dropOver = dropOverValue.use();
  const jobDrop = useJobDropOver() === agent.sessionId;
  const handoffs = useContext(HandoffsContext);
  const renaming = useRenaming(agent.name, (name) => rename({ kind: 'agent', sessionId: agent.sessionId }, name));
  const menu = useAgentTileMenu(id, agent, { from, implementer }, renaming.startSoon);
  useMenuBarSection('agent', selected, menu.entries);
  useRenameRequest(id, renaming);
  const nameClicks = useSlowClickRename(renaming, selected);
  const fitted = useFittedLines();
  const held = useHeldJobs(agent.sessionId);
  const commands = useBoardCommands();
  // A ticket's chat speaks for a helper it holds that needs the user, as the helper has no tile: its state, who asks and
  // what, and its action, which answers the helper.
  const rolled = helpers === undefined ? undefined : ticketTileAsk(agent, helpers, shows);
  const asker = rolled?.dot === true ? rolled.asker : agent;
  const asked = glanceFace(asker, shows, asker === agent ? implementer : undefined);
  const face = asker === agent ? asked : { ...asked, line: rolled?.line ?? asked.line };
  const { status } = face;
  // Its times are re-read as each would read differently: once a minute, never by the second.
  const sinceNow = useNowForSince(agent.stateSince);
  const towardNow = useNowToward(agent.schedule?.enabled === true ? agent.schedule.nextRunAt : null);
  const times = calmTimes(agent, Math.max(sinceNow, towardNow), QUIET_TILE);
  const progress = tileProgress(agent, QUIET_TILE);
  const quick = quickAskOf(asker);
  const dialog = quick === undefined ? tileDialogOf(asker) : undefined;
  const sending = handoffs.sending.has(agent.sessionId) && status !== 'needs-you';
  const card = lastMessageCard(agent);
  const open = () => (clickOpens !== 'expand' ? openAgent(agent) : expand(id));
  const { startup } = agent;
  const drop = dropKey({ kind: 'agent', id: agent.sessionId });
  const parts: GlanceParts = {
    agent,
    face,
    status,
    look: { harness: agent.harness, ...(sending ? { pose: 'handing-off' } : lookShown(poseOfStatus(status, agent), agent)) },
    name: (
      <>
        {startup !== null && !startup.failed && <Spinner />}
        <EditableName className="hybrid-tile-name glance-tile-name" value={agent.name} title={agent.name} renaming={renaming} clicks={nameClicks} label="Agent name" />
        <FrostMark agent={agent} />
        <HandPlacedMark nodeId={id} />
      </>
    ),
    reviewer: <ReviewerMark agent={agent} implementer={implementer} />,
    menu: <TileMenu entries={menu.entries} onOpen={menu.reread} />,
    expand: () => expand(id),
    prompt:
      agent.undelivered.length > 0 ? (
        <UndeliveredRow fitted={fitted} items={agent.undelivered} onResend={() => resendUndelivered(agent.sessionId)} onClear={() => clearUndelivered(agent.sessionId)} />
      ) : agent.trustFolder !== null ? (
        <TrustRow fitted={fitted} folder={agent.trustFolder} onTrust={() => trustFolder(agent.sessionId)} />
      ) : agent.untypedPrompt !== null ? (
        <UntypedRow fitted={fitted} prompt={agent.untypedPrompt} onSend={() => typeFirstPrompt(agent.sessionId)} />
      ) : agent.unsent !== null ? (
        <UnsentRow fitted={fitted} what={agent.unsent} asked={agent.ask?.question} onSend={() => sendUnsent(agent.sessionId)} onClear={() => clearUnsent(agent.sessionId)} />
      ) : null,
    // Its ask opens from its chip, beside the tile, in the button's place.
    action:
      quick !== undefined ? (
        <TileQuickAsk sessionId={asker.sessionId} name={asker.name} ask={quick} />
      ) : dialog !== undefined ? (
        <TileDialogAsk sessionId={asker.sessionId} name={asker.name} prompt={dialog} onOpen={() => openAgent(asker)} />
      ) : face.action !== null ? (
        <CalmButton action={face.action} agent={asker} actions={tileActions} open={asker === agent ? open : () => openAgent(asker)} className="glance-tile-action" />
      ) : null,
    times,
    tags: <GlanceTags agent={agent} />,
    fitted,
    repo: repo !== undefined && (
      // Outside every zone of its repo, the tile says which repo it works in.
      <span className="glance-tile-repo" data-testid="tile-repo" title={`Works in ${agent.repoRoot}`}>
        {repo}
      </span>
    ),
    extras: (
      <>
        {crewFlags !== undefined && (
          <span
            className="glance-tile-crew-flags"
            data-testid="crew-flags"
            role="img"
            aria-label={`${crewFlags} crew flag${crewFlags === 1 ? '' : 's'}`}
            title="Crew members waiting for its answer: sending each a message clears its flag"
          >
            ⚑ {crewFlags}
          </span>
        )}
        {held[0] !== undefined && <JobTicket taken={held[0]} onOpen={commands.showItem} />}
        {held.length > 1 && (
          <span className="glance-tile-more" title={held.slice(1).map((taken) => `Its job from “${taken.queueTitle}”: ${taken.job.text}`).join('\n')}>
            +{held.length - 1}
          </span>
        )}
      </>
    ),
  };
  return (
    <HoverCard label={card?.label ?? 'Last message'} content={card?.text}>
      <div
        className={frostedClasses(`hybrid-tile hybrid-tile-agent glance-tile ${design}-tile`, agent)}
        data-testid="agent-tile"
        data-representation="hybrid"
        data-tile-design={design}
        data-corner="hover"
        data-harness={agent.harness}
        data-state={agent.state}
        data-status={status}
        data-glance={face.state}
        data-level={face.level}
        data-start={startup === null ? undefined : startup.failed ? 'failed' : 'starting'}
        data-session-id={agent.sessionId}
        data-zone={agent.zoneId ?? ''}
        data-tab-drop={drop}
        data-drop-over={dropOver === drop || undefined}
        data-job-drop={jobDrop || undefined}
        data-muted={agent.muted}
        data-seen={(agent.seen && waitsForYou(agent, shows)) || undefined}
        data-needs-you={needsYouNow(agent, shows) || rolled?.needsYouNow || undefined}
        data-ticket-tile={helpers === undefined ? undefined : ''}
        data-handoff={sending ? 'sending' : handoffs.receiving.has(agent.sessionId) ? 'receiving' : undefined}
        data-reviewer={agent.reviewOf !== null || undefined}
        data-orchestrator={crew !== undefined || undefined}
        data-master={agent.master || undefined}
        title={card !== undefined ? undefined : clickOpens !== 'expand' ? 'Double-click to open its session window' : 'Double-click to expand it here'}
        onDoubleClick={open}
      >
        {children(parts)}
        {crew !== undefined && (
          <span className="hybrid-tile-crew-count" data-testid="crew-count" title={`It started ${crew} agent${crew === 1 ? '' : 's'} on the board`}>
            {crew}
          </span>
        )}
        {progress !== undefined && (
          <span className="hybrid-tile-progress" data-testid="tile-progress" role="progressbar" aria-label="Its progress" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} style={{ '--progress': `${progress}%` } as CSSProperties} />
        )}
        <SubagentPerch harness={agent.harness} subagents={agent.subagents} />
        <TileRobot agent={agent} sending={sending} />
      </div>
    </HoverCard>
  );
}

function GlanceTags({ agent }: { agent: Agent }) {
  const { openLink, openPullRequest } = useContext(TileActionsContext);
  const { issue } = agent;
  const pr = agent.pullRequests.find((each) => each.state === 'open') ?? agent.pullRequests.at(-1);
  return (
    <>
      {issue !== null && (
        <Chip
          tone="accent"
          mono
          className="glance-tile-ticket nodrag"
          data-testid="tile-issue"
          title={`${issue.title}\nOpen ${issue.id} in ${TRACKER_PROVIDERS[issue.provider].name}`}
          onClick={() => openLink(issue.url)}
          onDoubleClick={stopPropagation}
        >
          {shortIssueId(issue)}
        </Chip>
      )}
      {pr !== undefined && <PullRequestChip pr={pr} open={() => openPullRequest(agent, pr)} />}
    </>
  );
}
