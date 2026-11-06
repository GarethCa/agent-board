// A shelved zone (`Zone.layoutMode` `shelves`): its work as one stack per unit of work (an issue, the ticket in a
// branch, or agents joined by edges and reviews, as an arrange lanes them), each on the shelf its agents' states put
// it on, To do, Doing, Waiting or Done, under a head row of the zone's pinned leads and its shells. Only where things
// are drawn: no tile's saved place is read for it or written by it, so a zone set back to free shows as it was.
// Pure and deterministic, so the same board always draws the same way, whatever order it is listed in.
import { lanesOf, LANE_SLOTS, type ArrangeLink } from './board-arrange.ts';
import { CHIP_SIZE, isClosed, PERCH_ROOM, tileSizeKey, zoneGrid, type Point, type Size } from './board-layout.ts';
import { needsYouKind, type Agent, type AgentState, type ArrangeSpacing, type NeedsYouShows } from './protocol.ts';
import { workTilesOf } from './work-units.ts';

/** The shelves, left to right. */
export const SHELF_STAGES = ['todo', 'doing', 'waiting', 'done'] as const;
export type ShelfStage = (typeof SHELF_STAGES)[number];

/** Each shelf's heading. */
export const SHELF_NAMES: Record<ShelfStage, string> = { todo: 'To do', doing: 'Doing', waiting: 'Waiting', done: 'Done' };

/** States an agent is at work in: someone has it. */
const WORKING_STATES: ReadonlySet<AgentState> = new Set<AgentState>(['running', 'thinking', 'on-command', 'handing-off', 'starting', 'rate-limited']);

/**
 * Whether the agent waits on the user now, exactly as the Needs-you pill counts it: a permission prompt, a question or
 * plan, a flag, (with `turns`) its turn, or a restart that stopped it. So a stack is ringed only when the pill counts it.
 * Not a pull request left for review: that is someone else's turn, its stack on Waiting.
 */
export const needsUser = (agent: Agent, shows: NeedsYouShows): boolean => needsYouKind(agent, shows) !== null || agent.state === 'stopped-by-restart';

/**
 * Whether the agent failed, as the daemon says (`humanStatus` reads it so too): a stop is no failure, whatever exit code
 * it left. A problem stays on Doing with its stack, in view.
 */
const failed = (agent: Agent): boolean => agent.state === 'failed';

/** Whether one of the agents' pull requests is open (a draft too): waiting on review, or on CI, someone else's turn. */
const prOpen = (agent: Agent): boolean => agent.pullRequests.some((pr) => pr.state === 'open' || pr.state === 'draft');
const prMerged = (agent: Agent): boolean => agent.pullRequests.some((pr) => pr.state === 'merged');

/**
 * The shelf a stack of `agents` goes on, the first that holds:
 * - **Doing**: one of them works, needs the user, or failed (until its work is merged).
 * - **Done**: its pull request merged.
 * - **Waiting**: its pull request is open, so it waits on someone who is neither the user nor the agent, even with every
 *   agent of it closed.
 * - **Done**: every one is closed.
 * - **Doing**: one of them has finished a turn: its work has started, though nothing runs now. One paused after its
 *   first turn is here too, quiet on Doing, not back on To do.
 * - **To do**: none has finished a turn and none waits on anyone (scheduled, paused or stopped before its first turn
 *   ended, just made). The daemon keeps no "has run at all" signal, so a turn ended is what counts as started.
 */
export function stageOf(agents: readonly Agent[], shows: NeedsYouShows): ShelfStage {
  const merged = agents.some(prMerged);
  if (agents.some((agent) => (!isClosed(agent) && (WORKING_STATES.has(agent.state) || needsUser(agent, shows))) || (failed(agent) && !merged))) return 'doing';
  if (merged) return 'done';
  if (agents.some(prOpen)) return 'waiting';
  if (agents.length > 0 && agents.every(isClosed)) return 'done';
  if (agents.some((agent) => agent.finishedAt !== null)) return 'doing';
  return 'todo';
}

