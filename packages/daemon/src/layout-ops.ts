// The layout commands as the CLI and MCP give them (`move`, `arrange`, `zone`, `note`): refs and words turned into the
// daemon's `orchestrator.*` layout methods, and their results as text and JSON (ADR-0010's one API, two faces).
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BoardError, BoardRefs, callerTicket, connectorLine, connectorsIn, connectorsOnTicket, itemLine, itemPlace, readEveryBoard, ticketBoardName, REF_KINDS, resolveAgent, shapeSectionLines, zoneLine, type BoardSession, type BoardView, type RefKind } from './board-ops.ts';
import { checkPlacements } from './params.ts';
import {
  ARRANGE_BYS,
  ARRANGE_LAYOUTS,
  type ArrangePlacements,
  CAPTURE_STYLES,
  CONNECTOR_STYLES,
  FILL_SLOT_COLORS,
  NOTE_KINDS,
  RELATIONS,
  SHAPE_TYPES,
  TILE_SIDES,
  ZONE_LAYOUT_CHOICES,
  zoneLayoutChoiceOf,
  type BoardCaller,
  type BoardItem,
  type CaptureStyle,
  type ConnectorStyle,
  type DiagramConnectorFields,
  type DiagramShapeFields,
  type LayoutPlace,
  type LayoutTarget,
  type RelationId,
  type ShapeData,
  type ShapeType,
  type TileSide,
  type ZoneLayoutChoice,
  type ZoneMap,
  type ZoneScreenshot,
  MAX_AGENT_NOTE_SIZE,
  isLineBudget,
  MAX_AGENT_NOTE_LINES,
  MIN_AGENT_NOTE_SIZE,
} from './protocol.ts';
import { toMermaid } from './mermaid.ts';
import { boxPicture, laneTable, lintLine } from './zone-map.ts';
import { overlaps } from './board-layout.ts';
import { ownTicketBoard } from './ticket-tiles.ts';

