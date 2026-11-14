// A stage board: one board object in a zone (an item of kind `stages`, one to a zone, added from its menu) that holds
// the zone's work in four stages, To do, Doing, Waiting for review and Done, left to right. On Doing a ticket is its
// band of live tiles, the agent then its reviewers, as the Spine rule draws one, and their notes in a row under them; on
// the other stages it is a quiet card of its natural size, its tiles hidden behind it. Each stage is as wide as what it
// holds, a card at least. It holds every agent in its zone but its leads and those the user started by hand: one of
// those stays out, where the user put it, until it is dragged in. Only where things are drawn: no tile's saved place is
// read or written for it. Pure and deterministic, so the same board always draws the same way, whatever order it is
// listed in.
import { lanesOf, LANE_SLOTS, type ArrangeLink } from './board-arrange.ts';
import { AGENT_TILE_SIZE, isClosed, PERCH_ROOM, tileSizeKey, zoneGrid, type Point, type Size } from './board-layout.ts';
import { isOrchestratorRole, startedByHand, type Agent, type ArrangeSpacing, type NeedsYouShows } from './protocol.ts';
import { cardHeight, CARD_GAP, needsUser, SHELF_STAGES, stageOf, WORKING_STATES, type ShelfStage } from './shelf-layout.ts';
import { SPINE_GAPS } from './spine-layout.ts';
import { heldByTicket } from './ticket-tiles.ts';
import { workTilesOf } from './work-units.ts';

/** The item kind a stage board is. */
export const STAGE_BOARD_KIND = 'stages';

/** Each stage's heading. */
export const STAGE_NAMES: Record<ShelfStage, string> = { todo: 'To do', doing: 'Doing', waiting: 'Waiting for review', done: 'Done' };

/** The block's padding round its stages, in px. */
export const STAGE_BOARD_PADDING = 14;
/** The block's top bar, its grip and what it holds: where it is dragged by. */
export const STAGE_BOARD_HEADER = 34;
/** A stage's heading, under the top bar. */
export const STAGE_HEADING_TOP = 10;
export const STAGE_HEADING_HEIGHT = 24;
/** From the top bar to a stage's first ticket: its heading and the room under it. */
const STAGE_HEAD = 36 + 8;
/** Between two stages. */
export const STAGE_GAP = 24;
/** A quiet card's width: a tile's, never stretched to its stage. */
export const STAGE_CARD_WIDTH = AGENT_TILE_SIZE.width;
/** Done's line, "N done · Show", that its cards fold behind. */
export const DONE_LINE_HEIGHT = 28;
/** A card for later, at the foot of To do: its text, on a line or two. */
export const LATER_CARD_HEIGHT = 52;
/** The tickets a Doing column holds before the next starts beside it. */
export const DOING_COLUMN_TICKETS = 8;
/** A stage board with nothing on it: four stages a card wide, under their headings. */
export const EMPTY_STAGE_BOARD_SIZE = {
  width: 2 * STAGE_BOARD_PADDING + 4 * STAGE_CARD_WIDTH + 3 * STAGE_GAP,
  height: STAGE_BOARD_HEADER + STAGE_HEAD + STAGE_BOARD_PADDING,
} as const;

/**
 * What a stage board keeps (its item's data): the agents the user started by hand that were dragged in (`joined`), and
 * those it would hold that were dragged out (`left`), by session id; and whether Done shows its cards (`showDone`) or
 * folds them behind its line.
 */
export interface StageBoardData {
  joined: string[];
  left: string[];
  showDone: boolean;
}

const ids = (value: unknown): string[] => (Array.isArray(value) && value.every((each) => typeof each === 'string') ? [...value] : []);

/** A stage board's data as it reads, a list it can't read as none. */
export function stageBoardData(data: Readonly<Record<string, unknown>>): StageBoardData {
  return { joined: ids(data.joined), left: ids(data.left), showDone: data.showDone === true };
}

/** What is wrong with a stage board's data, or null: each list it has must be of session ids. */
export function stageBoardDataProblem(data: Readonly<Record<string, unknown>>): string | null {
  for (const key of ['joined', 'left'] as const) {
    const value = data[key];
    if (value !== undefined && !(Array.isArray(value) && value.every((each) => typeof each === 'string'))) return `a stage board's ${key} must be a list of session ids`;
  }
  if (data.showDone !== undefined && typeof data.showDone !== 'boolean') return "a stage board's showDone must be true or false";
  return null;
}

