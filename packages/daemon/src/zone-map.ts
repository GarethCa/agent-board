// A zone as a map an orchestrator reads (`agent-board zone map`): its lanes as an arrange by issue sees them, and what is
// amiss in it, as a lane table or a box picture. Pure, so every case is unit-tested.
import { LANE_SLOTS, type Lanes } from './board-arrange.ts';
import { GRID_COLUMN, GRID_ORIGIN, overlaps, ROW_STEP, TILE_GAP, type Rect } from './board-layout.ts';
import type { AgentState, ArrangeSettings, ZoneMap, ZoneMapLane, ZoneMapThing } from './protocol.ts';
import { cutText } from './text-cut.ts';

/**
 * What a zone's map is read from: its lanes, everything in it, the parts an arrange made (by arrange key, the item's
 * key), and how it is arranged, which says where a lane's tiles belong; and each tile expanded in place as it is
 * compact, by key (none, for none).
 */
export interface ZoneMapInput {
  lanes: Lanes;
  things: readonly ZoneMapThing[];
  parts: ReadonlyMap<string, string>;
  arrange: ArrangeSettings;
  compact?: ReadonlyMap<string, Rect>;
}

const rectOf = (thing: ZoneMapThing): Rect => ({ x: thing.x, y: thing.y, width: thing.width, height: thing.height });
const onGrid = (thing: ZoneMapThing) => Number.isInteger((thing.x - GRID_ORIGIN.x) / GRID_COLUMN) && Number.isInteger((thing.y - GRID_ORIGIN.y) / ROW_STEP);

/** The map of a zone: its lanes, the rest above them, and what is amiss. */
export function buildZoneMap({ lanes, things, parts, arrange, compact = new Map() }: ZoneMapInput): Pick<ZoneMap, 'top' | 'lanes' | 'overlaps' | 'widestGap' | 'offGrid'> {
  const byKey = new Map(things.map((thing) => [thing.key, thing]));
  const part = (key: string) => {
    const item = parts.get(key);
    return item !== undefined && byKey.has(item) ? item : null;
  };
  const mapped: ZoneMapLane[] = lanes.lanes.map((lane) => ({
    key: lane.key,
    label: lane.label,
    slots: Object.fromEntries(LANE_SLOTS.map((slot) => [slot, lane.slots[slot].map((tile) => tile.id).filter((id) => byKey.has(id))])) as ZoneMapLane['slots'],
    labelItem: part(`${lane.key}#label`),
    note: part(`${lane.key}#note`),
  }));
  const inLanes = new Set(mapped.flatMap((lane) => [...LANE_SLOTS.flatMap((slot) => lane.slots[slot]), ...[lane.labelItem, lane.note].filter((key) => key !== null)]));
  const lead = lanes.top.map((tile) => tile.id).filter((id) => byKey.has(id));
  const top = [...lead, ...things.filter((thing) => !inLanes.has(thing.key) && !lead.includes(thing.key)).map((thing) => thing.key)];

  // A tile expanded in place pushes what it grew over aside on the board, for as long as it is open, without moving it
  // where it is kept: two things overlap only if they did with every expanded tile compact. The lint so trusts the
  // board's push: where the board finds no room to push something clear (`clearOfExpanded` in the app's displace), it
  // is left under the expanded tile, and the lint doesn't say so.
  const asLaidOut = (thing: ZoneMapThing) => compact.get(thing.key) ?? rectOf(thing);
  const overlapping: [string, string][] = [];
  things.forEach((thing, index) => {
    for (const other of things.slice(index + 1)) {
      if (overlaps(rectOf(thing), rectOf(other)) && overlaps(asLaidOut(thing), asLaidOut(other))) overlapping.push([thing.key, other.key]);
    }
  });

  const offGrid = new Set(lead.filter((key) => !onGrid(byKey.get(key)!)));
  // A lane is a row, or a column, of its own only by issue in rows or columns: else its tiles need only be on the grid.
  const along = arrange.by !== 'issue' ? undefined : arrange.layout === 'rows' ? 'row' : arrange.layout === 'columns' ? 'column' : undefined;
  const lineOf = (thing: ZoneMapThing) => (along === 'row' ? thing.y : thing.x);
  let widestGap = 0;
  for (const lane of mapped) {
    const tiles = LANE_SLOTS.flatMap((slot) => lane.slots[slot]).map((key) => byKey.get(key)!);
    const label = lane.labelItem === null ? undefined : byKey.get(lane.labelItem);
    const note = lane.note === null ? undefined : byKey.get(lane.note);
    for (const tile of tiles) if (!onGrid(tile)) offGrid.add(tile.key);
    if (along === undefined) continue;
    // Its line is where its label is, else its first tile.
    const line = [label, ...tiles, note].find((thing) => thing !== undefined);
    if (line === undefined) continue;
    for (const thing of [...tiles, note]) if (thing !== undefined && lineOf(thing) !== lineOf(line)) offGrid.add(thing.key);
    // The gaps along it, in slots: grid columns across a row, grid rows down a column.
    const inLine = [label, ...tiles, note].filter((thing): thing is ZoneMapThing => thing !== undefined && lineOf(thing) === lineOf(line));
    const [start, length, step] = along === 'row' ? (['x', 'width', GRID_COLUMN] as const) : (['y', 'height', ROW_STEP] as const);
    inLine.sort((a, b) => a[start] - b[start]);
    for (const [index, thing] of inLine.slice(1).entries()) {
      const before = inLine[index]!;
      // What lies between them past the gap kept between any two: a row's gap is a tile gap, a column's a row's spacing.
      const kept = along === 'row' ? TILE_GAP : ROW_STEP - before[length];
      const gap = thing[start] - (before[start] + before[length]) - Math.max(TILE_GAP, kept);
      widestGap = Math.max(widestGap, Math.round(gap / step));
    }
  }
  return { top, lanes: mapped, overlaps: overlapping, widestGap, offGrid: [...offGrid] };
}