/** A point as typed: `x,y`. Throws `BoardError` for anything else. */
export function pointOf(text: string, what: string): { x: number; y: number } {
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(text);
  if (match === null) throw new BoardError(`${what} is x,y, such as 40,120`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

/** A size as typed: `width,height`, each at least 1. */
export function sizeOf(text: string): { width: number; height: number } {
  const match = /^\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (match === null || Number(match[1]) < 1 || Number(match[2]) < 1) throw new BoardError('--size is width,height, such as 720,480');
  return { width: Number(match[1]), height: Number(match[2]) };
}

/** An agent note's size as typed: `<width>x<height>` (or `width,height`), between the least and the most a note can be resized to. */
export function noteSizeOf(text: string): { width: number; height: number } {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[x,×]\s*(\d+(?:\.\d+)?)\s*$/i.exec(text);
  if (match === null) throw new BoardError('--size is <width>x<height>, such as 360x240');
  const size = { width: Number(match[1]), height: Number(match[2]) };
  if (size.width < MIN_AGENT_NOTE_SIZE.width || size.height < MIN_AGENT_NOTE_SIZE.height) {
    throw new BoardError(`--size is at least ${MIN_AGENT_NOTE_SIZE.width}x${MIN_AGENT_NOTE_SIZE.height}`);
  }
  if (size.width > MAX_AGENT_NOTE_SIZE.width || size.height > MAX_AGENT_NOTE_SIZE.height) {
    throw new BoardError(`--size is at most ${MAX_AGENT_NOTE_SIZE.width}x${MAX_AGENT_NOTE_SIZE.height}`);
  }
  return size;
}

/** An agent note's line budget as typed: a whole number of lines, from 1 to the most; `0` (when `clears`) for none. */
export function noteLinesOf(value: string | number, clears: boolean): number {
  const lines = typeof value === 'number' ? value : /^\s*\d+\s*$/.test(value) ? Number(value) : Number.NaN;
  if (clears && lines === 0) return 0;
  if (!isLineBudget(lines)) {
    throw new BoardError(`--lines is a whole number from 1 to ${MAX_AGENT_NOTE_LINES}${clears ? ', or 0 for none' : ''}`);
  }
  return lines;
}

/** What a layout command's options say where to put something, as typed: refs and words, not yet checked. */
export interface PlaceOptions {
  /** A zone ref, `board` for loose on the main board, a ticket's chat's ref for its ticket's own board, or `ticket` for the caller's. */
  to?: string;
  /** `x,y`, relative to the zone. */
  at?: string;
  /** A tile's or note's ref. */
  near?: string;
  side?: string;
}

/** Checks a place's options before anything connects: throws `BoardError` for a bad one. */
export function checkPlace(options: PlaceOptions): void {
  if (options.at !== undefined) pointOf(options.at, '--at');
  if (options.at !== undefined && options.near !== undefined) throw new BoardError('give --at or --near, not both');
  if (options.side !== undefined && options.near === undefined) throw new BoardError('--side is only with --near');
  if (options.side !== undefined && !TILE_SIDES.includes(options.side as TileSide)) throw new BoardError(`--side must be ${TILE_SIDES.join(', ')}`);
}

/** The tile or note `text` names: an agent, a shell or an item. */
function layoutTarget(refs: BoardRefs, text: string, caller: BoardCaller | null): LayoutTarget {
  const object = refs.resolve(text, caller);
  if (object.kind === 'agent') return { kind: 'agent', id: object.agent.sessionId };
  if (object.kind === 'shell') return { kind: 'shell', id: object.shell.id };
  if (object.kind === 'item') return { kind: 'item', id: object.item.id };
  throw new BoardError(`${text} is a ${object.kind}: only a tile (an agent or a shell) or an item moves`);
}

/** The zone `text` names, by its id. */
function zoneId(refs: BoardRefs, text: string, caller: BoardCaller | null): string {
  const object = refs.resolve(text, caller);
  if (object.kind !== 'zone') throw new BoardError(`${text} is a ${object.kind}, not a zone`);
  return object.zone.id;
}

/** The ticket whose own board `ref` names: the caller's for `ticket`, else the ticket chat's it names. */
function ticketOf(refs: BoardRefs, ref: string, caller: BoardCaller | null): string {
  if (ref === 'ticket') {
    const ticket = callerTicket(refs.board, caller);
    if (ticket === null) throw new BoardError("you are on no ticket: `ticket` is a ticket's chat's own board, or its helpers'");
    return ticket;
  }
  const object = refs.resolve(ref, caller);
  if (object.kind !== 'agent' || !object.agent.ticketChat) {
    throw new BoardError(`${ref} is no ticket's chat: only a ticket's chat has a board of its own (name its chat, or \`ticket\` for yours)`);
  }
  return object.agent.sessionId;
}

/** Where `to` puts something: the main board loose (`board`), the ticket's board it names (`ticket`, a ticket's chat), or a zone. */
function destinationOf(refs: BoardRefs, to: string, caller: BoardCaller | null): Pick<LayoutPlace, 'zoneId' | 'ticket'> {
  if (to === 'board') return { zoneId: null };
  if (to === 'ticket') return { ticket: ticketOf(refs, to, caller) };
  const object = refs.resolve(to, caller);
  if (object.kind === 'agent') return { ticket: ticketOf(refs, to, caller) };
  return { zoneId: zoneId(refs, to, caller) };
}

function placeOf(refs: BoardRefs, options: PlaceOptions, caller: BoardCaller | null): LayoutPlace {
  checkPlace(options);
  return {
    ...(options.to === undefined ? {} : destinationOf(refs, options.to, caller)),
    ...(options.at === undefined ? {} : { at: pointOf(options.at, '--at') }),
    ...(options.near === undefined ? {} : { near: layoutTarget(refs, options.near, caller) }),
    ...(options.side === undefined ? {} : { side: options.side as TileSide }),
  };
}

/** What `target` is called on the board: its ref and name. */
function label(refs: BoardRefs, target: LayoutTarget): string {
  if (target.kind === 'agent') return `${refs.of('agent', target.id)} ${refs.board.agents.find((each) => each.sessionId === target.id)?.name ?? ''}`.trim();
  if (target.kind === 'shell') return `${refs.of('shell', target.id)} ${refs.board.shells.find((each) => each.id === target.id)?.name ?? ''}`.trim();
  return refs.of('item', target.id);
}

const where = (x: number, y: number) => `at ${Math.round(x)},${Math.round(y)}`;

/** `move`: a tile or note to a zone, a place in it, or beside another, clear of what is there. */
export async function moveTile(session: BoardSession, ref: string, options: PlaceOptions): Promise<BoardView> {
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const target = layoutTarget(refs, ref, session.caller);
  const moved = await session.client.call('orchestrator.move', { token: session.token, target, ...placeOf(refs, options, session.caller) });
  return { text: `Moved ${label(refs, target)} ${itemPlace(refs, moved)} ${where(moved.x, moved.y)}.`, json: moved };
}

export interface ArrangeOptions {
  by?: string;
  layout?: string;
  /** `on` or `off`. */
  auto?: string;
  /** Where to place each kind of the zone's items, by kind (`ARRANGE_ITEM_KINDS`): `cluster`, `sidebar`, `top` or `stay`. */
  place?: Record<string, string>;
  /** The placements for this arrange only, not kept as the zone's. */
  once?: boolean;
  /** Tidies the items the user dragged or turned too. */
  all?: boolean;
}

/** `--place`'s `kind=placement` pairs, comma-separated, by kind. */
export function placeOption(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(',')
      .map((pair) => pair.trim())
      .filter((pair) => pair !== '')
      .map((pair) => {
        const [kind, placement, ...rest] = pair.split('=').map((part) => part.trim());
        if (kind === undefined || placement === undefined || kind === '' || placement === '' || rest.length > 0) throw new BoardError(`--place takes kind=placement pairs, as notes=sidebar,clocks=top: not ${pair}`);
        return [kind, placement] as const;
      }),
  );
}

/** Checks `arrange`'s options before anything connects. */
export function checkArrange(options: ArrangeOptions): void {
  if (options.by !== undefined && !(ARRANGE_BYS as readonly string[]).includes(options.by)) throw new BoardError(`--by must be ${ARRANGE_BYS.join(', ')}`);
  if (options.layout !== undefined && !(ARRANGE_LAYOUTS as readonly string[]).includes(options.layout)) {
    throw new BoardError(`--layout must be ${ARRANGE_LAYOUTS.join(', ')}`);
  }
  if (options.auto !== undefined && options.auto !== 'on' && options.auto !== 'off') throw new BoardError('--auto must be on or off');
  checkPlacements(options.place ?? {}, '--place', (message) => new BoardError(message));
  if (options.once === true && options.place === undefined) throw new BoardError('--once is for --place: give where to place each kind for this arrange only');
}

/** The ref of a map's thing, by its key (`agent:<id>`, `item:<id>`); one of no ref kind as it is. */
function mapRef(refs: BoardRefs, key: string): string {
  const colon = key.indexOf(':');
  const kind = key.slice(0, colon);
  return (REF_KINDS as readonly string[]).includes(kind) ? refs.of(kind as RefKind, key.slice(colon + 1)) : key;
}

/** A zone's map as text: its lane table, or its box picture. */
function mapText(refs: BoardRefs, map: ZoneMap, boxes: boolean): string {
  return (boxes ? boxPicture : laneTable)(map, refs.of('zone', map.zoneId), (key) => mapRef(refs, key));
}

/** The most lines of a zone's diagram `zone map` prints, without its members and with them; the rest are counted. */
const DIAGRAM_LINES = 40;
const DIAGRAM_LINES_WITH_SECTIONS = 200;
/** The most lines of each section `zone map --sections` prints, and the most characters of each. */
const SECTION_LIMIT = { lines: 12, width: 80 };

/** Where a read is printed: the CLI, or an MCP tool's answer, whose hints name the tools instead of the commands. */
export type ReadFace = 'cli' | 'mcp';

/** What a diagram summary points to for more, in the CLI's words or the MCP tools'. */
const DIAGRAM_HINTS: Record<ReadFace, { members: string; whole: string; all: string }> = {
  cli: { members: 'members with --sections, or `agent-board show <ref>`', whole: '`agent-board show <ref>` for one whole', all: '`agent-board tree --json` lists them all' },
  mcp: { members: 'members with sections: true', whole: 'each section cut to its first 12 lines', all: 'the board tool lists them all' },
};

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * The zone's diagram, kept short whatever its size: its shapes, each by its kind, text and section counts (with
 * `sections`, a class's members too, cut short), then its connectors by their ends, relation and labels. Cut short,
 * shapes and connectors share the lines, so a big diagram still shows some of its relations. Empty for a zone with
 * neither.
 */
function diagramLines(refs: BoardRefs, zoneId: string, sections: boolean, face: ReadFace): string[] {
  const shapes = refs.board.items.filter((item) => item.zoneId === zoneId && item.kind === 'shape');
  const connectors = connectorsIn(refs, zoneId);
  if (shapes.length === 0 && connectors.length === 0) return [];
  const blocks = shapes.map((item) => [itemLine(refs, item), ...(sections ? shapeSectionLines(item, SECTION_LIMIT).map((line) => `  ${line}`) : [])]);
  const cap = sections ? DIAGRAM_LINES_WITH_SECTIONS : DIAGRAM_LINES;
  const shapeLines = blocks.reduce((sum, block) => sum + block.length, 0);
  // Connectors take what the shapes leave, and at least half the lines when both overrun them.
  const connectorBudget = Math.min(connectors.length, Math.max(cap - shapeLines, Math.floor(cap / 2)));
  let left = cap - connectorBudget;
  const shown: string[][] = [];
  for (const block of blocks) {
    if (block.length > left) break;
    shown.push(block);
    left -= block.length;
  }
  const lines = connectors.slice(0, connectorBudget + left).map((connector) => connectorLine(refs, connector));
  const hints = DIAGRAM_HINTS[face];
  const more = [
    shapes.length > shown.length ? plural(shapes.length - shown.length, 'more shape') : '',
    connectors.length > lines.length ? plural(connectors.length - lines.length, 'more connector') : '',
  ]
    .filter((each) => each !== '')
    .join(' and ');
  return [
    `diagram  (${plural(shapes.length, 'shape')}, ${plural(connectors.length, 'connector')}; ${sections ? hints.whole : hints.members})`,
    ...[...shown.flat(), ...lines].map((line) => `  ${line}`),
    ...(more === '' ? [] : [`  … and ${more}: ${hints.all}`]),
  ];
}

/** What is on a ticket's own board, as `zone map` reads it out: each thing by its ref, place and size, then what overlaps. */
export interface TicketBoardMap {
  ticket: string;
  items: { ref: string; kind: string; x: number; y: number; width: number; height: number }[];
  /** Its connectors, each by its ref and its ends' (always items: a ticket's board holds nothing else). */
  connectors: { ref: string; from: string; to: string }[];
  overlaps: [string, string][];
}

/** A ticket's own board as a map: its items, each with where it is and its size, its connectors, and the pairs that overlap. */
function ticketBoardMap(refs: BoardRefs, ticket: string, sections: boolean): BoardView {
  const items = refs.board.items.filter((item) => item.ticket === ticket);
  const overlapping: [string, string][] = [];
  for (const [index, one] of items.entries()) {
    for (const other of items.slice(index + 1)) if (overlaps(one, other)) overlapping.push([refs.of('item', one.id), refs.of('item', other.id)]);
  }
  const lines = items.map((item) => [
    `${itemLine(refs, item)}  ${where(item.x, item.y)} ${Math.round(item.width)}×${Math.round(item.height)}`,
    ...(sections ? shapeSectionLines(item, SECTION_LIMIT).map((line) => `  ${line}`) : []),
  ]);
  const connectors = connectorsOnTicket(refs, ticket);
  const json: TicketBoardMap = {
    ticket,
    items: items.map((item) => ({ ref: refs.of('item', item.id), kind: item.kind, x: item.x, y: item.y, width: item.width, height: item.height })),
    connectors: connectors.map((connector) => ({
      ref: refs.of('connector', connector.id),
      from: refs.of('item', connector.from.id),
      to: refs.of('item', connector.to.id),
    })),
    overlaps: overlapping,
  };
  return {
    text: [
      `${ticketBoardName(refs, ticket)}  ${plural(items.length, 'item')}`,
      ...(lines.length === 0 ? ['(empty)'] : lines.flat()).map((line) => `  ${line}`),
      ...connectors.map((connector) => `  ${connectorLine(refs, connector)}`),
      `lint  ${overlapping.length === 0 ? 'ok · no overlaps' : `check · ${overlapping.length} overlapping (${overlapping.map(([a, b]) => `${a} / ${b}`).join(', ')})`}`,
    ].join('\n'),
    json,
  };
}

/**
 * The ticket's own board `zone map` reads, if it reads one: the one `zone` names (`ticket` for the caller's, or a
 * ticket's chat's ref), or with no `zone` the caller's own if its ticket holds it. Undefined for a zone.
 */
function mapTicket(refs: BoardRefs, zone: string | undefined, caller: BoardCaller | null): string | undefined {
  if (zone === undefined) {
    const me = caller?.kind === 'agent' ? refs.board.agents.find((agent) => agent.sessionId === caller.sessionId) : undefined;
    return me === undefined ? undefined : (ownTicketBoard(me, refs.board.agents) ?? undefined);
  }
  if (zone === 'ticket') return ticketOf(refs, zone, caller);
  return refs.resolve(zone, caller).kind === 'agent' ? ticketOf(refs, zone, caller) : undefined;
}

/**
 * `zone map`: a zone (the caller's by default) as its lanes and what is amiss, or with `boxes` as a box picture; then a
 * summary of its diagram, if it has one, a class's members too with `sections`. For a ticket's own board (a helper's
 * by default), what is on it, where, and what overlaps.
 */
export async function zoneMap(
  session: BoardSession,
  zone: string | undefined,
  options: { boxes?: boolean; sections?: boolean; face?: ReadFace },
): Promise<BoardView> {
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const ticket = mapTicket(refs, zone, session.caller);
  if (ticket !== undefined) return ticketBoardMap(refs, ticket, options.sections === true);
  const map = await session.client.call('orchestrator.map', { token: session.token, ...(zone === undefined ? {} : { zoneId: zoneId(refs, zone, session.caller) }) });
  const diagram = diagramLines(refs, map.zoneId, options.sections === true, options.face ?? 'cli');
  return { text: [mapText(refs, map, options.boxes === true), ...(diagram.length === 0 ? [] : ['', ...diagram])].join('\n'), json: map };
}

/** `arrange`: lays out the tiles of a zone (the caller's by default) it may move; `board`, the whole board. */
export async function arrangeZone(session: BoardSession, zone: string | undefined, options: ArrangeOptions): Promise<BoardView> {
  checkArrange(options);
  if (zone === 'board') return arrangeWholeBoard(session, options);
  const refs = new BoardRefs(await readEveryBoard(session.client));
  // `ticket` or a chat's ref names a ticket's board; any other agent's ref is refused as no ticket's chat.
  const ticket = zone === undefined ? undefined : mapTicket(refs, zone, session.caller);
  if (ticket !== undefined) return arrangeTicket(session, refs, ticket, options);
  const result = await session.client.call('orchestrator.arrange', {
    token: session.token,
    ...(zone === undefined ? {} : { zoneId: zoneId(refs, zone, session.caller) }),
    ...(options.by === undefined ? {} : { by: options.by as (typeof ARRANGE_BYS)[number] }),
    ...(options.layout === undefined ? {} : { layout: options.layout as (typeof ARRANGE_LAYOUTS)[number] }),
    ...(options.auto === undefined ? {} : { auto: options.auto === 'on' }),
    ...(options.place === undefined ? {} : { placements: options.place as Partial<ArrangePlacements> }),
    ...(options.once === undefined ? {} : { once: options.once }),
    ...(options.all === undefined ? {} : { all: options.all }),
  });
  const name = refs.board.zones.find((each) => each.id === result.zoneId)?.name ?? '';
  const moved = result.moved.map((each) => `  ${label(refs, each.target)} ${where(each.x, each.y)}`);
  // Then the zone's map, so the layout can be checked at once: read afresh, with the labels and notes it made, and where
  // this arrange placed each kind of item (for this arrange only, perhaps).
  const map = { ...(await session.client.call('orchestrator.map', { token: session.token, zoneId: result.zoneId })), placed: result.placed };
  const after = new BoardRefs(await readEveryBoard(session.client));
  return {
    text: [
      result.moved.length === 0
        ? `${refs.of('zone', result.zoneId)} ${name} was arranged already: nothing moved.`
        : [`Arranged ${refs.of('zone', result.zoneId)} ${name} (${Math.round(result.width)}×${Math.round(result.height)}):`, ...moved].join('\n'),
      '',
      mapText(after, map, false),
    ].join('\n'),
    json: { ...result, map },
  };
}

/** A zone's picture, and the caption that says what it shows. */
export interface ZoneScreenshotView {
  shot: ZoneScreenshot;
  caption: string;
}

/** Picture px per board px, as a caption says it: `1×`, `0.5×`. */
const scaleText = (scale: number) => `${Number(scale.toFixed(3))}×`;

/** `zone screenshot`: a picture of a zone (the caller's by default), as the app draws it or as a plain drawing. */
export async function zoneScreenshot(session: BoardSession, zone: string | undefined, options: { style?: string }): Promise<ZoneScreenshotView> {
  if (options.style !== undefined && !(CAPTURE_STYLES as readonly string[]).includes(options.style)) throw new BoardError(`style must be ${CAPTURE_STYLES.join(' or ')}`);
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const shot = await session.client.call('orchestrator.screenshot', {
    token: session.token,
    ...(zone === undefined ? {} : { zoneId: zoneId(refs, zone, session.caller) }),
    ...(options.style === undefined ? {} : { style: options.style as CaptureStyle }),
  });
  const { map } = shot;
  const what = shot.style === 'lofi' ? 'a plain drawing of its tiles, notes and lines' : 'terminals hidden';
  return {
    shot,
    caption: [
      `${refs.of('zone', map.zoneId)} ${map.name}, ${Math.round(map.width)}×${Math.round(map.height)} px, drawn at ${scaleText(shot.scale)} (${shot.width}×${shot.height}), ${what}.`,
      lintLine(map, (key) => mapRef(refs, key)),
    ].join('\n'),
  };
}

/**
 * `zone screenshot` in the CLI: the zone's picture written to `out`, and where it went with the caption. By default it
 * goes to a temp file named for the zone and style, which the next picture of them replaces, so they never pile up.
 * Its JSON is the shot's details and the map, without the picture.
 */
export async function writeZoneScreenshot(session: BoardSession, zone: string | undefined, options: { style?: string; out?: string }): Promise<BoardView> {
  const { shot, caption } = await zoneScreenshot(session, zone, options);
  const path = options.out ?? join(tmpdir(), 'agent-board-screenshots', `zone-${shot.zoneId.slice(0, 8)}-${shot.style}.png`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(shot.png, 'base64'));
  const { zoneId, style, width, height, scale, map } = shot;
  return { text: `Wrote ${path}\n${caption}`, json: { path, zoneId, style, width, height, scale, map } };
}

/** What `zone add|rename|resize` take, as typed. */
export interface GroupOptions {
  name?: string;
  color?: string;
  /** `x,y` on the board. */
  at?: string;
  /** `width,height`. */
  size?: string;
}

function groupFields(options: GroupOptions) {
  return {
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.color === undefined ? {} : { color: options.color }),
    ...(options.at === undefined ? {} : pointOf(options.at, '--at')),
    ...(options.size === undefined ? {} : sizeOf(options.size)),
  };
}

