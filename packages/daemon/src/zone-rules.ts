// A zone's layout rule, kept: the daemon lays the zone out by it again whenever what it holds changes.
//
// It hears every event, and keeps what each tile's place under a rule depends on (its zone, its ticket, its role, who
// started it, ...). An event that changes that for a tile in a zone with a rule marks the zone; a moment after the
// last such event, each marked zone is laid out again. Places and states are not part of it, so the rule's own moves,
// the app pushing a tile clear and an agent's turn never set it off.

import { isClosed, tileSizeKey } from './board-layout.ts';
import type { Clock } from './clock.ts';
import type { DaemonCall } from './orchestrator-layout.ts';
import type { Agent, BoardItem, DaemonEvent, DaemonMethods, FlowEdge, Shell, Zone } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';
import type { ZoneTable } from './zones.ts';

/** How long after the last change a zone waits to be laid out again: a burst of changes is laid out once. */
export const RULE_SETTLE_MS = 250;

/** What a tile's (or zone's, or edge's) place under a rule depends on, as last heard. */
interface Seen {
  /** The zone it is in: null, loose on the board (and for a zone or an edge). */
  zoneId: string | null;
  shape: string;
}

/** The tiles, zones and edges, as the rules last heard them, by key. */
export type RuleInputs = Map<string, Seen>;

const agentInputs = (agent: Agent): Seen => ({
  zoneId: agent.zoneId,
  shape: JSON.stringify([agent.name, agent.issue, agent.role, agent.reviewOf, agent.reviews, agent.spawnedBy, agent.branch, isClosed(agent)]),
});
const shellInputs = (shell: Shell): Seen => ({ zoneId: shell.zoneId, shape: JSON.stringify([shell.name]) });
const clockInputs = (item: BoardItem): Seen => ({ zoneId: item.zoneId, shape: JSON.stringify([item.width, item.height, item.rotation]) });
const zoneInputs = (zone: Zone): Seen => ({
  zoneId: zone.id,
  shape: JSON.stringify([zone.layoutRule, zone.spacing, zone.width, zone.folded, zone.handPlaced]),
});
const edgeInputs = (edge: FlowEdge): Seen => ({ zoneId: null, shape: JSON.stringify([edge.from, edge.to]) });

/** Notes `now` as what `key` depends on; returns the zones it was and is in if that changed, else none. */
function heard(inputs: RuleInputs, key: string, now: Seen | undefined): (string | null)[] {
  const was = inputs.get(key);
  if (now === undefined) inputs.delete(key);
  else inputs.set(key, now);
  if (was?.zoneId === now?.zoneId && was?.shape === now?.shape) return [];
  return [...new Set([was?.zoneId, now?.zoneId])].filter((zoneId) => zoneId !== undefined);
}

/**
 * The zones `event` changes what a rule lays out by in, as `inputs` last heard them (which it updates): `'all'` for a
 * change that may reach any zone (an edge between two agents, or a tile it never heard of going).
 */
export function zonesChangedBy(event: DaemonEvent, inputs: RuleInputs): string[] | 'all' {
  const zones = (changed: (string | null)[]) => changed.filter((zoneId) => zoneId !== null);
  switch (event.type) {
    case 'agent.updated':
      return zones(heard(inputs, tileSizeKey('agent', event.agent.sessionId), agentInputs(event.agent)));
    case 'agent.removed': {
      const key = tileSizeKey('agent', event.sessionId);
      return inputs.has(key) ? zones(heard(inputs, key, undefined)) : 'all';
    }
    case 'shell.updated':
      // A shell in an agent's tile is none of the board's: it has no place of its own.
      return event.shell.owner === null ? zones(heard(inputs, tileSizeKey('shell', event.shell.id), shellInputs(event.shell))) : [];
    case 'shell.removed': {
      const key = tileSizeKey('shell', event.shellId);
      return inputs.has(key) ? zones(heard(inputs, key, undefined)) : [];
    }
    case 'item.updated':
      // Of the board's items, only a clock an agent made is laid out with its crew; the rest are in the way, wherever.
      return event.item.kind === 'clock' ? zones(heard(inputs, `item:${event.item.id}`, clockInputs(event.item))) : [];
    case 'item.removed': {
      const key = `item:${event.id}`;
      return inputs.has(key) ? zones(heard(inputs, key, undefined)) : [];
    }
    case 'zone.updated':
      return zones(heard(inputs, `zone:${event.zone.id}`, zoneInputs(event.zone)));
    case 'zone.removed':
      heard(inputs, `zone:${event.id}`, undefined);
      return [];
    case 'flowEdge.updated':
      return heard(inputs, `edge:${event.edge.id}`, edgeInputs(event.edge)).length === 0 ? [] : 'all';
    case 'flowEdge.removed':
      return inputs.has(`edge:${event.id}`) && heard(inputs, `edge:${event.id}`, undefined).length > 0 ? 'all' : [];
    default:
      return [];
  }
}

