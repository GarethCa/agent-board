import { useContext, useState, type CSSProperties } from 'react';
import { Expand } from 'lucide-react';
import { needsYouNow, waitsForYou, type Agent } from '@agent-board/daemon/protocol';
import { Button, EditableName, HoverCard, Spinner, useRenaming, useSlowClickRename } from '../ui';
import { useNeedsYouShows } from '../needs-you-setting';
import { dropKey, dropOver as dropOverValue } from '../session/shell-moves';
import { calmFace, technicalLine, type CalmAction } from './calm-tile';
import { ticketHead, ticketSaysDone, ticketStatus, ticketTileAsk, type TicketButton, type TicketTileAsk } from './ticket-tile';
import { OneButton as TicketOneButton } from './ticket-parts';
import { TileRobot } from './CommandFigure';
import { HandoffsContext } from './flow-edges';
import { JobTicket, useHeldJobs } from './items/taken-jobs';
import { useJobDropOver } from './items/queue-board';
import { useBoardCommands } from './commands';
import { HarnessMark } from './HarnessMark';
import { useAgentTileMenu } from './agent-tile-menu';
import { useTicketChatMenu } from './use-ticket-chat-menu';
import { useMenuBarSection } from '../keys/menu-bar-bridge';
import { useNowForSince, useNowToward } from '../inbox/use-now';
import { calmTimes, QUIET_TILE, tileProgress, type TileShows } from './tile-shows';
import { useRenameRequest } from './rename';
import { StatusMark } from './StatusMark';
import { lookShown } from '@agent-board/daemon/character';
import { poseOfStatus } from './tile-pose';
import { SubagentPerch } from './SubagentPerch';
import { ClickOpensContext, TileActionsContext, type TileActions, type TileData } from './tile';
import { agentTileTip, answerTicket, openAgentTile } from './click-opens';
import { lastMessageCard, nameClass, stopPropagation, TileButton, TileMenu, TrustRow, UndeliveredRow, UnsentRow, UntypedRow } from './tile-parts';
import { useFittedLines } from './use-fitted-lines';
import { quickAskOf, tileDialogOf } from './quick-ask';
import { TileQuickAsk } from './TileQuickAsk';
import { TileDialogAsk } from './DialogQuickAsk';
import { HandPlacedMark } from './HandPlacedMark';
import { FrostMark, FrostWatermark } from './FrostMark';
import { frostedClasses } from './paused';

type CalmTileProps = { id: string; selected: boolean; agent: Agent } & Pick<TileData, 'repo' | 'from' | 'crew' | 'crewFlags' | 'implementer' | 'helpers'>;

/**
 * An agent's tile under the Simplified design, a calm tile (docs/adr/0022-simplified-design.md): its name and, on hover,
 * Expand and ⋯, one grey line of what it is doing or asks, its status, and
 * one button only when there is something to do, filled only while it needs the user. Show technical details adds a
 * mono line of its AI, branch, pull requests and raw state under it. It keeps the Classic tile's root and its data, so
 * the board finds, drops onto and measures it as it does that one.
 */