/** `zone add --group`: a group marked as made by the caller, beside its zone unless placed. */
export async function addGroup(session: BoardSession, options: GroupOptions & { name: string }): Promise<BoardView> {
  const zone = await session.client.call('orchestrator.addZone', { token: session.token, ...groupFields(options), name: options.name });
  const refs = new BoardRefs(await readEveryBoard(session.client));
  return { text: `Made ${zoneLine(refs, zone)} ${where(zone.x, zone.y)}, ${zone.width}×${zone.height}.`, json: zone };
}

/** `zone rename|resize`: changes a group the caller (or its crew) made. */
export async function changeGroup(session: BoardSession, ref: string, options: GroupOptions): Promise<BoardView> {
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const zone = await session.client.call('orchestrator.changeZone', { token: session.token, id: zoneId(refs, ref, session.caller), ...groupFields(options) });
  return { text: `Changed ${zoneLine(refs, zone)}: ${where(zone.x, zone.y)}, ${zone.width}×${zone.height}.`, json: zone };
}

/** What each zone layout draws, as `zone layout` says it. */
const LAYOUT_WORDS: Record<ZoneLayoutChoice, string> = {
  free: 'each tile where it was put',
  spine: 'its lead at the left with its shells under it, each ticket a band in columns to the right, kept as its work changes',
  lanes: 'a lane per ticket, laid out again whenever its work changes',
  shelves: 'its work as stacks on To do, Doing, Waiting and Done shelves, under a head row of its leads and shells',
  clusters: "each unit of work's tiles drawn together, what needs the user first, under a head row of its leads and shells",
};

