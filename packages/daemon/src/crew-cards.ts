// The crew cards: a running crew's one card on the board (a `crew` item), written from the crew's own record. The crew
// loop says when a crew changed and what its card shows; this keeps the item to that. Whatever a client sends as a crew
// card's data is written over with the crew's own, so no card says what its crew didn't do: only where it sits, its size
// and its `tiles` are the user's. A running crew always has its card; once stopped, its card is the user's to remove.
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { connectionAgent, type BoardCallerSources, type BoardConnection } from './board.ts';
import type { Size } from './board-layout.ts';
import { readsItem, type ReachesZone } from './item-scope.ts';
import { isObject } from './json.ts';
import { keyedQueue } from './keyed-queue.ts';
import type { DaemonCall } from './orchestrator-layout.ts';
import { invalidParams } from './params.ts';
import { crewCardSize, type Agent, type BoardItem, type BoardPlace, type Crew, type CrewCardData } from './protocol.ts';

export interface CrewCardsOptions extends BoardCallerSources {
  db: DatabaseSync;
  call: DaemonCall;
  /** Where a card of `size` goes beside the agent's tile; undefined for an agent with no tile. */
  place(sessionId: string, size: Size): Promise<BoardPlace | undefined>;
  /** What the crew's card shows now (`CrewLoop.card`); undefined for no such crew. */
  card(crewId: string): CrewCardData | undefined;
  /** Every crew (`CrewLoop.list`). */
  crews(): Crew[];
  reachesZone: ReachesZone;
  log(message: string): void;
}

export interface CrewCards {
  /** The crew changed: its card follows, and a running crew with none gets one beside its builder. */
  changed(crewId: string): void;
  /**
   * As the daemon starts: every card as its crew is now, a card for each running crew without one, and no card for a
   * crew there isn't. Until then `changed` does nothing.
   */
  load(): Promise<void>;
  /** `items` as the connection may see them: a board-token agent sees only the crew cards in its scope. */
  visible(items: BoardItem[], connection: BoardConnection): BoardItem[];
  /**
   * An `item.create`'s params as they are stored: a crew card's data is its crew's own, whatever was sent (an undo of
   * its removal sends it as it was), but for its `tiles`. Refuses a card for no crew, or for a crew with one already.
   */
  creating<P>(params: P): P;
  /** An `item.update`'s params as they are stored: a change to a crew card's data keeps only its `tiles`, over its crew's own. */
  updating<P>(params: P): P;
  /** Refuses an `item.delete` of a running crew's card. */
  checkDelete(params: unknown): void;
  /** Settles once no card is being written: for tests. */
  idle(): Promise<void>;
  /** Stops writing cards, as the daemon shuts down. */
  close(): void;
}

/** What the crew's card shows but for `tiles`, which is the user's once the card is made. */
function shown<T extends { tiles?: unknown }>(card: T): Omit<T, 'tiles'> {
  const rest: Partial<T> = { ...card };
  delete rest.tiles;
  return rest as Omit<T, 'tiles'>;
}