export function CalmTile({ id, selected, agent, repo, from, crew, crewFlags, implementer, helpers }: CalmTileProps) {
  const shows = useNeedsYouShows();
  const tileActions = useContext(TileActionsContext);
  const { expand, rename, sendUnsent, clearUnsent, typeFirstPrompt, trustFolder, resendUndelivered, clearUndelivered } = tileActions;
  const clickOpens = useContext(ClickOpensContext);
  const dropOver = dropOverValue.use();
  const jobDrop = useJobDropOver() === agent.sessionId;
  const handoffs = useContext(HandoffsContext);
  const renaming = useRenaming(agent.name, (name) => rename({ kind: 'agent', sessionId: agent.sessionId }, name));
  const menu = useAgentTileMenu(id, agent, { from, implementer }, renaming.startSoon);
  // A ticket's chat: the ticket's own items lead its ⋯ menu, and Close ticket… ends it, the one place a ticket closes.
  const ticket = useTicketChatMenu(agent, helpers, [], menu.entries, ticketHead(agent).id ?? agent.name);
  useMenuBarSection('agent', selected, ticket.entries);
  useRenameRequest(id, renaming);
  const nameClicks = useSlowClickRename(renaming, selected);
  const fitted = useFittedLines();
  const held = useHeldJobs(agent.sessionId);
  const commands = useBoardCommands();
  // A ticket's chat speaks for a helper it holds that needs the user, as the helper has no tile: its status, who asks and
  // what, and its button and ask, which answer the helper.
  const rolled = helpers === undefined ? undefined : ticketTileAsk(agent, helpers, shows);
  const asker = rolled?.dot === true ? rolled.asker : agent;
  const face = calmFace(asker, shows, asker === agent ? implementer : undefined);
  // Or for the ticket itself, as Classic's tile does: Ready to merge with Merge, New review with Read, and a merged Done,
  // in place of the chat's own status, which never reads Needs you then.
  const own = rolled?.dot === false ? rolled : undefined;
  const status = own === undefined ? face.status : ticketStatus(own, face.status);
  // Classic's word only for those three, and no ask of the chat's then; news alone keeps Simplified's own words and the
  // chat's own ask.
  const saysDone = own !== undefined && ticketSaysDone(own);
  const action = saysDone ? null : face.action;
  const line = asker === agent && own === undefined ? face.line : (rolled?.line ?? face.line);
  const look: TileShows = QUIET_TILE;
  // Its times are re-read as each would read differently: once a minute, never by the second.
  const sinceNow = useNowForSince(agent.stateSince);
  const towardNow = useNowToward(look.wakeInWords && agent.schedule?.enabled === true ? agent.schedule.nextRunAt : null);
  const times = calmTimes(agent, Math.max(sinceNow, towardNow), look);
  const progress = tileProgress(agent, look);
  const quick = quickAskOf(asker);
  // Claude's own question dialog, answered from the same chip.
  const dialog = quick === undefined ? tileDialogOf(asker) : undefined;
  const sending = handoffs.sending.has(agent.sessionId) && status !== 'needs-you';
  const card = lastMessageCard(agent);
  const open = () => openAgentTile(clickOpens, tileActions, id, agent);
  const { startup } = agent;
  const drop = dropKey({ kind: 'agent', id: agent.sessionId });
  return (
    <HoverCard label={card?.label ?? 'Last message'} content={card?.text}>
      <div
        className={frostedClasses('hybrid-tile hybrid-tile-agent calm-tile', agent, shows)}
        data-testid="agent-tile"
        data-representation="hybrid"
        data-corner="hover"
        data-harness={agent.harness}
        data-state={agent.state}
        data-status={status}
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
        title={card !== undefined ? undefined : agentTileTip(clickOpens)}
        onDoubleClick={open}
      >
        <FrostWatermark agent={agent} />
        <div className="hybrid-tile-head calm-tile-head">
          {startup !== null && !startup.failed && <Spinner />}
          <EditableName className={nameClass(agent.name)} value={agent.name} title={agent.name} renaming={renaming} clicks={nameClicks} label="Agent name" />
          <FrostMark agent={agent} />
          <HandPlacedMark nodeId={id} />
          {/* The same corner on every tile: Expand and ⋯, which holds the rest (Pop out, Fold, Rename, Stop and the like). */}
          <span className="calm-tile-controls" data-testid="tile-controls">
            <TileButton icon={<Expand />} aria-label="Expand" title="Expand it here, with its terminal" onClick={() => expand(id)} />
            <TileMenu entries={ticket.entries} onOpen={menu.reread} />
            {ticket.watches}
          </span>
        </div>
        {crew !== undefined && (
          <span className="hybrid-tile-crew-count" data-testid="crew-count" title={`It started ${crew} agent${crew === 1 ? '' : 's'} on the board`}>
            {crew}
          </span>
        )}
        {/* What waits on the user's click to reach the agent comes first, with its own buttons, in the line's place. */}
        {agent.undelivered.length > 0 ? (
          <UndeliveredRow fitted={fitted} items={agent.undelivered} onResend={() => resendUndelivered(agent.sessionId)} onClear={() => clearUndelivered(agent.sessionId)} />
        ) : agent.trustFolder !== null ? (
          <TrustRow fitted={fitted} folder={agent.trustFolder} onTrust={() => trustFolder(agent.sessionId)} />
        ) : agent.untypedPrompt !== null ? (
          <UntypedRow fitted={fitted} prompt={agent.untypedPrompt} onSend={() => typeFirstPrompt(agent.sessionId)} />
        ) : agent.unsent !== null ? (
          <UnsentRow fitted={fitted} what={agent.unsent} asked={agent.ask?.question} onSend={() => sendUnsent(agent.sessionId)} onClear={() => clearUnsent(agent.sessionId)} />
        ) : (
          (line !== null || times !== undefined) && (
            <span className="calm-tile-line" data-testid="tile-line" title={line ?? undefined}>
              {/* Its times lead, so the line's two-line cut never takes them. */}
              {times !== undefined && (
                <span className="calm-tile-times" data-testid="tile-times">
                  {times}
                  {line !== null && ' · '}
                </span>
              )}
              {line}
            </span>
          )
        )}
        <span className="calm-tile-foot">
          <StatusMark
            status={status}
            word={saysDone ? own.word : status === face.status ? face.word : undefined}
            ask={askColour(own)}
            character={{ harness: agent.harness, ...(sending ? { pose: 'handing-off' } : lookShown(poseOfStatus(status, agent), agent)) }}
          />
          {repo !== undefined && (
            // Outside every zone of its repo, the tile says which repo it works in.
            <span className="calm-tile-repo" data-testid="tile-repo" title={`Works in ${agent.repoRoot}`}>
              {repo}
            </span>
          )}
          {crewFlags !== undefined && (
            <span
              className="calm-tile-crew-flags"
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
            <span className="calm-tile-more" title={held.slice(1).map((taken) => `Its job from “${taken.queueTitle}”: ${taken.job.text}`).join('\n')}>
              +{held.length - 1}
            </span>
          )}
          {/* Its ask opens from its chip, beside the tile, in the button's place. */}
          {quick !== undefined ? (
            <TileQuickAsk sessionId={asker.sessionId} name={asker.name} ask={quick} />
          ) : dialog !== undefined ? (
            <TileDialogAsk sessionId={asker.sessionId} name={asker.name} prompt={dialog} onOpen={() => answerTicket(clickOpens, tileActions, agent, asker)} />
          ) : action !== null ? (
            // The chat's own ask (its Answer) comes before the ticket's button, which shows while the chat asks nothing.
            <CalmButton action={action} agent={asker} actions={tileActions} open={asker === agent ? open : () => answerTicket(clickOpens, tileActions, agent, asker)} />
          ) : (
            own?.button !== undefined && <TicketAskButton chat={agent} own={own} button={own.button} actions={tileActions} className="calm-tile-action" />
          )}
        </span>
        <span className="calm-tile-technical" data-testid="tile-technical" data-technical-detail="">
          <HarnessMark harness={agent.harness} />
          <span className="calm-tile-technical-text">{technicalLine(agent)}</span>
        </span>
        {progress !== undefined && (
          <span className="hybrid-tile-progress" data-testid="tile-progress" role="progressbar" aria-label="Its progress" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} style={{ '--progress': `${progress}%` } as CSSProperties} />
        )}
        <SubagentPerch harness={agent.harness} subagents={agent.subagents} />
        <TileRobot agent={agent} sending={sending} />
      </div>
    </HoverCard>
  );
}