/** How a map names the things in it: by ref (`agent:9c1e`), as the board CLI does. */
export type RefOf = (key: string) => string;

/** A gap of more slots than this is a lane spread too far apart. */
const MAX_GAP = 2;
const MAX_NAME = 16;

/** The line saying what is amiss, or `ok`. */
function lintLine(map: ZoneMap, ref: RefOf): string {
  const overlapText = map.overlaps.length === 0 ? 'no overlaps' : `${map.overlaps.length} overlapping (${map.overlaps.map(([a, b]) => `${ref(a)} / ${ref(b)}`).join(', ')})`;
  const gapText = `widest gap ${map.widestGap} slot${map.widestGap === 1 ? '' : 's'}`;
  const offText = map.offGrid.length === 0 ? '0 off-grid' : `${map.offGrid.length} off-grid (${map.offGrid.map(ref).join(', ')})`;
  const ok = map.overlaps.length === 0 && map.offGrid.length === 0 && map.widestGap <= MAX_GAP;
  return `lint  ${ok ? 'ok' : 'check'} · ${overlapText} · ${gapText} · ${offText}`;
}

/** The map's first line: the zone, its size, and how it is arranged. */
function headLine(map: ZoneMap, zoneRef: string): string {
  const { by, layout, auto } = map.arrange;
  return `zone ${zoneRef} ${map.name} · ${Math.round(map.width)}×${Math.round(map.height)} · by ${by}, in ${layout} · auto-arrange ${auto ? 'on' : 'off'}`;
}

const isDone = (thing: ZoneMapThing | undefined) => thing?.state === 'done';

/** The line saying where the next lane goes, and which lanes are finished. */
function freeLine(map: ZoneMap, things: ReadonlyMap<string, ZoneMapThing>): string {
  const finished = map.lanes.filter((lane) => {
    const tiles = LANE_SLOTS.flatMap((slot) => lane.slots[slot]);
    return tiles.length > 0 && tiles.every((key) => isDone(things.get(key)));
  });
  const place = map.arrange.layout === 'columns' ? 'column' : map.arrange.layout === 'cards' ? 'card' : 'row';
  return [`free  next lane → ${place} ${map.lanes.length + 1}`, ...finished.map((lane) => `${laneName(lane)} can fold (all done)`)].join(' · ');
}

/** A lane's name in a map: its issue, else its label. */
const laneName = (lane: ZoneMapLane) => (lane.key.startsWith('issue:') ? lane.key.slice('issue:'.length) : lane.label);

/**
 * The lane table (the map by default): one line per lane, one cell per slot with each tile's ref, name and state, a
 * free slot as `·`; the lead and the rest above them; then where the next lane goes, and the lint line.
 */
