// Starting agents and shells where they are put: the Agent and Shell tools. An agent starts at once in a repo
// zone; anywhere else (a group, or bare board) the New agent dialog asks, with its Repo field.
import { useCallback, useMemo } from 'react';
import type { CreateShellTileParams, Shell, Zone, ZoneLayout } from '@agent-board/daemon/protocol';
import { NEW_AGENT_SIZE } from '@agent-board/daemon/board-layout';
import { agentStartIn, dropPlace, inFreeDrop } from './place-session';

export interface PlaceSessionOptions {
  zones(): Zone[];
  zoneLayouts(): (ZoneLayout & { id: string })[];
  onShell(shell: Shell): void;
  /** Opens the New agent dialog for a tile dropped at `position`, in `zone` (a group) or loose on the board (undefined). */
  onDialog(zone: Zone | undefined, position: { x: number; y: number }): void;
  report(action: string): (error: unknown) => void;
}

export interface PlaceSession {
  /**
   * Puts a new agent with its centre at board point `at`: started at once in a repo zone, else asked for in the New agent
   * dialog.
   */
  placeAgent(at: { x: number; y: number }): void;
  /** Starts a shell with its centre at board point `at`, in the zone there or loose on the board. */
  placeShell(at: { x: number; y: number }): void;
}

export function usePlaceSession({ zones, zoneLayouts, onShell, onDialog, report }: PlaceSessionOptions): PlaceSession {
  /** Where a tile centred on board point `at` goes: in the zone there, relative to it, or loose. */
  const placeAt = useCallback(
    (at: { x: number; y: number }) => {
      const place = dropPlace(at, zoneLayouts());
      const zone = zones().find((each) => each.id === place.zoneId);
      return { zone, position: { x: place.x, y: place.y } };
    },
    [zones, zoneLayouts],
  );

  const placeAgent = useCallback(
    (at: { x: number; y: number }) => {
      const { zone, position } = placeAt(at);
      const start = agentStartIn(zone);
      if (start.kind === 'refuse') return report('start an agent')(start.reason);
      if (start.kind === 'dialog') return onDialog(zone, position);
      // Its tile is on the board once this answers: what fails after that stays on the tile.
      const started = window.agentBoard.agents.start({ zoneId: zone!.id, position, prompt: '', ...NEW_AGENT_SIZE });
      // Put in a zone's free area, it is the user's own place for it: marked free, so its layout leaves it there.
      const free = inFreeDrop(zone, position);
      started.then((sessionId) => (free ? window.agentBoard.agents.move(sessionId, { zoneId: zone!.id, ...position, byHand: true }) : undefined)).catch(report('start an agent'));
    },
    [placeAt, onDialog, report],
  );

  const placeShell = useCallback(
    (at: { x: number; y: number }) => {
      const { zoneId, x, y } = dropPlace(at, zoneLayouts());
      const position = { x, y };
      // A loose shell needs its place; one in a zone may have it too.
      const params: CreateShellTileParams = zoneId === null ? { zoneId: null, position } : { zoneId, position };
      const free = inFreeDrop(zones().find((zone) => zone.id === zoneId), position);
      window.agentBoard.shells
        .create(params)
        .then((shell) => {
          if (free) window.agentBoard.shells.move(shell.id, { zoneId, ...position, byHand: true }).catch(report('start a shell'));
          onShell(shell);
        }, report('start a shell'));
    },
    [zones, zoneLayouts, onShell, report],
  );

  return useMemo(() => ({ placeAgent, placeShell }), [placeAgent, placeShell]);
}
