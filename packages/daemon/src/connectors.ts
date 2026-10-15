import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CLIENT_ID, invalidParams, oneOf, paramsObject, pointsParam, stringParam } from './params.ts';
import {
  CONNECTOR_END_TYPES,
  CONNECTOR_LINE_ENDS,
  CONNECTOR_SIDES,
  CONNECTOR_STYLES,
  DEFAULT_CONNECTOR_LOOK,
  MAX_CONNECTOR_LABEL,
  type Connector,
  type ConnectorEnd,
  type ConnectorEndType,
  type DaemonEvent,
  type DaemonMethods,
} from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';

type ConnectorMethods = Pick<DaemonMethods, Extract<keyof DaemonMethods, `connector.${string}`>>;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Where each kind of object is stored: how to tell that one exists, and what to call it in a message. */
const END_TABLES: Record<ConnectorEndType, { table: string; key: string; label: string }> = {
  zone: { table: 'zones', key: 'id', label: 'zone' },
  item: { table: 'board_items', key: 'id', label: 'item' },
  agent: { table: 'agents', key: 'session_id', label: 'agent' },
  shell: { table: 'shells', key: 'id', label: 'shell' },
  external: { table: 'external_sessions', key: 'id', label: 'external session' },
};

interface ConnectorRow {
  id: string;
  from_type: ConnectorEndType;
  from_id: string;
  from_side: ConnectorEnd['side'];
  to_type: ConnectorEndType;
  to_id: string;
  to_side: ConnectorEnd['side'];
  style: Connector['style'];
  start_end: Connector['startEnd'];
  end_end: Connector['endEnd'];
  color: string | null;
  label: string;
  points: string;
  created_at: string;
  updated_at: string;
}

