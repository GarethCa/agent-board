// Arrange: an orchestrator's crew laid out tidily in its zone (`agent-board arrange`). Like Tidy (`board-tidy.ts`), but
// grouped: a row per issue (or role, or state), each pair joined by an edge side by side so their edge is a short
// straight line, never crossing another. Pure and deterministic, so every case is unit-tested.
import {
  AGENT_TILE_SIZE,
  clearOf,
  GRID_COLUMN,
  gridPoint,
  gridRowAtOrBelow,
  gridSpan,
  MAX_SEARCH_STEPS,
  PERCH_ROOM,
  RAIL_GAP,
  ROW_STEP,
  sizedFootprint,
  TILE_GAP,
  ZONE_PADDING,
  zoneHeightFor,
  type Point,
  type Rect,
  type Size,
} from './board-layout.ts';
import { MIN_ZONE_SIZE, type AgentRole, type AgentState, type ArrangeBy, type ArrangeLayout } from './protocol.ts';
import { cutText } from './text-cut.ts';

/** A tile to arrange: what it is grouped and ordered by. */
export interface ArrangeTile {
  /** Unique among the tiles. */
  id: string;
  name: string;
  kind: 'agent' | 'shell';
  role: AgentRole | null;
  /** Its linked issue's ID, or null. */
  issue: string | null;
  /** An agent's state; null for a shell. */
  state: AgentState | null;
  /** The id of the tile it reviews, if any: it sits beside that one, as if an edge joined them. */
  reviewOf: string | null;
  /** The orchestrator arranging: it goes first, on its own, and its edges chain no one. */
  lead: boolean;
  /** Its size if it was resized; `AGENT_TILE_SIZE` without. */
  size?: Size;
  /** Its linked issue's title, for its cluster's label. */
  issueTitle?: string | null;
  /** The branch it works on, or a reviewer the one it reviews: its ticket labels its cluster when it has no issue. */
  branch?: string | null;
  /** When it was started (ISO time): between tiles of one role, the one started first goes first. */
  createdAt?: string;
}

/** An edge between two of the tiles, from the one that hands off to the one it hands to. */
export interface ArrangeLink {
  from: string;
  to: string;
}

export interface ArrangeOptions {
  by: ArrangeBy;
  layout: ArrangeLayout;
  /** The zone's width now: a grid fills it, and it never narrows. */
  width: number;
  /** What it may not move (notes, cards, tiles out of scope), relative to the zone: every tile keeps a gap from them. */
  obstacles?: readonly Rect[];
  /**
   * Lay each issue's lane out as a cluster: its label in the first column, then its tiles, then its note. Only by issue,
   * in rows.
   */
  clusters?: boolean;
  /** How tall each cluster's note needs to be to show its text, by the cluster's key: its lane makes room for it. */
  noteHeights?: ReadonlyMap<string, number>;
}

/** The parts of a cluster, as `arrangeTiles` places them: its label in the column before its tiles, its note after them. */
export const CLUSTER_LABEL_SIZE = { width: AGENT_TILE_SIZE.width, height: 28 };
/** A tile's size, so a lane's note takes a slot of its own as its tiles do: the least it is, taller for more text. */
export const CLUSTER_NOTE_SIZE = AGENT_TILE_SIZE;
/** In columns and cards, a lane's note shares its head cell with its label, below it: together a tile's size at least. */
const HEAD_NOTE_SIZE = { width: AGENT_TILE_SIZE.width, height: AGENT_TILE_SIZE.height - CLUSTER_LABEL_SIZE.height - TILE_GAP };
/** A lane's head cell with its label over a note `note` big. */
const headSize = (note: Size): Size => ({ width: note.width, height: CLUSTER_LABEL_SIZE.height + TILE_GAP + note.height });
/** The most characters of a cluster's label: about as many as fit its column on one line. */
const MAX_LABEL = 28;

/** One unit of work laid out as a cluster (a lane): what it is, and where its label and note go. */
export interface ArrangedCluster {
  /** Stable across arranges: `issue:<id>` for its issue or the ticket in its branch, else its first tile's id (`agent:<session id>`). */
  key: string;
  /** Its issue's ID and title, else the ticket in its branch, else the words its agents' names start with, else its first one's name. */
  label: string;
  /** Its tiles, in the order they go: an implementer before its reviewer. */
  members: string[];
  labelAt: Point;
  noteAt: Point;
  noteSize: Size;
}

/**
 * The grid columns, and rows, left empty between two tiles a rail joins, so its token and label fit between them
 * (`RAIL_GAP`): next to each other they are only a tile gap apart.
 */
const RAIL_COLUMNS = Math.ceil((RAIL_GAP - TILE_GAP) / GRID_COLUMN);
const RAIL_ROWS = Math.ceil((RAIL_GAP - (ROW_STEP - AGENT_TILE_SIZE.height)) / ROW_STEP);

/**
 * Roles in the order a unit's tiles go, and by role, the order of the rows: those that do the work first, then those
 * that review it, so a reviewer comes after what it reviews whatever that one's role.
 */
