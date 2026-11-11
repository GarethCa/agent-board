import { createContext, memo, useContext, useState } from 'react';
import { NodeToolbar, Position, type NodeProps } from '@xyflow/react';
import { CircleStop, Trash2 } from 'lucide-react';
import type { Agent, BoardItem, PullRequest } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../../shared/errors';
import { IconButton, Kbd } from '../../ui';
import { keyText } from '../../keys/registry';
import { useNeedsYouShows } from '../../needs-you-setting';
import { useTechnicalDetails } from '../../technical';
import { ItemActionsContext, useOnlySelected, type ItemNodeType } from './items';
import { CrewCardView } from './CrewCard';
import { crewCardData, crewCardModel, type CrewAction } from './crew-card';

/** What a crew card reads of the board around it: its agents as they are now, and how to open what it points at. */
export interface CrewCardBoard {
  agents: readonly Agent[];
  openAgent(sessionId: string): void;
  openPullRequest(sessionId: string, pr: PullRequest): void;
  /** Asks the user whether to stop the card's crew, and stops it on their yes. */
  stop(card: BoardItem): void;
}

export const CrewCardBoardContext = createContext<CrewCardBoard>({ agents: [], openAgent: () => {}, openPullRequest: () => {}, stop: () => {} });

/**
 * A running crew's card on the board (`CrewCardView`), drawn from what the daemon wrote of its crew and the agents as
 * they are now. Its buttons are the user's own steps: opening an agent or a pull request, asking the
 * daemon for one more round, and stopping the crew, each checked and logged there. Taking a running crew's card off
 * the board asks to stop the crew first, as the daemon keeps a running crew's card.
 */
export const CrewCardNode = memo(function CrewCardNode({ data, selected: picked, dragging }: NodeProps<ItemNodeType>) {
  const selected = useOnlySelected(picked);
  const { remove } = useContext(ItemActionsContext);
  const board = useContext(CrewCardBoardContext);
  const shows = useNeedsYouShows();
  const { item } = data;
  const card = crewCardData(item.data);
  // Under Simplified an agent is read by its status; its raw state belongs to Show technical details.
  const technical = useTechnicalDetails();
  const model = crewCardModel(card, board.agents, shows, !technical);
  const [busy, setBusy] = useState<CrewAction['id']>();
  const [error, setError] = useState<string>();
  const running = card.crew.stopped === null;
  const takes = running ? 'Stop crew and take its card off the board' : 'Take it off the board';

  const act = (action: CrewAction) => {
    setError(undefined);
    if (action.id === 'pull-request') return openPullRequest();
    if (action.id === 'agent' && action.sessionId !== undefined) return board.openAgent(action.sessionId);
    if (action.id !== 'round') return;
    setBusy('round');
    // The daemon checks it and says why not; its card follows the crew once it has.
    window.agentBoard.orchestrators.crewRound(card.crewId).then(
      () => setBusy(undefined),
      (failure: unknown) => {
        setBusy(undefined);
        setError(errorMessage(failure));
      },
    );
  };
  const openPullRequest = () => {
    if (model.pullRequest !== undefined) board.openPullRequest(model.pullRequest.sessionId, model.pullRequest.pr);
  };

  return (
    <CrewCardView title={card.title} icon={card.icon} model={model} busy={busy} error={error} onAction={act} onOpenAgent={board.openAgent} onOpenPullRequest={openPullRequest}>
      <NodeToolbar isVisible={selected && !dragging} position={Position.Top} className="sticky-toolbar">
        {running && <IconButton icon={<CircleStop />} size="sm" aria-label="Stop crew" tooltip="Stop crew: nothing more is handed on, and its agents stay" onClick={() => board.stop(item)} />}
        <IconButton
          icon={<Trash2 />}
          size="sm"
          aria-label={takes}
          tooltip={
            <>
              {takes}
              <Kbd>{keyText('edit.delete')}</Kbd>
            </>
          }
          onClick={() => remove(item.id)}
        />
      </NodeToolbar>
    </CrewCardView>
  );
});