/** Which of a ticket's own asks stand up in their own colour: green to merge, blue for a new review. A glance tile reads it too. */
export function askColour(own: TicketTileAsk | undefined): 'merge' | 'new' | undefined {
  return own?.wordKind === 'merge' || own?.wordKind === 'new' ? own.wordKind : undefined;
}

/**
 * A ticket's own one button on a Simplified, Porthole or Shelf tile, as Classic's: Merge opens its pull request, Read marks
 * its watches' news read, Wake wakes its chat. A glance tile draws it too.
 */
export function TicketAskButton({ chat, own, button, actions, className }: { chat: Agent; own: TicketTileAsk; button: TicketButton; actions: TileActions; className: string }) {
  const clickOpens = useContext(ClickOpensContext);
  return (
    <TicketOneButton
      button={button}
      className={className}
      onOpen={() => answerTicket(clickOpens, actions, chat, own.asker)}
      onMerge={() => own.pullRequest !== undefined && actions.openPullRequest(own.pullRequest.owner, own.pullRequest.pr)}
      onWake={() => actions.resumeAgent(own.asker.sessionId)}
      onRead={() => actions.readWatches(own.asker.sessionId)}
    />
  );
}

/** The calm tile's one button, doing what its kind says; disabled while what it started is under way. A glance tile draws it too. */
export function CalmButton({ action, agent, actions, open, className = 'calm-tile-action' }: { action: CalmAction; agent: Agent; actions: TileActions; open(): void; className?: string }) {
  const [pending, setPending] = useState(false);
  const run = (act: () => Promise<void>) => {
    setPending(true);
    void act().finally(() => setPending(false));
  };
  const press = () => {
    switch (action.kind) {
      case 'open':
        return open();
      case 'plan':
        return actions.openPlan(agent);
      case 'pull-request': {
        const pr = agent.pullRequests.find((each) => each.state === 'open');
        return pr === undefined ? open() : actions.openPullRequest(agent, pr);
      }
      case 'retry':
        return actions.retryAgentStart(agent.sessionId);
      case 'wake':
        return run(() => actions.wakeAgent(agent));
      case 'credits':
        return run(() => actions.continueOnCredits(agent.sessionId));
    }
  };
  return (
    <Button
      size="xs"
      variant={action.prominent ? 'primary' : 'secondary'}
      className={`${className} nodrag`}
      data-testid="tile-action"
      data-prominent={action.prominent || undefined}
      data-on-hover={action.onHover}
      disabled={pending}
      onClick={press}
      onDoubleClick={stopPropagation}
    >
      {action.label}
    </Button>
  );
}
