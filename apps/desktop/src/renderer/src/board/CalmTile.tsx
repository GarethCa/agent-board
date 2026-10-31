import { useContext, useState } from 'react';
import { Expand, FoldVertical, SquareArrowOutUpRight, X } from 'lucide-react';
import { isClosed } from '@agent-board/daemon/board-layout';
import { needsYouNow, waitsForYou, type Agent } from '@agent-board/daemon/protocol';
import { Button, EditableName, HoverCard, RenameButton, Spinner, useRenaming, useSlowClickRename } from '../ui';
import { useGateRun } from '../gate/GatesProvider';
import { useNeedsYouShows } from '../needs-you-setting';
import { useReviews } from '../review/ReviewsProvider';
import { roundsOf } from '../review/reviews';
import { dropKey, dropOver as dropOverValue } from '../session/shell-moves';
import { calmFace, technicalLine, type CalmAction } from './calm-tile';
import { Character } from './Character';
import { CommandFigure } from './CommandFigure';
import { lightCrew } from './crew-view';
import { HandoffsContext } from './flow-edges';
import { HarnessMark } from './HarnessMark';
import { agentMenu } from './menu-model';
import { useRenameRequest } from './rename';
import { StatusMark } from './StatusMark';
import { SubagentPerch } from './SubagentPerch';
import { ClickOpensContext, TileActionsContext, type TileActions, type TileData } from './tile';
import { lastMessageCard, nameClass, stopPropagation, TileButton, TileMenu, TrustRow, UndeliveredRow, UnsentRow, UntypedRow } from './tile-parts';
import { useFittedLines } from './use-fitted-lines';

type CalmTileProps = { id: string; selected: boolean; agent: Agent } & Pick<TileData, 'repo' | 'from' | 'crew' | 'crewFlags' | 'implementer'>;

/**
 * An agent's tile under the Simplified design, a calm tile (docs/adr/0022-simplified-design.md): its name and its window
 * controls (Fold, Expand, Pop out, ⋯ and Close, always shown), one grey line of what it is doing or asks, its status, and
 * one button only when there is something to do, filled only while it needs the user. Show technical details adds a
 * mono line of its AI, branch, pull requests and raw state under it. It keeps the Classic tile's root and its data, so
 * the board finds, drops onto and measures it as it does that one.
 */