/** `zone layout`: sets how a zone (the caller's by default) lays out what it holds. Only a rule (spine, lanes) moves tiles. */
export async function setZoneLayout(session: BoardSession, mode: string, zone: string | undefined): Promise<BoardView> {
  if (!(ZONE_LAYOUT_CHOICES as readonly string[]).includes(mode)) throw new BoardError(`the layout must be ${ZONE_LAYOUT_CHOICES.join(', ')}`);
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const changed = await session.client.call('orchestrator.zoneLayout', {
    token: session.token,
    mode: mode as ZoneLayoutChoice,
    ...(zone === undefined ? {} : { zoneId: zoneId(refs, zone, session.caller) }),
  });
  const choice = zoneLayoutChoiceOf(changed);
  const moved = choice === 'lanes' ? 'Its tiles move into their lanes in a moment.' : choice === 'spine' ? 'Its tiles move into their bands in a moment.' : "No tile's place changed.";
  return { text: `${refs.of('zone', changed.id)} ${changed.name} is laid out as ${choice}: ${LAYOUT_WORDS[choice]}. ${moved}`, json: changed };
}

/** `zone remove`: deletes a group the caller (or its crew) made, leaving its tiles and notes loose. */
export async function removeGroup(session: BoardSession, ref: string): Promise<BoardView> {
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const id = zoneId(refs, ref, session.caller);
  await session.client.call('orchestrator.removeZone', { token: session.token, id });
  return { text: `Removed ${refs.of('zone', id)}: its tiles and notes stay where they were, loose on the board.`, json: null };
}

