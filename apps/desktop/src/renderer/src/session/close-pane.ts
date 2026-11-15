import { neighbourOf } from '@agent-board/daemon/pane-layout';
import type { Shell } from '@agent-board/daemon/protocol';
import { errorMessage } from '../../../shared/errors';

/** Closes `pane` of `shell`, ending its shell, then gives the focus to the pane beside it, if one is left. */
export async function closePane(shell: Shell, pane: string, onFocusPane?: (sessionId: string) => void): Promise<void> {
  const neighbour = neighbourOf(shell.layout, pane);
  await window.agentBoard.shells.closePane(shell.id, pane).catch((failure: unknown) => {
    throw new Error(`could not close the pane: ${errorMessage(failure)}`);
  });
  if (neighbour !== undefined) onFocusPane?.(neighbour);
}