const ROLE_ORDER: readonly (AgentRole | null)[] = ['implementer', 'custom', null, 'reviewer', 'follow-up-reviewer'];

/** States in the order their rows go: the ones that need the user first, the ended last. */
const STATE_ORDER: readonly AgentState[] = [
  'needs-permission',
  'waiting',
  'failed',
  'rate-limited',
  'running',
  'thinking',
  'handing-off',
  'starting',
  'on-command',
  'idle',
  'scheduled',
  'hibernated',
  'stopped-by-restart',
  'done',
];

const sizeOf = (tile: ArrangeTile): Size => tile.size ?? AGENT_TILE_SIZE;
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** Issue IDs in their natural order: ACME-9 before ACME-12. */
const byIssue = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true }) || byText(a, b);
/** By role (an implementer first), then the one started first, then by name. */
const byTile = (a: ArrangeTile, b: ArrangeTile) =>
  ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) ||
  byText(a.createdAt ?? '', b.createdAt ?? '') ||
  byText(a.name.toLowerCase(), b.name.toLowerCase()) ||
  byText(a.id, b.id);

/**
 * The ticket a branch is named for, as Linear names them (`acme-199-…`, `someone/acme-199-…`): `ACME-199`; else null. Six
 * digits ending it are no ticket: they are the random suffix agent-board gives an agent's own branch (`impl-123456`).
 */
export function ticketOfBranch(branch: string | null | undefined): string | null {
  const match = /(?:^|\/)([a-z][a-z0-9]*-(\d+))(-|$)/i.exec(branch ?? '');
  if (match === null || (match[3] === '' && match[2]!.length === 6)) return null;
  return match[1]!.toUpperCase();
}

/** A chain's unit of work: the first issue in it, else the first ticket its branches name, so a reviewer goes with its implementer. */
const unitOf = (chain: readonly ArrangeTile[]): string | null =>
  chain.find((tile) => tile.issue !== null)?.issue ?? chain.map((tile) => ticketOfBranch(tile.branch)).find((ticket) => ticket !== null) ?? null;

/**
 * The agents joined by `links` (and each reviewer to what it reviews) in chains: each set of tiles joined together, in
 * the order they flow (`inFlowOrder`), and the chains in order of their unit of work, then their first tile. The lead
 * and shells are in none.
 */