/** What `note add` takes, as typed. */
export interface NoteOptions extends PlaceOptions {
  text: string;
  kind?: string;
  color?: string;
  /** How many lines of an agent note's text show before the rest fades into a chip. */
  lines?: string | number;
}

/** Checks `note add`'s options before anything connects. */
export function checkNote(options: Omit<NoteOptions, 'text'>): void {
  checkPlace(options);
  if (options.kind !== undefined && !(NOTE_KINDS as readonly string[]).includes(options.kind)) throw new BoardError(`--kind must be ${NOTE_KINDS.join(' or ')}`);
  if (options.lines !== undefined) {
    noteLinesOf(options.lines, false);
    // Any kind given makes a sticky or a text, not an agent note.
    if (options.kind !== undefined) throw new BoardError('--lines is only for an agent note');
  }
}

/** What is said when a colour is given for an agent note, which has none: ignored, so no caller breaks. */
const colourIgnored = (item: BoardItem, color: string | undefined) =>
  item.kind === 'agent-note' && color !== undefined ? '\nwarning: an agent note has no colour, so the colour was ignored.' : '';

/** What is said when a line budget is given for an agent note the user has sized, whose size wins: ignored. */
const budgetIgnored = (item: BoardItem, lines: number | undefined) =>
  item.kind === 'agent-note' && lines !== undefined && lines > 0 && item.data.userSized === true
    ? '\nwarning: the user has sized this note, and their size wins over a line budget, so the budget was ignored.'
    : '';

