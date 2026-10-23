// The layout commands as the CLI and MCP give them (`move`, `arrange`, `zone`, `note`): refs and words turned into the
// daemon's `orchestrator.*` layout methods, and their results as text and JSON (ADR-0010's one API, two faces).
import { BoardError, BoardRefs, inZone, itemLine, readBoard, REF_KINDS, zoneLine, type BoardSession, type BoardView, type RefKind } from './board-ops.ts';
import { ARRANGE_BYS, ARRANGE_LAYOUTS, NOTE_KINDS, TILE_SIDES, type BoardCaller, type BoardItem, type LayoutPlace, type LayoutTarget, type TileSide, type ZoneMap } from './protocol.ts';
import { boxPicture, laneTable } from './zone-map.ts';

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

/** `zone map`: a zone (the caller's by default) as its lanes and what is amiss, or with `boxes` as a box picture. */
export async function zoneMap(session: BoardSession, zone: string | undefined, options: { boxes?: boolean }): Promise<BoardView> {
  const refs = new BoardRefs(await readBoard(session.client));
  const map = await session.client.call('orchestrator.map', { token: session.token, ...(zone === undefined ? {} : { zoneId: zoneId(refs, zone, session.caller) }) });
  return { text: mapText(refs, map, options.boxes === true), json: map };
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
