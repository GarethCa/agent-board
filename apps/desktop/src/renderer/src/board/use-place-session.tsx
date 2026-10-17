// Starting agents and shells where they are put: the Agent and Shell tools, a group's + agent,
// and the repo picker on a new agent's tile when no zone gives it a repo, from an issue card too.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Agent, CreateShellTileParams, IssueCardData, Shell, SpawnAgentParams, Zone, ZoneLayout } from '@agent-board/daemon/protocol';
import { HarnessMark } from './HarnessMark';
import { AGENT_TILE_SIZE, NEW_AGENT_SIZE } from '@agent-board/daemon/board-layout';
import { agentStartIn, dropPlace } from './place-session';
import { RepoPicker, type PickerStart, type RepoChoice } from './RepoPicker';
import { StatusPill } from '../ui';

/** Space between a zone's corner and a tile put in it with no place, px. */
const ZONE_INSET = 24;

/** A new agent waiting on the repo picker: its zone, its place there (or on the board), and where it is drawn. */
interface Pending {
  zoneId: string | null;
  /** Its place in its zone, or on the board; none lets the board slot it in. */
  position: { x: number; y: number } | undefined;
  /** Its top-left on the board, where its stand-in tile is drawn. */
  at: { x: number; y: number };
  /** The issue it starts from, and the zone whose tracker that is in. */
  issue?: { card: IssueCardData; zoneId: string };
}

export interface PlaceSessionOptions {
  zones(): Zone[];
  zoneLayouts(): (ZoneLayout & { id: string })[];
  onAgent(agent: Agent): void;
  onShell(shell: Shell): void;
  report(action: string): (error: unknown) => void;
}

export interface PlaceSession {
  /** Puts a new agent with its centre at board point `at`: started at once if its zone gives it a repo, else picked for. */
  placeAgent(at: { x: number; y: number }): void;
  /** Starts a new agent in `zone` from its + agent chip: at once with a default repo, else picked for. */
  newAgentIn(zone: Zone): void;
  /**
   * Picks a repo for an agent starting from `card`, an issue in `issueZoneId`'s tracker: its tile in `zone` (or loose,
   * undefined), centred on board point `at`.
   */
  pickForIssue(card: IssueCardData, issueZoneId: string, zone: Zone | undefined, at: { x: number; y: number }): void;
  /** Starts a shell with its centre at board point `at`, in the zone there or loose on the board. */
  placeShell(at: { x: number; y: number }): void;
  /** The repo picker and the tile it points at, while one is open: drawn in board coordinates. */
  picker: ReactNode;
  /** Whether an agent waits on the picker: its stand-in tile is on the board though it isn't a node yet. */
  placing: boolean;
}

