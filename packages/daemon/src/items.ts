import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { finiteNumberParam, invalidParams, paramsObject, stringParam } from './params.ts';
import type { ImageStore } from './image-store.ts';
import { imagesOf, type ImageSweeper } from './image-sweeper.ts';
import { isObject } from './json.ts';
import {
  BOARD_ITEM_KINDS,
  IMAGE_EXTENSIONS,
  issueCardProblem,
  MAX_ITEM_DATA_BYTES,
  MAX_LINK_URL,
  MAX_STICKY_TEXT,
  type ImageRef,
  type LinkData,
  MAX_TEXT_FONT_SIZE,
  MAX_TEXT_LENGTH,
  MIN_TEXT_FONT_SIZE,
  normalisedAngle,
  SHAPE_TYPES,
  TEXT_ALIGNS,
  TEXT_SIZES,
  type BoardItem,
  type BoardItemKind,
  type DaemonEvent,
  type DaemonMethods,
} from './protocol.ts';

import type { RpcHandlers, RpcMethodError } from './rpc.ts';
import { zoneIdParam } from './tile-position.ts';

type ItemMethods = Pick<DaemonMethods, Extract<keyof DaemonMethods, `item.${string}` | `image.${string}`>>;

const CLIENT_ID = /^[A-Za-z0-9-]{1,64}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Whether `value` is a reference to a stored image. */
function isImageRef(value: unknown, extensions: readonly string[]): value is ImageRef {
  if (typeof value !== 'object' || value === null) return false;
  const { sha256, ext } = value as Record<string, unknown>;
  return typeof sha256 === 'string' && SHA256.test(sha256) && typeof ext === 'string' && extensions.includes(ext);
}

const IMAGE_ITEM_EXTENSIONS = IMAGE_EXTENSIONS.filter((ext) => ext !== 'ico');

const isOneOf = (options: readonly unknown[], value: unknown) => options.includes(value);

function checkText(owner: string, data: Record<string, unknown>, key: string): void {
  const text = data[key];
  if (typeof text !== 'string') throw invalidParams(`${owner}'s ${key} must be a string`);
  if (text.length > MAX_TEXT_LENGTH) throw invalidParams(`${owner}'s ${key} is over ${MAX_TEXT_LENGTH} characters`);
}

function checkColor(owner: string, data: Record<string, unknown>, key: string, allowNone = false): void {
  const value = data[key];
  if (allowNone && value === null) return;
  if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
    throw invalidParams(`${owner}'s ${key} must be #rrggbb${allowNone ? ' or null' : ''}`);
  }
}

function checkOneOf(owner: string, data: Record<string, unknown>, key: string, options: readonly unknown[]): void {
  if (!isOneOf(options, data[key])) throw invalidParams(`${owner}'s ${key} must be one of ${options.join(', ')}`);
}

function checkBoolean(owner: string, data: Record<string, unknown>, key: string): void {
  if (typeof data[key] !== 'boolean') throw invalidParams(`${owner}'s ${key} must be true or false`);
}

/**
 * Each kind's check of an item's whole `data`, as it would be stored: throws `invalidParams` saying what is wrong. A
 * new kind adds its own here. Keys a kind doesn't know are kept, within the size cap.
 */