/** `note add`: a note marked as made by the caller, placed clear of what is there: an agent note, from an agent. */
export async function addNote(session: BoardSession, options: NoteOptions): Promise<BoardView> {
  checkNote(options);
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const item = await session.client.call('orchestrator.addNote', {
    token: session.token,
    text: options.text,
    ...(options.kind === undefined ? {} : { kind: options.kind as (typeof NOTE_KINDS)[number] }),
    ...(options.color === undefined ? {} : { color: options.color }),
    ...(options.lines === undefined ? {} : { lines: noteLinesOf(options.lines, false) }),
    ...placeOf(refs, options, session.caller),
  });
  const fresh = new BoardRefs(await readEveryBoard(session.client));
  return { text: `Added ${itemLine(fresh, item)} ${itemPlace(fresh, item)} ${where(item.x, item.y)}.${colourIgnored(item, options.color)}`, json: item };
}

/** The note `text` names, by its id. */
function noteId(refs: BoardRefs, text: string, caller: BoardCaller | null): string {
  const object = refs.resolve(text, caller);
  if (object.kind !== 'item') throw new BoardError(`${text} is a ${object.kind}, not a note`);
  return object.item.id;
}

/** `note edit`: the text, colour, size (`<w>x<h>`) or line budget (`0` for none) of a note the caller (or its crew) made; size and lines are an agent note's. */
export async function editNote(session: BoardSession, ref: string, options: { text?: string; color?: string; size?: string; lines?: string | number }): Promise<BoardView> {
  const { size, lines, ...fields } = options;
  if (size !== undefined && lines !== undefined) throw new BoardError('give --size or --lines, not both');
  const budget = lines === undefined ? undefined : noteLinesOf(lines, true);
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const item = await session.client.call('orchestrator.editNote', {
    token: session.token,
    id: noteId(refs, ref, session.caller),
    ...fields,
    ...(size === undefined ? {} : noteSizeOf(size)),
    ...(budget === undefined ? {} : { lines: budget }),
  });
  return { text: `Changed ${itemLine(refs, item)}.${colourIgnored(item, options.color)}${budgetIgnored(item, budget)}`, json: item };
}

/** `note remove`: deletes a note the caller (or its crew) made. */
export async function removeNote(session: BoardSession, ref: string): Promise<BoardView> {
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const id = noteId(refs, ref, session.caller);
  await session.client.call('orchestrator.removeNote', { token: session.token, id });
  return { text: `Removed ${refs.of('item', id)}.`, json: null };
}

/** `note pass`: gives an agent note or document card to the agent `toRef`, which holds it from then on. */
export async function passNote(session: BoardSession, ref: string, toRef: string): Promise<BoardView> {
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const id = noteId(refs, ref, session.caller);
  const to = resolveAgent(refs, toRef, session.caller);
  const item = await session.client.call('orchestrator.passItem', { token: session.token, id, to: to.sessionId });
  return { text: `Passed ${refs.of('item', id)} to ${refs.of('agent', to.sessionId)} ${to.name}: it goes off the board with ${to.name} now.`, json: item };
}

/** What `shape add` and `shape edit` take, as typed. */
export interface ShapeOptions {
  shape?: string;
  text?: string;
  /** A line each. */
  attributes?: string[];
  methods?: string[];
  fill?: string;
}

/** Checks a shape's options before anything connects. */
export function checkShape(options: ShapeOptions): void {
  if (options.shape !== undefined && !(SHAPE_TYPES as readonly string[]).includes(options.shape)) throw new BoardError(`the shape is one of ${SHAPE_TYPES.join(', ')}`);
}

function shapeFields(options: ShapeOptions): DiagramShapeFields {
  checkShape(options);
  return {
    ...(options.shape === undefined ? {} : { shape: options.shape as ShapeType }),
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.attributes === undefined ? {} : { attributes: options.attributes.join('\n') }),
    ...(options.methods === undefined ? {} : { methods: options.methods.join('\n') }),
    ...(options.fill === undefined ? {} : { fill: options.fill }),
  };
}