function chainsOf(agents: readonly ArrangeTile[], links: readonly ArrangeLink[]): ArrangeTile[][] {
  const byId = new Map(agents.map((tile) => [tile.id, tile]));
  const joined = links.filter((link) => byId.has(link.from) && byId.has(link.to) && link.from !== link.to);
  const reviews = agents.filter((tile) => tile.reviewOf !== null && byId.has(tile.reviewOf) && tile.reviewOf !== tile.id);
  const neighbours = new Map(agents.map((tile) => [tile.id, new Set<string>()]));
  for (const { from, to } of [...joined, ...reviews.map((tile) => ({ from: tile.reviewOf!, to: tile.id }))]) {
    neighbours.get(from)!.add(to);
    neighbours.get(to)!.add(from);
  }
  // An edge from a reviewer back to what it reviews hands its findings back: the work still flows the other way.
  const flow = joined.filter((link) => byId.get(link.from)!.reviewOf !== link.to);
  const seen = new Set<string>();
  const chains: ArrangeTile[][] = [];
  for (const start of agents.toSorted(byTile)) {
    if (seen.has(start.id)) continue;
    const members: ArrangeTile[] = [];
    const queue = [start.id];
    seen.add(start.id);
    while (queue.length > 0) {
      const id = queue.shift()!;
      members.push(byId.get(id)!);
      for (const next of [...neighbours.get(id)!].sort(byText)) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    chains.push(inFlowOrder(members, flow));
  }
  return chains.toSorted((a, b) => {
    const [x, y] = [unitOf(a), unitOf(b)];
    if (x !== y) return x === null ? 1 : y === null ? -1 : byIssue(x, y);
    return byTile(a[0]!, b[0]!);
  });
}

/**
 * `members` in the order their work flows: a reviewer always after what it reviews, whatever their roles; else each
 * next the first by `byTile` that no edge left among the rest flows into. Edges both ways (or round a loop) leave every
 * tile one flowing in: then an implementer goes first, else the one started first.
 */
function inFlowOrder(members: readonly ArrangeTile[], flow: readonly ArrangeLink[]): ArrangeTile[] {
  const left = members.toSorted(byTile);
  const ordered: ArrangeTile[] = [];
  while (left.length > 0) {
    const ids = new Set(left.map((tile) => tile.id));
    const reviewed = left.filter((tile) => tile.reviewOf === null || tile.reviewOf === tile.id || !ids.has(tile.reviewOf));
    // Reviewers round a loop (none can be): the first by role and name starts it.
    const ready = reviewed.length > 0 ? reviewed : left;
    const next = ready.find((tile) => !flow.some((link) => link.to === tile.id && ids.has(link.from))) ?? ready[0]!;
    ordered.push(next);
    left.splice(left.indexOf(next), 1);
  }
  return ordered;
}

/** A row of tiles, left to right, each in a column of the layout's, so tiles in different rows line up. */
interface Row {
  tiles: ArrangeTile[];
  columns: number[];
  /** Whether it is a unit of work (an issue's, or a chain's), which can be laid out as a cluster. */
  unit: boolean;
}

/** A lane's slots, left to right: what does its work, what reviews it, what reviews it again. */
export const LANE_SLOTS = ['implementer', 'reviewer', 'follow-up'] as const;
export type LaneSlot = (typeof LANE_SLOTS)[number];

/** The slot of a lane a tile goes in: a reviewer's (or whatever reviews another), a follow-up reviewer's, else the work's. */
const slotOf = (tile: Pick<ArrangeTile, 'role' | 'reviewOf'>): LaneSlot =>
  tile.role === 'follow-up-reviewer' ? 'follow-up' : tile.role === 'reviewer' || tile.reviewOf !== null ? 'reviewer' : 'implementer';

/**
 * Lanes as rows: each unit's tiles in its slots' columns, every slot as many columns wide as its fullest lane needs and
 * none for a slot no lane uses, so every lane's tiles line up. Its note goes right after its own last tile, so a short
 * lane leaves no run of free slots before it.
 */
function laneRows(units: readonly ArrangeTile[][]): Row[] {
  const slotted = units.map((unit) => LANE_SLOTS.map((slot) => unit.filter((tile) => slotOf(tile) === slot)));
  const widths = LANE_SLOTS.map((_, index) => Math.max(0, ...slotted.map((slots) => slots[index]!.length)));
  const starts = widths.map((_, index) => widths.slice(0, index).reduce((sum, width) => sum + width, 0));
  return slotted.map((slots) => ({
    tiles: slots.flat(),
    columns: slots.flatMap((tiles, index) => tiles.map((_, at) => starts[index]! + at)),
    unit: true,
  }));
}

/** Columns for the tiles of each role in `chain`, from 0: a reviewer in the column of what it reviews where it can. */
function roleColumns(chain: readonly ArrangeTile[]): Map<string, number> {
  const at = new Map<string, number>();
  for (const role of ROLE_ORDER) {
    const used = new Set<number>();
    const rest: ArrangeTile[] = [];
    for (const tile of chain.filter((each) => each.role === role)) {
      const wanted = tile.reviewOf === null ? undefined : at.get(tile.reviewOf);
      if (wanted !== undefined && !used.has(wanted)) {
        at.set(tile.id, wanted);
        used.add(wanted);
      } else rest.push(tile);
    }
    for (const tile of rest) {
      let column = 0;
      while (used.has(column)) column++;
      at.set(tile.id, column);
      used.add(column);
    }
  }
  return at;
}

function rowsOf(tiles: readonly ArrangeTile[], links: readonly ArrangeLink[], by: ArrangeBy): Row[] {
  const lead = tiles.filter((tile) => tile.lead).toSorted(byTile);
  const shells = tiles.filter((tile) => !tile.lead && tile.kind === 'shell').toSorted(byTile);
  const chains = chainsOf(
    tiles.filter((tile) => !tile.lead && tile.kind === 'agent'),
    links,
  );
  const rows: Row[] = [];
  const add = (row: ArrangeTile[], columns: number[] = row.map((_, index) => index), unit = false) => {
    if (row.length > 0) rows.push({ tiles: row, columns, unit });
  };
  if (by === 'issue') {
    // The lead and the shells share the top row, above the lanes.
    add([...lead, ...shells]);
    const units = new Map<string, ArrangeTile[]>();
    for (const chain of chains) {
      const unit = unitOf(chain);
      if (unit !== null) units.set(unit, [...(units.get(unit) ?? []), ...chain]);
    }
    const lanes: ArrangeTile[][] = [];
    for (const chain of chains) {
      const unit = unitOf(chain);
      if (unit === null) lanes.push(chain);
      else if (units.has(unit)) {
        lanes.push(units.get(unit)!);
        units.delete(unit);
      }
    }
    // In the order their work started, so a new lane goes last and the others stay put.
    const started = (lane: readonly ArrangeTile[]) => lane.map((tile) => tile.createdAt ?? '').reduce((first, at) => (at !== '' && (first === '' || at < first) ? at : first), '');
    rows.push(...laneRows(lanes.toSorted((a, b) => byText(started(a), started(b)))));
    return rows;
  }
  add(lead);
  if (by === 'role') {
    // Each chain takes as many columns as its roles need, side by side.
    const columns = new Map<string, number>();
    let next = 0;
    for (const chain of chains) {
      const own = roleColumns(chain);
      for (const [id, column] of own) columns.set(id, next + column);
      next += Math.max(...own.values()) + 1;
    }
    for (const role of ROLE_ORDER) {
      const row = chains.flat().filter((tile) => tile.role === role);
      add(
        row.toSorted((a, b) => columns.get(a.id)! - columns.get(b.id)!),
        row.map((tile) => columns.get(tile.id)!).sort((a, b) => a - b),
      );
    }
  } else {
    const ordered = chains.flat();
    for (const state of STATE_ORDER) add(ordered.filter((tile) => tile.state === state));
  }
  add(shells);
  return rows;
}

/** The words every one of `names` starts with, without trailing punctuation; '' for none, or for one name. */
function commonStart(names: readonly string[]): string {
  if (names.length < 2) return '';
  const words = names.map((name) => name.trim().split(/\s+/));
  const shared: string[] = [];
  for (const [index, word] of words[0]!.entries()) {
    if (!words.every((each) => each[index] === word)) break;
    shared.push(word);
  }
  // A last word shared only up to a colon or dash in one name is still a word of its own: trim what ends it.
  return shared.join(' ').replace(/[\s:;,.·–—-]+$/u, '');
}

/** A cluster's label: its issue, else its branch's ticket, else what its agents' names start with, else its first's name. */
function labelOf(row: readonly ArrangeTile[]): string {
  const linked = row.find((tile) => tile.issue !== null);
  if (linked !== undefined) return cutText(`${linked.issue}${linked.issueTitle ? ` ${linked.issueTitle}` : ''}`, MAX_LABEL);
  const ticket = unitOf(row);
  if (ticket !== null) return ticket;
  return cutText(commonStart(row.map((tile) => tile.name)) || row[0]!.name, MAX_LABEL);
}

/** A lane's key, stable across arranges: `issue:<id>` for its issue or the ticket in its branch, else its first tile's id. */
function laneKey(tiles: readonly ArrangeTile[]): string {
  const unit = tiles.find((tile) => tile.issue !== null)?.issue ?? unitOf(tiles);
  return unit === null ? tiles[0]!.id : `issue:${unit}`;
}

/** A zone's crew as lanes, by issue: what the top row holds (the lead, then the shells), and each lane's tiles by slot. */
export interface Lanes {
  top: ArrangeTile[];
  lanes: { key: string; label: string; slots: Record<LaneSlot, ArrangeTile[]> }[];
}

/** `tiles` as an arrange by issue puts them in lanes, whatever their places. */
export function lanesOf(tiles: readonly ArrangeTile[], links: readonly ArrangeLink[]): Lanes {
  const rows = rowsOf(tiles, links, 'issue');
  return {
    top: rows.filter((row) => !row.unit).flatMap((row) => row.tiles),
    lanes: rows
      .filter((row) => row.unit)
      .map((row) => ({
        key: laneKey(row.tiles),
        label: labelOf(row.tiles),
        slots: Object.fromEntries(LANE_SLOTS.map((slot) => [slot, row.tiles.filter((tile) => slotOf(tile) === slot)])) as Record<LaneSlot, ArrangeTile[]>,
      })),
  };
}

/**
 * Whether an edge joins the tiles `a` and `b`, either way: the board draws the edges between two agents as one rail.
 * A reviewer joined by none draws none.
 */
const joins = (links: readonly ArrangeLink[], a: string, b: string) => links.some((link) => (link.from === a && link.to === b) || (link.from === b && link.to === a));

/** The least box holding both `a` and `b`. */
const hull = (a: Rect, b: Rect): Rect => {
  const [x, y] = [Math.min(a.x, b.x), Math.min(a.y, b.y)];
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
};

/** Where `tiles` go as a grid filling a zone `width` wide in their order, each on the grid and clear of `obstacles`. */
function gridFill(tiles: readonly ArrangeTile[], obstacles: readonly Rect[], width: number): Map<string, Point> {
  const perRow = Math.max(1, Math.floor((width - 2 * ZONE_PADDING + TILE_GAP) / GRID_COLUMN));
  const positions = new Map<string, Point>();
  const taken = [...obstacles];
  let index = 0;
  for (const tile of tiles) {
    const size = sizeOf(tile);
    const { columns } = gridSpan(size);
    const start = index;
    const fits = (at: number) => {
      const column = at % perRow;
      return (column === 0 || column + columns <= perRow) && clearOf(sizedFootprint(gridPoint(column, Math.floor(at / perRow)), size), taken);
    };
    while (index - start < MAX_SEARCH_STEPS && !fits(index)) index++;
    // Past the cap, on the first row below everything placed: never on top of it.
    const spot =
      index - start < MAX_SEARCH_STEPS
        ? gridPoint(index % perRow, Math.floor(index++ / perRow))
        : gridPoint(0, gridRowAtOrBelow(Math.max(...taken.map((rect) => rect.y + rect.height)) + TILE_GAP + PERCH_ROOM));
    positions.set(tile.id, spot);
    taken.push(sizedFootprint(spot, size));
  }
  return positions;
}

/**
 * The tiles a grid lays out as rows do: every tile an edge joins to another of `tiles`, and the rest of its unit of
 * work (its chain, or by issue its issue's row), so a unit joined by edges keeps the layout its rails have room in.
 */
function joinedUnits(tiles: readonly ArrangeTile[], links: readonly ArrangeLink[], rows: readonly Row[], by: ArrangeBy): Set<string> {
  const ids = new Set(tiles.map((tile) => tile.id));
  const joined = new Set(links.filter((link) => link.from !== link.to && ids.has(link.from) && ids.has(link.to)).flatMap((link) => [link.from, link.to]));
  const units =
    by === 'issue'
      ? rows.filter((row) => row.unit).map((row) => row.tiles)
      : chainsOf(
          tiles.filter((tile) => !tile.lead && tile.kind === 'agent'),
          links,
        );
  for (const unit of units) if (unit.some((tile) => joined.has(tile.id))) for (const tile of unit) joined.add(tile.id);
  return joined;
}

/**
 * Where each of `tiles` goes in its zone (relative to it) when arranged, and the least size the zone must be to hold
 * them: at least its width now. Every tile goes on the zone's grid (`gridPoint`). `rows` puts each group on its own
 * row, every row's tiles in shared columns, each row pushed down whole past anything in its way; `grid` fills the zone's
 * width in the same order, as Tidy does.
 */
export function arrangeTiles(
  tiles: readonly ArrangeTile[],
  links: readonly ArrangeLink[],
  options: ArrangeOptions,
): { positions: Map<string, Point>; clusters: ArrangedCluster[]; size: Size } {
  const obstacles = options.obstacles ?? [];
  const clusters: ArrangedCluster[] = [];
  // A lane's note is as tall as its text needs, and never less than its slot (`least`).
  const noteSizeOf = (key: string, least: Size): Size => ({ width: least.width, height: Math.max(least.height, options.noteHeights?.get(key) ?? 0) });
  const rows = rowsOf(tiles, links, options.by);
  let positions: Map<string, Point>;
  if (options.layout === 'columns' || options.layout === 'cards') {
    const isCluster = (row: Row) => options.clusters === true && options.by === 'issue' && row.unit;
    const headOf = (row: Row) => headSize(noteSizeOf(laneKey(row.tiles), HEAD_NOTE_SIZE));
    const cells = (options.layout === 'columns' ? columnCells : cardCells)(rows, isCluster, headOf);
    positions = placeCells(cells, links, obstacles);
    for (const row of rows.filter(isCluster)) {
      const key = laneKey(row.tiles);
      const labelAt = positions.get(headId(key))!;
      positions.delete(headId(key));
      clusters.push({ key, label: labelOf(row.tiles), members: row.tiles.map((tile) => tile.id), labelAt, noteAt: noteBelow(labelAt), noteSize: noteSizeOf(key, HEAD_NOTE_SIZE) });
    }
  } else if (options.layout === 'grid') {
    // A unit joined by edges goes as rows lay it out, from the top, and only the tiles no edge joins fill the grid, round
    // it: clear of its tiles and of the box round each two its rails join, where its rails and their tokens are.
    const inRows = joinedUnits(tiles, links, rows, options.by);
    const block = tiles.filter((tile) => inRows.has(tile.id));
    positions = block.length === 0 ? new Map() : arrangeTiles(block, links, { ...options, layout: 'rows', clusters: false }).positions;
    const footprint = (tile: ArrangeTile) => sizedFootprint(positions.get(tile.id)!, sizeOf(tile));
    const railed = links.flatMap((link) => {
      const [from, to] = [block.find((tile) => tile.id === link.from), block.find((tile) => tile.id === link.to)];
      return from === undefined || to === undefined || from === to ? [] : [hull(footprint(from), footprint(to))];
    });
    const rest = rows.flatMap((row) => row.tiles).filter((tile) => !inRows.has(tile.id));
    for (const [id, spot] of gridFill(rest, [...obstacles, ...block.map(footprint), ...railed], options.width)) positions.set(id, spot);
  } else {
    positions = new Map();
    // A cluster's label takes the column before its tiles.
    const isCluster = (row: Row) => options.clusters === true && options.by === 'issue' && row.unit;
    const columnsOf = (row: Row) => row.columns.map((column) => column + (isCluster(row) ? 1 : 0));
    const noteColumn = (row: Row) => Math.max(-1, ...row.columns) + 2;
    // Every column as many grid columns wide as its widest tile, in every row, so columns line up; and a rail's room
    // wider than a tile of a row a rail runs past the right of, in every row too: past each tile from either end of the
    // rail to the tile before the other, so its token has room whichever end it is at, never on a tile between them.
    // By issue a row is a lane: there a tile wider than a grid column (expanded, or resized) widens its column in its own
    // lane only, so the rest of it goes past and no other lane's tiles and note are spread apart by it. By role or state
    // the rows line up whole, so a reviewer stays under what it reviews. The lead's row lines up with none: its tiles go
    // at their own widths.
    const spansOf = (spanned: readonly Row[], widthOf: (tile: ArrangeTile) => number = (tile) => gridSpan(sizeOf(tile)).columns): number[] => {
      const spans: number[] = [];
      for (const row of spanned) {
        const columns = columnsOf(row);
        const railAfter = new Set<number>();
        for (const [index, column] of columns.entries()) {
          for (const [other, to] of columns.entries()) {
            if (to > column && joins(links, row.tiles[index]!.id, row.tiles[other]!.id)) for (let between = column; between < to; between++) railAfter.add(between);
          }
        }
        columns.forEach((column, index) => {
          const rail = railAfter.has(column) ? RAIL_COLUMNS : 0;
          spans[column] = Math.max(spans[column] ?? 1, widthOf(row.tiles[index]!) + rail);
        });
      }
      return spans;
    };
    const leads = (row: Row) => row.tiles.some((tile) => tile.lead);
    const byLane = options.by === 'issue';
    const shared = spansOf(
      rows.filter((row) => !leads(row)),
      byLane ? () => 1 : undefined,
    );
    /** The widths of `row`'s columns: the shared ones, a lane's each widened for a wider tile of its own. */
    const spansIn = (row: Row): number[] => {
      if (leads(row)) return spansOf([row]);
      if (!byLane) return shared;
      return widenedBy(shared, spansOf([row]));
    };
    const gridColumnOf = (spans: readonly number[], column: number) => Array.from({ length: column }, (_, index) => spans[index] ?? 1).reduce((sum, span) => sum + span, 0);
    // A rail's room above each row a rail crosses the top of: one from a row above it to it, or to a row below it.
    const rowOf = new Map(rows.flatMap((row, index) => row.tiles.map((tile) => [tile.id, index] as const)));
    const crossings = links.flatMap((link) => {
      const [from, to] = [rowOf.get(link.from), rowOf.get(link.to)];
      return from === undefined || to === undefined || from === to ? [] : [[Math.min(from, to), Math.max(from, to)] as const];
    });
    const railAbove = (index: number) => crossings.some(([top, bottom]) => top < index && index <= bottom);
    let next = 0;
    for (const [rowIndex, row] of rows.entries()) {
      const cluster = isCluster(row);
      const spans = spansIn(row);
      const columns = columnsOf(row).map((column) => gridColumnOf(spans, column));
      const noteSize = noteSizeOf(laneKey(row.tiles), CLUSTER_NOTE_SIZE);
      if (railAbove(rowIndex)) next += RAIL_ROWS;
      const labelAt = (at: number) => gridPoint(0, at);
      const noteAt = (at: number) => gridPoint(gridColumnOf(spans, noteColumn(row)), at);
      const parts = (at: number): Rect[] => [
        ...row.tiles.map((tile, index) => sizedFootprint(gridPoint(columns[index]!, at), sizeOf(tile))),
        ...(cluster
          ? [
              { ...labelAt(at), ...CLUSTER_LABEL_SIZE },
              { ...noteAt(at), ...noteSize },
            ]
          : []),
      ];
      // Down past the lowest obstacle in the way, a whole row at a time, until nothing is: each step passes one.
      let at = next;
      const blockedAt = (row: number) => obstacles.filter((obstacle) => parts(row).some((rect) => !clearOf(rect, [obstacle])));
      for (let step = 0; step <= obstacles.length && blockedAt(at).length > 0; step++) {
        at = Math.max(at + 1, gridRowAtOrBelow(Math.max(...blockedAt(at).map((obstacle) => obstacle.y + obstacle.height)) + TILE_GAP + PERCH_ROOM));
      }
      // Never past the cap still in the way: the first grid row below every obstacle.
      if (blockedAt(at).length > 0) at = gridRowAtOrBelow(Math.max(...obstacles.map((obstacle) => obstacle.y + obstacle.height)) + TILE_GAP + PERCH_ROOM);
      row.tiles.forEach((tile, index) => positions.set(tile.id, gridPoint(columns[index]!, at)));
      if (cluster) {
        clusters.push({
          key: laneKey(row.tiles),
          label: labelOf(row.tiles),
          members: row.tiles.map((tile) => tile.id),
          labelAt: labelAt(at),
          noteAt: noteAt(at),
          noteSize,
        });
      }
      // As many grid rows as its tallest tile, or its note.
      next = at + Math.max(...row.tiles.map((tile) => gridSpan(sizeOf(tile)).rows), cluster ? gridSpan(noteSize).rows : 1);
    }
  }
  const placed = [
    ...tiles.map((tile) => ({ ...positions.get(tile.id)!, ...sizeOf(tile) })),
    ...clusters.flatMap((cluster) => [
      { ...cluster.labelAt, ...CLUSTER_LABEL_SIZE },
      { ...cluster.noteAt, ...cluster.noteSize },
    ]),
  ];
  return { positions, clusters, size: fittedSize(placed, obstacles) };
}

/** `shared` column widths, each widened to `own`'s where that is wider: for a lane's, or a line of cards', own wider tiles. */
const widenedBy = (shared: readonly number[], own: readonly number[]): number[] =>
  Array.from({ length: Math.max(shared.length, own.length) }, (_, column) => Math.max(shared[column] ?? 1, own[column] ?? 1));

/** Something put in a cell of a layout's own grid, before sizes and rails widen its columns and rows: a tile, or a lane's head. */
interface Cell {
  id: string;
  size: Size;
  column: number;
  row: number;
  /** Lined up with no other row's cells, at its own row's widths: the top row above lanes, or the lead's, so neither widens a lane's column. */
  alone?: boolean;
  /**
   * The line of cards it is in: lines share columns as compact tiles, and a wider tile (expanded, or resized) widens its
   * column within its own line only, so no card in another line is spread apart by it.
   */
  band?: number;
}

/** A lane's head cell's id among the tiles' (where its label and note go). */
const headId = (key: string) => `#head:${key}`;
/** Where a lane's note goes in its head cell: below its label. */
const noteBelow = (labelAt: Point): Point => ({ x: labelAt.x, y: labelAt.y + CLUSTER_LABEL_SIZE.height + TILE_GAP });

/** A row's tiles in the order a lane takes them: by slot (implementer, reviewer, follow-up), or as they are for a row by role or state. */
const inSlotOrder = (row: Row): ArrangeTile[] => (row.unit ? LANE_SLOTS.flatMap((slot) => row.tiles.filter((tile) => slotOf(tile) === slot)) : row.tiles);

/** Lanes as columns: the lead and shells stacked in the first, then a column per lane, its head cell first, its tiles under it. */
function columnCells(rows: readonly Row[], isCluster: (row: Row) => boolean, headOf: (row: Row) => Size): Cell[] {
  return rows.flatMap((row, column) => {
    const head = isCluster(row) ? [{ id: headId(laneKey(row.tiles)), size: headOf(row) }] : [];
    return [...head, ...inSlotOrder(row).map((tile) => ({ id: tile.id, size: sizeOf(tile) }))].map((cell, index) => ({ ...cell, column, row: index }));
  });
}

/**
 * A card per lane, flowed two across (three past four lanes) below the lead's row: on its first row its head cell, its
 * implementer and its reviewers; on its second, under them, its follow-up reviewers. Every card as wide as the widest,
 * an empty grid column between cards and an empty grid row between their rows, so each reads as a block of its own.
 */
function cardCells(rows: readonly Row[], isCluster: (row: Row) => boolean, headOf: (row: Row) => Size): Cell[] {
  const top = rows.filter((row) => !row.unit);
  const lanes = rows.filter((row) => row.unit);
  const cards = lanes.map((row) => {
    const head = isCluster(row) ? [{ id: headId(laneKey(row.tiles)), size: headOf(row) }] : [];
    const tiles = inSlotOrder(row).map((tile) => ({ id: tile.id, size: sizeOf(tile), slot: row.unit ? slotOf(tile) : 'implementer' }));
    const first = [...head, ...tiles.filter((tile) => tile.slot !== 'follow-up')];
    const second = tiles.filter((tile) => tile.slot === 'follow-up');
    return [first.map((cell, column) => ({ ...cell, column, row: 0 })), second.map((cell, column) => ({ ...cell, column: head.length + column, row: 1 }))].flat();
  });
  const across = lanes.length > 4 ? 3 : 2;
  const width = Math.max(1, ...cards.flat().map((cell) => cell.column + 1));
  // Above lanes (by issue), the top row of the lead and the shells lines up with no card; by role or state, the rows
  // are all top rows, lined up with each other but the lead's.
  const alone = (row: Row) => lanes.length > 0 || row.tiles.some((tile) => tile.lead);
  const cells: Cell[] = top.flatMap((row, index) =>
    row.tiles.map((tile, column) => ({ id: tile.id, size: sizeOf(tile), column, row: index, ...(alone(row) ? { alone: true } : {}) })),
  );
  let row = top.length;
  for (let start = 0; start < cards.length; start += across) {
    const line = cards.slice(start, start + across);
    const band = start / across;
    line.forEach((card, index) => cells.push(...card.map(({ id, size, column, row: within }) => ({ id, size, column: index * (width + 1) + column, row: row + within, band }))));
    row += Math.max(...line.flat().map((cell) => cell.row + 1)) + 1;
  }
  return cells;
}

/**
 * Where `cells` go on the zone's grid: every column as many grid columns wide as its widest cell (a line of cards' widest
 * in its own line, the lead's row's its own: `Cell.band`, `Cell.alone`), and a rail's room past each column a rail runs
 * along within a row; every row as tall as its tallest, and a rail's room above each row a rail
 * crosses; each row pushed down whole past what it may not move (`obstacles`).
 */
function placeCells(cells: readonly Cell[], links: readonly ArrangeLink[], obstacles: readonly Rect[]): Map<string, Point> {
  const byId = new Map(cells.map((cell) => [cell.id, cell]));
  const railAfter = new Set<number>();
  const railAbove = new Set<number>();
  for (const { from, to } of links) {
    const [a, b] = [byId.get(from), byId.get(to)];
    if (a === undefined || b === undefined || a === b) continue;
    if (a.row === b.row) for (let column = Math.min(a.column, b.column); column < Math.max(a.column, b.column); column++) railAfter.add(column);
    else for (let row = Math.min(a.row, b.row) + 1; row <= Math.max(a.row, b.row); row++) railAbove.add(row);
  }
  /** Each column's width, as wide as its widest of `spanned` (by `widthOf`), and a rail's room past it. */
  const spansOf = (spanned: readonly Cell[], widthOf = (cell: Cell) => gridSpan(cell.size).columns) =>
    Array.from({ length: Math.max(0, ...spanned.map((cell) => cell.column + 1)) }, (_, column) =>
      Math.max(1, ...spanned.filter((cell) => cell.column === column).map(widthOf)) + (railAfter.has(column) ? RAIL_COLUMNS : 0),
    );
  // A cell in a line of cards counts as a grid column wide here: its own line is widened for it (`band`).
  const shared = spansOf(
    cells.filter((cell) => cell.alone !== true),
    (cell) => (cell.band === undefined ? gridSpan(cell.size).columns : 1),
  );
  const spansFor = (cell: Cell): number[] => {
    if (cell.alone === true) return spansOf(cells.filter((other) => other.alone === true && other.row === cell.row));
    if (cell.band === undefined) return shared;
    return widenedBy(
      shared,
      spansOf(cells.filter((other) => other.band === cell.band)),
    );
  };
  const gridColumn = (cell: Cell) => spansFor(cell).slice(0, cell.column).reduce((sum, span) => sum + span, 0);
  const positions = new Map<string, Point>();
  const rows = Math.max(0, ...cells.map((cell) => cell.row + 1));
  let next = 0;
  for (let row = 0; row < rows; row++) {
    const inRow = cells.filter((cell) => cell.row === row);
    // An empty row is a grid row of space.
    if (inRow.length === 0) {
      next += 1;
      continue;
    }
    if (railAbove.has(row)) next += RAIL_ROWS;
    const parts = (at: number) => inRow.map((cell) => sizedFootprint(gridPoint(gridColumn(cell), at), cell.size));
    const blockedAt = (at: number) => obstacles.filter((obstacle) => parts(at).some((rect) => !clearOf(rect, [obstacle])));
    let at = next;
    // Down past the lowest obstacle in the way, a whole row at a time, until nothing is: each step passes one.
    for (let step = 0; step <= obstacles.length && blockedAt(at).length > 0; step++) {
      at = Math.max(at + 1, gridRowAtOrBelow(Math.max(...blockedAt(at).map((obstacle) => obstacle.y + obstacle.height)) + TILE_GAP + PERCH_ROOM));
    }
    if (blockedAt(at).length > 0) at = gridRowAtOrBelow(Math.max(...obstacles.map((obstacle) => obstacle.y + obstacle.height)) + TILE_GAP + PERCH_ROOM);
    for (const cell of inRow) positions.set(cell.id, gridPoint(gridColumn(cell), at));
    next = at + Math.max(...inRow.map((cell) => gridSpan(cell.size).rows));
  }
  return positions;
}

/**
 * The size a zone fits what it holds at: what was laid out in it (`placed`) and what stays put (`fixed`), with its
 * padding and a tile's gap below; never less than a zone's least size. Smaller than it was, it shrinks.
 */
export function fittedSize(placed: readonly Rect[], fixed: readonly Rect[]): Size {
  const width = Math.max(MIN_ZONE_SIZE.width, ...[...placed, ...fixed].map((rect) => rect.x + rect.width + ZONE_PADDING));
  const height = Math.max(
    MIN_ZONE_SIZE.height,
    zoneHeightFor(0, width),
    ...placed.map((rect) => rect.y + rect.height + TILE_GAP + ZONE_PADDING),
    ...fixed.map((rect) => rect.y + rect.height + ZONE_PADDING),
  );
  return { width, height };
}

/**
 * Where the parts of `clusters` (an arrange by issue's, by key) go when the crew is arranged another way, so none is
 * lost: each cluster a grid row of its own (more for a tall note, `noteSize` by its key) from the cell `from` down, its
 * label in `from`'s column and its note in the next, each row clear of `obstacles`.
 */
export function parkClusters(
  clusters: readonly string[],
  from: { column: number; row: number },
  obstacles: readonly Rect[],
  noteSize: (key: string) => Size = () => CLUSTER_NOTE_SIZE,
): Pick<ArrangedCluster, 'key' | 'labelAt' | 'noteAt'>[] {
  const { column } = from;
  let row = from.row;
  return clusters.map((key) => {
    const note = noteSize(key);
    const parts = (at: number): Rect[] => [
      { ...gridPoint(column, at), ...CLUSTER_LABEL_SIZE },
      { ...gridPoint(column + 1, at), ...note },
    ];
    const start = row;
    while (row - start < MAX_SEARCH_STEPS && !parts(row).every((rect) => clearOf(rect, obstacles))) row++;
    // Past the cap, on the first row below everything in the way: never on top of it.
    if (row - start >= MAX_SEARCH_STEPS) row = gridRowAtOrBelow(Math.max(...obstacles.map((rect) => rect.y + rect.height)) + TILE_GAP);
    const at = row;
    row += gridSpan(note).rows;
    return { key, labelAt: gridPoint(column, at), noteAt: gridPoint(column + 1, at) };
  });
}