export function CalmTile({ id, selected, agent, repo, from, crew, crewFlags, implementer }: CalmTileProps) {
  const shows = useNeedsYouShows();
  const tileActions = useContext(TileActionsContext);
  const { expand, openAgent, popOutAgent, setFolded, stopAgent, rename, sendUnsent, clearUnsent, typeFirstPrompt, trustFolder, resendUndelivered, clearUndelivered } = tileActions;
  const clickOpens = useContext(ClickOpensContext);
  const gate = useGateRun(agent.sessionId);
  const rounds = roundsOf(useReviews(), agent.sessionId);
  const dropOver = dropOverValue.use();
  const handoffs = useContext(HandoffsContext);
  const renaming = useRenaming(agent.name, (name) => rename({ kind: 'agent', sessionId: agent.sessionId }, name));
  useRenameRequest(id, renaming);
  const nameClicks = useSlowClickRename(renaming, selected);
  const fitted = useFittedLines();
  const face = calmFace(agent, shows, implementer);
  const sending = handoffs.sending.has(agent.sessionId) && face.status !== 'needs-you';
  const card = lastMessageCard(agent);
  const open = () => (clickOpens === 'window' ? openAgent(agent) : expand(id));
  const closed = isClosed(agent);
  const { startup } = agent;
  const drop = dropKey({ kind: 'agent', id: agent.sessionId });
  return (
    <HoverCard label={card?.label ?? 'Last message'} content={card?.text}>
      <div
        className="hybrid-tile hybrid-tile-agent calm-tile"
        data-testid="agent-tile"
        data-representation="hybrid"
        data-harness={agent.harness}
        data-state={agent.state}
        data-status={face.status}
        data-start={startup === null ? undefined : startup.failed ? 'failed' : 'starting'}
        data-session-id={agent.sessionId}
        data-zone={agent.zoneId ?? ''}
        data-tab-drop={drop}
        data-drop-over={dropOver === drop || undefined}
        data-muted={agent.muted}
        data-seen={(agent.seen && waitsForYou(agent, shows)) || undefined}
        data-needs-you={needsYouNow(agent, shows) || undefined}
        data-handoff={sending ? 'sending' : handoffs.receiving.has(agent.sessionId) ? 'receiving' : undefined}
        data-reviewer={agent.reviewOf !== null || undefined}
        data-orchestrator={crew !== undefined || undefined}
        data-master={agent.master || undefined}
        data-crew={crew === undefined ? from?.sessionId : agent.sessionId}
        onMouseEnter={crew === undefined ? undefined : () => lightCrew(agent.sessionId)}
        onMouseLeave={crew === undefined ? undefined : () => lightCrew(undefined)}
        title={card !== undefined ? undefined : clickOpens === 'window' ? 'Double-click to open its session window' : 'Double-click to expand it here'}
        onDoubleClick={open}
      >
        <div className="hybrid-tile-head calm-tile-head">
          {startup !== null && !startup.failed && <Spinner />}
          <EditableName className={nameClass(agent.name)} value={agent.name} title={agent.name} renaming={renaming} clicks={nameClicks} label="Agent name" />
          <RenameButton renaming={renaming} />
          <span className="calm-tile-controls" data-testid="tile-controls">
            <TileButton
              icon={<FoldVertical />}
              aria-label="Fold to a chip"
              title={closed ? 'Collapse it to a chip' : 'Collapse: only a closed agent folds to a chip'}
              disabled={!closed}
              onClick={() => setFolded(id, true)}
            />
            <TileButton icon={<Expand />} aria-label="Expand" title="Expand it here, with its terminal" onClick={() => expand(id)} />
            <TileButton icon={<SquareArrowOutUpRight />} aria-label="Pop out" title="Open its session in its own window" onClick={() => popOutAgent(agent)} />
            <TileMenu entries={agentMenu({ nodeId: id, agent, clickOpens, gate, rounds, rename: renaming.startSoon, actions: tileActions })} />
            {/* Close never deletes: live, it stops (asking first); closed, it folds to its chip. A paused agent, one a
                restart stopped and one whose pane is a live shell are woken, resumed or restarted, so it is disabled. */}
            <TileButton
              icon={<X />}
              aria-label="Close agent"
              title={agent.endedAt === null ? 'Close: stop it, asking first' : closed ? 'Close: fold it to its chip' : 'Close: it isn’t running; Delete agent is in ⋯'}
              disabled={agent.endedAt !== null && !closed}
              onClick={() => (agent.endedAt === null ? stopAgent(agent.sessionId) : setFolded(id, true))}
            />
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
          face.line !== null && (
            <span className="calm-tile-line" data-testid="tile-line" title={face.line}>
              {face.line}
            </span>
          )
        )}
        <span className="calm-tile-foot">
          <StatusMark status={face.status} />
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
          {face.action !== null && <CalmButton action={face.action} agent={agent} actions={tileActions} open={open} />}
        </span>
        <span className="calm-tile-technical" data-testid="tile-technical" data-technical-detail="">
          <HarnessMark harness={agent.harness} />
          <span className="calm-tile-technical-text">{technicalLine(agent)}</span>
        </span>
        <SubagentPerch harness={agent.harness} subagents={agent.subagents} />
        {sending ? (
          <span className="hybrid-tile-handoff">
            <Character harness={agent.harness} pose="handing-off" label={agent.name} />
          </span>
        ) : (
          <CommandFigure agent={agent} />
        )}
      </div>
    </HoverCard>
  );
}

/** The calm tile's one button, doing what its kind says; disabled while what it started is under way. */
function CalmButton({ action, agent, actions, open }: { action: CalmAction; agent: Agent; actions: TileActions; open(): void }) {
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
      case 'resume':
      case 'wake':
        return run(() => actions.resumeAgent(agent.sessionId));
      case 'credits':
        return run(() => actions.continueOnCredits(agent.sessionId));
    }
  };
  return (
    <Button
      size="xs"
      variant={action.prominent ? 'primary' : 'secondary'}
      className="calm-tile-action nodrag"
      data-testid="tile-action"
      data-prominent={action.prominent || undefined}
      disabled={pending}
      onClick={press}
      onDoubleClick={stopPropagation}
    >
      {action.label}
    </Button>
  );
}