function toConnector(row: ConnectorRow): Connector {
  return {
    id: row.id,
    from: { type: row.from_type, id: row.from_id, side: row.from_side },
    to: { type: row.to_type, id: row.to_id, side: row.to_side },
    style: row.style,
    startEnd: row.start_end,
    endEnd: row.end_end,
    color: row.color,
    label: row.label,
    points: JSON.parse(row.points) as Connector['points'],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function colorParam(fields: Record<string, unknown>): string | null {
  const color = fields.color;
  if (color === null) return null;
  if (typeof color !== 'string' || !HEX_COLOR.test(color)) throw invalidParams('color must be #rrggbb or null');
  return color;
}

function labelParam(fields: Record<string, unknown>): string {
  const label = stringParam(fields, 'label');
  if (label.length > MAX_CONNECTOR_LABEL) throw invalidParams(`label is over ${MAX_CONNECTOR_LABEL} characters`);
  return label;
}

function endParam(fields: Record<string, unknown>, name: 'from' | 'to'): ConnectorEnd {
  const end = paramsObject(fields[name]);
  return {
    type: oneOf(end, 'type', CONNECTOR_END_TYPES),
    id: stringParam(end, 'id'),
    side: oneOf(end, 'side', CONNECTOR_SIDES),
  };
}

/**
 * Moves every connector end on one object to another, which takes its place on the board (an external session adopted
 * as an agent), and tells every client.
 */
export function connectorRepointer(
  db: DatabaseSync,
  broadcast: (event: DaemonEvent) => void,
): (from: Omit<ConnectorEnd, 'side'>, to: Omit<ConnectorEnd, 'side'>) => void {
  const selectOn = db.prepare('SELECT id FROM connectors WHERE (from_type = ?1 AND from_id = ?2) OR (to_type = ?1 AND to_id = ?2)');
  const selectOne = db.prepare('SELECT * FROM connectors WHERE id = ?');
  const moveEnds = (['from', 'to'] as const).map((end) =>
    db.prepare(
      `UPDATE connectors SET ${end}_type = ?, ${end}_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE ${end}_type = ? AND ${end}_id = ?`,
    ),
  );
  return (from, to) => {
    const ids = selectOn.all(from.type, from.id) as { id: string }[];
    for (const moveEnd of moveEnds) moveEnd.run(to.type, to.id, from.type, from.id);
    for (const { id } of ids) broadcast({ type: 'connector.updated', connector: toConnector(selectOne.get(id) as unknown as ConnectorRow) });
  };
}

/**
 * The `connector.*` RPC handlers, backed by the `connectors` table. A connector goes with an object at either end
 * through the table's triggers, which don't announce it. Every other change is broadcast to every client.
 */
export function connectorHandlers<Context>(
  db: DatabaseSync,
  broadcast: (event: DaemonEvent) => void,
): RpcHandlers<ConnectorMethods, Context> {
  const selectAll = db.prepare('SELECT * FROM connectors ORDER BY created_at, rowid');
  const selectOne = db.prepare('SELECT * FROM connectors WHERE id = ?');
  const insert = db.prepare(
    `INSERT INTO connectors (id, from_type, from_id, from_side, to_type, to_id, to_side, style, start_end, end_end, color, label, points)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE connectors SET style = ?, start_end = ?, end_end = ?, color = ?, label = ?, points = ?, from_side = ?, to_side = ?,
     updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
  );
  const remove = db.prepare('DELETE FROM connectors WHERE id = ?');
  const exists = Object.fromEntries(
    Object.entries(END_TABLES).map(([type, { table, key }]) => [type, db.prepare(`SELECT 1 FROM ${table} WHERE ${key} = ?`)]),
  );

  const get = (id: string): Connector => {
    const row = selectOne.get(id) as ConnectorRow | undefined;
    if (row === undefined) throw noConnector(id);
    return toConnector(row);
  };

  const checkEndExists = ({ type, id }: ConnectorEnd) => {
    if (exists[type]!.get(id) === undefined) throw invalidParams(`no ${END_TABLES[type].label} ${id}`);
  };

  const announce = (connector: Connector): Connector => {
    broadcast({ type: 'connector.updated', connector });
    return connector;
  };

  return {
    'connector.list': () => (selectAll.all() as unknown as ConnectorRow[]).map(toConnector),
    'connector.create': (params) => {
      const fields = paramsObject(params);
      const from = endParam(fields, 'from');
      const to = endParam(fields, 'to');
      if (from.type === to.type && from.id === to.id) throw invalidParams('a connector can not join an object to itself');
      checkEndExists(from);
      checkEndExists(to);
      const id = fields.id === undefined ? randomUUID() : stringParam(fields, 'id');
      if (!CLIENT_ID.test(id)) throw invalidParams('a connector id is letters, digits and -, at most 64');
      if (selectOne.get(id) !== undefined) throw invalidParams(`connector ${id} already exists`);
      const given = (name: string) => fields[name] !== undefined;
      insert.run(
        id,
        from.type,
        from.id,
        from.side,
        to.type,
        to.id,
        to.side,
        given('style') ? oneOf(fields, 'style', CONNECTOR_STYLES) : DEFAULT_CONNECTOR_LOOK.style,
        given('startEnd') ? oneOf(fields, 'startEnd', CONNECTOR_LINE_ENDS) : DEFAULT_CONNECTOR_LOOK.startEnd,
        given('endEnd') ? oneOf(fields, 'endEnd', CONNECTOR_LINE_ENDS) : DEFAULT_CONNECTOR_LOOK.endEnd,
        given('color') ? colorParam(fields) : DEFAULT_CONNECTOR_LOOK.color,
        given('label') ? labelParam(fields) : DEFAULT_CONNECTOR_LOOK.label,
        JSON.stringify(given('points') ? pointsParam(fields, 'points') : []),
      );
      return announce(get(id));
    },
    'connector.update': (params) => {
      const fields = paramsObject(params);
      const connector = get(stringParam(fields, 'id'));
      const given = (name: string) => fields[name] !== undefined;
      update.run(
        given('style') ? oneOf(fields, 'style', CONNECTOR_STYLES) : connector.style,
        given('startEnd') ? oneOf(fields, 'startEnd', CONNECTOR_LINE_ENDS) : connector.startEnd,
        given('endEnd') ? oneOf(fields, 'endEnd', CONNECTOR_LINE_ENDS) : connector.endEnd,
        given('color') ? colorParam(fields) : connector.color,
        given('label') ? labelParam(fields) : connector.label,
        JSON.stringify(given('points') ? pointsParam(fields, 'points') : connector.points),
        given('fromSide') ? oneOf(fields, 'fromSide', CONNECTOR_SIDES) : connector.from.side,
        given('toSide') ? oneOf(fields, 'toSide', CONNECTOR_SIDES) : connector.to.side,
        connector.id,
      );
      return announce(get(connector.id));
    },
    'connector.delete': (params) => {
      const id = stringParam(paramsObject(params), 'id');
      if (remove.run(id).changes === 0) throw noConnector(id);
      broadcast({ type: 'connector.removed', id });
      return null;
    },
  };
}

const noConnector = (id: string) => invalidParams(`no connector ${id}`);
