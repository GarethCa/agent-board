// Orchestrators lay out their zone (`agent-board move`, `arrange`, `zone`, `note`): move tiles, arrange a crew, make
// groups and notes. Each is checked and logged as every orchestrator method is (`OrchestratorAccess`), and acts through
// the methods the board's own drags and menus call (`agent.move`, `item.create`, `zone.dissolve`…), placed by the
// board's own rules (`board-layout.ts`), so nothing here keeps a state of its own but who made a group or note.
import type { DatabaseSync } from 'node:sqlite';
import { agentNoteAuthor, agentNoteData, agentNoteSize } from './agent-notes.ts';
import { arrangeTiles, CLUSTER_LABEL_SIZE, CLUSTER_NOTE_SIZE, fittedSize, lanesOf, parkClusters, type ArrangeTile, type ArrangedCluster } from './board-arrange.ts';
import {
  AGENT_TILE_SIZE,
  besideSpot,
  clamp,
  clearOf,
  freeItemSpot,
  freeSpotFor,
  freeTileSlot,
  GRID_COLUMN,
  gridColumnAtOrRight,
  gridPoint,
  gridRowAtOrBelow,
  nearestFreeSpot,
  overlaps,
  packTiles,
  PERCH_ROOM,
  rotatedBounds,
  ROW_STEP,
  sizedFootprint,
  slotUnplaced,
  snapToGrid,
  TILE_GAP,
  EXPANDED_VIEW_KEY,
  expandedSizesFrom,
  TILE_SIZES_VIEW_KEY,
  UNFOLDED_VIEW_KEY,
  CHIP_SIZE,
  isFolded,
  unfoldedFrom,
  tileSizeKey,
  ZONE_PADDING,
  type Point,
  type Rect,
  type Size,
  type ZoneTile,
} from './board-layout.ts';
import { makeRoom } from './board-room.ts';
import type { BoardConnection } from './board.ts';
import { keyedQueue } from './keyed-queue.ts';
import type { ActivityEntry, Orchestrator, OrchestratorAccess } from './orchestrators.ts';
import { finiteNumberParam, invalidParams, optionalBooleanParam, optionalStringParam, paramsObject, stringParam } from './params.ts';
import {
  AGENT_STATES,
  ARRANGE_BYS,
  ARRANGE_LAYOUTS,
  BOARD_ERROR,
  COLOR_SLOTS,
  DEFAULT_ARRANGE_SETTINGS,
  DEFAULT_ZONE_SIZE,
  NOTE_KINDS,
  CONNECTOR_STYLES,
  MAX_CONNECTOR_LABEL,
  RELATIONS,
  SECTIONED_SHAPES,
  FILL_SLOTS,
  FILL_SLOT_COLORS,
  SHAPE_SECTIONS,
  SHAPE_TYPES,
  MAX_STICKY_TEXT,
  MAX_TEXT_LENGTH,
  SLOT_COLORS,
  STICKY_COLORS,
  STICKY_SIZE,
  TEXT_PRESET_FONT_SIZES,
  TILE_SIDES,
  type Agent,
  type OrchestratorSpawned,
  type ArrangeBy,
  type ArrangeLayout,
  type ArrangeResult,
  type ArrangeSettings,
  type BoardItem,
  type BoardPlace,
  type Connector,
  type ConnectorSide,
  type DaemonMethod,
  type DaemonMethods,
  type ExternalSession,
  type LayoutMoved,
  type LayoutPlace,
  type LayoutTarget,
  type NoteKind,
  type ColorSlot,
  type FillSlot,
  newShapeData,
  type ShapeType,
  statusLine,
  type Shell,
  type TileSide,
  type Zone,
  type ZoneMapThing,
} from './protocol.ts';
import { RpcMethodError, type RpcHandlers } from './rpc.ts';
import { cutText } from './text-cut.ts';
import { nameSlug } from './worktrees.ts';
import { buildZoneMap } from './zone-map.ts';

export type LayoutMethods = Pick<
  DaemonMethods,
  | 'orchestrator.move'
  | 'orchestrator.arrange'
  | 'orchestrator.map'
  | 'orchestrator.addZone'
  | 'orchestrator.changeZone'
  | 'orchestrator.removeZone'
  | 'orchestrator.addNote'
  | 'orchestrator.editNote'
  | 'orchestrator.removeNote'
  | 'orchestrator.addShape'
  | 'orchestrator.editShape'
  | 'orchestrator.removeShape'
  | 'orchestrator.connect'
  | 'orchestrator.editConnector'
  | 'orchestrator.removeConnector'
>;

/** Calls one of the daemon's own methods, as the app would. */
export type DaemonCall = <M extends DaemonMethod>(method: M, params: DaemonMethods[M]['params']) => Promise<DaemonMethods[M]['result']>;

export interface LayoutHandlerOptions {
  db: DatabaseSync;
  access: OrchestratorAccess;
  call: DaemonCall;
  /** Starts an agent as an orchestrator (`orchestrators.ts`): a reviewer it starts then joins its implementer's cluster. */
  spawn: (params: unknown, connection: BoardConnection) => Promise<OrchestratorSpawned>;
  /** Closes (or removes) an agent as an orchestrator (`orchestrators.ts`): its zone is then arranged, if its orchestrator arranges by itself. */
  close: (params: unknown, connection: BoardConnection) => Promise<Agent | null>;
  /** Writes a line to the daemon's log: a reviewer that started but could not join its cluster. */
  warn?: (message: string) => void;
}

/** Where each orchestrator's arrange settings are kept (`ArrangeSettings`), by its session id. */
const ARRANGE_SETTINGS_VIEW_KEY = 'arrangeSettings';

/** Arrange settings as saved, each one not saved, or not one of its own, the default. */
function settingsFrom(saved: unknown): ArrangeSettings {
  const fields = typeof saved === 'object' && saved !== null ? (saved as Record<string, unknown>) : {};
  return {
    by: ARRANGE_BYS.includes(fields.by as ArrangeBy) ? (fields.by as ArrangeBy) : DEFAULT_ARRANGE_SETTINGS.by,
    layout: ARRANGE_LAYOUTS.includes(fields.layout as ArrangeLayout) ? (fields.layout as ArrangeLayout) : DEFAULT_ARRANGE_SETTINGS.layout,
    auto: typeof fields.auto === 'boolean' ? fields.auto : DEFAULT_ARRANGE_SETTINGS.auto,
  };
}

/** Space kept between a new group and the zone it is stepped past, as the board's Zone tool keeps. */
const ZONE_GAP = 40;

/** A text item's line height, and the room round its text, as the board draws body text (about). */
const TEXT_LINE = 1.4;
const TEXT_PAD = 8;
/** The widest a text item an orchestrator makes starts, before it wraps. */
const MAX_TEXT_WIDTH = 480;

/**
 * How far past its zone's edge `at` may put something: about a drag's worth. Further, it is put at that edge, so a
 * stray coordinate can't grow a zone across the board.
 */
const MAX_REACH = 1000;
/** How far from the board's origin `at` (loose) and a new group may be, px: a wish further off is put at the edge. */
const BOARD_EXTENT = 100_000;
/** The most characters a group's name may have: it is drawn on its tab and printed by `agent-board zones`. */
const MAX_GROUP_NAME = 80;
/** The largest a group an orchestrator makes or resizes may be. */
const MAX_GROUP_SIZE = { width: 8000, height: 8000 };
/** The most characters of an arrange's sticky that say what its agents are doing, before it is cut short. */
const MAX_UNIT_NOTE = 1000;
/** The most characters of what one agent is doing, on its cluster's sticky. */
const MAX_DOING = 80;

/** A control character (C0 or C1, DEL): never in a group's name; in a note only as a tab or line break. */
const CONTROL = /\p{Cc}/u;
const NOTE_CONTROL = /(?![\t\n])\p{Cc}/u;

/** A group's name as an agent may give it: not blank, at most `MAX_GROUP_NAME`, no control characters. */
function groupName(raw: string): string {
  const name = raw.trim();
  if (name === '') throw invalidParams('name must not be blank');
  if (name.length > MAX_GROUP_NAME) throw invalidParams(`a group's name is at most ${MAX_GROUP_NAME} characters`);
  if (CONTROL.test(name)) throw invalidParams("a group's name may not hold a control character");
  return name;
}

/**
 * Checks a note's text as an agent may give it: not blank, no control character but tabs and line breaks, and room
 * left under the kind's limit for `signature`, which the daemon adds.
 */
function checkNoteText(text: string, kind: NoteKind, signature: number): void {
  if (text.trim() === '') throw invalidParams('a note needs some text');
  if (NOTE_CONTROL.test(text)) throw invalidParams('a note may hold tabs and line breaks, but no other control character');
  const max = (kind === 'sticky' ? MAX_STICKY_TEXT : MAX_TEXT_LENGTH) - signature;
  if (text.length > max) throw invalidParams(`a ${kind === 'sticky' ? 'sticky note' : 'text'}'s text is at most ${max} characters, with room for your signature`);
}

/** A width or height a group may be: at least `MIN_ZONE_SIZE`'s, at most `MAX_GROUP_SIZE`'s. */
function groupSize(value: number | undefined, axis: 'width' | 'height'): number | undefined {
  if (value === undefined) return undefined;
  if (value > MAX_GROUP_SIZE[axis]) throw invalidParams(`a group is at most ${MAX_GROUP_SIZE[axis]} px in ${axis}`);
  return value;
}

/**
 * A cluster's note: found by its slot in its `arrange` key and the `members` it lists, whatever its kind (an agent
 * note from an agent's arrange, a sticky from the user's, an older sticky until it is replaced).
 */
const CLUSTER_NOTE_SLOT = '#note';

/** The notes an orchestrator makes and edits: the kinds `note` handles, and the agent notes an agent's become. */
const NOTE_ITEM_KINDS: ReadonlySet<string> = new Set([...NOTE_KINDS, 'agent-note']);
/** What `note remove` removes: notes, and link cards. */
const REMOVABLE_KINDS: ReadonlySet<string> = new Set([...NOTE_ITEM_KINDS, 'link']);
/** What the shape commands change. */
const SHAPE_KINDS: ReadonlySet<string> = new Set(['shape']);

/** Whether `item` is a note of text: a sticky note, text or an agent note. */
const isNote = (item: BoardItem) => NOTE_ITEM_KINDS.has(item.kind);

/** Everything on the board a layout reads, at one moment. */
interface Board {
  zones: Zone[];
  agents: Agent[];
  /** Shell tiles: a tab is no tile. */
  shells: Shell[];
  externals: ExternalSession[];
  items: BoardItem[];
  /** Resized tiles' sizes, by `tileSizeKey`: an expanded tile's expanded size. */
  sizes: Record<string, Size>;
  /** The tiles expanded in place, by `tileSizeKey`: each one's size compact, which the board pushes its neighbours aside from. */
  compact: Record<string, Size>;
}

/** A tile or item on the board, where it is and what it is. */
interface Placed {
  key: string;
  kind: 'agent' | 'shell' | 'external' | 'item';
  id: string;
  zoneId: string | null;
  /** Its place and size, relative to its zone (a board position when loose), as the board draws it, unrotated. */
  rect: Rect;
  /** An item's angle, clockwise about its centre (`BoardItem.rotation`); 0 for a tile. */
  rotation: number;
  /** Whether that place is its own, saved: false for a tile the board slots each time it draws. */
  saved: boolean;
  name: string;
}

const outOfScope = (message: string) => new RpcMethodError(BOARD_ERROR.outOfScope, message);

/** A short quote of a note's text, for a log line or a refusal. */
const quoted = (text: string) => `“${cutText(text, 40)}”`;

function noteText(item: BoardItem): string {
  return typeof item.data.text === 'string' ? item.data.text : '';
}

/** What an item is called in a log line or a refusal: a note or shape by its text, a link by its URL. */
function itemName(item: BoardItem): string {
  if (isNote(item)) return `note ${quoted(noteText(item))}`;
  if (item.kind === 'shape') return `shape ${quoted(noteText(item))}`;
  if (item.kind === 'link') return `link ${quoted(String(item.data.url ?? ''))}`;
  return `${item.kind} item`;
}

/**
 * Every tile and item on the board, where the board draws it: a tile with no place of its own yet is slotted as the
 * board slots it (`slotUnplaced`), since the board never saves that place.
 */