/** `shape add`: a shape with text (a class's sections under its name), marked as made by the caller, placed as a note is. */
export async function addShape(session: BoardSession, options: ShapeOptions & PlaceOptions & { shape: string }): Promise<BoardView> {
  checkPlace(options);
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const item = await session.client.call('orchestrator.addShape', {
    token: session.token,
    ...shapeFields(options),
    shape: options.shape as ShapeType,
    text: options.text ?? '',
    ...placeOf(refs, options, session.caller),
  });
  const fresh = new BoardRefs(await readEveryBoard(session.client));
  return { text: `Added ${itemLine(fresh, item)} ${itemPlace(fresh, item)} ${where(item.x, item.y)}.`, json: item };
}

/** `diagram add`: the Mermaid flowchart or class diagram `mermaid` drawn as shapes and connectors, placed as a note is. */
export async function addDiagram(session: BoardSession, mermaid: string, options: PlaceOptions): Promise<BoardView> {
  checkPlace(options);
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const drawn = await session.client.call('orchestrator.addDiagram', { token: session.token, mermaid, ...placeOf(refs, options, session.caller) });
  const fresh = new BoardRefs(await readEveryBoard(session.client));
  const [first] = drawn.items;
  return {
    text: [
      `Drew ${drawn.items.length} shape${drawn.items.length === 1 ? '' : 's'} and ${drawn.connectors.length} connector${drawn.connectors.length === 1 ? '' : 's'} ${itemPlace(fresh, first!)}:`,
      ...drawn.items.map((item) => `  ${itemLine(fresh, item)}`),
      ...drawn.connectors.map((connector) => `  ${connectorLine(fresh, connector)}`),
      ...(drawn.skipped.length === 0 ? [] : [`Passed over ${drawn.skipped.length} line${drawn.skipped.length === 1 ? '' : 's'} it does not draw:`, ...drawn.skipped.map((line) => `  ${line}`)]),
    ].join('\n'),
    json: drawn,
  };
}

/**
 * `diagram export`: the shapes `refs` name (each a shape, or a zone for every shape in it), and the connectors between
 * them, as Mermaid. With none, the shapes on the caller's ticket's board if its ticket holds it (where its shapes go),
 * else those in its zone.
 */
export async function exportDiagram(session: BoardSession, refs: readonly string[]): Promise<BoardView> {
  const board = new BoardRefs(await readEveryBoard(session.client));
  const shapes = new Map<string, BoardItem>();
  const ticket = refs.length === 0 ? mapTicket(board, undefined, session.caller) : undefined;
  if (ticket !== undefined) {
    for (const item of board.board.items) if (item.kind === 'shape' && item.ticket === ticket) shapes.set(item.id, item);
    if (shapes.size === 0) throw new BoardError(`there is no shape on ${ticketBoardName(board, ticket)} to export`);
  }
  const own = session.caller?.zoneId ?? null;
  const named = refs.length > 0 ? refs : ticket !== undefined ? [] : own === null ? [] : [`zone:${own}`];
  if (named.length === 0 && ticket === undefined) throw new BoardError('give the zone, or the shapes, to export');
  for (const ref of named) {
    const object = board.resolve(ref, session.caller);
    if (object.kind === 'zone') {
      for (const item of board.board.items) if (item.kind === 'shape' && item.zoneId === object.zone.id) shapes.set(item.id, item);
    } else if (object.kind === 'item' && object.item.kind === 'shape') shapes.set(object.item.id, object.item);
    else throw new BoardError(`${ref} is ${object.kind === 'item' ? `a ${object.item.kind}` : `a ${object.kind}`}: export takes shapes, or a zone`);
  }
  if (shapes.size === 0) throw new BoardError(`there is no shape in ${named.join(', ')} to export`);
  const mermaid = toMermaid(
    // A shape saved before sections has none.
    [...shapes.values()].map((item) => ({ id: item.id, data: { shape: 'rectangle', text: '', attributes: '', methods: '', fill: FILL_SLOT_COLORS.tile, ...item.data } as ShapeData })),
    board.board.connectors.map(({ from, to, ...look }) => ({ from, to, ...look })),
  );
  return { text: mermaid.trimEnd(), json: { mermaid } };
}

/** The shape `text` names, by its id. */
function shapeId(refs: BoardRefs, text: string, caller: BoardCaller | null): string {
  const object = refs.resolve(text, caller);
  if (object.kind !== 'item' || object.item.kind !== 'shape') throw new BoardError(`${text} is ${object.kind === 'item' ? `a ${object.item.kind}` : `a ${object.kind}`}, not a shape`);
  return object.item.id;
}

/** `shape edit`: the kind, text, sections or fill of a shape the caller (or its crew) made. */
export async function editShape(session: BoardSession, ref: string, options: ShapeOptions): Promise<BoardView> {
  const fields = shapeFields(options);
  if (Object.keys(fields).length === 0) throw new BoardError('give the shape, text, attributes, methods or fill to change');
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const item = await session.client.call('orchestrator.editShape', { token: session.token, id: shapeId(refs, ref, session.caller), ...fields });
  return { text: `Changed ${itemLine(new BoardRefs(await readEveryBoard(session.client)), item)}.`, json: item };
}

/** `shape remove`: deletes a shape the caller (or its crew) drew, and every connector joined to it. */
export async function removeShape(session: BoardSession, ref: string): Promise<BoardView> {
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const id = shapeId(refs, ref, session.caller);
  await session.client.call('orchestrator.removeShape', { token: session.token, id });
  return { text: `Removed ${refs.of('item', id)}.`, json: null };
}

