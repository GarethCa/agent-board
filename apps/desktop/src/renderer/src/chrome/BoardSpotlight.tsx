import type { Ref } from 'react';
import type { Agent, Shell, Zone } from '@agent-board/daemon/protocol';
import { useBoardCommands, type TileRef } from '../board/commands';
import { shownWindow } from '../windows/session-windows';
import { useSessionWindows } from '../windows/SessionWindows';
import { requestTab } from '../session/tab-request';
import { rowKeyOf, Spotlight, surfaceOfSubject, windowTargetOf, type SpotlightHandle, type SpotlightPlace } from './Spotlight';
import type { BoardSubject } from './spotlight-results';
import { useTicketItems } from './ticket-items';

import { boardPlace, expandedPlace, popUpPick, popUpPlace, tabHostOf, type BoardContext } from './board-spotlight';

/** The tile a session row is about, or undefined for a zone. */
const tileOf = (subject: BoardSubject): TileRef | undefined =>
  subject.kind === 'agent' ? { kind: 'agent', id: subject.agent.sessionId } : subject.kind === 'shell' ? { kind: 'shell', id: subject.shell.id } : undefined;

/**
 * The board window's ⌘K switcher. On the board, or in an expanded tile with the focus, ↵ flies to the tile, pulses and
 * selects it, and ⌘↵ opens it (on the board ⇧↵ too); the expanded tile stays expanded. In the session window shown on
 * the board, ↵ switches it to the session, as ‹ › do; in the pop-up, the agent picked pops up in its place. A session
 * popped out into an OS window of its own comes forward there. A zone, or an item on a ticket's board, is brought into
 * view, out of the session window. A pull request or page opens as a tab of the session window or expanded tile, or
 * from the board in its agent's window, else a window of its own; ⇧↵ opens a session, pull request or page beside the
 * session in view, in a pane of its own.
 */
export function BoardSpotlight({ ref, agents, shells, zones }: { ref?: Ref<SpotlightHandle>; agents: readonly Agent[]; shells: readonly Shell[] | undefined; zones: readonly Zone[] }) {
  const sessionWindows = useSessionWindows();
  const board = useBoardCommands();
  const ticketItems = useTicketItems(agents);

  const placeOf = (at: Element | null): SpotlightPlace<BoardContext> => {
    const popUp = at?.closest<HTMLElement>('[data-testid="agent-popup"]')?.dataset.sessionId;
    if (popUp !== undefined) return popUpPlace(popUp);
    const shown = shownWindow(sessionWindows.windows);
    if (shown !== undefined) return { context: { kind: 'window', id: shown.id }, mode: 'switch', current: rowKeyOf(shown) };
    const expanded = at?.closest<HTMLElement>('.expanded-tile');
    const nodeId = expanded?.closest('.react-flow__node')?.getAttribute('data-id');
    const id = expanded?.dataset.sessionId ?? expanded?.dataset.shellId;
    // On the board, ⇧↵ has a session to open beside only with an agent selected, or for a reviewer or a pull request an agent opened.
    if (nodeId == null || id === undefined) return boardPlace(board.opensBeside);
    return expandedPlace(nodeId, id);
  };

  const onPick = (context: BoardContext, subject: BoardSubject, open: boolean, windowed: boolean, beside: boolean): boolean => {
    if (context.kind === 'popup') {
      const agent = popUpPick(subject, windowed);
      if (agent !== undefined && board.popUpIn({ kind: 'agent', id: agent })) return true;
      // What the pop-up can't show opens as ⌘↵ opens it from the board, the pop-up closed: a shell, a zone, a pull
      // request, a row of the Windows group, an agent kept pinned on the board.
      board.closePopUp();
      return onPick({ kind: 'board' }, subject, true, windowed, false);
    }
    if (subject.kind === 'zone') {
      const shown = board.showZone(subject.zone.id);
      if (shown && context.kind === 'window') sessionWindows.close(context.id);
      return shown;
    }
    // An item on a ticket's board: the board shows it there, out of the session window.
    if (subject.kind === 'item') {
      board.showTicketItem(subject.ticket, subject.item.id);
      if (context.kind === 'window') sessionWindows.close(context.id);
      return true;
    }
    const surface = surfaceOfSubject(subject);
    if (surface !== undefined && (beside || subject.kind === 'pr' || subject.kind === 'web' || subject.kind === 'document')) {
      const host = tabHostOf(context);
      if (host !== undefined) {
        requestTab(host, surface, { beside });
        return true;
      }
      // A session with nothing selected to be beside opens as ↵ opens it.
      if (board.openSurface(surface, beside)) return true;
    }
    const tile = tileOf(subject)!;
    // A row of the Windows group brings its window back, minimised or not, wherever ⌘K was pressed, and flies the board
    // to its tile behind it. ⌘↵ asks for what ↵ does: the window is the open form already.
    if (windowed) {
      board.showTile(tile);
      sessionWindows.show(windowTargetOf(subject)!);
      return true;
    }
    // Off a session window, as on the board: the tile ⌘K was pressed in, expanded, stays as it is.
    if (context.kind !== 'window') return open ? board.openTile(tile) : board.showTile(tile, { focus: true });
    // Out in an OS window of its own, it comes forward there, and the view here stays as it was: it can't show it.
    const target = windowTargetOf(subject)!;
    if (sessionWindows.windows.some((entry) => entry.id === target.id && entry.placement === 'popped')) {
      sessionWindows.show(target);
      return true;
    }
    sessionWindows.switchTo(context.id, target);
    return true;
  };

  /** The zone of the session the view in focus shows, for a new agent named from there. */
  const zoneOf = (context: BoardContext): string | null => {
    if (context.kind === 'board') return null;
    const { id } = context;
    return agents.find((agent) => agent.sessionId === id)?.zoneId ?? shells?.find((shell) => shell.id === id)?.zoneId ?? null;
  };

  return (
    <Spotlight
      ref={ref}
      agents={agents}
      shells={shells}
      zones={zones}
      windows={sessionWindows.windows}
      ticketItems={ticketItems}
      placeOf={placeOf}
      onPick={onPick}
      canStartAgent={board.canStartAgent()}
      onNewAgent={(context, name) => board.newAgentNamed(name, zoneOf(context))}
      onCrew={(context, prefab, describe) => board.startCrew(prefab, zoneOf(context), describe)}
    />
  );
}
