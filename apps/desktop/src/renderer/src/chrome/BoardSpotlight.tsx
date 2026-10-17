import type { Ref } from 'react';
import type { Agent, Shell, Zone } from '@agent-board/daemon/protocol';
import { useBoardCommands, type TileRef } from '../board/commands';
import { shownWindow } from '../windows/session-windows';
import { useSessionWindows } from '../windows/SessionWindows';
import { rowKeyOf, Spotlight, windowTargetOf, type SpotlightHandle, type SpotlightPlace } from './Spotlight';
import type { SpotlightSubject } from './spotlight-results';

/**
 * Where ⌘K was pressed in the board's window: the board, the session window shown over it, or an expanded tile with the
 * focus, by its node id (`agent:<session id>` or `shell:<id>`, as a row's key) and its agent's session or shell's id.
 */
type BoardContext = { kind: 'board' } | { kind: 'window'; id: string } | { kind: 'expanded'; nodeId: string; id: string };

/** The tile a session row is about, or undefined for a zone. */
const tileOf = (subject: SpotlightSubject): TileRef | undefined =>
  subject.kind === 'agent' ? { kind: 'agent', id: subject.agent.sessionId } : subject.kind === 'shell' ? { kind: 'shell', id: subject.shell.id } : undefined;

/**
 * The board window's ⌘K switcher. On the board, ↵ flies to the tile, pulses and selects it, and ⌘↵ opens it. In
 * the session window shown on the board, ↵ switches it to the session, as ‹ › do; in an expanded tile with the focus,
 * the session picked expands in its place. A session popped out into an OS window of its own comes forward there. A
 * zone is brought into view, out of the session window or expanded tile.
 */
export function BoardSpotlight({ ref, agents, shells, zones }: { ref?: Ref<SpotlightHandle>; agents: readonly Agent[]; shells: readonly Shell[] | undefined; zones: readonly Zone[] }) {
  const sessionWindows = useSessionWindows();
  const board = useBoardCommands();

  const placeOf = (at: Element | null): SpotlightPlace<BoardContext> => {
    const shown = shownWindow(sessionWindows.windows);
    if (shown !== undefined) return { context: { kind: 'window', id: shown.id }, mode: 'switch', current: rowKeyOf(shown) };
    const expanded = at?.closest<HTMLElement>('.expanded-tile');
    const nodeId = expanded?.closest('.react-flow__node')?.getAttribute('data-id');
    const id = expanded?.dataset.sessionId ?? expanded?.dataset.shellId;
    if (nodeId == null || id === undefined) return { context: { kind: 'board' }, mode: 'show' };
    return { context: { kind: 'expanded', nodeId, id }, mode: 'switch', current: nodeId };
  };

  const onPick = (context: BoardContext, subject: SpotlightSubject, open: boolean): boolean => {
    if (subject.kind === 'zone') {
      const shown = board.showZone(subject.zone.id, context.kind === 'expanded' ? context.nodeId : undefined);
      if (shown && context.kind === 'window') sessionWindows.close(context.id);
      return shown;
    }
    const tile = tileOf(subject)!;
    if (context.kind === 'board') return open ? board.openTile(tile) : board.showTile(tile);
    // Out in an OS window of its own, it comes forward there, and the view here stays as it was: it can't show it.
    const target = windowTargetOf(subject)!;
    if (sessionWindows.windows.some((entry) => entry.id === target.id && entry.placement === 'popped')) {
      sessionWindows.show(target);
      return true;
    }
    if (context.kind === 'expanded') return board.switchExpanded(context.nodeId, tile);
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
      placeOf={placeOf}
      onPick={onPick}
      canStartAgent={board.canStartAgent()}
      onNewAgent={(context, name) => board.newAgentNamed(name, zoneOf(context))}
    />
  );
}