/** What `connect` and `connector edit` take, as typed. */
export interface ConnectorOptions {
  relation?: string;
  style?: string;
  label?: string;
  fromLabel?: string;
  toLabel?: string;
}

/** Checks a connector's options before anything connects. */
export function checkConnector(options: ConnectorOptions): void {
  if (options.relation !== undefined && !RELATIONS.some((relation) => relation.id === options.relation)) {
    throw new BoardError(`the relation is one of ${RELATIONS.map((relation) => relation.id).join(', ')}`);
  }
  if (options.style !== undefined && !(CONNECTOR_STYLES as readonly string[]).includes(options.style)) throw new BoardError(`the style is one of ${CONNECTOR_STYLES.join(', ')}`);
}

function connectorFields(options: ConnectorOptions): DiagramConnectorFields {
  checkConnector(options);
  return {
    ...(options.relation === undefined ? {} : { relation: options.relation as RelationId }),
    ...(options.style === undefined ? {} : { style: options.style as ConnectorStyle }),
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.fromLabel === undefined ? {} : { startLabel: options.fromLabel }),
    ...(options.toLabel === undefined ? {} : { endLabel: options.toLabel }),
  };
}

/** The item `text` names, by its id: an end of a connector. */
function connectorEnd(refs: BoardRefs, text: string, caller: BoardCaller | null): string {
  const object = refs.resolve(text, caller);
  if (object.kind !== 'item') throw new BoardError(`${text} is a ${object.kind}: a connector joins board items (shapes, notes, cards)`);
  return object.item.id;
}

/** `connect`: joins two items with a connector, `from` to `to` as the relation reads, marked as made by the caller. */
export async function connectItems(session: BoardSession, from: string, to: string, options: ConnectorOptions): Promise<BoardView> {
  const fields = connectorFields(options);
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const connector = await session.client.call('orchestrator.connect', {
    token: session.token,
    from: connectorEnd(refs, from, session.caller),
    to: connectorEnd(refs, to, session.caller),
    ...fields,
  });
  return { text: `Connected ${connectorLine(new BoardRefs(await readEveryBoard(session.client)), connector)}.`, json: connector };
}

/** The connector `text` names, by its id. */
function connectorId(refs: BoardRefs, text: string, caller: BoardCaller | null): string {
  const object = refs.resolve(text, caller);
  if (object.kind !== 'connector') throw new BoardError(`${text} is a ${object.kind}, not a connector`);
  return object.connector.id;
}

/** `connector edit`: the relation, style or labels of a connector the caller (or its crew) made. */
export async function editConnector(session: BoardSession, ref: string, options: ConnectorOptions): Promise<BoardView> {
  const fields = connectorFields(options);
  if (Object.keys(fields).length === 0) throw new BoardError('give the relation, style or a label to change');
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const connector = await session.client.call('orchestrator.editConnector', { token: session.token, id: connectorId(refs, ref, session.caller), ...fields });
  return { text: `Changed ${connectorLine(new BoardRefs(await readEveryBoard(session.client)), connector)}.`, json: connector };
}

/** `connector remove`: deletes a connector the caller (or its crew) made. */
export async function removeConnector(session: BoardSession, ref: string): Promise<BoardView> {
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const id = connectorId(refs, ref, session.caller);
  await session.client.call('orchestrator.removeConnector', { token: session.token, id });
  return { text: `Removed ${refs.of('connector', id)}.`, json: null };
}

/**
 * `arrange ticket` (or a ticket chat's ref): lays out that ticket's own board, its chat and helpers beside the notes and
 * cards there, which stay put; nothing on the main board moves. It takes none of a zone's arrange options.
 */
async function arrangeTicket(session: BoardSession, refs: BoardRefs, ticket: string, options: ArrangeOptions): Promise<BoardView> {
  if (Object.values(options).some((value) => value !== undefined)) throw new BoardError("arrange of a ticket's board takes no --by, --layout, --auto, --place, --once or --all: they are a zone's");
  const result = await session.client.call('orchestrator.arrangeTicket', { token: session.token, ticket });
  const name = ticketBoardName(refs, ticket);
  const moved = result.moved.map((each) => `  ${label(refs, { kind: 'agent', id: each.sessionId })} ${where(each.x, each.y)}`);
  return {
    text: result.moved.length === 0 ? `${name} was arranged already: nothing moved.` : [`Arranged ${name}:`, ...moved].join('\n'),
    json: result,
  };
}

/**
 * `arrange board`: lays out the whole board, its zones in rows and its loose tiles below them, never what is in a zone,
 * for an orchestrator of the whole board. It takes none of a zone's arrange options.
 */
async function arrangeWholeBoard(session: BoardSession, options: ArrangeOptions): Promise<BoardView> {
  if (Object.values(options).some((value) => value !== undefined)) throw new BoardError('arrange board takes no --by, --layout, --auto, --place, --once or --all: they are a zone\'s');
  const result = await session.client.call('orchestrator.arrangeBoard', { token: session.token });
  const refs = new BoardRefs(await readEveryBoard(session.client));
  const zones = result.zones.map((each) => `  ${refs.of('zone', each.zoneId)} ${refs.board.zones.find((zone) => zone.id === each.zoneId)?.name ?? ''} ${where(each.x, each.y)}`);
  const tiles = result.moved.map((each) => `  ${label(refs, each.target)} ${where(each.x, each.y)}`);
  return {
    text: zones.length + tiles.length === 0 ? 'The board was arranged already: nothing moved.' : ['Arranged the board:', ...zones, ...tiles].join('\n'),
    json: result,
  };
}
