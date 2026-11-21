import { useContext, useEffect, useRef } from 'react';
import type { Agent, Shell } from '@agent-board/daemon/protocol';
import { nameTarget, useRenameRequest } from '../board/rename';
import { tileHistory } from '../board/tile-shows';
import { TileActionsContext } from '../board/tile';
import { EditableName, RenameButton, useRenaming } from '../ui';

/**
 * The name in a session window's header (the maximised window, the pop-out and the expanded tile): the agent's or
 * shell's name, which a double-click or the pencil beside it turns into a field. A session that isn't one the app
 * started (an external one) just shows its name. Its tooltip carries the tile's history too (`tileHistory`), as the hover
 * card does on the board.
 */
export function SessionName({ agent, shell, name, title, nodeId, ask = 0 }: { agent?: Agent; shell?: Shell; name: string; title: string; nodeId?: string; ask?: number }) {
  const { rename } = useContext(TileActionsContext);
  const target = nameTarget({ agent, shell });
  const renaming = useRenaming(name, async (next) => {
    if (target !== undefined) await rename(target, next);
  });
  // Asked for by the board (F2, the menu) while the tile is open this way; an unplaced header never is.
  useRenameRequest(nodeId ?? '', renaming);
  // Asked for by a menu of the header's own (a pop-up's ⋯ → Rename), each time `ask` goes up.
  // Only a new ask starts it: the one seen is kept, so a header drawn again after a rename doesn't open the field.
  const askSeen = useRef(ask);
  useEffect(() => {
    if (ask === askSeen.current) return;
    askSeen.current = ask;
    renaming.startSoon();
    // `renaming` is rebuilt every render; only a new ask should start it.
  }, [ask]);
  const tip = agent === undefined ? title : [title, ...tileHistory(agent, Date.now())].join('\n');
  if (target === undefined) {
    return (
      <h2 className="session-window-name" title={tip}>
        {name}
      </h2>
    );
  }
  return (
    <>
      <EditableName as="h2" className="session-window-name" value={name} title={tip} renaming={renaming} label={shell ? 'Shell name' : 'Agent name'} />
      <RenameButton renaming={renaming} />
    </>
  );
}
