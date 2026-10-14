import { useContext } from 'react';
import type { Agent, Shell } from '@agent-board/daemon/protocol';
import { nameTarget, useRenameRequest } from '../board/rename';
import { TileActionsContext } from '../board/tile';
import { EditableName, RenameButton, useRenaming } from '../ui';

/**
 * The name in a session window's header (the maximised window, the pop-out and the expanded tile): the agent's or
 * shell's name, which a double-click or the pencil beside it turns into a field. A session that isn't one the app
 * started (an external one) just shows its name.
 */
export function SessionName({ agent, shell, name, title, nodeId }: { agent?: Agent; shell?: Shell; name: string; title: string; nodeId?: string }) {
  const { rename } = useContext(TileActionsContext);
  const target = nameTarget({ agent, shell });
  const renaming = useRenaming(name, async (next) => {
    if (target !== undefined) await rename(target, next);
  });
  // Asked for by the board (F2, the menu) while the tile is open this way; an unplaced header never is.
  useRenameRequest(nodeId ?? '', renaming);
  if (target === undefined) {
    return (
      <h2 className="session-window-name" title={title}>
        {name}
      </h2>
    );
  }
  return (
    <>
      <EditableName as="h2" className="session-window-name" value={name} title={title} renaming={renaming} label={shell ? 'Shell name' : 'Agent name'} />
      <RenameButton renaming={renaming} />
    </>
  );
}