/** A stack: one unit of work's agents, drawn as one card (a row on Waiting, a chip on Done). */
export interface ShelfStack {
  /** Stable across layouts: `issue:<id>` for its issue or branch ticket, else its first agent's tile key. */
  key: string;
  /** Its issue or branch ticket, if it has one. */
  ticket: string | null;
  /** Its issue's title, else its first agent's name. */
  title: string;
  stage: ShelfStage;
  /** Whether one of its agents needs the user: it goes first on its shelf, and is never folded away. */
  needsYou: boolean;
  /** Its agents' session ids, in slot order: implementer, reviewer, follow-up. */
  members: string[];
  /** When its work started: its first agent's. */
  startedAt: string;
  /** Where it is drawn, relative to the zone; Done's stacks while Done is folded are drawn nowhere (`placed` false). */
  x: number;
  y: number;
  width: number;
  height: number;
  placed: boolean;
}

/** A shelf: its heading and the column its stacks fill. */
export interface Shelf extends Point, Size {
  stage: ShelfStage;
  count: number;
}

/** What a shelved zone draws, relative to the zone. */
export interface ShelfLayout {
  /** The tiles drawn in the head row, by node key (`tileSizeKey`), at their places: pinned leads, then shells. */
  head: { key: string; x: number; y: number }[];
  shelves: Shelf[];
  stacks: ShelfStack[];
  /** Done's one line, "N done · Show", drawn while it has any. */
  doneLine: (Point & Size & { count: number; shown: boolean }) | null;
  /**
   * The open stack's tiles, fanned out below the shelves (`fanTop`), in the free space under them, by node key: they
   * cover no card, and nothing else moves for them.
   */
  fan: { key: string; x: number; y: number }[];
  /** Where a stack's tiles fan out: just below the lowest shelf. */
  fanTop: number;
  /** The least size the zone is drawn at to hold all this (a fan floats over, so is left out). */
  size: Size;
}

/** A card's least width; Doing takes as many columns of cards as fit, at most `MAX_DOING_COLUMNS`. */
export const MIN_CARD_WIDTH = 200;
const MAX_DOING_COLUMNS = 3;
/** A card's height with no member line (heading and padding), each member line's, and its footer line's. */
const CARD_BASE = 44;
export const MEMBER_LINE = 22;
const CARD_FOOT = 20;
/** A card lists at most this many members, then "+N more". */
export const MAX_MEMBER_LINES = 4;
/** A waiting row's height, with its ticket and title and what it waits on. */
export const WAITING_ROW_HEIGHT = 56;
/** Done's folded line. */
const DONE_LINE_HEIGHT = 28;
/** A shelf heading's height, and the gaps between shelves and between the cards on one. */
export const SHELF_HEADING = 28;
export const SHELF_GAP = 24;
export const CARD_GAP = 12;
/** How far below its card a stack's tiles fan out. */
export const FAN_GAP = 12;

/** Each shelf's least width, and its share of what the zone has beyond: Doing twice To do's. */
export const MIN_SHELF_WIDTHS: Record<ShelfStage, number> = { todo: MIN_CARD_WIDTH, doing: MIN_CARD_WIDTH, waiting: 220, done: CHIP_SIZE.width };
const SHELF_WEIGHTS: Record<ShelfStage, number> = { todo: 1, doing: 2, waiting: 0.9, done: 0.8 };

/**
 * The shelves' rows and widths in a zone `width` wide, its padding `padding`: the four side by side when they fit at
 * their least widths, else To do and Doing above Waiting and Done, in the same two columns. The width is shared by the
 * shelves' weights, none narrower than its least; a zone too narrow for even that is drawn wider.
 */
export function shelfRows(width: number, padding: number): { stage: ShelfStage; width: number }[][] {
  const room = width - 2 * padding;
  const fits = (stages: readonly ShelfStage[]) => stages.reduce((sum, stage) => sum + MIN_SHELF_WIDTHS[stage], 0) + (stages.length - 1) * SHELF_GAP <= room;
  const shared = (row: readonly ShelfStage[]) => {
    const share = room - (row.length - 1) * SHELF_GAP;
    const weights = row.reduce((sum, stage) => sum + SHELF_WEIGHTS[stage], 0);
    return row.map((stage) => ({ stage, width: Math.max(MIN_SHELF_WIDTHS[stage], Math.floor((share * SHELF_WEIGHTS[stage]) / weights)) }));
  };
  if (fits(SHELF_STAGES)) return [shared(SHELF_STAGES)];
  // Two rows on the same two columns: Waiting under To do, Done under Doing.
  const top = shared(['todo', 'doing']);
  const columns = top.map((shelf, at) => Math.max(shelf.width, MIN_SHELF_WIDTHS[at === 0 ? 'waiting' : 'done']));
  return [
    top.map((shelf, at) => ({ ...shelf, width: columns[at]! })),
    [
      { stage: 'waiting', width: columns[0]! },
      { stage: 'done', width: columns[1]! },
    ],
  ];
}