/** Whether `agent` leads its zone, as the Spine rule reads it: an orchestrator or the Master, kept out of every ticket. */
/** Whether `agent` leads others (an orchestrator, or the master): it never goes on a stage board. */
export const leads = (agent: Agent): boolean => isOrchestratorRole(agent.roleName) || agent.master;

/**
 * The session ids of the agents the stage board of zone `zoneId` holds, in the board's order: its agents but its leads,
 * those the user started by hand only once dragged in, and none dragged out. Never a ticket's helpers in its chat's zone,
 * which their ticket holds: its chat goes on as one.
 */
export function stageBoardMembers(agents: readonly Agent[], zoneId: string, data: Pick<StageBoardData, 'joined' | 'left'>): string[] {
  return agents
    .filter(
      (agent) =>
        agent.zoneId === zoneId &&
        !leads(agent) &&
        !heldByTicket(agent, agents) &&
        (!startedByHand(agent) || data.joined.includes(agent.sessionId)) &&
        !data.left.includes(agent.sessionId),
    )
    .map((agent) => agent.sessionId);
}

/**
 * What a stage board keeps once the user drops `agent`'s tile on its block (`on`), off it in its zone (`off`), or away in
 * another zone (`away`), or undefined if that changes nothing: on it, one the user started joins, and one an agent
 * started comes back; off it, the first leaves `joined`, the second goes on `left`. Away, it is on neither, as it is no
 * longer in the zone: back in it one day, it is a member or not by who started it. A lead never joins.
 */
export function stageBoardDrop(agent: Agent, data: StageBoardData, drop: 'on' | 'off' | 'away'): StageBoardData | undefined {
  if (leads(agent)) return undefined;
  const id = agent.sessionId;
  const without = (list: readonly string[]) => list.filter((each) => each !== id);
  const withIt = (list: readonly string[]) => (list.includes(id) ? [...list] : [...list, id]);
  const hand = startedByHand(agent);
  const next =
    drop === 'on'
      ? { ...data, joined: hand ? withIt(data.joined) : without(data.joined), left: without(data.left) }
      : { ...data, joined: without(data.joined), left: hand || drop === 'away' ? without(data.left) : withIt(data.left) };
  const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((each, at) => each === b[at]);
  return same(next.joined, data.joined) && same(next.left, data.left) ? undefined : next;
}

const prOpen = (agent: Agent): boolean => agent.pullRequests.some((pr) => pr.state === 'open' || pr.state === 'draft');

/**
 * The stage a ticket of `agents` is on (`reviewers` its reviewers' session ids). As the shelves have it (`stageOf`), but
 * for review: with its pull request open, it waits for review once its implementer has stopped, however its reviewers
 * run, unless one of them needs the user, which brings it back to Doing.
 */
export function ticketStage(agents: readonly Agent[], reviewers: ReadonlySet<string>, shows: NeedsYouShows): ShelfStage {
  const stage = stageOf(agents, shows);
  if (stage !== 'doing' || !agents.some(prOpen)) return stage;
  if (agents.some((agent) => !isClosed(agent) && needsUser(agent, shows))) return 'doing';
  const makers = agents.filter((agent) => !reviewers.has(agent.sessionId));
  const working = makers.some((agent) => (!isClosed(agent) && WORKING_STATES.has(agent.state)) || agent.state === 'failed');
  return working ? 'doing' : 'waiting';
}

export interface StageBoardInput {
  /** The board's agents: those the board holds are laid out, the rest name the ones they review. */
  agents: readonly Agent[];
  zoneId: string;
  data: StageBoardData;
  /** Edges between agents, by node key: agents an edge joins share a ticket, as an arrange's lane. */
  links: readonly ArrangeLink[];
  shows: NeedsYouShows;
  spacing: ArrangeSpacing;
  /** Each tile's size as drawn, by node key: a Doing ticket's tiles. */
  sizeOf: (key: string) => Size;
  /** Whether a ticket's card has a footer line (a pull request, notes), by its members' session ids. */
  footOf: (members: readonly string[]) => boolean;
  /** The notes an agent wrote, by its session id: their node keys and sizes, drawn in its band on Doing. */
  notesOf?: (sessionId: string) => readonly { key: string; size: Size }[];
  /** What is put off for later, in its order: a card each at the foot of To do, that no agent starts. */
  later?: readonly { id: string; text: string }[];
}