const KIND_DATA: Record<BoardItemKind, (data: Record<string, unknown>) => void> = {
  sticky: (data) => {
    if (typeof data.text !== 'string') throw invalidParams("a sticky note's text must be a string");
    if (data.text.length > MAX_STICKY_TEXT) {
      throw invalidParams(`a sticky note's text is over ${MAX_STICKY_TEXT} characters`);
    }
    if (typeof data.color !== 'string' || !HEX_COLOR.test(data.color)) {
      throw invalidParams("a sticky note's color must be #rrggbb");
    }
  },
  image: (data) => {
    if (!isImageRef(data, IMAGE_ITEM_EXTENSIONS)) throw invalidParams("an image's data must be a stored image's sha256 and ext");
  },
  link: (data) => {
    const { url, title, domain, favicon, status } = data as Partial<Record<keyof LinkData, unknown>>;
    if (typeof url !== 'string' || url.length > MAX_LINK_URL || !isHttpsUrl(url)) {
      throw invalidParams(`a link card's url must be an https URL of at most ${MAX_LINK_URL} characters`);
    }
    for (const [name, value] of Object.entries({ title, domain })) {
      if (value !== undefined && typeof value !== 'string') throw invalidParams(`a link card's ${name} must be a string`);
    }
    if (favicon !== undefined && !isImageRef(favicon, IMAGE_EXTENSIONS)) {
      throw invalidParams("a link card's favicon must be a stored image's sha256 and ext");
    }
    if (status !== undefined) {
      const s = status as Record<string, unknown> | null;
      const ok =
        typeof s === 'object' && s !== null && (s.kind === 'issue' || s.kind === 'pr') && typeof s.id === 'string' && typeof s.state === 'string';
      if (!ok) throw invalidParams("a link card's status must be { kind, id, state }");
    }
},
  issue: (data) => {
    const problem = issueCardProblem(data);
    if (problem !== undefined) throw invalidParams(problem);
  },
  text: (data) => {
    const owner = 'a text item';
    checkText(owner, data, 'text');
    checkOneOf(owner, data, 'size', TEXT_SIZES);
    if (data.fontSize !== undefined && !(typeof data.fontSize === 'number' && data.fontSize >= MIN_TEXT_FONT_SIZE && data.fontSize <= MAX_TEXT_FONT_SIZE)) {
      throw invalidParams(`a text item's fontSize must be a number from ${MIN_TEXT_FONT_SIZE} to ${MAX_TEXT_FONT_SIZE}`);
    }
    if (data.minHeight !== undefined && !(typeof data.minHeight === 'number' && data.minHeight >= 0)) {
      throw invalidParams("a text item's minHeight must be a number, 0 or more");
    }
    checkOneOf(owner, data, 'align', TEXT_ALIGNS);
    checkBoolean(owner, data, 'bold');
    checkBoolean(owner, data, 'italic');
    checkBoolean(owner, data, 'wrap');
    checkColor(owner, data, 'color');
  },
  shape: (data) => {
    const owner = 'a shape';
    checkOneOf(owner, data, 'shape', SHAPE_TYPES);
    checkColor(owner, data, 'fill', true);
    checkColor(owner, data, 'stroke');
    checkColor(owner, data, 'textColor');
    if (typeof data.strokeWidth !== 'number' || !(data.strokeWidth >= 0 && data.strokeWidth <= 20)) {
      throw invalidParams("a shape's strokeWidth must be a number from 0 to 20");
    }
    checkBoolean(owner, data, 'dashed');
    checkBoolean(owner, data, 'bold');
    checkText(owner, data, 'text');
    checkOneOf(owner, data, 'textSize', TEXT_SIZES);
  },
};

function isHttpsUrl(text: string): boolean {
  try {
    return new URL(text).protocol === 'https:';
  } catch {
    return false;
  }
}

/** `data` as stored for an item of `kind`, once it passes the kind's check and the size cap. */
function checkedData(kind: BoardItemKind, data: Record<string, unknown>): string {
  KIND_DATA[kind](data);
  const encoded = JSON.stringify(data);
  if (Buffer.byteLength(encoded) > MAX_ITEM_DATA_BYTES) {
    throw invalidParams(`an item's data is over ${MAX_ITEM_DATA_BYTES} bytes`);
  }
  return encoded;
}

interface ItemRow {
  id: string;
  kind: BoardItemKind;
  zone_id: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
  rotation: number;
  data: string;
  created_at: string;
  updated_at: string;
}

export interface ItemHandlerOptions {
  images: ImageStore;
  sweeper: ImageSweeper;
  /** Looks up what a new link card can show of its URL. */
  linkCards: { enrich(url: string): Promise<Partial<LinkData>> };
  log: (message: string) => void;
}

/**
 * The `item.*` RPC handlers, backed by the `board_items` table. Every change is broadcast to every client, so each
 * window's board stays live. They don't use the calling connection.
 */