/** How many columns of cards a Doing shelf `width` wide holds, and how wide each card is. */
export function doingColumns(width: number): { columns: number; card: number } {
  const columns = Math.max(1, Math.min(MAX_DOING_COLUMNS, Math.floor((width + CARD_GAP) / (MIN_CARD_WIDTH + CARD_GAP))));
  return { columns, card: Math.floor((width - (columns - 1) * CARD_GAP) / columns) };
}

/** A card's height: its member lines (at most `MAX_MEMBER_LINES`, then one for "+N more") and its footer if it has one. */
export function cardHeight(members: number, foot: boolean): number {
  const lines = Math.min(members, MAX_MEMBER_LINES) + (members > MAX_MEMBER_LINES ? 1 : 0);
  return CARD_BASE + lines * MEMBER_LINE + (foot ? CARD_FOOT : 0);
}

export interface ShelfInput {
  /** The board's agents: those in the zone are laid out, the rest name the ones they review. */
  agents: readonly Agent[];
  zoneId: string;
  spacing: ArrangeSpacing;
  /** The zone's width as saved: the shelves share it, and grow it only when it is too narrow for them. */
  width: number;
  /** The zone's leads drawn pinned in the head row, by session id; a lead the user freed is a stack like any other. */
  pinned: ReadonlySet<string>;
  /** The other tiles of the head row, by node key, in order: the zone's shells and external sessions, agents starting. */
  heads: readonly string[];
  /** Edges between agents, by node key: agents an edge joins share a stack, as an arrange's lane. */
  links: readonly ArrangeLink[];
  shows: NeedsYouShows;
  /** Each tile's compact size as drawn, by node key: a head tile, a fanned tile (a closed agent's is a chip). */
  sizeOf: (key: string) => Size;
  /** Whether a stack's card has a footer line (a pull request, notes), by its members' session ids. */
  footOf: (members: readonly string[]) => boolean;
  /** Whether Done is shown as chips, not only its one line. */
  doneShown: boolean;
  /** The stack fanned out, by key, if any. */
  open?: string | null;
}

/** Earliest first; a stack with no start time (none known) last. */
const byStart = (a: ShelfStack, b: ShelfStack) => (a.startedAt === b.startedAt ? (a.key < b.key ? -1 : 1) : a.startedAt === '' ? 1 : b.startedAt === '' ? -1 : a.startedAt < b.startedAt ? -1 : 1);

/** The order a shelf lists its stacks in: what needs the user first, then by when the work started (Done newest first). */
function shelfOrder(stage: ShelfStage, ended: ReadonlyMap<string, string>) {
  return (a: ShelfStack, b: ShelfStack): number => {
    if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1;
    if (stage === 'done') {
      const [x, y] = [ended.get(a.key) ?? '', ended.get(b.key) ?? ''];
      if (x !== y) return x < y ? 1 : -1;
    }
    return byStart(a, b);
  };
}

/** The zone's stacks, unplaced: one per unit of work among its agents that aren't pinned leads. */
export function stacksOf(input: Pick<ShelfInput, 'agents' | 'zoneId' | 'pinned' | 'links' | 'shows'>): ShelfStack[] {
  const here = input.agents.filter((agent) => agent.zoneId === input.zoneId && !input.pinned.has(agent.sessionId));
  const byKey = new Map(here.map((agent) => [tileSizeKey('agent', agent.sessionId), agent]));
  const { lanes } = lanesOf(workTilesOf(input.agents, here, undefined, {}), input.links);
  return lanes.map((lane): ShelfStack => {
    const tiles = LANE_SLOTS.flatMap((slot) => lane.slots[slot]);
    const agents = tiles.map((tile) => byKey.get(tile.id)!);
    const issued = tiles.find((tile) => tile.issueTitle);
    const ticket = lane.key.startsWith('issue:') ? lane.key.slice('issue:'.length) : null;
    return {
      key: lane.key,
      ticket,
      title: issued?.issueTitle ?? agents[0]!.name,
      stage: stageOf(agents, input.shows),
      needsYou: agents.some((agent) => !isClosed(agent) && needsUser(agent, input.shows)),
      members: agents.map((agent) => agent.sessionId),
      startedAt: agents.map((agent) => agent.createdAt).reduce((first, at) => (first === '' || at < first ? at : first), ''),
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      placed: false,
    };
  });
}