function placedOf(board: Board): Placed[] {
  const zones = new Map(board.zones.map((zone) => [zone.id, zone]));
  const items = board.items.map((item): Placed => ({
    key: `item:${item.id}`,
    kind: 'item',
    id: item.id,
    zoneId: item.zoneId,
    rect: { x: item.x, y: item.y, width: item.width, height: item.height },
    rotation: item.rotation,
    saved: true,
    name: itemName(item),
  }));
  type Slotted = Omit<Placed, 'rect' | 'rotation' | 'saved'> & { at: Point | undefined; size: Size; from: string | undefined };
  const tile = (kind: 'agent' | 'shell' | 'external', id: string, subject: Pick<Agent, 'zoneId' | 'position' | 'name'>, from?: string | null): Slotted => ({
    key: tileSizeKey(kind, id),
    kind,
    id,
    zoneId: subject.zoneId,
    at: subject.position === null ? undefined : { x: subject.position.x, y: subject.position.y },
    size: board.sizes[tileSizeKey(kind, id)] ?? AGENT_TILE_SIZE,
    name: subject.name,
    from: from ?? undefined,
  });
  // In the board's order, as it slots them; a tile of a zone that has gone isn't drawn.
  const tiles = [
    ...board.agents.map((agent) => tile('agent', agent.sessionId, agent, agent.spawnedBy)),
    ...board.shells.map((shell) => tile('shell', shell.id, shell)),
    ...board.externals.map((session) => tile('external', session.id, session)),
  ].filter((each) => each.zoneId === null || zones.has(each.zoneId));
  const saved = new Set(tiles.filter((each) => each.at !== undefined).map((each) => each.key));
  slotUnplaced(tiles, {
    zoneOf: (each) => each.zoneId ?? undefined,
    placeOf: (each) => each.at,
    place: (each, spot) => (each.at = spot),
    agentOf: (each) => (each.kind === 'agent' ? each.id : undefined),
    orchestratorOf: (each) => each.from,
    rect: (each) => ({ ...each.at!, ...each.size }),
    footprint: (each) => sizedFootprint(each.at!, each.size),
    zoneWidth: (zoneId) => zones.get(zoneId)!.width,
    zones: board.zones,
    items: (zoneId) => items.filter((item) => item.zoneId === (zoneId ?? null)).map(takenBy),
  });
  return [
    ...tiles.map(({ key, kind, id, zoneId, name, at, size }): Placed => ({ key, kind, id, zoneId, name, rect: { ...at!, ...size }, rotation: 0, saved: saved.has(key) })),
    ...items,
  ];
}

/**
 * What a tile or item takes up for another placed near it: a tile with the room above it for its characters, an item
 * turned (`rotation`) the upright box round it.
 */
const takenBy = (placed: Placed): Rect => (placed.kind === 'item' ? rotatedBounds(placed.rect, placed.rotation) : sizedFootprint(placed.rect, placed.rect));

/** The size a text item of `text` starts at: as wide as its longest line, up to a limit, and as tall as its lines. */
function textSize(text: string): Size {
  const fontSize = TEXT_PRESET_FONT_SIZES.body;
  const lines = text.split('\n');
  const longest = Math.max(...lines.map((line) => line.length));
  const width = Math.min(MAX_TEXT_WIDTH, Math.max(40, Math.ceil(longest * fontSize * 0.55) + TEXT_PAD));
  const perLine = Math.max(1, Math.floor((width - TEXT_PAD) / (fontSize * 0.55)));
  const rows = lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / perLine)), 0);
  return { width, height: Math.ceil(rows * fontSize * TEXT_LINE) + TEXT_PAD };
}

/** A text item's data: body text of `text` in `colors` (its colour, and its slot), wrapping at the width it is given. */
function textItemData(text: string, colors: NoteColors): Record<string, unknown> {
  return { text, size: 'body', fontSize: TEXT_PRESET_FONT_SIZES.body, minHeight: 0, bold: false, italic: false, align: 'left', ...colors, wrap: true };
}

/** An orchestrator's signature on a note it writes: 🤖, its name and the time, on a line of its own at the end. */
const SIGNATURE = /\n\n🤖 [^\n]* · \d\d:\d\d$/;

/** The agent `agent` reviews, among `agents`: its `reviewOf`, else the one in its zone on the branch it reviews. */
function reviewedBy(agents: readonly Agent[], agent: Agent): Agent | undefined {
  if (agent.reviewOf !== null) return agents.find((each) => each.sessionId === agent.reviewOf);
  if (agent.reviews === null) return undefined;
  return agents.find((each) => each.zoneId === agent.zoneId && each.sessionId !== agent.sessionId && each.branch === agent.reviews!.branch);
}

/** Whether `agent`'s branch is the one agent-board named for it (`agentBranchName`), which names no ticket but its own name's. */
const namedBranch = (agent: Agent) => new RegExp(`^${nameSlug(agent.name)}-[0-9a-f]{6}$`).test(agent.branch);

/**
 * The branch whose ticket labels `agent`'s cluster: its own, or a reviewer's the one it reviews; none for a branch
 * agent-board named after its agent (`namedBranch`), whose name holds no ticket.
 */
function ticketBranch(agents: readonly Agent[], agent: Agent): string | null {
  if (agent.reviews === null) return namedBranch(agent) ? null : agent.branch;
  const reviewed = reviewedBy(agents, agent);
  return reviewed !== undefined && namedBranch(reviewed) ? null : agent.reviews.branch;
}

/** The last `STATUS:` line an agent ended its last message with, without the marker. */
const finalStatus = (message: string | null): string | undefined => [...(message ?? '').matchAll(/^STATUS:\s*(.+)$/gm)].at(-1)?.[1]?.trim();

/**
 * Where an agent named `name` stands, for its cluster's note: a list item of the status line it set, else its latest
 * STATUS, else its state; and its pull request's number and title when it has one. Never the task it was given.
 */
function standingOf(name: string, agent: Agent | undefined): string {
  const pr = agent?.pullRequests[0] ?? agent?.pushedPullRequests[0];
  const standing = agent === undefined ? 'shell' : agent.status !== null ? statusLine(agent.status) : (finalStatus(agent.lastMessage) ?? agent.state);
  const request = pr === undefined ? '' : ` · PR #${pr.number} ${cutText(pr.title, MAX_DOING)}`;
  return `- **${name}**: ${cutText(standing, MAX_DOING)}${request}`;
}

/** The height an agent note needs to show `text`, if it is taller than `note` is: it only grows, keeping a size it was given. */
function grownNote(note: BoardItem, text: string): { height?: number } {
  const { height } = agentNoteSize(text, note.width, 0);
  return height > note.height ? { height } : {};
}

/**
 * The height a lane's agent note keeps over what an arrange would give it: one the board grew it to, to fit its text,
 * or the user resized it to since an arrange last sized it (`arrangeHeight`), only while its text is still the text it
 * was sized for (`sizedFor`) and the arrange keeps it (`keep`). Its text changed by anyone, it is sized afresh, so a
 * note written shorter shrinks again.
 */
function heldHeight(note: BoardItem, keep: boolean): number | undefined {
  const { arrangeHeight, sizedFor, text } = note.data;
  return keep && note.kind === 'agent-note' && typeof arrangeHeight === 'number' && sizedFor === text && note.height > arrangeHeight ? note.height : undefined;
}

/** What a cluster's note says when an arrange writes it: a line for where each of its tiles stands (`standing`). */
const noteSays = (cluster: ArrangedCluster, standing: (id: string) => string) => cutText(cluster.members.map(standing).join('\n'), MAX_UNIT_NOTE);

/** `text` without the signature `stamped` put on it. */
const unsigned = (text: string) => text.replace(SIGNATURE, '').trimEnd();

/**
 * Whether someone edited an arrange's note: its text, unsigned, isn't what the arrange wrote. A sticky from before arranges
 * remembered that counts as edited unless it is still as they wrote it: a line per agent, its name and state.
 * An agent note adopted from a hand-placed one has no record of it, so it is the writer's.
 */
function edited(item: BoardItem): boolean {
  if (typeof item.data.text !== 'string') return true;
  if (item.kind === 'agent-note') return item.data.editedByUser === true || item.data.text !== item.data.arrangeText;
  if (typeof item.data.arrangeText === 'string') return unsigned(item.data.text) !== item.data.arrangeText;
  return !(SIGNATURE.test(item.data.text) && unsigned(item.data.text).split('\n').every((line) => STATE_LINE.test(line)));
}

/** A line an arrange wrote on a sticky before arranges recorded what they wrote: an agent's name and its state. */
const STATE_LINE = new RegExp(`^.+: (?:${AGENT_STATES.join('|')}|shell)$`);