export function itemHandlers<Context>(
  db: DatabaseSync,
  broadcast: (event: DaemonEvent) => void,
  { images, sweeper, linkCards, log }: ItemHandlerOptions,
): RpcHandlers<ItemMethods, Context> {
  const selectAll = db.prepare('SELECT * FROM board_items ORDER BY z, rowid');
  const selectOne = db.prepare('SELECT * FROM board_items WHERE id = ?');
  const insert = db.prepare(
    `INSERT INTO board_items (id, kind, zone_id, x, y, width, height, z, rotation, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT coalesce(max(z), 0) + 1 FROM board_items), ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE board_items SET zone_id = ?, x = ?, y = ?, width = ?, height = ?, z = ?, rotation = ?, data = ?,
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  );
  const remove = db.prepare('DELETE FROM board_items WHERE id = ?');
  const unenrichedLinks = db.prepare("SELECT id FROM board_items WHERE kind = 'link' AND json_extract(data, '$.domain') IS NULL");
  const zoneOrigin = db.prepare('SELECT x, y FROM zones WHERE id = ?');

  const get = (id: string): BoardItem => {
    const row = selectOne.get(id) as ItemRow | undefined;
    if (row === undefined) throw noItem(id);
    return toItem(row);
  };

  /** Where the zone's (or, for null, the board's) origin is on the board. */
  const originOf = (zoneId: string | null): { x: number; y: number } => {
    if (zoneId === null) return { x: 0, y: 0 };
    const zone = zoneOrigin.get(zoneId) as { x: number; y: number } | undefined;
    if (zone === undefined) throw invalidParams(`no zone ${zoneId}`);
    return zone;
  };

  /** Checks the stored images an item's data refers to are there. */
  const checkImagesStored = (data: Record<string, unknown>) => {
    for (const ref of [data, data.favicon]) {
      if (isImageRef(ref, IMAGE_EXTENSIONS) && !images.has(ref)) throw invalidParams(`image ${ref.sha256} is not stored`);
    }
  };

  /** Fills in a new link card from its page, once the page answers; the card is there meanwhile with its bare URL. */
  const enrichLink = (item: BoardItem) => {
    void linkCards
      .enrich((item.data as unknown as LinkData).url)
      .then((found) => {
        if (selectOne.get(item.id) === undefined) return; // deleted meanwhile
        const current = get(item.id);
        announce(writeData(current, found));
      })
      .catch((error: Error) => log(`could not fill in a link card: ${error.message}`));
  };

  const writeData = (item: BoardItem, patch: Record<string, unknown>): BoardItem => {
    const data = checkedData(item.kind, { ...item.data, ...patch });
    update.run(item.zoneId, item.x, item.y, item.width, item.height, item.z, item.rotation, data, item.id);
    return get(item.id);
  };

  const announce = (item: BoardItem): BoardItem => {
    broadcast({ type: 'item.updated', item });
    return item;
  };

  sweeper.sweep();
  // A card whose page was never read (the daemon stopped first) gets another go.
  for (const { id } of unenrichedLinks.all() as { id: string }[]) enrichLink(get(id));

  return {
    'image.import': (params) => images.importFile(stringParam(paramsObject(params), 'path')),
    'image.paste': (params) => ({ path: images.pasteFile(stringParam(paramsObject(params), 'path')) }),
    'item.list': () => (selectAll.all() as unknown as ItemRow[]).map(toItem),
    'item.create': (params) => {
      const fields = paramsObject(params);
      const kind = fields.kind;
      if (!BOARD_ITEM_KINDS.includes(kind as BoardItemKind)) throw invalidParams(`unknown board item kind ${String(kind)}`);
      const zoneId = zoneIdParam(fields);
      originOf(zoneId);
      const data = dataParam(fields);
      checkedData(kind as BoardItemKind, data);
      checkImagesStored(data);
      const id = fields.id === undefined ? randomUUID() : stringParam(fields, 'id');
      if (!CLIENT_ID.test(id)) throw invalidParams('an item id is letters, digits and -, at most 64');
      if (selectOne.get(id) !== undefined) throw invalidParams(`board item ${id} already exists`);
      insert.run(
        id,
        kind as BoardItemKind,
        zoneId,
        finiteNumberParam(fields, 'x'),
        finiteNumberParam(fields, 'y'),
        sizeParam(fields, 'width'),
        sizeParam(fields, 'height'),
        fields.rotation === undefined ? 0 : rotationParam(fields),
        checkedData(kind as BoardItemKind, data),
      );
      const created = announce(get(id));
      if (created.kind === 'link') enrichLink(created);
      return created;
    },
    'item.update': (params) => {
      const fields = paramsObject(params);
      const item = get(stringParam(fields, 'id'));
      const has = (name: string) => fields[name] !== undefined;
      let { x, y } = item;
      const zoneId = has('zoneId') ? zoneIdParam(fields) : item.zoneId;
      if (zoneId !== item.zoneId) {
        // Moved to another zone: the same place on the board, in the new zone's terms.
        const from = originOf(item.zoneId);
        const to = originOf(zoneId);
        x += from.x - to.x;
        y += from.y - to.y;
      }
      if (has('x')) x = finiteNumberParam(fields, 'x');
      if (has('y')) y = finiteNumberParam(fields, 'y');
      const data = has('data') ? { ...item.data, ...dataParam(fields) } : item.data;
      if (has('data')) checkImagesStored(data);
      update.run(
        zoneId,
        x,
        y,
        has('width') ? sizeParam(fields, 'width') : item.width,
        has('height') ? sizeParam(fields, 'height') : item.height,
        has('z') ? finiteNumberParam(fields, 'z') : item.z,
        has('rotation') ? rotationParam(fields) : item.rotation,
        has('data') ? checkedData(item.kind, data) : JSON.stringify(item.data),
        item.id,
      );
      const updated = announce(get(item.id));
      // A replaced image or favicon may have been the last use of its file.
      if (has('data') && (item.kind === 'image' || item.kind === 'link')) sweeper.sweep();
      return updated;
    },
    'item.delete': (params) => {
      const id = stringParam(paramsObject(params), 'id');
      const doomed = get(id);
      // Its images stay through the grace period, so undoing the delete can make it again.
      for (const sha256 of imagesOf(doomed.data)) images.spare(sha256);
      remove.run(id);
      broadcast({ type: 'item.removed', id });
      sweeper.sweep();
      return null;
    },
  };
}

/**
 * Runs `remove`, which removes the zone, then tells every client about the items it held: the
 * `board_items_leave_removed_zone` trigger moves them onto the board, inside the zone's own delete.
 */
export function itemsLeavingZone(
  db: DatabaseSync,
  broadcast: (event: DaemonEvent) => void,
): <T>(zoneId: string | undefined, remove: () => T | Promise<T>) => Promise<T> {
  const inZone = db.prepare('SELECT id FROM board_items WHERE zone_id = ?');
  const selectOne = db.prepare('SELECT * FROM board_items WHERE id = ?');
  return async (zoneId, remove) => {
    const ids = zoneId === undefined ? [] : (inZone.all(zoneId) as { id: string }[]).map((row) => row.id);
    const result = await remove();
    for (const id of ids) {
      const row = selectOne.get(id) as ItemRow | undefined;
      if (row !== undefined) broadcast({ type: 'item.updated', item: toItem(row) });
    }
    return result;
  };
}

function toItem(row: ItemRow): BoardItem {
  return {
    id: row.id,
    kind: row.kind,
    zoneId: row.zone_id,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    z: row.z,
    rotation: row.rotation,
    data: JSON.parse(row.data) as Record<string, unknown>,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A width or height: at least 1. */
function sizeParam(fields: Record<string, unknown>, name: string): number {
  const value = finiteNumberParam(fields, name);
  if (value < 1) throw invalidParams(`${name} must be at least 1`);
  return value;
}

/** An angle in degrees, as kept. */
function rotationParam(fields: Record<string, unknown>): number {
  return normalisedAngle(finiteNumberParam(fields, 'rotation'));
}

function dataParam(fields: Record<string, unknown>): Record<string, unknown> {
  const data = fields.data;
  if (!isObject(data)) throw invalidParams('data must be an object');
  return data;
}

function noItem(id: string): RpcMethodError {
  return invalidParams(`no board item ${id}`);
}