export function createCrewCards(options: CrewCardsOptions): CrewCards {
  // Oldest first: of two cards for one crew, the first made is its card.
  const selectCards = options.db.prepare("SELECT id, data FROM board_items WHERE kind = 'crew' ORDER BY created_at, rowid");
  const selectCard = options.db.prepare("SELECT data FROM board_items WHERE id = ? AND kind = 'crew'");
  /** One write at a time for each crew's card. */
  const queue = keyedQueue();
  const writing = new Set<Promise<void>>();
  let loaded = false;
  let closed = false;

  const cards = () => (selectCards.all() as { id: string; data: string }[]).map((row) => ({ id: row.id, data: JSON.parse(row.data) as Record<string, unknown> }));
  const cardOf = (crewId: string) => cards().find((card) => card.data.crewId === crewId);
  /** The crew the item `id` is the card of, if it is one. */
  const crewOfItem = (id: unknown): string | undefined => {
    if (typeof id !== 'string') return undefined;
    const stored = (selectCard.get(id) as { data: string } | undefined)?.data;
    const crewId = stored === undefined ? undefined : (JSON.parse(stored) as Record<string, unknown>).crewId;
    return typeof crewId === 'string' ? crewId : undefined;
  };

  const write = async (crewId: string): Promise<void> => {
    if (closed) return;
    const card = options.card(crewId);
    if (card === undefined) return;
    const item = cardOf(crewId);
    if (item !== undefined) {
      // `updating` fills in the crew's own: an update only when that isn't what the card says already.
      if (!isDeepStrictEqual(shown(item.data), shown(card))) await options.call('item.update', { id: item.id, data: {} });
      return;
    }
    // A stopped crew's card went with the user's say, and stays gone until the crew runs again.
    if (card.crew.stopped !== null) return;
    const size = crewCardSize(card.members.length);
    const spot = (await options.place(card.crew.builder, size)) ?? { zoneId: options.agents.get(card.crew.builder)?.zoneId ?? null, x: 0, y: 0 };
    if (closed) return;
    await options.call('item.create', { kind: 'crew', ...spot, ...size, data: { ...card } });
  };

  const changed = (crewId: string) => {
    if (!loaded || closed) return;
    const run = queue(crewId, () => write(crewId)).catch((error: unknown) => options.log(`could not write crew ${crewId}'s card: ${(error as Error).message}`));
    writing.add(run);
    void run.finally(() => writing.delete(run));
  };

  /** Whether the agent is of the card's crew: its builder, one of its reviewers, or the orchestrator that started it. */
  const involved = (me: Agent, data: Partial<CrewCardData>): boolean =>
    data.crew !== undefined && (data.crew.builder === me.sessionId || data.crew.startedBy === me.sessionId || data.crew.reviewers.some((each) => each.sessionId === me.sessionId));

  return {
    changed,

    async load() {
      loaded = true;
      // One card a crew: the first of a crew there is stays, and any other goes.
      const kept = new Set<string>();
      for (const card of cards()) {
        const crewId = typeof card.data.crewId === 'string' && options.card(card.data.crewId) !== undefined ? card.data.crewId : undefined;
        if (crewId !== undefined && !kept.has(crewId)) {
          kept.add(crewId);
          continue;
        }
        const why = crewId === undefined ? 'a card of no crew' : `a second card of crew:${crewId}`;
        await options.call('item.delete', { id: card.id }).catch((error: unknown) => options.log(`could not remove ${why}: ${(error as Error).message}`));
      }
      for (const crew of options.crews()) changed(crew.id);
    },

    visible(items, connection) {
      const me = connectionAgent(options, connection);
      if (me === undefined) return items;
      if (me === null) return items.filter((item) => item.kind !== 'crew');
      return items.filter((item) => item.kind !== 'crew' || readsItem(me, item, involved(me, item.data as Partial<CrewCardData>), options.reachesZone));
    },

    creating(params) {
      if (!isObject(params) || params.kind !== 'crew' || !isObject(params.data) || typeof params.data.crewId !== 'string') return params;
      const crewId = params.data.crewId;
      const card = options.card(crewId);
      if (card === undefined) throw invalidParams(`there is no crew ${crewId} for a card to show: a crew's card is made as the crew starts`);
      if (cardOf(crewId) !== undefined) throw invalidParams(`crew:${crewId} has its card on the board already`);
      return { ...params, data: { ...card, tiles: typeof params.data.tiles === 'boolean' ? params.data.tiles : card.tiles } } as typeof params;
    },

    updating(params) {
      if (!isObject(params) || !isObject(params.data)) return params;
      const crewId = crewOfItem(params.id);
      if (crewId === undefined) return params;
      const card = options.card(crewId);
      const tiles = typeof params.data.tiles === 'boolean' ? { tiles: params.data.tiles } : {};
      return { ...params, data: card === undefined ? tiles : { ...shown(card), ...tiles } } as typeof params;
    },

    checkDelete(params) {
      const id = isObject(params) ? params.id : undefined;
      const crewId = crewOfItem(id);
      if (crewId === undefined || options.card(crewId)?.crew.stopped !== null) return;
      // A second card of its crew (`load` removes one) is not the card it keeps.
      if (cardOf(crewId)?.id !== id) return;
      throw invalidParams(`crew:${crewId} is still running, and a running crew keeps its card: stop the crew first (agent-board crew stop crew:${crewId})`);
    },

    async idle() {
      while (writing.size > 0) await Promise.all(writing);
    },

    close() {
      closed = true;
    },
  };
}