export function laneTable(map: ZoneMap, zoneRef: string, ref: RefOf): string {
  const things = new Map(map.things.map((thing) => [thing.key, thing]));
  const cell = (key: string) => {
    const thing = things.get(key);
    if (thing === undefined) return ref(key);
    if (thing.itemKind === 'agent-note') return ref(key);
    if (thing.itemKind !== null) return `${ref(key)} ${thing.itemKind}`;
    return `${ref(key)} ${cutText(thing.name, MAX_NAME)} ${thing.state ?? 'shell'}`;
  };
  const cells = (keys: readonly string[]) => (keys.length === 0 ? '·' : keys.map(cell).join(', '));
  const head = ['lane', ...LANE_SLOTS, 'notes'];
  // The top row fills the columns in turn, the last taking the rest.
  const topCells = head.slice(1).map((_, index, columns) => cells(index < columns.length - 1 ? map.top.slice(index, index + 1) : map.top.slice(index)));
  const rows = [
    ['top', ...topCells.map((text) => (text === '·' ? '' : text))],
    ...map.lanes.map((lane) => [cutText(laneName(lane), MAX_NAME), ...LANE_SLOTS.map((slot) => cells(lane.slots[slot])), lane.note === null ? '·' : cell(lane.note)]),
  ];
  const widths = head.map((title, index) => Math.max(title.length, ...rows.map((row) => row[index]!.length)));
  const line = (row: readonly string[]) => row.map((text, index) => text.padEnd(widths[index]!)).join(' │ ').trimEnd();
  return [
    headLine(map, zoneRef),
    '',
    line(head),
    widths.map((width) => '─'.repeat(width)).join('─┼─'),
    ...rows.map(line),
    '',
    freeLine(map, things),
    lintLine(map, ref),
  ].join('\n');
}

/** A box picture's scale: one character a column this many pixels wide, one line a half row tall. */
const CELL_WIDTH = 40;
const LINE_HEIGHT = ROW_STEP / 2;
/** Every key a box picture tags a tile or note with, in turn. */
const KEYS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A state as one character in a box picture. */
const STATE_MARK: Partial<Record<AgentState, string>> = {
  'needs-permission': '!',
  waiting: 'i',
  idle: 'i',
  scheduled: 'i',
  running: 'w',
  thinking: 'w',
  'handing-off': 'w',
  'on-command': 'w',
  starting: 'w',
  done: '✓',
  failed: 'x',
  'rate-limited': 'r',
  'stopped-by-restart': 's',
};

/**
 * The box picture (`--boxes`): the zone drawn in characters, about one to 40 px, so overlaps (`#`) and gaps show where
 * they really are, whatever the layout: a tile as `[a w]`, an agent note as `<b>`, another note as `{c}`, a lane's
 * label as its text; then a legend of the keys.
 */
export function boxPicture(map: ZoneMap, zoneRef: string, ref: RefOf): string {
  const columns = Math.max(1, Math.ceil(map.width / CELL_WIDTH));
  const lines = Math.max(1, Math.ceil(map.height / LINE_HEIGHT));
  const grid = Array.from({ length: lines }, () => Array.from({ length: columns }, () => ' '));
  const labels = new Set(map.lanes.flatMap((lane) => lane.labelItem ?? []));
  const legend: string[] = [];
  let next = 0;
  for (const thing of map.things) {
    // Edges to the nearest character, so things a gap apart never share one.
    const left = Math.max(0, Math.min(columns - 2, Math.round(thing.x / CELL_WIDTH)));
    const right = Math.max(left + 1, Math.min(columns - 1, Math.round((thing.x + thing.width) / CELL_WIDTH) - 1));
    const top = Math.max(0, Math.min(lines - 1, Math.round(thing.y / LINE_HEIGHT)));
    const bottom = Math.max(top, Math.min(lines - 1, Math.round((thing.y + thing.height) / LINE_HEIGHT) - 1));
    let text: string;
    let [open, close] = ['[', ']'];
    if (labels.has(thing.key)) {
      text = thing.name;
      [open, close] = [' ', ' '];
    } else {
      const key = KEYS[next++] ?? '?';
      if (thing.itemKind === 'agent-note') [open, close] = ['<', '>'];
      else if (thing.itemKind !== null) [open, close] = ['{', '}'];
      const mark = thing.itemKind === null ? (thing.state === null ? '$' : (STATE_MARK[thing.state] ?? '?')) : '';
      text = mark === '' ? key : `${key} ${mark}`;
      const what = thing.itemKind ?? (thing.state === null ? 'shell' : thing.state);
      legend.push(`${key} ${ref(thing.key)} ${cutText(thing.name, MAX_NAME * 2)} (${what})`);
    }
    for (let line = top; line <= bottom; line++) {
      for (let column = left; column <= right; column++) {
        const char = column === left ? open : column === right ? close : line === top ? (text[column - left - 1] ?? ' ') : ' ';
        const was = grid[line]![column]!;
        // Two things on one character: an overlap.
        grid[line]![column] = was !== ' ' && char !== ' ' ? '#' : was === ' ' ? char : was;
      }
    }
  }
  const title = `─ ${map.name} `;
  const width = Math.max(columns, title.length);
  return [
    headLine(map, zoneRef),
    '',
    `┌${title.padEnd(width, '─')}┐`,
    ...grid.map((row) => `│${row.join('').padEnd(width)}│`),
    `└${'─'.repeat(width)}┘`,
    ...legend,
    '! needs you · w working · i idle · ✓ done · x failed · r rate-limited · s stopped · $ shell · <> agent note · {} note',
    lintLine(map, ref),
  ].join('\n');
}