/** A card for later, relative to the block. */
export interface LaterCard {
  id: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One ticket: its agents, drawn as a band on Doing and as a card on the other stages. */
export interface StageTicket {
  /** Stable across layouts: `issue:<id>` for its issue or branch ticket, else its first agent's tile key. */
  key: string;
  /** Its issue or branch ticket, if it has one. */
  ticket: string | null;
  /** Its issue's title, else its first agent's name. */
  title: string;
  stage: ShelfStage;
  /** Whether one of its agents needs the user: it goes first on Doing. */
  needsYou: boolean;
  /** Its agents' session ids, in slot order: implementer, reviewer, follow-up. */
  members: string[];
  /** When its work started: its first agent's. */
  startedAt: string;
  /** Whether its tiles show (a band on Doing), not a card. */
  live: boolean;
  /** Whether its card is folded behind Done's line, not drawn. */
  folded: boolean;
  /** Where its band or card is, relative to the block. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A stage's column, relative to the block: its heading's place and what it says. */
export interface StageColumn {
  stage: ShelfStage;
  x: number;
  width: number;
  count: number;
  /** On Doing, its tickets that need the user. */
  needYou: number;
  /** On To do, the cards for later at its foot, which `count` leaves out. */
  later: number;
}

/** Done's line, at the head of the stage, relative to the block: how many tickets are done, and whether their cards show. */
export interface DoneFold {
  x: number;
  y: number;
  width: number;
  height: number;
  count: number;
  shown: boolean;
}

export interface StageBoardLayout {
  /** The block's size, hugging its stages. */
  size: Size;
  columns: StageColumn[];
  /** Done's line, or null with nothing done. */
  fold: DoneFold | null;
  /** The cards for later, at the foot of To do. */
  later: LaterCard[];
  tickets: StageTicket[];
  /** Where each live tile, and each note in a band, goes (its top-left), relative to the block, by node key. */
  tiles: Map<string, Point>;
  /** The session ids of the agents it holds: their tiles are its, shown on Doing and hidden on the other stages. */
  members: string[];
}

/** Earliest first; a ticket with no start time last. */
const byStart = (a: StageTicket, b: StageTicket) => (a.startedAt === b.startedAt ? (a.key < b.key ? -1 : 1) : a.startedAt === '' ? 1 : b.startedAt === '' ? -1 : a.startedAt < b.startedAt ? -1 : 1);
/** A stage's order: what needs the user first, then by when the work started. */
const stageOrder = (a: StageTicket, b: StageTicket) => (a.needsYou === b.needsYou ? byStart(a, b) : a.needsYou ? -1 : 1);

/** The tickets of the agents `members` names, unplaced, a lane each, as an arrange lanes them. */
function ticketsOf(input: StageBoardInput, members: readonly string[]): { ticket: StageTicket; tiles: string[] }[] {
  const here = input.agents.filter((agent) => members.includes(agent.sessionId));
  const byKey = new Map(here.map((agent) => [tileSizeKey('agent', agent.sessionId), agent]));
  const { lanes } = lanesOf(workTilesOf(input.agents, here, undefined, {}), input.links);
  return lanes.map((lane) => {
    const tiles = LANE_SLOTS.flatMap((slot) => lane.slots[slot]);
    const agents = tiles.map((tile) => byKey.get(tile.id)!);
    const reviewers = new Set([...lane.slots.reviewer, ...lane.slots['follow-up']].map((tile) => byKey.get(tile.id)!.sessionId));
    const issued = tiles.find((tile) => tile.issueTitle);
    const stage = ticketStage(agents, reviewers, input.shows);
    return {
      tiles: tiles.map((tile) => tile.id),
      ticket: {
        key: lane.key,
        ticket: lane.key.startsWith('issue:') ? lane.key.slice('issue:'.length) : null,
        title: issued?.issueTitle ?? agents[0]!.name,
        stage,
        needsYou: agents.some((agent) => !isClosed(agent) && needsUser(agent, input.shows)),
        members: agents.map((agent) => agent.sessionId),
        startedAt: agents.map((agent) => agent.createdAt).reduce((first, at) => (first === '' || at < first ? at : first), ''),
        live: stage === 'doing',
        folded: false,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      },
    };
  });
}

/** Where a stage board draws what it holds, relative to its block. */
export function layOutStageBoard(input: StageBoardInput): StageBoardLayout {
  const tileGap = zoneGrid(input.spacing).gaps.tile;
  const { down, band: bandPad } = SPINE_GAPS[input.spacing];
  const members = stageBoardMembers(input.agents, input.zoneId, input.data);
  const all = ticketsOf(input, members);
  const tilesOf = new Map(all.map(({ ticket, tiles }) => [ticket.key, tiles]));
  const tickets = all.map(({ ticket }) => ticket);
  const tiles = new Map<string, Point>();
  const columns: StageColumn[] = [];
  let fold: DoneFold | null = null;
  const later: LaterCard[] = [];
  const top = STAGE_BOARD_HEADER + STAGE_HEAD;
  let x = STAGE_BOARD_PADDING;
  let bottom = top;
  for (const stage of SHELF_STAGES) {
    const on = tickets.filter((ticket) => ticket.stage === stage).sort(stageOrder);
    let width = STAGE_CARD_WIDTH;
    if (stage === 'doing') {
      // A band per ticket, the agent then its reviewers, a column of them to every eight tickets.
      let left = x;
      for (let first = 0; first < on.length; first += DOING_COLUMN_TICKETS) {
        let y = top;
        let columnWidth = 0;
        for (const ticket of on.slice(first, first + DOING_COLUMN_TICKETS)) {
          const keys = tilesOf.get(ticket.key)!;
          const sizes = keys.map((key) => input.sizeOf(key));
          let along = left + bandPad;
          keys.forEach((key, index) => {
            tiles.set(key, { x: along, y: y + PERCH_ROOM });
            along += sizes[index]!.width + tileGap;
          });
          let height = PERCH_ROOM + Math.max(...sizes.map((size) => size.height));
          let right = along - tileGap;
          // Its agents' notes, a row under its tiles.
          const notes = ticket.members.flatMap((id) => input.notesOf?.(id) ?? []);
          if (notes.length > 0) {
            let noteX = left + bandPad;
            for (const note of notes) {
              tiles.set(note.key, { x: noteX, y: y + height + tileGap });
              noteX += note.size.width + tileGap;
            }
            right = Math.max(right, noteX - tileGap);
            height += tileGap + Math.max(...notes.map((note) => note.size.height));
          }
          height += bandPad;
          Object.assign(ticket, { x: left, y, width: right + bandPad - left, height });
          columnWidth = Math.max(columnWidth, ticket.width);
          y += height + down;
          bottom = Math.max(bottom, y - down);
        }
        left += columnWidth + STAGE_GAP;
      }
      width = Math.max(width, left - STAGE_GAP - x);
    } else {
      let y = top;
      let cards = on;
      if (stage === 'done' && on.length > 0) {
        // Its tickets fold behind one line, that shows them under it.
        fold = { x, y, width: STAGE_CARD_WIDTH, height: DONE_LINE_HEIGHT, count: on.length, shown: input.data.showDone };
        bottom = Math.max(bottom, y + DONE_LINE_HEIGHT);
        if (!input.data.showDone) {
          for (const ticket of on) Object.assign(ticket, { x, y, width: STAGE_CARD_WIDTH, height: DONE_LINE_HEIGHT, folded: true });
          cards = [];
        }
        y += DONE_LINE_HEIGHT + CARD_GAP;
      }
      for (const ticket of cards) {
        const height = cardHeight(ticket.members.length, input.footOf(ticket.members));
        Object.assign(ticket, { x, y, width: STAGE_CARD_WIDTH, height });
        y += height + CARD_GAP;
        bottom = Math.max(bottom, y - CARD_GAP);
      }
      if (stage === 'todo') {
        for (const { id, text } of input.later ?? []) {
          later.push({ id, text, x, y, width: STAGE_CARD_WIDTH, height: LATER_CARD_HEIGHT });
          y += LATER_CARD_HEIGHT + CARD_GAP;
          bottom = Math.max(bottom, y - CARD_GAP);
        }
      }
    }
    columns.push({ stage, x, width, count: on.length, needYou: stage === 'doing' ? on.filter((ticket) => ticket.needsYou).length : 0, later: stage === 'todo' ? later.length : 0 });
    x += width + STAGE_GAP;
  }
  return {
    size: { width: x - STAGE_GAP + STAGE_BOARD_PADDING, height: bottom + STAGE_BOARD_PADDING },
    columns,
    fold,
    later,
    tickets: SHELF_STAGES.flatMap((stage) => tickets.filter((ticket) => ticket.stage === stage).sort(stageOrder)),
    tiles,
    members,
  };
}