/** The `arrange` key of the cluster a part belongs to: its own key without its part (`issue:ACME-9#note` → `issue:ACME-9`). */
const clusterKeyOf = (key: string) => key.replace(/#[^#]*$/, '');

/**
 * `parts` (an earlier arrange's, by key) as `clusters` take them: each by its cluster's key; and a cluster whose key
 * changed (its first tile went, or an edge now leads into it) takes the note of a cluster gone that shares an agent
 * with it, so its sticky is re-anchored, never lost. The rest are left over.
 */
function matchParts(clusters: readonly ArrangedCluster[], parts: ReadonlyMap<string, BoardItem>): { matched: Map<string, BoardItem>; left: BoardItem[] } {
  const keys = new Set(clusters.map((cluster) => cluster.key));
  const matched = new Map([...parts].filter(([key]) => keys.has(clusterKeyOf(key))));
  const orphans = [...parts].filter(([key]) => !keys.has(clusterKeyOf(key)) && key.endsWith(CLUSTER_NOTE_SLOT));
  for (const cluster of clusters) {
    const slot = `${cluster.key}${CLUSTER_NOTE_SLOT}`;
    if (matched.has(slot)) continue;
    const members = new Set(cluster.members.map((id) => id.replace(/^agent:/, '')));
    const index = orphans.findIndex(([, item]) => Array.isArray(item.data.members) && item.data.members.some((id) => members.has(String(id))));
    if (index === -1) continue;
    matched.set(slot, orphans[index]![1]);
    orphans.splice(index, 1);
  }
  const used = new Set(matched.values());
  return { matched, left: [...parts.values()].filter((item) => !used.has(item)) };
}

/** The fields that make `said` the text of the cluster note `kind`: an agent note's own, or a sticky's signed by `name`. */
const saying = (kind: string, said: string, name: string): Record<string, unknown> =>
  kind === 'agent-note'
    ? { text: said, arrangeText: said, writtenAt: new Date().toISOString(), editedByUser: false }
    : { text: stamped(said, name), arrangeText: said };

/** How many characters `stamped` adds for `name`. */
const signatureLength = (name: string) => stamped('', name).length;

/** `text` signed by `name` now, replacing a signature it had: so a note edited again isn't signed twice. */
function stamped(text: string, name: string, now = new Date()): string {
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  return `${unsigned(text)}\n\n🤖 ${name} · ${time}`;
}

/** Text's colours by name: the theme colour slots, each stored as its colour, which the board draws as the slot. */
const TEXT_SLOT_COLORS = COLOR_SLOTS.map((slot) => ({ name: slot, value: SLOT_COLORS[slot] }));

/** A note's colour as its data keeps it: a text item's slot beside it, so a colour set writes over the slot it had. */
type NoteColors = { color: string; colorSlot?: ColorSlot | null };

/**
 * `color` as a note of `kind` keeps it: one of its colours by name (any case), or any #rrggbb. A text item's colour by
 * name is its theme colour slot, and a #rrggbb is fixed, in no slot.
 */
function noteColor(kind: NoteKind, color: string): NoteColors {
  const presets = kind === 'sticky' ? STICKY_COLORS : TEXT_SLOT_COLORS;
  const named = presets.find((preset) => preset.name.toLowerCase() === color.trim().toLowerCase());
  if (named !== undefined) return kind === 'sticky' ? { color: named.value } : { color: named.value, colorSlot: named.name as ColorSlot };
  if (/^#[0-9a-fA-F]{6}$/.test(color.trim())) return kind === 'sticky' ? { color: color.trim().toLowerCase() } : { color: color.trim().toLowerCase(), colorSlot: null };
  throw invalidParams(`a ${kind === 'sticky' ? 'sticky note' : 'text'} colour is #rrggbb or one of ${presets.map((preset) => preset.name.toLowerCase()).join(', ')}`);
}

/** Text an agent gives a shape or connector: no control character but tabs and line breaks, at most `max` characters. */
function diagramText(fields: Record<string, unknown>, name: string, max: number): string | undefined {
  const text = optionalStringParam(fields, name);
  if (text === undefined) return undefined;
  if (NOTE_CONTROL.test(text)) throw invalidParams(`${name} may hold tabs and line breaks, but no other control character`);
  if (text.length > max) throw invalidParams(`${name} is at most ${max} characters`);
  return text;
}

/**
 * A shape's fill as given, with its slot: one of `FILL_SLOTS` by name (any case; `white`, as the tile was once called,
 * too), any #rrggbb, fixed, or `none`.
 */
function shapeFill(fill: string): { fill: string | null; fillSlot: FillSlot | null } {
  const wanted = fill.trim().toLowerCase();
  if (wanted === 'none') return { fill: null, fillSlot: null };
  const named = wanted === 'white' ? 'tile' : FILL_SLOTS.find((slot) => slot === wanted);
  if (named !== undefined) return { fill: FILL_SLOT_COLORS[named], fillSlot: named };
  if (/^#[0-9a-f]{6}$/.test(wanted)) return { fill: wanted, fillSlot: null };
  throw invalidParams(`a shape's fill is none, #rrggbb or one of ${FILL_SLOTS.join(', ')}`);
}

/**
 * The data fields a shape's params set, checked against its kind `shape`: only a class or box interface has sections,
 * so a section given another kind is refused.
 */
function shapeDataParams(fields: Record<string, unknown>, shape: ShapeType): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const text = diagramText(fields, 'text', MAX_TEXT_LENGTH);
  if (text !== undefined) data.text = text;
  for (const section of SHAPE_SECTIONS) {
    const lines = diagramText(fields, section, MAX_TEXT_LENGTH);
    if (lines === undefined) continue;
    if (!SECTIONED_SHAPES.includes(shape)) throw invalidParams(`a ${shape} has no ${section}: only ${SECTIONED_SHAPES.join(' and ')} shapes have sections`);
    data[section] = lines;
  }
  const fill = optionalStringParam(fields, 'fill');
  if (fill !== undefined) Object.assign(data, shapeFill(fill));
  return data;
}

/** A shape's kind as given, if it is. */
function shapeKindParam(fields: Record<string, unknown>): ShapeType | undefined {
  if (fields.shape === undefined) return undefined;
  if (!SHAPE_TYPES.includes(fields.shape as ShapeType)) throw invalidParams(`shape must be one of ${SHAPE_TYPES.join(', ')}`);
  return fields.shape as ShapeType;
}

/** The widest a shape an orchestrator draws starts, before its text wraps. */
const MAX_SHAPE_WIDTH = 480;
/** How wide a character is, in px, in a shape's name (heading 2, bold) and in its sections (mono), about. */
const NAME_CHAR = 14;
const SECTION_CHAR = 9;
/** A line's height in a shape's name and in its sections, px, and the room round a shape's text. */
const NAME_LINE = 32;
const SECTION_LINE = 22;
const SHAPE_PAD = 32;

/**
 * The size a shape an orchestrator draws starts at: as wide as its longest line, up to a limit, and as tall as its
 * name and sections. About: the board grows a shape taller to fit its text as it draws it.
 */
function shapeSize(data: { shape: ShapeType; text: string; attributes?: string; methods?: string }): Size {
  const lines = (text: string) => (text === '' ? [] : text.split('\n'));
  const name = lines(data.text);
  const sections = SECTIONED_SHAPES.includes(data.shape) ? SHAPE_SECTIONS.map((section) => lines(data[section] ?? '')) : [];
  const longest = Math.max(0, ...name.map((line) => line.length * NAME_CHAR), ...sections.flat().map((line) => line.length * SECTION_CHAR));
  const width = Math.min(MAX_SHAPE_WIDTH, Math.max(sections.length > 0 ? 200 : 160, longest + SHAPE_PAD));
  const sectionHeight = sections.reduce((sum, each) => sum + Math.max(1, each.length) * SECTION_LINE + SHAPE_PAD / 2, 0);
  return { width, height: Math.max(80, Math.max(1, name.length) * NAME_LINE + SHAPE_PAD + sectionHeight) };
}

/**
 * The sides a connector from `from` to `to` (board rects) leaves and arrives at: facing each other across the axis
 * they are furthest apart on, so a parent above its children is joined bottom to top.
 */
function facingSides(from: Rect, to: Rect): { from: ConnectorSide; to: ConnectorSide } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
  return dy > 0 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' };
}

/** The look a connector's params set: its relation's ends and dash, its style and its labels, each only if given. */
function connectorLookParams(fields: Record<string, unknown>): Partial<Pick<Connector, 'startEnd' | 'endEnd' | 'dashed' | 'style' | 'label' | 'startLabel' | 'endLabel'>> {
  const look: ReturnType<typeof connectorLookParams> = {};
  if (fields.relation !== undefined) {
    const relation = RELATIONS.find((each) => each.id === fields.relation);
    if (relation === undefined) throw invalidParams(`relation must be one of ${RELATIONS.map((each) => each.id).join(', ')}`);
    Object.assign(look, relation.look);
  }
  if (fields.style !== undefined) {
    if (!CONNECTOR_STYLES.includes(fields.style as Connector['style'])) throw invalidParams(`style must be one of ${CONNECTOR_STYLES.join(', ')}`);
    look.style = fields.style as Connector['style'];
  }
  for (const name of ['label', 'startLabel', 'endLabel'] as const) {
    const text = diagramText(fields, name, MAX_CONNECTOR_LABEL);
    if (text !== undefined) look[name] = text;
  }
  return look;
}

function targetParam(fields: Record<string, unknown>, name: string): LayoutTarget {
  const target = paramsObject(fields[name]);
  const kind = target.kind;
  if (kind !== 'agent' && kind !== 'shell' && kind !== 'item') throw invalidParams(`${name}.kind must be agent, shell or item`);
  return { kind, id: stringParam(target, 'id') };
}

function placeParams(fields: Record<string, unknown>): LayoutPlace {
  const place: LayoutPlace = {};
  if (fields.zoneId !== undefined) {
    if (fields.zoneId !== null && typeof fields.zoneId !== 'string') throw invalidParams('zoneId must be a string or null');
    place.zoneId = fields.zoneId;
  }
  if (fields.at !== undefined) {
    const at = paramsObject(fields.at);
    place.at = { x: finiteNumberParam(at, 'x'), y: finiteNumberParam(at, 'y') };
  }
  if (fields.near !== undefined) place.near = targetParam(fields, 'near');
  if (fields.side !== undefined) {
    if (!TILE_SIDES.includes(fields.side as TileSide)) throw invalidParams(`side must be ${TILE_SIDES.join(', ')}`);
    if (place.near === undefined) throw invalidParams('side is only with near');
    place.side = fields.side as TileSide;
  }
  if (place.at !== undefined && place.near !== undefined) throw invalidParams('give at or near, not both');
  return place;
}

function optionalSizeParam(fields: Record<string, unknown>, name: 'width' | 'height'): number | undefined {
  return fields[name] === undefined ? undefined : finiteNumberParam(fields, name);
}

/** Everything on the board a layout reads, through the daemon's own methods. */
async function readLayoutBoard(call: DaemonCall): Promise<Board> {
  const [zones, agents, shells, externals, items, sizes, unfolded, expanded] = await Promise.all([
    call('zone.list', undefined),
    call('agent.list', undefined),
    call('shell.list', undefined),
    call('external.list', undefined),
    call('item.list', undefined),
    call('view.get', { key: TILE_SIZES_VIEW_KEY }),
    call('view.get', { key: UNFOLDED_VIEW_KEY }),
    call('view.get', { key: EXPANDED_VIEW_KEY }),
  ]);
  const resized = typeof sizes === 'object' && sizes !== null ? (sizes as Record<string, Size>) : {};
  const open = new Set(unfoldedFrom(unfolded));
  // A closed agent the user hasn't unfolded is a chip on the board, so it takes a chip's room.
  const chips = Object.fromEntries(agents.filter((agent) => isFolded(agent, open)).map((agent) => [tileSizeKey('agent', agent.sessionId), CHIP_SIZE]));
  const opened = expandedSizesFrom(expanded);
  return {
    zones,
    agents,
    shells: shells.filter((shell) => shell.owner === null),
    externals,
    items,
    // A tile expanded in place takes its expanded size, so the rest are laid out clear of it.
    sizes: { ...resized, ...chips, ...opened },
    compact: Object.fromEntries(Object.keys(opened).map((key) => [key, chips[key] ?? resized[key] ?? AGENT_TILE_SIZE])),
  };
}

/**
 * Where something of `size` goes beside the agent's tile, in its zone (or loose with it): to its right, else the
 * nearest spot clear of everything else there. Undefined for an agent with no tile.
 */
export async function spotBesideAgent(call: DaemonCall, sessionId: string, size: Size): Promise<BoardPlace | undefined> {
  const board = await readLayoutBoard(call);
  const tile = placedOf(board).find((each) => each.kind === 'agent' && each.id === sessionId);
  if (tile === undefined) return undefined;
  const zone = board.zones.find((each) => each.id === tile.zoneId);
  const blocking = placedOf(board)
    .filter((each) => each.zoneId === tile.zoneId)
    .map(takenBy);
  if (zone === undefined) blocking.push(...board.zones);
  const region =
    zone === undefined ? { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity } : { left: ZONE_PADDING, top: ZONE_PADDING, right: Infinity, bottom: Infinity };
  const spot = nearestFreeSpot(besideSpot(tile.rect, 'right', size), blocking, region, size)!;
  return { zoneId: tile.zoneId, x: spot.x, y: spot.y };
}

export function layoutHandlers<Context extends BoardConnection>({
  db,
  access,
  call,
  spawn,
  close,
  warn = () => {},
}: LayoutHandlerOptions): RpcHandlers<LayoutMethods & Pick<DaemonMethods, 'orchestrator.spawn' | 'orchestrator.close'>, Context> {
  const zoneMadeBy = db.prepare('SELECT made_by FROM zones WHERE id = ?');
  const markZone = db.prepare('UPDATE zones SET made_by = ? WHERE id = ?');
  const itemMadeBy = db.prepare('SELECT made_by FROM board_items WHERE id = ?');
  const markItem = db.prepare('UPDATE board_items SET made_by = ? WHERE id = ?');
  const connectorMadeBy = db.prepare('SELECT made_by FROM connectors WHERE id = ?');
  const markConnector = db.prepare('UPDATE connectors SET made_by = ? WHERE id = ?');
  /** Arranges, one at a time per zone. */
  const arranging = keyedQueue();

  const madeBy = (statement: typeof zoneMadeBy, id: string): string | null =>
    (statement.get(id) as { made_by: string | null } | undefined)?.made_by ?? null;

  const readBoard = () => readLayoutBoard(call);

  /** Whether `me` may lay out `zone`: in its scope, or a group it (or its crew) made. */
  const zoneInReach = (me: Orchestrator, zone: Zone): boolean =>
    access.reachesZone(me, zone) || (me.agent !== null && zone.kind === 'unbound' && access.madeByCrew(me, madeBy(zoneMadeBy, zone.id)));

  /** Checks `me` may put things in `zoneId` (null: loose on the board, at board scope only). */
  const checkDestination = (me: Orchestrator, board: Board, zoneId: string | null): Zone | undefined => {
    if (zoneId === null) {
      if (me.orchestrate !== 'board') throw outOfScope(`only an orchestrator of the whole board puts things loose on it; your scope is ${access.scopeText(me)}`);
      return undefined;
    }
    const zone = board.zones.find((each) => each.id === zoneId);
    if (zone === undefined) throw invalidParams(`no zone ${zoneId}`);
    if (!zoneInReach(me, zone)) throw outOfScope(`${zone.name} is outside your scope (${access.scopeText(me)}), and is no group you made`);
    return zone;
  };

  /** The tile or item `target` names, which `me` may move: an agent it reaches, or a shell or item in a zone it may lay out. */
  const movable = (me: Orchestrator, board: Board, target: LayoutTarget): Placed => {
    const placed = placedOf(board).find((each) => each.kind === target.kind && each.id === target.id);
    if (placed === undefined) throw invalidParams(`no ${target.kind} ${target.id}`);
    if (target.kind === 'agent') {
      const agent = board.agents.find((each) => each.sessionId === target.id)!;
      if (!access.reachesAgent(me, agent)) throw outOfScope(`${agent.name} is outside your scope (${access.scopeText(me)}), and you did not start it`);
      return placed;
    }
    const zone = board.zones.find((each) => each.id === placed.zoneId);
    const reached = zone === undefined ? me.orchestrate === 'board' : zoneInReach(me, zone);
    if (!reached) throw outOfScope(`${placed.name} is outside your scope (${access.scopeText(me)})`);
    return placed;
  };

  /**
   * Whether `me` may move `placed` aside to make room in a zone it lays out, as arrange may: a shell, an agent in its
   * scope, or a note or card its crew made; never the user's notes and cards, an agent outside its scope, nor an
   * external session's tile.
   */
  const mayMove = (me: Orchestrator, board: Board, placed: Placed): boolean =>
    placed.kind === 'item'
      ? access.madeByCrew(me, madeBy(itemMadeBy, placed.id))
      : placed.kind === 'shell' || (placed.kind === 'agent' && access.reachesAgent(me, board.agents.find((each) => each.sessionId === placed.id)!));

  /**
   * Where something of `size` goes in `zone` (or loose, with none) for `place`: at `at` on the grid cell nearest it, or
   * beside `near`, exactly (`roomFor` moves what is in the way aside); else the first free spot a new tile (or note)
   * takes. Loose on the board, or where that would be outside its zone, it is moved the least distance clear of what is
   * there but `exclude`.
   */
  const spotFor = (board: Board, zone: Zone | undefined, size: Size, place: LayoutPlace, exclude: string | null, isNote: boolean): Point => {
    const here = placedOf(board).filter((each) => each.key !== exclude && each.zoneId === (zone?.id ?? null));
    const blocking = here.map(takenBy);
    if (zone === undefined) blocking.push(...board.zones);
    const region =
      zone === undefined
        ? { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity }
        : { left: ZONE_PADDING, top: ZONE_PADDING + (isNote ? 0 : PERCH_ROOM), right: Infinity, bottom: Infinity };
    let wanted: Point;
    if (place.near !== undefined) {
      const near = placedOf(board).find((each) => each.kind === place.near!.kind && each.id === place.near!.id);
      if (near === undefined) throw invalidParams(`no ${place.near.kind} ${place.near.id}`);
      wanted = besideSpot(near.rect, place.side ?? 'below', size);
      if (zone !== undefined && wanted.x >= region.left && wanted.y >= region.top) return wanted;
    } else if (place.at !== undefined) {
      if (zone !== undefined) {
        // A wish past the zone's reach is put at its edge, on the grid.
        const snapped = snapToGrid({ x: clamp(place.at.x, ZONE_PADDING, zone.width + MAX_REACH), y: clamp(place.at.y, ZONE_PADDING, zone.height + MAX_REACH) });
        return {
          x: snapped.x > zone.width + MAX_REACH ? snapped.x - GRID_COLUMN : snapped.x,
          y: snapped.y > zone.height + MAX_REACH ? snapped.y - ROW_STEP : snapped.y,
        };
      }
      wanted = { x: clamp(place.at.x, -BOARD_EXTENT, BOARD_EXTENT), y: clamp(place.at.y, -BOARD_EXTENT, BOARD_EXTENT) };
    } else if (zone === undefined) {
      return freeSpotFor({ x: 0, y: 0 }, size, [...board.zones, ...here.map((each) => each.rect)]);
    } else {
      const taken = here.map((each) => each.rect);
      return isNote ? freeItemSpot(zone.width, size, taken) : freeTileSlot(zone.width, taken, size);
    }
    // The region has no right or bottom edge, so a clear spot is always found.
    return nearestFreeSpot(wanted, blocking, region, size)!;
  };

  /**
   * What moves aside, and to where, for `rect` (a tile's footprint, or an item's rect) to go in `zone`: the
   * tiles and notes in its way pushed right along their row (`makeRoom`). Throws if something `me` may not move is there.
   */
  const roomFor = (me: Orchestrator, board: Board, zone: Zone, rect: Rect, exclude: string | null): { placed: Placed; spot: Point }[] => {
    const here = placedOf(board).filter((each) => each.key !== exclude && each.zoneId === zone.id);
    const fixed = here.filter((each) => !mayMove(me, board, each));
    const there = fixed.find((each) => !clearOf(rect, [takenBy(each)]));
    if (there !== undefined) {
      throw outOfScope(
        there.kind === 'item'
          ? `${there.name} is there, and you didn't make it: only the user moves their notes and cards. Pick another spot`
          : `${there.name} is there, outside your scope (${access.scopeText(me)}): pick another spot`,
      );
    }
    const moves = makeRoom(
      rect,
      here.filter((each) => mayMove(me, board, each)).map((each) => ({ id: each.key, rect: takenBy(each) })),
      fixed.map(takenBy),
    );
    return [...moves].map(([key, at]) => {
      const placed = here.find((each) => each.key === key)!;
      // Where it goes is where what it takes goes: a tile below the room above it, a turned item inside its upright box.
      const taken = takenBy(placed);
      return { placed, spot: { x: at.x + placed.rect.x - taken.x, y: at.y + placed.rect.y - taken.y } };
    });
  };

  /** The zone `place` puts things in: `near`'s, else the one it names, else `fallback`'s. */
  const zoneOfPlace = (board: Board, place: LayoutPlace, fallback: string | null): string | null => {
    if (place.near !== undefined) {
      const near = placedOf(board).find((each) => each.kind === place.near!.kind && each.id === place.near!.id);
      if (near === undefined) throw invalidParams(`no ${place.near.kind} ${place.near.id}`);
      if (place.zoneId !== undefined && place.zoneId !== near.zoneId) throw invalidParams(`${near.name} is in another zone than the one named`);
      return near.zoneId;
    }
    return place.zoneId === undefined ? fallback : place.zoneId;
  };

  /** The size `zone` grows to, to hold `rect` (relative to it), as the board grows a zone round what is dropped in it. */
  const grownTo = (zone: Zone, rect: Rect, isNote: boolean): Size => ({
    width: Math.max(zone.width, rect.x + rect.width + ZONE_PADDING),
    height: Math.max(zone.height, rect.y + rect.height + (isNote ? 0 : TILE_GAP) + ZONE_PADDING),
  });

  /** The size `zone` grows to, to hold `placed` and what moved aside to make room for it. */
  const grownWith = (zone: Zone, placed: Rect, isNote: boolean, aside: readonly { placed: Placed; spot: Point }[]): Size =>
    aside.reduce(
      (size, each) => grownTo({ ...zone, ...size }, { ...each.spot, width: each.placed.rect.width, height: each.placed.rect.height }, each.placed.kind === 'item'),
      grownTo(zone, placed, isNote),
    );

  /** The zone `zone` would cover, grown to `size`, if any. */
  const coveredBy = (board: Board, zone: Zone, size: Size): Zone | undefined =>
    board.zones.find((other) => other.id !== zone.id && overlaps({ x: zone.x, y: zone.y, ...size }, other));

  /** Throws unless `zone` may grow to `size`: zones never overlap, so not over another. */
  const checkGrowth = (board: Board, zone: Zone, size: Size, why: string) => {
    const covered = coveredBy(board, zone, size);
    if (covered !== undefined) {
      throw invalidParams(`${why} ${zone.name} would grow to ${Math.round(size.width)}×${Math.round(size.height)}, over ${covered.name}: zones never overlap. Pick a spot inside it, or ask the user to make room`);
    }
  };

  /** Resizes `zone` to `size`, if it differs: a move grows it, an arrange fits it (growing or shrinking it). */
  const growTo = async (zone: Zone | undefined, size: Size) => {
    if (zone !== undefined && (size.width !== zone.width || size.height !== zone.height)) {
      await call('zone.update', { id: zone.id, x: zone.x, y: zone.y, ...size });
    }
  };

  /** Moves the tile or item to `zoneId` at `spot`, as the board's drag does. */
  const moveTo = async (placed: Pick<Placed, 'kind' | 'id'>, zoneId: string | null, spot: Point) => {
    const move = { zoneId, x: spot.x, y: spot.y };
    if (placed.kind === 'agent') await call('agent.move', { sessionId: placed.id, ...move });
    else if (placed.kind === 'shell') await call('shell.move', { shellId: placed.id, ...move });
    else if (placed.kind === 'external') await call('external.move', { id: placed.id, ...move });
    else await call('item.update', { id: placed.id, ...move });
  };

  /** The group `id`, which `me` may change: a group, made by it or its crew (any, on the user's side). */
  const ownGroup = (me: Orchestrator, board: Board, id: string): Zone => {
    const zone = board.zones.find((each) => each.id === id);
    if (zone === undefined) throw invalidParams(`no zone ${id}`);
    if (zone.kind !== 'unbound') throw invalidParams(`${zone.name} is bound to a repo: the zone commands change only groups`);
    if (!access.madeByCrew(me, madeBy(zoneMadeBy, zone.id))) {
      throw outOfScope(`${zone.name} was not made by you or an agent you started: an orchestrator changes only the groups its crew made`);
    }
    return zone;
  };

  /**
   * The note `id`, which `me` may change: a sticky note or text item made by it or its crew (any, on the user's side);
   * to remove, a link card too.
   */
  const ownNote = (me: Orchestrator, id: string, items: BoardItem[], kinds: ReadonlySet<string> = NOTE_ITEM_KINDS): BoardItem => {
    const item = items.find((each) => each.id === id);
    if (item === undefined) throw invalidParams(`no board item ${id}`);
    if (!kinds.has(item.kind)) {
      throw invalidParams(
        kinds === SHAPE_KINDS
          ? `that is a ${item.kind} item: the shape commands change only shapes`
          : `that is a ${item.kind} item: the note commands change only notes and text, and remove link cards`,
      );
    }
    if (!access.madeByCrew(me, madeBy(itemMadeBy, item.id))) {
      const what = item.kind === 'shape' ? 'shape' : 'note';
      throw outOfScope(`that ${what} was not made by you or an agent you started: an orchestrator changes only the ${what}s its crew made`);
    }
    return item;
  };

  /** The item `id`, which `me` may draw a connector to: one in a zone it may lay out (loose, at board scope). */
  const drawable = (me: Orchestrator, board: Board, id: string): BoardItem => {
    const item = board.items.find((each) => each.id === id);
    if (item === undefined) throw invalidParams(`no board item ${id}`);
    const zone = board.zones.find((each) => each.id === item.zoneId);
    const reached = zone === undefined ? me.orchestrate === 'board' : zoneInReach(me, zone);
    if (!reached) throw outOfScope(`${itemName(item)} is outside your scope (${access.scopeText(me)})`);
    return item;
  };

  /** `item`'s rect on the board: its zone's corner added to a place relative to it. */
  const boardRect = (board: Board, item: BoardItem): Rect => {
    const zone = board.zones.find((each) => each.id === item.zoneId);
    return { x: item.x + (zone?.x ?? 0), y: item.y + (zone?.y ?? 0), width: item.width, height: item.height };
  };

  /** What a connector is called in a log line: its label, or that it is one. */
  const connectorName = (connector: Connector) => (connector.label === '' ? 'a connector' : `connector ${quoted(connector.label)}`);

  /** The connector `id`, which `me` may change: one it or its crew made (any, on the user's side). */
  const ownConnector = async (me: Orchestrator, id: string): Promise<Connector> => {
    const connector = (await call('connector.list', undefined)).find((each) => each.id === id);
    if (connector === undefined) throw invalidParams(`no connector ${id}`);
    if (!access.madeByCrew(me, madeBy(connectorMadeBy, connector.id))) {
      throw outOfScope('that connector was not made by you or an agent you started: an orchestrator changes only the connectors its crew made');
    }
    return connector;
  };

  /** `item` as it is now, or undefined if it has gone (or was undefined). */
  const fresh = async (item: BoardItem | undefined): Promise<BoardItem | undefined> =>
    item === undefined ? undefined : (await call('item.list', undefined)).find((each) => each.id === item.id);

  /**
   * The parts an arrange of `me`'s crew made before in `zoneId`, by their `arrange` key, and those that go: any more of
   * one key (stacked by an arrange from before they were made one at a time), and the pull request link cards arranges
   * made before they stopped making them.
   */
  const clusterParts = (me: Orchestrator, zoneId: string, items: readonly BoardItem[]): { parts: Map<string, BoardItem>; stale: BoardItem[] } => {
    const parts = new Map<string, BoardItem>();
    const stale: BoardItem[] = [];
    for (const item of items) {
      if (item.zoneId !== zoneId || typeof item.data.arrange !== 'string' || !access.madeByCrew(me, madeBy(itemMadeBy, item.id))) continue;
      if (item.kind === 'link' || parts.has(item.data.arrange)) stale.push(item);
      else parts.set(item.data.arrange, item);
    }
    return { parts, stale };
  };

  /**
   * Puts each cluster's label and note where `clusters` says, editing the ones an arrange made before
   * (`parts`, by their cluster's `arrange` key) in place rather than stacking new ones, and leaving alone what is
   * already where it goes. The note is an agent note signed by `me` (a sticky when the user's side arranges) and says where
   * each of its agents stands (`standing`) until someone edits it: then it keeps their text. A sticky an earlier arrange
   * made and no one edited is replaced by an agent note. Returns the parts it used.
   */
  const placeClusters = async (me: Orchestrator, zoneId: string, clusters: readonly ArrangedCluster[], parts: ReadonlyMap<string, BoardItem>, standing: (id: string) => string) => {
    const used = new Set<BoardItem>();
    /** Writes `data` as the part `key` (`known`, or made new as `kind`), moved to `at`; only what differs is written. */
    const put = async (key: string, kind: 'text' | 'sticky' | 'agent-note', known: BoardItem | undefined, at: Point, size: Size, data: Record<string, unknown>) => {
      if (known !== undefined) {
        const wanted = { ...data, arrange: key };
        const changed = Object.entries(wanted).filter(([field, value]) => JSON.stringify(known.data[field]) !== JSON.stringify(value));
        const moved = known.x !== at.x || known.y !== at.y || known.width !== size.width || known.height !== size.height;
        if (moved || changed.length > 0) await call('item.update', { id: known.id, zoneId, ...at, ...size, data: Object.fromEntries(changed) });
        return;
      }
      const item = await call('item.create', { kind, zoneId, ...at, ...size, data: { ...data, arrange: key } });
      markItem.run(me.agent?.sessionId ?? null, item.id);
    };
    // An agent writes agent notes; the user's side has no badge to give one, so its arranges make stickies.
    const author = me.agent === null ? undefined : agentNoteAuthor(me.agent);
    for (const cluster of clusters) {
      const label = parts.get(`${cluster.key}#label`);
      if (label !== undefined) used.add(label);
      await put(`${cluster.key}#label`, 'text', label, cluster.labelAt, CLUSTER_LABEL_SIZE, { ...textItemData(cluster.label, { color: SLOT_COLORS.ink, colorSlot: 'ink' }), bold: true });
      const said = noteSays(cluster, standing);
      const slot = `${cluster.key}${CLUSTER_NOTE_SLOT}`;
      // Read afresh: the user may have edited it in the app since the arrange read the board.
      const earlier = parts.get(slot);
      if (earlier !== undefined) used.add(earlier);
      let known = await fresh(earlier);
      // A sticky of the old kind nobody edited gives way to an agent note.
      if (known !== undefined && author !== undefined && known.kind === 'sticky' && !edited(known)) {
        await call('item.delete', { id: known.id });
        known = undefined;
      }
      const members = cluster.members.flatMap((id) => (id.startsWith('agent:') ? [id.slice('agent:'.length)] : []));
      // Edited: its text is someone's, so it stays. Unchanged: it isn't written again.
      const keep = known !== undefined && (edited(known) || known.data.arrangeText === said);
      let data: Record<string, unknown>;
      // About its cluster's implementer, its first: the board tethers it there, never to its author.
      const about = members[0] === undefined ? {} : { about: members[0] };
      // The height it is given and the text it is given it for, unless it keeps its own: the next arrange tells a height
      // it grew to from this one, while its text stays.
      const sized =
        known !== undefined && heldHeight(known, keep) !== undefined ? {} : { arrangeHeight: cluster.noteSize.height, sizedFor: keep ? known?.data.text : said };
      if (known?.kind === 'agent-note') data = { ...(keep ? {} : saying('agent-note', said, me.name)), members, ...about, ...sized };
      else if (known !== undefined) data = { ...(keep ? {} : saying('sticky', said, me.name)), color: typeof known.data.color === 'string' ? known.data.color : STICKY_COLORS[0].value, members };
      else if (author !== undefined) data = { ...agentNoteData(author, said, about), arrangeText: said, members, ...sized };
      else data = { text: stamped(said, me.name), arrangeText: said, color: STICKY_COLORS[0].value, members };
      await put(slot, (known?.kind as 'sticky' | 'agent-note' | undefined) ?? (author === undefined ? 'sticky' : 'agent-note'), known, cluster.noteAt, cluster.noteSize, data);
    }
    return used;
  };

  /**
   * How tall each of `clusters`' notes needs to be for its text to show (`notes`, by slot key, what fills them), by
   * cluster key: what it says now if an arrange writes it again, else its own text, and a height it keeps
   * (`heldHeight`). A sticky's text shrinks to fit its slot instead, so it needs nothing more.
   */
  const noteHeightsOf = (me: Orchestrator, clusters: readonly ArrangedCluster[], notes: ReadonlyMap<string, BoardItem>, standing: (id: string) => string) =>
    new Map(
      clusters.map((cluster) => {
        const known = notes.get(`${cluster.key}${CLUSTER_NOTE_SLOT}`);
        const said = noteSays(cluster, standing);
        // As `placeClusters` makes it: a sticky of the old kind nobody edited gives way to an agent note.
        const agentNote = known === undefined ? me.agent !== null : known.kind === 'agent-note' || (me.agent !== null && !edited(known));
        if (!agentNote) return [cluster.key, 0] as const;
        const keep = known !== undefined && (edited(known) || known.data.arrangeText === said);
        const needs = agentNoteSize(keep ? String(known.data.text) : said, CLUSTER_NOTE_SIZE.width, 0).height;
        return [cluster.key, Math.max(needs, (known && heldHeight(known, keep)) ?? 0)] as const;
      }),
    );

  /**
   * The agent notes `me`'s crew put in a cluster's slot before an arrange, by that cluster's note slot key: one made
   * by `note add --near` an agent of the cluster (its `about`), and left beside that agent's tile, on any side. A cluster
   * that has a note from an arrange takes none, and takes one at most; the rest stay where they are, as obstacles.
   */
  const handPlaced = (me: Orchestrator, inZone: readonly Placed[], items: readonly BoardItem[], parts: ReadonlyMap<string, BoardItem>, clusters: readonly ArrangedCluster[]): Map<string, BoardItem> => {
    const { matched } = matchParts(clusters, parts);
    const known = new Set(parts.values());
    const free = items.filter(
      (item) => item.kind === 'agent-note' && item.data.arrange === undefined && typeof item.data.about === 'string' && !known.has(item) && access.madeByCrew(me, madeBy(itemMadeBy, item.id)),
    );
    const adopted = new Map<string, BoardItem>();
    for (const cluster of clusters) {
      const slot = `${cluster.key}${CLUSTER_NOTE_SLOT}`;
      if (matched.has(slot)) continue;
      const members = new Set(cluster.members.map((id) => id.replace(/^agent:/, '')));
      const note = free.find((item) => {
        const about = item.data.about as string;
        const rect = inZone.find((each) => each.key === `item:${item.id}`)?.rect;
        const tile = inZone.find((each) => each.kind === 'agent' && each.id === about)?.rect;
        if (rect === undefined || tile === undefined || !members.has(about) || [...adopted.values()].includes(item)) return false;
        // Beside the tile, on any side, within a tile gap and a bit.
        const reach = 2 * TILE_GAP;
        return overlaps({ x: rect.x - reach, y: rect.y - reach, width: rect.width + 2 * reach, height: rect.height + 2 * reach }, tile);
      });
      if (note !== undefined) adopted.set(slot, note);
    }
    return adopted;
  };

  /** The sticky of the cluster an arrange put `sessionId`'s tile in, in `zoneId`, if any. */
  const clusterStickyOf = (board: Board, zoneId: string, sessionId: string): BoardItem | undefined =>
    board.items.find(
      (item) =>
        item.zoneId === zoneId &&
        typeof item.data.arrange === 'string' &&
        item.data.arrange.endsWith(CLUSTER_NOTE_SLOT) &&
        Array.isArray(item.data.members) &&
        item.data.members.includes(sessionId),
    );

  /**
   * Puts `reviewer`, just started by `me`, straight into the cluster of the agent it reviews: after that one
   * and its other reviewers, on the grid, what is there moving along, and on its cluster's note. It waits its turn
   * with the zone's arranges and other joins, reading the board afresh. A reviewer of no arranged cluster, or one whose
   * slot can't be made, is left where the board slots it; a join that fails is only warned of, since the reviewer has
   * started all the same.
   */
  const joinCluster = async (caller: () => Orchestrator, reviewer: Agent): Promise<Agent> => {
    const zoneId = reviewer.zoneId;
    if (zoneId === null || (reviewer.reviewOf === null && reviewer.reviews === null)) return reviewer;
    try {
      const me = caller();
      return await arranging(zoneId, () => joinNow(me, reviewer, zoneId));
    } catch (error) {
      warn(`${reviewer.name} started, but could not join its cluster: ${(error as Error).message}`);
      return reviewer;
    }
  };

  const joinNow = async (me: Orchestrator, reviewer: Agent, zoneId: string): Promise<Agent> => {
    const board = await readBoard();
    const zone = board.zones.find((each) => each.id === zoneId);
    const implementer = zone === undefined ? undefined : reviewedBy(board.agents, reviewer);
    const sticky = implementer === undefined ? undefined : clusterStickyOf(board, zoneId, implementer.sessionId);
    if (zone === undefined || implementer === undefined || sticky === undefined) return reviewer;
    const members = (sticky.data.members as unknown[]).filter((id): id is string => typeof id === 'string' && id !== reviewer.sessionId);
    const placed = placedOf(board);
    const implementerTile = placed.find((each) => each.kind === 'agent' && each.id === implementer.sessionId);
    if (implementerTile === undefined) return reviewer;
    // Its chain: the implementer and the reviewers of it already in the cluster, on its row. It goes after the last.
    const chain = members.filter((id) => {
      const agent = board.agents.find((each) => each.sessionId === id);
      return id === implementer.sessionId || (agent !== undefined && reviewedBy(board.agents, agent)?.sessionId === implementer.sessionId);
    });
    const tiles = placed.filter((each) => each.kind === 'agent' && chain.includes(each.id) && each.rect.y === implementerTile.rect.y);
    const last = tiles.reduce((right, each) => (each.rect.x + each.rect.width > right.rect.x + right.rect.width ? each : right));
    const spot = { x: gridPoint(gridColumnAtOrRight(last.rect.x + last.rect.width + TILE_GAP), 0).x, y: implementerTile.rect.y };
    const key = tileSizeKey('agent', reviewer.sessionId);
    const size = board.sizes[key] ?? AGENT_TILE_SIZE;
    let aside: { placed: Placed; spot: Point }[];
    let grown: Size;
    try {
      aside = roomFor(me, board, zone, sizedFootprint(spot, size), key);
      grown = grownWith(zone, { ...spot, ...size }, false, aside);
      checkGrowth(board, zone, grown, 'joined to its cluster,');
    } catch {
      return reviewer;
    }
    await call('agent.move', { sessionId: reviewer.sessionId, zoneId: zone.id, ...spot });
    for (const each of aside) await moveTo(each.placed, zone.id, each.spot);
    await growTo(zone, grown);
    const at = members.indexOf(last.id) + 1;
    const joined = [...members.slice(0, at), reviewer.sessionId, ...members.slice(at)];
    const agents = await call('agent.list', undefined);
    const said = cutText(
      joined
        .map((id) => agents.find((each) => each.sessionId === id))
        .flatMap((agent) => (agent === undefined ? [] : [standingOf(agent.name, agent)]))
        .join('\n'),
      MAX_UNIT_NOTE,
    );
    // Read afresh: the user may have edited it in the app since the join read the board.
    const now = await fresh(sticky);
    if (now === undefined) throw new Error('its cluster’s note has gone');
    // Written with the reviewer's line, an agent note grows to show it.
    const rewrite = edited(now) ? {} : saying(now.kind, said, me.name);
    const taller = now.kind === 'agent-note' && typeof rewrite.text === 'string' ? grownNote(now, rewrite.text) : {};
    await call('item.update', { id: now.id, data: { members: joined, ...rewrite }, ...taller });
    return agents.find((each) => each.sessionId === reviewer.sessionId) ?? reviewer;
  };

  /** The tiles of `zone` that `me` arranges: the agents in its scope (itself the lead) and the shells. */
  const crewOf = (me: Orchestrator, board: Board, zone: Zone): ArrangeTile[] => {
    const agentsHere = board.agents.filter((agent) => agent.zoneId === zone.id && access.reachesAgent(me, agent));
    const branches = new Map(agentsHere.filter((agent) => agent.branch !== '').map((agent) => [agent.branch, agent.sessionId]));
    return [
      ...agentsHere.map((agent): ArrangeTile => {
        // A reviewer the user started reviews `reviewOf`; one an orchestrator started reviews a branch.
        const reviewed = agent.reviewOf ?? (agent.reviews === null ? undefined : branches.get(agent.reviews.branch));
        return {
          id: tileSizeKey('agent', agent.sessionId),
          name: agent.name,
          kind: 'agent',
          role: agent.role,
          issue: agent.issue?.id ?? null,
          issueTitle: agent.issue?.title ?? null,
          state: agent.state,
          reviewOf: reviewed === undefined ? null : tileSizeKey('agent', reviewed),
          lead: agent.sessionId === me.agent?.sessionId,
          branch: ticketBranch(board.agents, agent),
          createdAt: agent.createdAt,
          ...(board.sizes[tileSizeKey('agent', agent.sessionId)] === undefined ? {} : { size: board.sizes[tileSizeKey('agent', agent.sessionId)] }),
        };
      }),
      ...board.shells
        .filter((shell) => shell.zoneId === zone.id)
        .map((shell): ArrangeTile => ({
          id: tileSizeKey('shell', shell.id),
          name: shell.name,
          kind: 'shell',
          role: null,
          issue: null,
          state: null,
          reviewOf: null,
          lead: false,
          ...(board.sizes[tileSizeKey('shell', shell.id)] === undefined ? {} : { size: board.sizes[tileSizeKey('shell', shell.id)] }),
        })),
    ];
  };

  /** Every edge between two agents, as an arrange reads them. */
  const linksOf = async () => (await call('flowEdge.list', undefined)).map((edge) => ({ from: tileSizeKey('agent', edge.from), to: tileSizeKey('agent', edge.to) }));

  /** Each orchestrator's arrange settings, saved, one change at a time. */
  const settingsQueue = keyedQueue();
  const savedSettings = async (): Promise<Record<string, unknown>> => {
    const saved = await call('view.get', { key: ARRANGE_SETTINGS_VIEW_KEY });
    return typeof saved === 'object' && saved !== null && !Array.isArray(saved) ? (saved as Record<string, unknown>) : {};
  };

  /** `me`'s arrange settings: the defaults on the user's side, which keeps none. */
  const settingsOf = async (me: Orchestrator): Promise<ArrangeSettings> =>
    me.agent === null ? DEFAULT_ARRANGE_SETTINGS : settingsFrom((await savedSettings())[me.agent.sessionId]);

  /** Changes `me`'s arrange settings by `changes`, keeping them for its next arrange; returns them. */
  const keepSettings = (me: Orchestrator, changes: Partial<ArrangeSettings>): Promise<ArrangeSettings> =>
    settingsQueue('settings', async () => {
      if (me.agent === null) return { ...DEFAULT_ARRANGE_SETTINGS, ...changes };
      const all = await savedSettings();
      const was = settingsFrom(all[me.agent.sessionId]);
      const now = { ...was, ...changes };
      if (JSON.stringify(now) !== JSON.stringify(was)) await call('view.set', { key: ARRANGE_SETTINGS_VIEW_KEY, value: { ...all, [me.agent.sessionId]: now } });
      return now;
    });

  /**
   * Arranges `zoneId` for `me` as its settings say, with `changes` (read in the zone's layout queue, so a refusal is
   * logged) kept once nothing can refuse it: its zone is in scope and may grow as it needs; `how` says in the activity log what moved it to. One arrange of a
   * zone at a time: two at once would each make its lanes' labels and notes.
   */
  const arrangeIn = (me: Orchestrator, zoneId: string | null, changes: () => Partial<ArrangeSettings>, how = ''): Promise<ArrangeResult> => {
    const entry: ActivityEntry = { detail: '' };
    return access.logged(me, 'arrange', entry, () => arranging(zoneId ?? '', async () => {
      const changed = changes();
      if (zoneId === null) throw invalidParams(`${me.agent === null ? 'you have' : 'your tile is in'} no zone: name the zone to arrange`);
      const board = await readBoard();
      const zone = checkDestination(me, board, zoneId)!;
      entry.on = { id: zone.id, name: zone.name };
      // Kept only once the arrange is sure to go ahead: a refused one keeps nothing.
      const { by, layout } = { ...(await settingsOf(me)), ...changed };
      const inZone = placedOf(board).filter((each) => each.zoneId === zone.id);
      const tiles = crewOf(me, board, zone);
      const moving = new Set(tiles.map((tile) => tile.id));
      // What an arrange of its crew made before (each cluster's label and note) it places again, in place.
      const clusters = by === 'issue' && layout !== 'grid';
      const { parts, stale } = clusterParts(me, zone.id, board.items);
      const ownParts = new Set([...parts.values(), ...stale].map((item) => `item:${item.id}`));
      const links = await linksOf();
      const keep = (excluding: ReadonlySet<string>) => inZone.filter((each) => !moving.has(each.key) && !excluding.has(each.key)).map(takenBy);
      const standing = (id: string) => {
        const tile = tiles.find((each) => each.id === id)!;
        const agent = board.agents.find((each) => tileSizeKey('agent', each.sessionId) === id);
        return standingOf(tile.name, agent);
      };
      // An agent note its crew left in a cluster's slot (`note add --near`) is that cluster's note: not in the way of
      // the layout. Who is in a cluster doesn't depend on where anything is, so the clusters are read from a first pass.
      const first = clusters ? arrangeTiles(tiles, links, { by, layout, width: zone.width, obstacles: keep(ownParts), clusters }).clusters : [];
      const byHand = clusters ? handPlaced(me, inZone, board.items, parts, first) : new Map<string, BoardItem>();
      const obstacles = keep(new Set([...ownParts, ...[...byHand.values()].map((item) => `item:${item.id}`)]));
      // Each lane makes room for its note at the height its text needs.
      // Read afresh, as `placeClusters` reads each: the user may have edited one in the app since the board was read.
      const current = new Map((await call('item.list', undefined)).map((item) => [item.id, item]));
      const filling = [...matchParts(first, parts).matched, ...byHand].map(([slot, item]) => [slot, current.get(item.id) ?? item] as const);
      const noteHeights = noteHeightsOf(me, first, new Map(filling), standing);
      // Laid out round `stay` too: the parts it could find no room to park, left where they are.
      const plan = (stay: readonly Rect[]) => {
        const arranged = arrangeTiles(tiles, links, { by, layout, width: zone.width, obstacles: [...obstacles, ...stay], clusters, noteHeights });
        const { positions } = arranged;
        // By issue, each cluster takes its parts, re-anchoring a note whose cluster's key changed. Arranged another way,
        // what an arrange by issue made is kept, parked beside the crew, until it is again; so is a sticky someone edited
        // whose cluster has gone. The rest of what is left over goes.
        const { matched, left } = clusters ? matchParts(arranged.clusters, parts) : { matched: new Map<string, BoardItem>(), left: [...parts.values()] };
        for (const cluster of arranged.clusters) {
          const slot = `${cluster.key}${CLUSTER_NOTE_SLOT}`;
          const note = byHand.get(slot);
          if (!matched.has(slot) && note !== undefined) matched.set(slot, note);
        }
        const toPark = clusters ? left.filter((item) => String(item.data.arrange).endsWith(CLUSTER_NOTE_SLOT) && edited(item)) : left;
        const parkKeys = [...new Set(toPark.map((item) => clusterKeyOf(String(item.data.arrange))))];
        const placedRects = [
          ...tiles.map((tile) => sizedFootprint(positions.get(tile.id)!, tile.size ?? AGENT_TILE_SIZE)),
          ...arranged.clusters.flatMap((cluster) => [
            { ...cluster.labelAt, ...CLUSTER_LABEL_SIZE },
            { ...cluster.noteAt, ...cluster.noteSize },
          ]),
        ];
        // The zone fits what it holds: grown or shrunk to the crew, what it parked and what stays put.
        // A parked note keeps its own size.
        const parkedNote = (key: string): Size => {
          const item = toPark.find((each) => each.data.arrange === `${key}${CLUSTER_NOTE_SLOT}`);
          return item === undefined ? CLUSTER_NOTE_SIZE : { width: item.width, height: item.height };
        };
        const sizeWith = (parked: ReturnType<typeof parkClusters>): Size =>
          fittedSize(
            [...placedRects, ...parked.flatMap((cluster) => [{ ...cluster.labelAt, ...CLUSTER_LABEL_SIZE }, { ...cluster.noteAt, ...parkedNote(cluster.key) }])],
            [...obstacles, ...stay],
          );
        const park = (from: { column: number; row: number }) => parkClusters(parkKeys, from, [...obstacles, ...placedRects], parkedNote);
        // Beside the crew; else, where that would grow the zone over another, below it; else nowhere, left as they are.
        const right = Math.max(ZONE_PADDING, ...placedRects.map((rect) => rect.x + rect.width));
        const bottom = Math.max(ZONE_PADDING, ...placedRects.map((rect) => rect.y + rect.height));
        const parked =
          parkKeys.length === 0 || stay.length > 0
            ? []
            : ([park({ column: gridColumnAtOrRight(right + TILE_GAP), row: 0 }), park({ column: 0, row: gridRowAtOrBelow(bottom + TILE_GAP) })].find(
                (each) => coveredBy(board, zone, sizeWith(each)) === undefined,
              ) ?? []);
        return { arranged, positions, matched, left, toPark, parkKeys, parked, sizeWith };
      };
      let laid = plan([]);
      // Nowhere to park them: the crew is laid out again round them where they are, never on top of them.
      if (laid.parkKeys.length > 0 && laid.parked.length === 0) laid = plan(laid.toPark.map((item) => ({ x: item.x, y: item.y, width: item.width, height: item.height })));
      const { arranged, positions, matched, left, toPark, parked, sizeWith } = laid;
      const { width, height } = sizeWith(parked);
      // Checked before anything moves, so a refused arrange leaves the zone as it was.
      checkGrowth(board, zone, { width, height }, 'arranged,');
      await keepSettings(me, changed);
      for (const item of stale) await call('item.delete', { id: item.id });
      const moved: LayoutMoved[] = [];
      for (const tile of tiles) {
        const spot = positions.get(tile.id)!;
        const placed = inZone.find((each) => each.key === tile.id)!;
        // A tile the board slotted is moved even to where it is drawn: it is saved there, so it stays.
        if (placed.saved && placed.rect.x === spot.x && placed.rect.y === spot.y) continue;
        await moveTo(placed, zone.id, spot);
        moved.push({ target: { kind: placed.kind as 'agent' | 'shell', id: placed.id }, zoneId: zone.id, ...spot });
      }
      await growTo(zone, { width, height });
      entry.detail = `${tiles.length} tile${tiles.length === 1 ? '' : 's'} by ${by}, in ${layout}${how}`;
      if (clusters) {
        const used = await placeClusters(me, zone.id, arranged.clusters, matched, standing);
        // A part its cluster no longer has (another cluster's) goes.
        for (const item of matched.values()) if (!used.has(item)) await call('item.delete', { id: item.id });
        // A sticky someone edited is never deleted: parked if there is room, else left where it is.
        for (const item of left) if (!toPark.includes(item)) await call('item.delete', { id: item.id });
      }
      for (const cluster of parked) {
        const spots = { label: cluster.labelAt, note: cluster.noteAt };
        for (const [part, at] of Object.entries(spots)) {
          const item = toPark.find((each) => each.data.arrange === `${cluster.key}#${part}`);
          if (item !== undefined && (item.x !== at.x || item.y !== at.y)) await call('item.update', { id: item.id, ...at });
        }
      }
      return { zoneId: zone.id, width, height, moved };
    }));
  };

  /**
   * Arranges `zoneId` again for the orchestrator `caller` names, if it arranges by itself: after an agent it starts, a
   * note it adds or an agent it closes. A failure is only warned of, as what came before it is done all the same.
   * Returns whether it arranged.
   */
  const autoArrange = async (caller: () => Orchestrator, zoneId: string | null): Promise<boolean> => {
    if (zoneId === null) return false;
    try {
      const me = caller();
      if (!(await settingsOf(me)).auto) return false;
      await arrangeIn(me, zoneId, () => ({}), ', by itself');
      return true;
    } catch (error) {
      warn(`could not arrange by itself: ${(error as Error).message}`);
      return false;
    }
  };

  return {
    'orchestrator.spawn': async (params, connection) => {
      const { template, ...agent } = await spawn(params, connection);
      const caller = () => access.caller('orchestrator.spawn', paramsObject(params), connection);
      // Arranging by itself, its zone is laid out afresh, the new agent in its lane; else a reviewer joins its cluster.
      if (await autoArrange(caller, agent.zoneId)) return { ...((await call('agent.list', undefined)).find((each) => each.sessionId === agent.sessionId) ?? agent), template };
      const joined = await joinCluster(caller, agent);
      return { ...joined, template };
    },

    'orchestrator.close': async (params, connection) => {
      const zoneId = (await call('agent.list', undefined)).find((each) => each.sessionId === paramsObject(params).sessionId)?.zoneId ?? null;
      const closed = await close(params, connection);
      await autoArrange(() => access.caller('orchestrator.close', paramsObject(params), connection), zoneId);
      return closed;
    },

    'orchestrator.move': async (params, connection) => {
      const p = paramsObject(params);
      const me = access.caller('orchestrator.move', p, connection);
      const entry: ActivityEntry = { detail: '' };
      return access.logged(me, 'move', entry, async (): Promise<LayoutMoved> => {
        const target = targetParam(p, 'target');
        const place = placeParams(p);
        const board = await readBoard();
        const placed = movable(me, board, target);
        entry.on = { id: placed.id, name: placed.name };
        const zoneId = zoneOfPlace(board, place, placed.zoneId);
        const zone = checkDestination(me, board, zoneId);
        entry.detail = `into ${zone?.name ?? 'the board'}`;
        // Its zone is its scope: moved out of it, it could neither come back nor arrange it.
        if (target.kind === 'agent' && target.id === me.agent?.sessionId && me.orchestrate === 'zone' && zoneId !== placed.zoneId) {
          throw outOfScope('your zone is your scope: moved out of it, you could not come back or arrange it. Move yourself within it, or ask the user');
        }
        if (target.kind === 'agent' && me.agent !== null && zoneId !== placed.zoneId) {
          const agent = board.agents.find((each) => each.sessionId === target.id)!;
          if (access.wouldGainOrchestrating(agent, zone)) {
            throw outOfScope(`moving ${agent.name} into ${zone!.name} would let it orchestrate there: only the user lets an agent orchestrate`);
          }
        }
        const size: Size = { width: placed.rect.width, height: placed.rect.height };
        const isNote = target.kind === 'item';
        const spot = spotFor(board, zone, size, place, tileKey(target), isNote);
        const rect = isNote ? { ...spot, ...size } : sizedFootprint(spot, size);
        const aside = zone === undefined || (place.at === undefined && place.near === undefined) ? [] : roomFor(me, board, zone, rect, tileKey(target));
        const grown = zone === undefined ? undefined : grownWith(zone, { ...spot, ...size }, isNote, aside);
        if (zone !== undefined) checkGrowth(board, zone, grown!, 'moved there,');
        await moveTo(placed, zoneId, spot);
        for (const each of aside) await moveTo(each.placed, zoneId, each.spot);
        if (grown !== undefined) await growTo(zone, grown);
        entry.detail = `into ${zone?.name ?? 'the board'} at ${Math.round(spot.x)},${Math.round(spot.y)}${aside.length === 0 ? '' : `, moving ${aside.length} aside`}`;
        return { target, zoneId, x: spot.x, y: spot.y };
      });
    },

    'orchestrator.arrange': async (params, connection) => {
      const p = paramsObject(params);
      const me = access.caller('orchestrator.arrange', p, connection);
      return arrangeIn(me, optionalStringParam(p, 'zoneId') ?? me.zoneId, () => {
        const by = optionalStringParam(p, 'by') as ArrangeBy | undefined;
        if (by !== undefined && !ARRANGE_BYS.includes(by)) throw invalidParams(`by must be ${ARRANGE_BYS.join(', ')}`);
        const layout = optionalStringParam(p, 'layout') as ArrangeLayout | undefined;
        if (layout !== undefined && !ARRANGE_LAYOUTS.includes(layout)) throw invalidParams(`layout must be ${ARRANGE_LAYOUTS.join(', ')}`);
        const auto = optionalBooleanParam(p, 'auto');
        return { ...(by === undefined ? {} : { by }), ...(layout === undefined ? {} : { layout }), ...(auto === undefined ? {} : { auto }) };
      });
    },

    'orchestrator.map': async (params, connection) => {
      const p = paramsObject(params);
      const me = access.caller('orchestrator.map', p, connection);
      const zoneId = optionalStringParam(p, 'zoneId') ?? me.zoneId;
      if (zoneId === null) throw invalidParams(`${me.agent === null ? 'you have' : 'your tile is in'} no zone: name the zone to map`);
      const board = await readBoard();
      const zone = checkDestination(me, board, zoneId)!;
      const things = placedOf(board)
        .filter((each) => each.zoneId === zone.id)
        .map((each): ZoneMapThing => {
          const item = each.kind === 'item' ? board.items.find((one) => one.id === each.id) : undefined;
          const agent = each.kind === 'agent' ? board.agents.find((one) => one.sessionId === each.id) : undefined;
          return { key: each.key, itemKind: item?.kind ?? null, name: item === undefined ? each.name : cutText(noteText(item), 60) || item.kind, state: agent?.state ?? null,
            // A turned item as the upright box it takes up, so the map shows (and lints) the room it really takes.
            ...(item === undefined ? each.rect : takenBy(each)),
          };
        });
      const { parts } = clusterParts(me, zone.id, board.items);
      const lanes = lanesOf(crewOf(me, board, zone), await linksOf());
      const arrange = await settingsOf(me);
      return {
        zoneId: zone.id,
        name: zone.name,
        width: zone.width,
        height: zone.height,
        arrange,
        things,
        ...buildZoneMap({
          lanes,
          things,
          parts: new Map([...parts].map(([key, item]) => [key, `item:${item.id}`])),
          arrange,
          compact: new Map(things.flatMap((thing) => (board.compact[thing.key] === undefined ? [] : [[thing.key, { x: thing.x, y: thing.y, ...board.compact[thing.key]! }] as const]))),
        }),
      };
    },

    'orchestrator.addZone': async (params, connection) => {
      const p = paramsObject(params);
      const me = access.caller('orchestrator.addZone', p, connection);
      const entry: ActivityEntry = { detail: '' };
      return access.logged(me, 'add-zone', entry, async () => {
        entry.detail = quoted(typeof p.name === 'string' ? p.name : '');
        const name = groupName(stringParam(p, 'name'));
        const size = {
          width: groupSize(optionalSizeParam(p, 'width'), 'width') ?? DEFAULT_ZONE_SIZE.width,
          height: groupSize(optionalSizeParam(p, 'height'), 'height') ?? DEFAULT_ZONE_SIZE.height,
        };
        const board = await readBoard();
        const own = board.zones.find((zone) => zone.id === me.zoneId);
        const wanted =
          p.x !== undefined || p.y !== undefined
            ? { x: clamp(finiteNumberParam(p, 'x'), -BOARD_EXTENT, BOARD_EXTENT), y: clamp(finiteNumberParam(p, 'y'), -BOARD_EXTENT, BOARD_EXTENT) }
            : own === undefined
              ? { x: 0, y: 0 }
              : { x: own.x + own.width + ZONE_GAP, y: own.y };
        // As the Zone tool places one: clear of every zone (never inside one) and of the loose tiles.
        const loose = placedOf(board).flatMap((each) => (each.zoneId === null ? [each.rect] : []));
        const at = freeSpotFor(wanted, size, [...board.zones, ...loose]);
        const color = optionalStringParam(p, 'color');
        let zone = await call('zone.addUnbound', { name, ...at, ...size, ...(color === undefined ? {} : { color }) });
        markZone.run(me.agent?.sessionId ?? null, zone.id);
        // An agent's group lets no agent orchestrate: in it, its crew would orchestrate where the user didn't let them.
        if (me.agent !== null) zone = await call('zone.configure', { id: zone.id, agentsOrchestrate: false });
        entry.on = { id: zone.id, name: zone.name };
        entry.detail = `at ${Math.round(at.x)},${Math.round(at.y)}, ${size.width}×${size.height}`;
        return zone;
      });
    },

    'orchestrator.changeZone': async (params, connection) => {
      const p = paramsObject(params);
      const me = access.caller('orchestrator.changeZone', p, connection);
      const entry: ActivityEntry = { detail: '' };
      return access.logged(me, 'change-zone', entry, async () => {
        const board = await readBoard();
        const zone = ownGroup(me, board, stringParam(p, 'id'));
        entry.on = { id: zone.id, name: zone.name };
        const rawName = optionalStringParam(p, 'name');
        const name = rawName === undefined ? undefined : groupName(rawName);
        const color = optionalStringParam(p, 'color');
        const layout = {
          x: p.x === undefined ? zone.x : finiteNumberParam(p, 'x'),
          y: p.y === undefined ? zone.y : finiteNumberParam(p, 'y'),
          width: groupSize(optionalSizeParam(p, 'width'), 'width') ?? zone.width,
          height: groupSize(optionalSizeParam(p, 'height'), 'height') ?? zone.height,
        };
        const changes = [
          ...(name === undefined ? [] : [`renamed ${name}`]),
          ...(color === undefined ? [] : [`coloured ${color}`]),
          ...(layout.x !== zone.x || layout.y !== zone.y ? [`moved to ${layout.x},${layout.y}`] : []),
          ...(layout.width !== zone.width || layout.height !== zone.height ? [`resized to ${layout.width}×${layout.height}`] : []),
        ];
        if (changes.length === 0) throw invalidParams('give a name, a colour, a place or a size');
        entry.detail = changes.join(', ');
        const covered = board.zones.find((other) => other.id !== zone.id && overlaps(layout, other));
        if (covered !== undefined) throw invalidParams(`${zone.name} would cover ${covered.name}: zones never overlap`);
        // Shrinking past its tiles moves only those its edge cuts through, as the board's resize does.
        const inZone = placedOf(board).filter((each) => each.zoneId === zone.id);
        const tiles = inZone.filter((each) => each.kind !== 'item');
        const resized = (rect: Rect) => rect.width !== AGENT_TILE_SIZE.width || rect.height !== AGENT_TILE_SIZE.height;
        const packed = packTiles(
          layout,
          tiles.map((each): ZoneTile => ({ id: each.key, x: each.rect.x, y: each.rect.y, ...(resized(each.rect) ? { width: each.rect.width, height: each.rect.height } : {}) })),
          inZone.filter((each) => each.kind === 'item').map((each) => each.rect),
        );
        if (packed === undefined) throw invalidParams(`${zone.name}'s tiles would have nowhere to go: it can shrink no further`);
        if (name !== undefined || color !== undefined) {
          await call('zone.setLook', { id: zone.id, ...(name === undefined ? {} : { name }), ...(color === undefined ? {} : { color }) });
        }
        for (const tile of tiles) {
          const spot = packed.get(tile.key)!;
          if (spot.x !== tile.rect.x || spot.y !== tile.rect.y) await moveTo(tile, zone.id, spot);
        }
        return call('zone.update', { id: zone.id, ...layout });
      });
    },

    'orchestrator.removeZone': async (params, connection) => {
      const p = paramsObject(params);
      const me = access.caller('orchestrator.removeZone', p, connection);
      const entry: ActivityEntry = { detail: '' };
      return access.logged(me, 'remove-zone', entry, async () => {
        const zone = ownGroup(me, await readBoard(), stringParam(p, 'id'));
        entry.on = { id: zone.id, name: zone.name };
        // As the board's Delete: its tiles and notes stay where they are drawn, loose.
        await call('zone.dissolve', { id: zone.id });
        return null;
      });
    },

    'orchestrator.addNote': async (params, connection) => {
      const p = paramsObject(params);
      const me = access.caller('orchestrator.addNote', p, connection);
      const entry: ActivityEntry = { detail: typeof p.text === 'string' ? quoted(p.text) : '' };
      const added = await access.logged(me, 'add-note', entry, async () => {
        const text = stringParam(p, 'text');
        const given = optionalStringParam(p, 'kind');
        const asked = (given ?? 'sticky') as NoteKind;
        if (!NOTE_KINDS.includes(asked)) throw invalidParams(`kind must be ${NOTE_KINDS.join(' or ')}`);
        // An agent's note, with no kind asked for, is an agent note, badged with who wrote it; `--kind sticky` makes a sticky.
        const agentNote = given === undefined && me.agent !== null;
        // Text an agent writes is signed; an agent note says who wrote it on its badge.
        const signs = me.agent !== null && !agentNote;
        checkNoteText(text, asked, signs ? signatureLength(me.name) : 0);
        // An agent note has no colour: one asked for is ignored, not refused, so callers that give one still work (the
        // CLI and MCP say so).
        const colorParam = agentNote ? undefined : optionalStringParam(p, 'color');
        const colors = noteColor(asked, colorParam ?? (asked === 'sticky' ? STICKY_COLORS[0].value : 'ink'));
        const place = placeParams(p);
        // In the zone's layout queue, with its arranges and joins: none of them can write over a note added to a sticky.
        const queued = zoneOfPlace(await readBoard(), place, me.zoneId);
        return arranging(queued ?? '', async () => {
          const board = await readBoard();
          const zoneId = zoneOfPlace(board, place, me.zoneId);
          const zone = checkDestination(me, board, zoneId);
          const signed = signs ? stamped(text, me.name) : text;
          // A sticky near a tile, with no side, goes in its cluster's slot: on its cluster's sticky, or before it.
          const nearAgent =
            asked === 'sticky' && (given === undefined || me.agent === null) && zone !== undefined && place.near?.kind === 'agent' && place.side === undefined
              ? placedOf(board).find((each) => each.kind === 'agent' && each.id === place.near!.id)
              : undefined;
          const clusterSticky = nearAgent === undefined ? undefined : clusterStickyOf(board, zone!.id, nearAgent.id);
          if (clusterSticky !== undefined && access.madeByCrew(me, madeBy(itemMadeBy, clusterSticky.id))) {
            // Added to what it says, never in place of it: someone may have written there. It is the arrange's sticky,
            // so it is signed and keeps a colour given, as a sticky does.
            const before = typeof clusterSticky.data.text === 'string' ? unsigned(clusterSticky.data.text) : '';
            const added = before === '' ? text : `${before}\n${text}`;
            const onAgentNote = clusterSticky.kind === 'agent-note';
            checkNoteText(added, 'sticky', me.agent === null || onAgentNote ? 0 : signatureLength(me.name));
            entry.on = { id: clusterSticky.id, name: `note ${quoted(text)}` };
            entry.detail = `added to ${nearAgent!.name}'s cluster's note`;
            const given = optionalStringParam(p, 'color');
            // An agent note has no colour, and says it is written by an agent again (it no longer reads as the arrange's own).
            const data = onAgentNote
              ? { text: added, ...(me.agent === null ? { editedByUser: true } : { writtenAt: new Date().toISOString(), editedByUser: false }) }
              : { text: me.agent === null ? added : stamped(added, me.name), ...(given === undefined ? {} : noteColor('sticky', given)) };
            const taller = onAgentNote ? grownNote(clusterSticky, added) : {};
            // Its place was made for the tiles' sizes then: a tile expanded since may cover it. Only then (a note it grew into is the arrange's to put right) does it move, beside
            // the agent at its real size, clear of everything; growing taller is left to the arrange, as an edit's is.
            const rect = { x: clusterSticky.x, y: clusterSticky.y, width: clusterSticky.width, height: clusterSticky.height };
            const here = placedOf(board).filter((each) => each.zoneId === zone!.id && each.key !== `item:${clusterSticky.id}`);
            const others = here.map(takenBy);
            const size = { width: rect.width, height: taller.height ?? rect.height };
            const region = { left: ZONE_PADDING, top: ZONE_PADDING, right: Infinity, bottom: Infinity };
            // Beside the agent; else, where that would grow the zone over another, below everything there; else in place.
            const bottom = Math.max(ZONE_PADDING, ...others.map((each) => each.y + each.height));
            const candidates = clearOf(rect, here.filter((each) => each.kind !== 'item').map(takenBy))
              ? []
              : [besideSpot(nearAgent!.rect, 'right', size), { x: ZONE_PADDING, y: bottom + TILE_GAP }].map((wanted) => nearestFreeSpot(wanted, others, region, size)!);
            const spot = candidates.find((each) => coveredBy(board, zone!, grownTo(zone!, { ...each, ...size }, true)) === undefined);
            const grew = spot === undefined ? undefined : grownTo(zone!, { ...spot, ...size }, true);
            const updated = await call('item.update', { id: clusterSticky.id, data, ...taller, ...spot });
            if (grew !== undefined) await growTo(zone, grew);
            return updated;
          }
          // Else in the slot before the agent, which moves along: only one it may move, else beside it as asked.
          const slotOf = nearAgent !== undefined && mayMove(me, board, nearAgent) ? nearAgent : undefined;
          const size =
            slotOf !== undefined ? AGENT_TILE_SIZE : agentNote ? agentNoteSize(text) : asked === 'sticky' ? STICKY_SIZE : textSize(signed);
          const spot = slotOf !== undefined ? { x: slotOf.rect.x, y: slotOf.rect.y } : spotFor(board, zone, size, place, null, true);
          const aside = zone === undefined || (place.at === undefined && place.near === undefined) ? [] : roomFor(me, board, zone, { ...spot, ...size }, null);
          const grown = zone === undefined ? undefined : grownWith(zone, { ...spot, ...size }, true, aside);
          if (zone !== undefined) checkGrowth(board, zone, grown!, 'put there,');
          const [kind, data] = agentNote
            ? (['agent-note', agentNoteData(agentNoteAuthor(me.agent!), text, place.near?.kind === 'agent' ? { about: place.near.id } : {})] as const)
            : asked === 'sticky'
              ? (['sticky', { text: signed, ...colors }] as const)
              : (['text', textItemData(signed, colors)] as const);
          const item = await call('item.create', { kind, zoneId, ...spot, ...size, data: { ...data } });
          markItem.run(me.agent?.sessionId ?? null, item.id);
          for (const each of aside) await moveTo(each.placed, zoneId, each.spot);
          if (grown !== undefined) await growTo(zone, grown);
          entry.on = { id: item.id, name: `note ${quoted(text)}` };
          entry.detail = `in ${zone?.name ?? 'the board'}`;
          return item;
        });
      });
      // Arranging by itself, its zone is laid out afresh: a note beside an agent of a lane with none becomes its note.
      if (!(await autoArrange(() => me, added.zoneId))) return added;
      return (await call('item.list', undefined)).find((each) => each.id === added.id) ?? added;
    },

    'orchestrator.editNote': async (params, connection) => {
      const p = paramsObject(params);
      const me = access.caller('orchestrator.editNote', p, connection);
      const entry: ActivityEntry = { detail: typeof p.text === 'string' ? quoted(p.text) : '' };
      let grew = false;
      const edited = await access.logged(me, 'edit-note', entry, async () => {
        const found = (await call('item.list', undefined)).find((each) => each.id === p.id);
        // In its zone's layout queue: an arrange or join under way can't write over the edit.
        return arranging(found?.zoneId ?? '', async () => {
          const item = ownNote(me, stringParam(p, 'id'), await call('item.list', undefined));
          entry.on = { id: item.id, name: `note ${quoted(noteText(item))}` };
          const text = optionalStringParam(p, 'text');
          const color = optionalStringParam(p, 'color');
          if (text === undefined && color === undefined) throw invalidParams('give the text or the colour');
          if (item.kind === 'agent-note') {
            // Its colour, which it hasn't, is ignored, as `addNote` ignores it.
            if (text === undefined) return item;
            checkNoteText(text, 'sticky', 0);
            // Written again by an agent, it is its own again; by the user's side, the user's edit.
            const data = me.agent === null ? { text, editedByUser: true } : { text, writtenAt: new Date().toISOString(), editedByUser: false };
            const grown = grownNote(item, text);
            grew = grown.height !== undefined;
            return call('item.update', { id: item.id, data, ...grown });
          }
          const kind = item.kind as NoteKind;
          if (text !== undefined) checkNoteText(text, kind, me.agent === null ? 0 : signatureLength(me.name));
          // Signed again, in place of the old signature.
          const signed = text === undefined || me.agent === null ? text : stamped(text, me.name);
          const data = { ...(signed === undefined ? {} : { text: signed }), ...(color === undefined ? {} : noteColor(kind, color)) };
          // A text item is as big as its text; a sticky note keeps its size, its font shrinking to fit.
          const size = kind === 'text' && signed !== undefined ? textSize(signed) : {};
          return call('item.update', { id: item.id, data, ...size });
        });
      });
      // Grown taller, it may reach what is below it: arranging by itself, its zone makes room for it.
      if (!grew || !(await autoArrange(() => me, edited.zoneId))) return edited;
      return (await call('item.list', undefined)).find((each) => each.id === edited.id) ?? edited;
    },

    'orchestrator.removeNote': async (params, connection) => {
      const p = paramsObject(params);
      const me = access.caller('orchestrator.removeNote', p, connection);
      const entry: ActivityEntry = { detail: '' };
      return access.logged(me, 'remove-note', entry, async () => {
        const item = ownNote(me, stringParam(p, 'id'), await call('item.list', undefined), REMOVABLE_KINDS);
        entry.on = { id: item.id, name: itemName(item) };
        await call('item.delete', { id: item.id });
        return null;
      });
    },

    'orchestrator.addShape': async (params, connection) => {
      const p = paramsObject(params);
      const me = access.caller('orchestrator.addShape', p, connection);
      const entry: ActivityEntry = { detail: typeof p.text === 'string' ? quoted(p.text) : '' };
      return access.logged(me, 'add-shape', entry, async () => {
        const shape = shapeKindParam(p);
        if (shape === undefined) throw invalidParams('shape is required');
        const data = { ...newShapeData(shape), ...shapeDataParams(p, shape) };
        const place = placeParams(p);
        const queued = zoneOfPlace(await readBoard(), place, me.zoneId);
        return arranging(queued ?? '', async () => {
          const board = await readBoard();
          const zoneId = zoneOfPlace(board, place, me.zoneId);
          const zone = checkDestination(me, board, zoneId);
          const size = shapeSize(data);
          const spot = spotFor(board, zone, size, place, null, true);
          const aside = zone === undefined || (place.at === undefined && place.near === undefined) ? [] : roomFor(me, board, zone, { ...spot, ...size }, null);
          const grown = zone === undefined ? undefined : grownWith(zone, { ...spot, ...size }, true, aside);
          if (zone !== undefined) checkGrowth(board, zone, grown!, 'put there,');
          const item = await call('item.create', { kind: 'shape', zoneId, ...spot, ...size, data });
          markItem.run(me.agent?.sessionId ?? null, item.id);
          for (const each of aside) await moveTo(each.placed, zoneId, each.spot);
          if (grown !== undefined) await growTo(zone, grown);
          entry.on = { id: item.id, name: itemName(item) };
          entry.detail = `in ${zone?.name ?? 'the board'}`;
          return item;
        });
      });
    },

    'orchestrator.editShape': async (params, connection) => {
      const p = paramsObject(params);
      const me = access.caller('orchestrator.editShape', p, connection);
      const entry: ActivityEntry = { detail: typeof p.text === 'string' ? quoted(p.text) : '' };
      return access.logged(me, 'edit-shape', entry, async () => {
        const found = (await call('item.list', undefined)).find((each) => each.id === p.id);
        // In its zone's layout queue: an arrange or add under way can't place things by its old size.
        return arranging(found?.zoneId ?? '', async () => {
          const item = ownNote(me, stringParam(p, 'id'), await call('item.list', undefined), SHAPE_KINDS);
          entry.on = { id: item.id, name: itemName(item) };
          const asked = shapeKindParam(p);
          const was = SHAPE_TYPES.includes(item.data.shape as ShapeType) ? (item.data.shape as ShapeType) : 'rectangle';
          const shape = asked ?? was;
          const data: Record<string, unknown> = { ...(asked === undefined ? {} : { shape }), ...shapeDataParams(p, shape) };
          if (Object.keys(data).length === 0) throw invalidParams('give the shape, text, attributes, methods or fill to change');
          // Its sections go with a kind that has none, so they don't come back unasked if it is made a class again.
          if (!SECTIONED_SHAPES.includes(shape)) for (const section of SHAPE_SECTIONS) if (item.data[section]) data[section] = '';
          // Made a class, it takes a class's mono, as one drawn as a class has.
          if (SECTIONED_SHAPES.includes(shape) && !SECTIONED_SHAPES.includes(was)) data.mono = true;
          const merged = { ...item.data, ...data } as Parameters<typeof shapeSize>[0];
          // Only grows, keeping a size the user gave it; the board grows it taller to fit its text as it draws it.
          const needs = shapeSize({ ...merged, text: typeof merged.text === 'string' ? merged.text : '' });
          const size = { width: Math.max(item.width, needs.width), height: Math.max(item.height, needs.height) };
          return call('item.update', { id: item.id, data, ...(size.width === item.width && size.height === item.height ? {} : size) });
        });
      });
    },

    'orchestrator.removeShape': async (params, connection) => {
      const p = paramsObject(params);
      const me = access.caller('orchestrator.removeShape', p, connection);
      const entry: ActivityEntry = { detail: '' };
      return access.logged(me, 'remove-shape', entry, async () => {
        const item = ownNote(me, stringParam(p, 'id'), await call('item.list', undefined), SHAPE_KINDS);
        entry.on = { id: item.id, name: itemName(item) };
        await call('item.delete', { id: item.id });
        return null;
      });
    },

    'orchestrator.connect': async (params, connection) => {
      const p = paramsObject(params);
      const me = access.caller('orchestrator.connect', p, connection);
      const entry: ActivityEntry = { detail: typeof p.relation === 'string' ? p.relation : '' };
      return access.logged(me, 'connect', entry, async () => {
        const board = await readBoard();
        const [from, to] = (['from', 'to'] as const).map((name) => drawable(me, board, stringParam(p, name)));
        if (from!.id === to!.id) throw invalidParams('a connector joins two different items');
        const look = connectorLookParams(p);
        const sides = facingSides(boardRect(board, from!), boardRect(board, to!));
        entry.on = { id: to!.id, name: `${itemName(from!)} → ${itemName(to!)}` };
        entry.detail = look.startEnd === undefined ? '' : `as ${String(p.relation)}`;
        const connector = await call('connector.create', {
          from: { type: 'item', id: from!.id, side: sides.from },
          to: { type: 'item', id: to!.id, side: sides.to },
          ...look,
        });
        markConnector.run(me.agent?.sessionId ?? null, connector.id);
        return connector;
      });
    },

    'orchestrator.editConnector': async (params, connection) => {
      const p = paramsObject(params);
      const me = access.caller('orchestrator.editConnector', p, connection);
      const entry: ActivityEntry = { detail: typeof p.relation === 'string' ? p.relation : '' };
      return access.logged(me, 'edit-connector', entry, async () => {
        const connector = await ownConnector(me, stringParam(p, 'id'));
        entry.on = { id: connector.id, name: connectorName(connector) };
        const look = connectorLookParams(p);
        if (Object.keys(look).length === 0) throw invalidParams('give the relation, style or a label to change');
        return call('connector.update', { id: connector.id, ...look });
      });
    },

    'orchestrator.removeConnector': async (params, connection) => {
      const p = paramsObject(params);
      const me = access.caller('orchestrator.removeConnector', p, connection);
      const entry: ActivityEntry = { detail: '' };
      return access.logged(me, 'remove-connector', entry, async () => {
        const connector = await ownConnector(me, stringParam(p, 'id'));
        entry.on = { id: connector.id, name: connectorName(connector) };
        await call('connector.delete', { id: connector.id });
        return null;
      });
    },
  };
}

/** The key of what `target` names among `placedOf`'s. */
function tileKey(target: LayoutTarget): string {
  return target.kind === 'item' ? `item:${target.id}` : tileSizeKey(target.kind, target.id);
}
