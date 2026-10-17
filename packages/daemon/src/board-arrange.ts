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
   * Lay each group out as a cluster: a label above it, a sticky at its start, then its tiles. Only in rows.
   */
  clusters?: boolean;
}

/** The parts of a cluster, as `arrangeTiles` places them: its label and sticky share the column before its tiles. */
export const CLUSTER_LABEL_SIZE = { width: AGENT_TILE_SIZE.width, height: 28 };
/** Between a cluster's label and its sticky, below it in their cell: the gap kept between any two things. */
const CLUSTER_PART_GAP = TILE_GAP;
export const CLUSTER_STICKY_SIZE = { width: AGENT_TILE_SIZE.width, height: AGENT_TILE_SIZE.height - CLUSTER_LABEL_SIZE.height - CLUSTER_PART_GAP };
/** The most characters of a cluster's label: about as many as fit its column on one line. */
const MAX_LABEL = 28;

/** One unit of work laid out as a cluster: what it is, and where its label and sticky go. */
export interface ArrangedCluster {
  /** Stable across arranges: `issue:<id>` for its issue or the ticket in its branch, else its first tile's id (`agent:<session id>`). */
  key: string;
  /** Its issue's ID and title, else the ticket in its branch, else the words its agents' names start with, else its first one's name. */
  label: string;
  /** Its tiles, in the order they go: an implementer before its reviewer. */
  members: string[];
  labelAt: Point;
  stickyAt: Point;
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
  'idle',
  'scheduled',
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
  add(lead);
  if (by === 'issue') {
    const units = new Map<string, ArrangeTile[]>();
    for (const chain of chains) {
      const unit = unitOf(chain);
      if (unit !== null) units.set(unit, [...(units.get(unit) ?? []), ...chain]);
    }
    for (const chain of chains) {
      const unit = unitOf(chain);
      if (unit === null) add(chain, undefined, true);
      else if (units.has(unit)) {
        add(units.get(unit)!, undefined, true);
        units.delete(unit);
      }
    }
  } else if (by === 'role') {
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
  const rows = rowsOf(tiles, links, options.by);
  let positions: Map<string, Point>;
  if (options.layout === 'grid') {
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
    // A cluster's label and sticky take the column before its tiles.
    const isCluster = (row: Row) => options.clusters === true && options.by === 'issue' && row.unit;
    const columnsOf = (row: Row) => row.columns.map((column) => column + (isCluster(row) ? 1 : 0));
    // Every column as many grid columns wide as its widest tile, in every row, so columns line up; and a rail's room
    // wider than a tile of a row a rail runs past the right of, in every row too: past each tile from either end of the
    // rail to the tile before the other, so its token has room whichever end it is at, never on a tile between them.
    const spans: number[] = [];
    for (const row of rows) {
      const columns = columnsOf(row);
      const railAfter = new Set<number>();
      for (const [index, column] of columns.entries()) {
        for (const [other, to] of columns.entries()) {
          if (to > column && joins(links, row.tiles[index]!.id, row.tiles[other]!.id)) for (let between = column; between < to; between++) railAfter.add(between);
        }
      }
      columns.forEach((column, index) => {
        const rail = railAfter.has(column) ? RAIL_COLUMNS : 0;
        spans[column] = Math.max(spans[column] ?? 1, gridSpan(sizeOf(row.tiles[index]!)).columns + rail);
      });
    }
    const gridColumn = (column: number) => Array.from({ length: column }, (_, index) => spans[index] ?? 1).reduce((sum, span) => sum + span, 0);
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
      const columns = columnsOf(row).map(gridColumn);
      if (railAbove(rowIndex)) next += RAIL_ROWS;
      const labelAt = (at: number) => gridPoint(0, at);
      const stickyAt = (at: number) => stickyBelow(labelAt(at));
      const parts = (at: number): Rect[] => [
        ...row.tiles.map((tile, index) => sizedFootprint(gridPoint(columns[index]!, at), sizeOf(tile))),
        ...(cluster
          ? [
              { ...labelAt(at), ...CLUSTER_LABEL_SIZE },
              { ...stickyAt(at), ...CLUSTER_STICKY_SIZE },
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
        const linked = row.tiles.find((tile) => tile.issue !== null);
        const unit = linked?.issue ?? unitOf(row.tiles);
        clusters.push({
          key: unit === null ? row.tiles[0]!.id : `issue:${unit}`,
          label: labelOf(row.tiles),
          members: row.tiles.map((tile) => tile.id),
          labelAt: labelAt(at),
          stickyAt: stickyAt(at),
        });
      }
      next = at + Math.max(...row.tiles.map((tile) => gridSpan(sizeOf(tile)).rows));
    }
  }
  const placed = [
    ...tiles.map((tile) => ({ ...positions.get(tile.id)!, ...sizeOf(tile) })),
    ...clusters.flatMap((cluster) => [
      { ...cluster.labelAt, ...CLUSTER_LABEL_SIZE },
      { ...cluster.stickyAt, ...CLUSTER_STICKY_SIZE },
    ]),
  ];
  const width = Math.max(options.width, MIN_ZONE_SIZE.width, ...placed.map((rect) => rect.x + rect.width + ZONE_PADDING));
  const height = Math.max(
    MIN_ZONE_SIZE.height,
    zoneHeightFor(0, width),
    ...placed.map((rect) => rect.y + rect.height + TILE_GAP + ZONE_PADDING),
  );
  return { positions, clusters, size: { width, height } };
}

/** Where a cluster's sticky goes: below its label, in their cell. */
const stickyBelow = (labelAt: Point): Point => ({ x: labelAt.x, y: labelAt.y + CLUSTER_LABEL_SIZE.height + CLUSTER_PART_GAP });

/**
 * Where the parts of `clusters` (an arrange by issue's, by key) go when the crew is arranged another way, so none is
 * lost: each cluster a grid row of its own from the cell `from` down, its label and sticky in `from`'s column, each row
 * clear of `obstacles`.
 */
export function parkClusters(
  clusters: readonly string[],
  from: { column: number; row: number },
  obstacles: readonly Rect[],
): Pick<ArrangedCluster, 'key' | 'labelAt' | 'stickyAt'>[] {
  const { column } = from;
  let row = from.row;
  return clusters.map((key) => {
    const parts = (at: number): Rect[] => [
      { ...gridPoint(column, at), ...CLUSTER_LABEL_SIZE },
      { ...stickyBelow(gridPoint(column, at)), ...CLUSTER_STICKY_SIZE },
    ];
    const start = row;
    while (row - start < MAX_SEARCH_STEPS && !parts(row).every((rect) => clearOf(rect, obstacles))) row++;
    // Past the cap, on the first row below everything in the way: never on top of it.
    if (row - start >= MAX_SEARCH_STEPS) row = gridRowAtOrBelow(Math.max(...obstacles.map((rect) => rect.y + rect.height)) + TILE_GAP);
    const labelAt = gridPoint(column, row++);
    return { key, labelAt, stickyAt: stickyBelow(labelAt) };
  });
}
