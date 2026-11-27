import { useContext, useEffect, useRef, useState } from 'react';
import { GitMerge, Play, Square } from 'lucide-react';
import type { Agent } from '@agent-board/daemon/protocol';
import { humanStatus } from '@agent-board/daemon/human-status';
import { keyText, pressed } from '../../keys/registry';
import { useNeedsYouShows } from '../../needs-you-setting';
import { Button, useToast } from '../../ui';
import { errorMessage } from '../../../../shared/errors';
import { wakeFromWindow } from '../../windows/pop-out-actions';
import { TileActionsContext } from '../tile';
import { nowActions } from './now-action';

/**
 * The header's buttons for what the agent is doing now (`nowActions`): Stop (⌘.) while it works, Wake while paused,
 * then a ticket's Merge once its pull request is ready (`onMerge`, which opens it to merge there).
 */
export function NowAction({ agent, placement, onMerge }: { agent: Agent; placement: 'board' | 'own-window'; onMerge?: (() => void) | undefined }) {
  const toast = useToast();
  // On the board, Wake is the board's own, as from the tile; in its own window, a busy shell asks with the board's confirm.
  const { resumeAgent } = useContext(TileActionsContext);
  const wake = placement === 'board' ? () => resumeAgent(agent.sessionId) : () => wakeFromWindow(window.agentBoard, agent.sessionId);
  const [busy, setBusy] = useState(false);
  const shows = useNeedsYouShows();
  const actions = nowActions(agent, { status: humanStatus(agent, shows).status, merge: onMerge !== undefined });
  const working = actions.includes('stop');
  const act = (what: string, call: () => Promise<unknown>) => {
    setBusy(true);
    call()
      .catch((failure: unknown) => toast.show({ tone: 'error', message: `Could not ${what}: ${errorMessage(failure)}` }))
      .finally(() => setBusy(false));
  };
  const stop = useRef(() => {});
  stop.current = () => act('stop its step', () => window.agentBoard.agents.interrupt(agent.sessionId));
  // ⌘. while it works, wherever the focus is in the window, before the terminal takes it.
  useEffect(() => {
    if (!working) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!pressed('window.stopStep', event)) return;
      event.preventDefault();
      event.stopPropagation();
      stop.current();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [working]);
  return actions.map((action) =>
    action === 'stop' ? (
      <Button key={action} size="sm" icon={<Square />} loading={busy} onClick={() => stop.current()} tooltip={`Stop what it is doing now; it keeps its conversation  ${keyText('window.stopStep')}`}>
        Stop
      </Button>
    ) : action === 'wake' ? (
      <Button key={action} size="sm" icon={<Play />} loading={busy} onClick={() => act('wake it', wake)} tooltip="Wake it: it picks up where it was paused">
        Wake
      </Button>
    ) : (
      <Button key={action} size="sm" variant="primary" icon={<GitMerge />} data-testid="agent-popup-merge" title="Open its pull request, to merge it there" onClick={onMerge}>
        Merge
      </Button>
    ),
  );
}