/** The tile `event` says is now in a zone (null, loose; undefined, gone), if it is about a tile that can be marked. */
function tileSeenBy(event: DaemonEvent): { key: string; zoneId: string | null | undefined } | undefined {
  switch (event.type) {
    case 'agent.updated':
      return { key: tileSizeKey('agent', event.agent.sessionId), zoneId: event.agent.zoneId };
    case 'agent.removed':
      return { key: tileSizeKey('agent', event.sessionId), zoneId: undefined };
    case 'shell.updated':
      // A shell taken into an agent's tile has no place of its own on the board.
      return { key: tileSizeKey('shell', event.shell.id), zoneId: event.shell.owner === null ? event.shell.zoneId : undefined };
    case 'shell.removed':
      return { key: tileSizeKey('shell', event.shellId), zoneId: undefined };
    default:
      return undefined;
  }
}

export interface ZoneRulesOptions {
  /** The daemon's own methods: the board is read, and a zone laid out by its rule, through them. */
  call: DaemonCall;
  /** The zones' marks: a tile seen outside the zone it was placed by hand in loses its mark there. */
  zones: Pick<ZoneTable, 'tileSeen'>;
  clock: Clock;
  log: (message: string) => void;
}

export interface ZoneRules {
  /** Hears one of the daemon's events. */
  onEvent(event: DaemonEvent): void;
  /** Reads the board, then lays out each zone with a rule once (which moves nothing in a zone already laid out by it). */
  start(): Promise<void>;
  /** Stops waiting to lay out. */
  stop(): void;
}

export function createZoneRules({ call, zones: marks, clock, log }: ZoneRulesOptions): ZoneRules {
  const inputs: RuleInputs = new Map();
  const due = new Set<string>();
  let everyZone = false;
  let cancel: (() => void) | undefined;
  let started = false;

  const layOut = async () => {
    cancel = undefined;
    const ids = new Set(due);
    const all = everyZone;
    due.clear();
    everyZone = false;
    // A folded zone waits: unfolding it changes what it lays out by, so it is laid out then.
    const zones = (await call('zone.list', undefined)).filter((zone) => zone.layoutRule !== 'off' && !zone.folded && (all || ids.has(zone.id)));
    for (const zone of zones) {
      try {
        await call('zone.followRule', { id: zone.id, tiles: [] });
      } catch (error) {
        log(`could not lay out ${zone.name} by its rule: ${(error as Error).message}`);
      }
    }
  };

  const settle = () => {
    cancel?.();
    cancel = clock.setTimer(() => void layOut().catch((error: unknown) => log(`could not lay out the zones by their rules: ${(error as Error).message}`)), RULE_SETTLE_MS);
  };

  return {
    onEvent(event) {
      // However it left (closed and opened elsewhere, or put somewhere by the daemon), not only by a move of its own.
      const seen = tileSeenBy(event);
      if (seen !== undefined) marks.tileSeen(seen.key, seen.zoneId);
      if (!started) return;
      const changed = zonesChangedBy(event, inputs);
      if (changed === 'all') everyZone = true;
      else if (changed.length === 0) return;
      else for (const zoneId of changed) due.add(zoneId);
      settle();
    },
    async start() {
      const [zones, agents, shells, items, edges] = await Promise.all([
        call('zone.list', undefined),
        call('agent.list', undefined),
        call('shell.list', undefined),
        call('item.list', undefined),
        call('flowEdge.list', undefined),
      ]);
      for (const zone of zones) inputs.set(`zone:${zone.id}`, zoneInputs(zone));
      for (const agent of agents) inputs.set(tileSizeKey('agent', agent.sessionId), agentInputs(agent));
      for (const shell of shells) if (shell.owner === null) inputs.set(tileSizeKey('shell', shell.id), shellInputs(shell));
      for (const item of items) if (item.kind === 'clock') inputs.set(`item:${item.id}`, clockInputs(item));
      for (const edge of edges) inputs.set(`edge:${edge.id}`, edgeInputs(edge));
      started = true;
      everyZone = true;
      settle();
    },
    stop() {
      cancel?.();
      cancel = undefined;
    },
  };
}

type MoveMethods = Pick<DaemonMethods, 'agent.move' | 'shell.move'>;

/**
 * The board's moves, marking a tile the user put down by hand in a zone with a rule (`byHand`) as placed by hand, and
 * dropping the mark of one that left its zone. Each wraps the method `handlers` has now. A clock is never marked: the
 * rule lays it out with its crew wherever it is put.
 */
export function markingHandMoves<Context>(handlers: RpcHandlers<MoveMethods, Context>, zones: Pick<ZoneTable, 'tileMoved'>): RpcHandlers<MoveMethods, Context> {
  // The methods as they are now: the result may take their place in the same object.
  const moves = { ...handlers };
  const byHand = (params: unknown) => (params as { byHand?: unknown } | null)?.byHand === true;
  return {
    'agent.move': async (params, context) => {
      const agent = await moves['agent.move'](params, context);
      zones.tileMoved(tileSizeKey('agent', agent.sessionId), agent.zoneId, byHand(params));
      return agent;
    },
    'shell.move': async (params, context) => {
      const shell = await moves['shell.move'](params, context);
      zones.tileMoved(tileSizeKey('shell', shell.id), shell.zoneId, byHand(params));
      return shell;
    },
  };
}