/** The gap between tiles side by side, in a head row, a fan or a cluster, at the zone's spacing. */
export const tileStep = (spacing: ArrangeSpacing): number => Math.max(zoneGrid(spacing).gaps.tile, CARD_GAP);

/**
 * A shelved or clustered zone's head row, relative to the zone: its pinned leads in the order they started, then its
 * other head tiles as given, left to right; where what is under it starts (`top`), and how far right it reaches.
 */
function headRow(input: Pick<ShelfInput, 'agents' | 'zoneId' | 'spacing' | 'pinned' | 'heads' | 'sizeOf'>): { head: ShelfLayout['head']; top: number; right: number } {
  const grid = zoneGrid(input.spacing);
  const step = tileStep(input.spacing);
  const leads = input.agents
    .filter((agent) => agent.zoneId === input.zoneId && input.pinned.has(agent.sessionId))
    .toSorted((a, b) => (a.createdAt === b.createdAt ? (a.sessionId < b.sessionId ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1))
    .map((agent) => tileSizeKey('agent', agent.sessionId));
  const head: ShelfLayout['head'] = [];
  let x = grid.origin.x;
  let bottom = grid.gaps.padding;
  for (const key of [...leads, ...input.heads]) {
    const size = input.sizeOf(key);
    head.push({ key, x, y: grid.origin.y });
    x += size.width + step;
    bottom = Math.max(bottom, grid.origin.y + size.height);
  }
  return { head, top: head.length === 0 ? grid.gaps.padding : bottom + grid.gaps.lane, right: x - step };
}

/** When each stack's work ended: its last agent's close, '' while any is open. Done is listed newest first by it. */
function endedOf(stacks: readonly ShelfStack[], agents: readonly Agent[]): ReadonlyMap<string, string> {
  const byId = new Map(agents.map((agent) => [agent.sessionId, agent]));
  return new Map(stacks.map((stack) => [stack.key, stack.members.map((id) => byId.get(id)?.endedAt ?? '').reduce((last, at) => (at > last ? at : last), '')]));
}

/** Where a shelved zone draws what it holds. */
export function layoutShelves(input: ShelfInput): ShelfLayout {
  const grid = zoneGrid(input.spacing);
  const { padding } = grid.gaps;

  const { head, top, right: headRight } = headRow(input);

  const stacks = stacksOf(input);
  const ended = endedOf(stacks, input.agents);
  const shelves: Shelf[] = [];
  let doneLine: ShelfLayout['doneLine'] = null;
  let right = padding;
  let rowTop = top;
  let bottom = top;
  for (const row of shelfRows(input.width, padding)) {
    let x = padding;
    let rowBottom = rowTop;
    for (const { stage, width } of row) {
      const on = stacks.filter((stack) => stack.stage === stage).sort(shelfOrder(stage, ended));
      let y = rowTop + SHELF_HEADING;
      if (stage === 'doing' || stage === 'todo') {
        // Rows of equal height, as many cards to a row as the shelf has columns.
        const { columns, card } = stage === 'doing' ? doingColumns(width) : { columns: 1, card: width };
        for (let first = 0; first < on.length; first += columns) {
          const cards = on.slice(first, first + columns);
          const height = Math.max(...cards.map((stack) => cardHeight(stack.members.length, input.footOf(stack.members))));
          cards.forEach((stack, column) => Object.assign(stack, { x: x + column * (card + CARD_GAP), y, width: card, height, placed: true }));
          y += height + CARD_GAP;
        }
      } else if (stage === 'waiting') {
        for (const stack of on) {
          Object.assign(stack, { x, y, width, height: WAITING_ROW_HEIGHT, placed: true });
          y += WAITING_ROW_HEIGHT + CARD_GAP;
        }
      } else if (on.length > 0) {
        // Done: one line, then its chips once shown. One that needs the user is never folded away.
        doneLine = { x, y, width, height: DONE_LINE_HEIGHT, count: on.length, shown: input.doneShown };
        y += DONE_LINE_HEIGHT + CARD_GAP;
        for (const stack of on) {
          if (!input.doneShown && !stack.needsYou) continue;
          Object.assign(stack, { x, y, width, height: CHIP_SIZE.height, placed: true });
          y += CHIP_SIZE.height + CARD_GAP / 2;
        }
      }
      shelves.push({ stage, count: on.length, x, y: rowTop, width, height: Math.max(SHELF_HEADING, y - rowTop) });
      rowBottom = Math.max(rowBottom, y);
      x += width + SHELF_GAP;
    }
    right = Math.max(right, x - SHELF_GAP);
    bottom = Math.max(bottom, rowBottom);
    rowTop = rowBottom + SHELF_GAP;
  }

  // The open stack's tiles, in a row below the shelves from its card's left, each at its compact size: in the free
  // space there, never over a card (one that needs you included), moving nothing.
  const fanTop = bottom + FAN_GAP + PERCH_ROOM;
  const opened = stacks.find((stack) => stack.key === input.open && stack.placed);
  const fan: ShelfLayout['fan'] = [];
  if (opened !== undefined) {
    let fanX = opened.x;
    for (const id of opened.members) {
      const key = tileSizeKey('agent', id);
      fan.push({ key, x: fanX, y: fanTop });
      fanX += input.sizeOf(key).width + tileStep(input.spacing);
    }
  }
  return {
    head,
    shelves,
    stacks: stacks.toSorted((a, b) => SHELF_STAGES.indexOf(a.stage) - SHELF_STAGES.indexOf(b.stage) || shelfOrder(a.stage, ended)(a, b)),
    doneLine,
    fan,
    fanTop,
    size: { width: Math.max(right, headRight) + padding, height: bottom + padding },
  };
}

/** A cluster: one unit of work's tiles drawn together, at their compact sizes, in a dashed outline headed by its label. */
export interface ShelfCluster extends ShelfStack {
  /** A single tile: the tile is the group, drawn with no outline or label of its own. */
  solo: boolean;
  /** Its tiles' places, by node key, relative to the zone: in rows under its label, as many across as the zone holds. */
  tiles: { key: string; x: number; y: number }[];
}

/** What a zone in clusters draws, relative to the zone. */
export interface ClusterLayout {
  head: ShelfLayout['head'];
  /**
   * Every cluster, with its place. Done's are `placed` (drawn) only once Done is shown; while it is folded they keep the
   * place they would be drawn at, so a jump to one knows where it will be.
   */
  clusters: ShelfCluster[];
  /** Done's one line, "N done · Show", after the others, drawn while it has any. */
  doneLine: ShelfLayout['doneLine'];
  /** The least size the zone is drawn at to hold all this. */
  size: Size;
}

/** The space inside a cluster's outline round its tiles. */
export const CLUSTER_PADDING = 8;
/** The gap between a cluster's tiles: room for the chip midway along an edge joining two of them. */
const CLUSTER_TILE_GAP = 24;
/** The row at the top of a cluster's outline for its label, above the room for what perches on its tiles. */
const CLUSTER_LABEL_ROOM = 16;
/** The gap between clusters: twice the zone's tile gap, and never less than 40, so groups read apart from their tiles. */
const clusterGap = (spacing: ShelfInput['spacing']) => Math.max(2 * tileStep(spacing), 40);

/** A cluster's place in line: what needs the user first, then Doing, Waiting and To do, then Done. */
const clusterRank = (stack: ShelfStack) => (stack.needsYou ? 0 : stack.stage === 'doing' ? 1 : stack.stage === 'waiting' ? 2 : stack.stage === 'todo' ? 3 : 4);

/**
 * Where a zone in clusters draws what it holds: its head row as on shelves, then each unit of work's tiles as a cluster,
 * what needs the user nearest the top-left, packed left to right in rows within the zone's saved width; then Done's
 * line, its clusters after it once shown. Each is ordered as on its shelf. A cluster with more tiles than fit across
 * wraps them into rows, so the zone grows downward only. Only where things are drawn: no tile's saved place is read or
 * written.
 */
export function layoutClusters(input: Omit<ShelfInput, 'footOf' | 'open'>): ClusterLayout {
  const grid = zoneGrid(input.spacing);
  const { padding } = grid.gaps;
  // Tiles in a cluster sit close, room enough between them for the chip on the edge that joins them; clusters stand
  // well apart.
  const step = CLUSTER_TILE_GAP;
  const gap = clusterGap(input.spacing);
  const { head, top, right: headRight } = headRow(input);
  const stacks = stacksOf(input);
  const ended = endedOf(stacks, input.agents);
  stacks.sort((a, b) => clusterRank(a) - clusterRank(b) || shelfOrder(a.stage, ended)(a, b));
  const clusters = stacks.map((stack): ShelfCluster => ({ ...stack, solo: stack.members.length === 1, tiles: [] }));
  const limit = Math.max(input.width - padding, padding);
  // The most a cluster's tiles reach across, from its outline's inside: a row of the zone's, less the outline's padding.
  const inner = limit - padding - 2 * CLUSTER_PADDING;
  let x = padding;
  let y = top;
  let rowHeight = 0;
  let right = padding;
  let bottom = top;
  const place = (cluster: ShelfCluster, drawn: boolean) => {
    // A solo tile has no outline to pad, and no label.
    const pad = cluster.solo ? 0 : CLUSTER_PADDING;
    const label = cluster.solo ? 0 : CLUSTER_LABEL_ROOM;
    const sizes = cluster.members.map((id) => input.sizeOf(tileSizeKey('agent', id)));
    // Its tiles in rows, as many across as fit (one at least), each row with room above for what perches on its tiles.
    const rows: number[][] = [];
    let across = 0;
    for (const [at, size] of sizes.entries()) {
      const row = rows.at(-1);
      if (row !== undefined && across + step + size.width <= inner) {
        row.push(at);
        across += step + size.width;
      } else {
        rows.push([at]);
        across = size.width;
      }
    }
    const rowWidth = (row: number[]) => row.reduce((sum, at) => sum + sizes[at]!.width, 0) + (row.length - 1) * step;
    const rowTall = (row: number[]) => PERCH_ROOM + Math.max(...row.map((at) => sizes[at]!.height));
    const width = 2 * pad + Math.max(...rows.map(rowWidth));
    const height = 2 * pad + label + rows.reduce((sum, row) => sum + rowTall(row), 0) + (rows.length - 1) * step;
    // A new row when it would reach past the zone's edge, unless it is the first of its row.
    if (x > padding && x + width > limit) {
      x = padding;
      y += rowHeight + gap;
      rowHeight = 0;
    }
    cluster.tiles = [];
    let tileY = y + pad + label;
    for (const row of rows) {
      let tileX = x + pad;
      for (const at of row) {
        cluster.tiles.push({ key: tileSizeKey('agent', cluster.members[at]!), x: tileX, y: tileY + PERCH_ROOM });
        tileX += sizes[at]!.width + step;
      }
      tileY += rowTall(row) + step;
    }
    Object.assign(cluster, { x, y, width, height, placed: drawn });
    x += width + gap;
    rowHeight = Math.max(rowHeight, height);
    if (!drawn) return;
    right = Math.max(right, x - gap);
    bottom = Math.max(bottom, y + height);
  };
  const done = clusters.filter((cluster) => cluster.stage === 'done' && !cluster.needsYou);
  for (const cluster of clusters) if (!done.includes(cluster)) place(cluster, true);
  let doneLine: ClusterLayout['doneLine'] = null;
  if (done.length > 0) {
    // On a row of its own, after the rest.
    if (x > padding) y += rowHeight + gap;
    doneLine = { x: padding, y, width: CHIP_SIZE.width, height: DONE_LINE_HEIGHT, count: done.length, shown: input.doneShown };
    right = Math.max(right, padding + CHIP_SIZE.width);
    bottom = Math.max(bottom, y + DONE_LINE_HEIGHT);
    x = padding;
    y += DONE_LINE_HEIGHT + CARD_GAP;
    rowHeight = 0;
    // Placed while folded too, but not drawn, and not counted in the zone's size.
    for (const cluster of done) place(cluster, input.doneShown);
  }
  return { head, clusters, doneLine, size: { width: Math.max(right, headRight) + padding, height: bottom + padding } };
}
