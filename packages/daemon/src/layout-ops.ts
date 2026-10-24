// The layout commands as the CLI and MCP give them (`move`, `arrange`, `zone`, `note`): refs and words turned into the
// daemon's `orchestrator.*` layout methods, and their results as text and JSON (ADR-0010's one API, two faces).
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BoardError, BoardRefs, connectorLine, connectorsIn, inZone, itemLine, readBoard, REF_KINDS, shapeSectionLines, zoneLine, type BoardSession, type BoardView, type RefKind } from './board-ops.ts';
import {
  ARRANGE_BYS,
  ARRANGE_LAYOUTS,
  CAPTURE_STYLES,
  CONNECTOR_STYLES,
  FILL_SLOT_COLORS,
  NOTE_KINDS,
  RELATIONS,
  SHAPE_TYPES,
  TILE_SIDES,
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
  type ZoneMap,
  type ZoneScreenshot,
} from './protocol.ts';
import { toMermaid } from './mermaid.ts';
import { boxPicture, laneTable, lintLine } from './zone-map.ts';

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

/** What a layout command's options say where to put something, as typed: refs and words, not yet checked. */
export interface PlaceOptions {
  /** A zone ref, or `board` for loose on the board. */
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

function placeOf(refs: BoardRefs, options: PlaceOptions, caller: BoardCaller | null): LayoutPlace {
  checkPlace(options);
  return {
    ...(options.to === undefined ? {} : { zoneId: options.to === 'board' ? null : zoneId(refs, options.to, caller) }),
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
  const refs = new BoardRefs(await readBoard(session.client));
  const target = layoutTarget(refs, ref, session.caller);
  const moved = await session.client.call('orchestrator.move', { token: session.token, target, ...placeOf(refs, options, session.caller) });
  return { text: `Moved ${label(refs, target)} ${inZone(refs, moved.zoneId)} ${where(moved.x, moved.y)}.`, json: moved };
}

export interface ArrangeOptions {
  by?: string;
  layout?: string;
  /** `on` or `off`. */
  auto?: string;
}

/** Checks `arrange`'s options before anything connects. */
export function checkArrange(options: ArrangeOptions): void {
  if (options.by !== undefined && !(ARRANGE_BYS as readonly string[]).includes(options.by)) throw new BoardError(`--by must be ${ARRANGE_BYS.join(', ')}`);
  if (options.layout !== undefined && !(ARRANGE_LAYOUTS as readonly string[]).includes(options.layout)) {
    throw new BoardError(`--layout must be ${ARRANGE_LAYOUTS.join(', ')}`);
  }
  if (options.auto !== undefined && options.auto !== 'on' && options.auto !== 'off') throw new BoardError('--auto must be on or off');
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

/**
 * `zone map`: a zone (the caller's by default) as its lanes and what is amiss, or with `boxes` as a box picture; then a
 * summary of its diagram, if it has one, a class's members too with `sections`.
 */
export async function zoneMap(
  session: BoardSession,
  zone: string | undefined,
  options: { boxes?: boolean; sections?: boolean; face?: ReadFace },
): Promise<BoardView> {
  const refs = new BoardRefs(await readBoard(session.client));
  const map = await session.client.call('orchestrator.map', { token: session.token, ...(zone === undefined ? {} : { zoneId: zoneId(refs, zone, session.caller) }) });
  const diagram = diagramLines(refs, map.zoneId, options.sections === true, options.face ?? 'cli');
  return { text: [mapText(refs, map, options.boxes === true), ...(diagram.length === 0 ? [] : ['', ...diagram])].join('\n'), json: map };
}

/** `arrange`: lays out the tiles of a zone (the caller's by default) it may move. */
export async function arrangeZone(session: BoardSession, zone: string | undefined, options: ArrangeOptions): Promise<BoardView> {
  checkArrange(options);
  const refs = new BoardRefs(await readBoard(session.client));
  const result = await session.client.call('orchestrator.arrange', {
    token: session.token,
    ...(zone === undefined ? {} : { zoneId: zoneId(refs, zone, session.caller) }),
    ...(options.by === undefined ? {} : { by: options.by as (typeof ARRANGE_BYS)[number] }),
    ...(options.layout === undefined ? {} : { layout: options.layout as (typeof ARRANGE_LAYOUTS)[number] }),
    ...(options.auto === undefined ? {} : { auto: options.auto === 'on' }),
  });
  const name = refs.board.zones.find((each) => each.id === result.zoneId)?.name ?? '';
  const moved = result.moved.map((each) => `  ${label(refs, each.target)} ${where(each.x, each.y)}`);
  // Then the zone's map, so the layout can be checked at once: read afresh, with the labels and notes it made.
  const map = await session.client.call('orchestrator.map', { token: session.token, zoneId: result.zoneId });
  const after = new BoardRefs(await readBoard(session.client));
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
  const refs = new BoardRefs(await readBoard(session.client));
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
  const refs = new BoardRefs(await readBoard(session.client));
  return { text: `Made ${zoneLine(refs, zone)} ${where(zone.x, zone.y)}, ${zone.width}×${zone.height}.`, json: zone };
}

/** `zone rename|resize`: changes a group the caller (or its crew) made. */
export async function changeGroup(session: BoardSession, ref: string, options: GroupOptions): Promise<BoardView> {
  const refs = new BoardRefs(await readBoard(session.client));
  const zone = await session.client.call('orchestrator.changeZone', { token: session.token, id: zoneId(refs, ref, session.caller), ...groupFields(options) });
  return { text: `Changed ${zoneLine(refs, zone)}: ${where(zone.x, zone.y)}, ${zone.width}×${zone.height}.`, json: zone };
}

/** `zone remove`: deletes a group the caller (or its crew) made, leaving its tiles and notes loose. */
export async function removeGroup(session: BoardSession, ref: string): Promise<BoardView> {
  const refs = new BoardRefs(await readBoard(session.client));
  const id = zoneId(refs, ref, session.caller);
  await session.client.call('orchestrator.removeZone', { token: session.token, id });
  return { text: `Removed ${refs.of('zone', id)}: its tiles and notes stay where they were, loose on the board.`, json: null };
}

/** What `note add` takes, as typed. */
export interface NoteOptions extends PlaceOptions {
  text: string;
  kind?: string;
  color?: string;
}

/** Checks `note add`'s options before anything connects. */
export function checkNote(options: Omit<NoteOptions, 'text'>): void {
  checkPlace(options);
  if (options.kind !== undefined && !(NOTE_KINDS as readonly string[]).includes(options.kind)) throw new BoardError(`--kind must be ${NOTE_KINDS.join(' or ')}`);
}

/** What is said when a colour is given for an agent note, which has none: ignored, so no caller breaks. */
const colourIgnored = (item: BoardItem, color: string | undefined) =>
  item.kind === 'agent-note' && color !== undefined ? '\nwarning: an agent note has no colour, so the colour was ignored.' : '';

/** `note add`: a note marked as made by the caller, placed clear of what is there: an agent note, from an agent. */
export async function addNote(session: BoardSession, options: NoteOptions): Promise<BoardView> {
  checkNote(options);
  const refs = new BoardRefs(await readBoard(session.client));
  const item = await session.client.call('orchestrator.addNote', {
    token: session.token,
    text: options.text,
    ...(options.kind === undefined ? {} : { kind: options.kind as (typeof NOTE_KINDS)[number] }),
    ...(options.color === undefined ? {} : { color: options.color }),
    ...placeOf(refs, options, session.caller),
  });
  const fresh = new BoardRefs(await readBoard(session.client));
  return { text: `Added ${itemLine(fresh, item)} ${inZone(fresh, item.zoneId)} ${where(item.x, item.y)}.${colourIgnored(item, options.color)}`, json: item };
}

/** The note `text` names, by its id. */
function noteId(refs: BoardRefs, text: string, caller: BoardCaller | null): string {
  const object = refs.resolve(text, caller);
  if (object.kind !== 'item') throw new BoardError(`${text} is a ${object.kind}, not a note`);
  return object.item.id;
}

/** `note edit`: the text or colour of a note the caller (or its crew) made. */
export async function editNote(session: BoardSession, ref: string, options: { text?: string; color?: string }): Promise<BoardView> {
  const refs = new BoardRefs(await readBoard(session.client));
  const item = await session.client.call('orchestrator.editNote', { token: session.token, id: noteId(refs, ref, session.caller), ...options });
  return { text: `Changed ${itemLine(refs, item)}.${colourIgnored(item, options.color)}`, json: item };
}

/** `note remove`: deletes a note the caller (or its crew) made. */
export async function removeNote(session: BoardSession, ref: string): Promise<BoardView> {
  const refs = new BoardRefs(await readBoard(session.client));
  const id = noteId(refs, ref, session.caller);
  await session.client.call('orchestrator.removeNote', { token: session.token, id });
  return { text: `Removed ${refs.of('item', id)}.`, json: null };
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
  const refs = new BoardRefs(await readBoard(session.client));
  const item = await session.client.call('orchestrator.addShape', {
    token: session.token,
    ...shapeFields(options),
    shape: options.shape as ShapeType,
    text: options.text ?? '',
    ...placeOf(refs, options, session.caller),
  });
  const fresh = new BoardRefs(await readBoard(session.client));
  return { text: `Added ${itemLine(fresh, item)} ${inZone(fresh, item.zoneId)} ${where(item.x, item.y)}.`, json: item };
}

/** `diagram add`: the Mermaid flowchart or class diagram `mermaid` drawn as shapes and connectors, placed as a note is. */
export async function addDiagram(session: BoardSession, mermaid: string, options: PlaceOptions): Promise<BoardView> {
  checkPlace(options);
  const refs = new BoardRefs(await readBoard(session.client));
  const drawn = await session.client.call('orchestrator.addDiagram', { token: session.token, mermaid, ...placeOf(refs, options, session.caller) });
  const fresh = new BoardRefs(await readBoard(session.client));
  const [first] = drawn.items;
  return {
    text: [
      `Drew ${drawn.items.length} shape${drawn.items.length === 1 ? '' : 's'} and ${drawn.connectors.length} connector${drawn.connectors.length === 1 ? '' : 's'} ${inZone(fresh, first!.zoneId)}:`,
      ...drawn.items.map((item) => `  ${itemLine(fresh, item)}`),
      ...drawn.connectors.map((connector) => `  ${connectorLine(fresh, connector)}`),
      ...(drawn.skipped.length === 0 ? [] : [`Passed over ${drawn.skipped.length} line${drawn.skipped.length === 1 ? '' : 's'} it does not draw:`, ...drawn.skipped.map((line) => `  ${line}`)]),
    ].join('\n'),
    json: drawn,
  };
}

/**
 * `diagram export`: the shapes `refs` name (each a shape, or a zone for every shape in it; the caller's zone with none),
 * and the connectors between them, as Mermaid.
 */
export async function exportDiagram(session: BoardSession, refs: readonly string[]): Promise<BoardView> {
  const board = new BoardRefs(await readBoard(session.client));
  const own = session.caller?.zoneId ?? null;
  const named = refs.length > 0 ? refs : own === null ? [] : [`zone:${own}`];
  if (named.length === 0) throw new BoardError('give the zone, or the shapes, to export');
  const shapes = new Map<string, BoardItem>();
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
  const refs = new BoardRefs(await readBoard(session.client));
  const item = await session.client.call('orchestrator.editShape', { token: session.token, id: shapeId(refs, ref, session.caller), ...fields });
  return { text: `Changed ${itemLine(new BoardRefs(await readBoard(session.client)), item)}.`, json: item };
}

/** `shape remove`: deletes a shape the caller (or its crew) drew, and every connector joined to it. */
export async function removeShape(session: BoardSession, ref: string): Promise<BoardView> {
  const refs = new BoardRefs(await readBoard(session.client));
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
  const refs = new BoardRefs(await readBoard(session.client));
  const connector = await session.client.call('orchestrator.connect', {
    token: session.token,
    from: connectorEnd(refs, from, session.caller),
    to: connectorEnd(refs, to, session.caller),
    ...fields,
  });
  return { text: `Connected ${connectorLine(new BoardRefs(await readBoard(session.client)), connector)}.`, json: connector };
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
  const refs = new BoardRefs(await readBoard(session.client));
  const connector = await session.client.call('orchestrator.editConnector', { token: session.token, id: connectorId(refs, ref, session.caller), ...fields });
  return { text: `Changed ${connectorLine(new BoardRefs(await readBoard(session.client)), connector)}.`, json: connector };
}

/** `connector remove`: deletes a connector the caller (or its crew) made. */
export async function removeConnector(session: BoardSession, ref: string): Promise<BoardView> {
  const refs = new BoardRefs(await readBoard(session.client));
  const id = connectorId(refs, ref, session.caller);
  await session.client.call('orchestrator.removeConnector', { token: session.token, id });
  return { text: `Removed ${refs.of('connector', id)}.`, json: null };
}