export function usePlaceSession({ zones, zoneLayouts, onAgent, onShell, report }: PlaceSessionOptions): PlaceSession {
  const [pending, setPending] = useState<Pending>();
  /** The name the daemon will give the pending agent, once it says. */
  const [name, setName] = useState<string>();
  useEffect(() => {
    setName(undefined);
    if (pending === undefined || pending.issue !== undefined) return;
    let cancelled = false;
    window.agentBoard.agents.nextName().then((next) => cancelled || setName(next), report('name the agent'));
    return () => {
      cancelled = true;
    };
  }, [pending, report]);

  const spawn = useCallback(
    async (params: Omit<SpawnAgentParams, 'cols' | 'rows' | 'prompt'>): Promise<PickerStart> => {
      const result = await window.agentBoard.agents.spawn({ ...params, prompt: '', ...NEW_AGENT_SIZE });
      if (result.status === 'confirm') return result;
      onAgent(result.agent);
      return { status: 'started' };
    },
    [onAgent],
  );

  /** Starts the agent at once, or opens the picker on its stand-in tile, as its zone allows. */
  const begin = useCallback(
    (zone: Zone | undefined, position: { x: number; y: number } | undefined, at: { x: number; y: number }) => {
      const start = agentStartIn(zone);
      if (start.kind === 'refuse') return report('start an agent')(start.reason);
      const zoneId = zone?.id ?? null;
      if (start.kind === 'pick') return setPending({ zoneId, position, at });
      spawn({ zoneId, position }).then((result) => {
        // A Codex config warning can't come back without a harness choice: only the picker offers Codex.
        if (result.status === 'confirm') report('start an agent')(result.message);
      }, report('start an agent'));
    },
    [spawn, report],
  );

  /** Where a tile centred on board point `at` goes: in the zone there, relative to it, or loose; and where it is drawn. */
  const placeAt = useCallback(
    (at: { x: number; y: number }) => {
      const place = dropPlace(at, zoneLayouts());
      const zone = zones().find((each) => each.id === place.zoneId);
      const drawn = zone === undefined ? place : { x: zone.x + place.x, y: zone.y + place.y };
      return { zone, position: { x: place.x, y: place.y }, drawn };
    },
    [zones, zoneLayouts],
  );

  const placeAgent = useCallback(
    (at: { x: number; y: number }) => {
      const { zone, position, drawn } = placeAt(at);
      begin(zone, position, drawn);
    },
    [begin, placeAt],
  );

  const newAgentIn = useCallback(
    (zone: Zone) => begin(zone, undefined, { x: zone.x + ZONE_INSET, y: zone.y + ZONE_INSET * 2 }),
    [begin],
  );

  const pickForIssue = useCallback(
    (card: IssueCardData, issueZoneId: string, zone: Zone | undefined, at: { x: number; y: number }) => {
      const { position, drawn } = placeAt(at);
      // In a zone, the board slots it in clear of the card; loose, it goes where it is drawn.
      setPending({ zoneId: zone?.id ?? null, position: zone === undefined ? position : undefined, at: drawn, issue: { card, zoneId: issueZoneId } });
    },
    [placeAt],
  );

  const placeShell = useCallback(
    (at: { x: number; y: number }) => {
      const { zoneId, x, y } = dropPlace(at, zoneLayouts());
      const position = { x, y };
      // A loose shell needs its place; one in a zone may have it too.
      const params: CreateShellTileParams = zoneId === null ? { zoneId: null, position } : { zoneId, position };
      window.agentBoard.shells.create(params).then(onShell, report('start a shell'));
    },
    [zoneLayouts, onShell, report],
  );

  const picker =
    pending === undefined ? null : (
      <RepoPicker
        key={`${pending.at.x},${pending.at.y}`}
        agentName={name}
        issue={pending.issue?.card}
        anchor={pendingTile(pending, pending.issue === undefined ? name : pending.issue.card.id)}
        onStart={(choice: RepoChoice) =>
          spawn({
            zoneId: pending.zoneId,
            position: pending.position,
            // Named by the daemon as it offered; one started from an issue is named after it.
            name: pending.issue === undefined ? name : undefined,
            issueId: pending.issue?.card.id,
            issueZoneId: pending.issue?.zoneId,
            ...choice,
          }).then((result) => {
            if (result.status === 'started') setPending(undefined);
            return result;
          })
        }
        onCancel={() => setPending(undefined)}
      />
    );

  const placing = pending !== undefined;
  return useMemo(
    () => ({ placeAgent, newAgentIn, pickForIssue, placeShell, picker, placing }),
    [placeAgent, newAgentIn, pickForIssue, placeShell, picker, placing],
  );
}

/**
 * The stand-in tile of an agent waiting on the picker: its name (or issue) and that it needs a repo. A plain element,
 * not a component, so the picker can anchor to it by its ref.
 */
function pendingTile(pending: Pending, label: string | undefined) {
  return (
    <div
      className="pending-tile"
      data-testid="pending-tile"
      style={{ transform: `translate(${pending.at.x}px, ${pending.at.y}px)`, ...AGENT_TILE_SIZE }}
    >
      <div className="pending-tile-head">
        <HarnessMark harness="claude" />
        <span className="pending-tile-name">{label ?? 'new agent'}</span>
        <StatusPill state="thinking" label="needs a repo" />
      </div>
    </div>
  );
}
