import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CLIENT_ID, invalidParams, oneOf, optionalBooleanParam, paramsObject, pointsParam, stringParam } from './params.ts';
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
  type ConnectorLook,
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
  dashed: number;
  color: string | null;
  label: string;
  start_label: string;
  end_label: string;
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
    dashed: row.dashed === 1,
    color: row.color,
    label: row.label,
    startLabel: row.start_label,
    endLabel: row.end_label,
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

function labelParam(fields: Record<string, unknown>, name: 'label' | 'startLabel' | 'endLabel'): string {
  const label = stringParam(fields, name);
  if (label.length > MAX_CONNECTOR_LABEL) throw invalidParams(`${name} is over ${MAX_CONNECTOR_LABEL} characters`);
  return label;
}

/** The look and labels `fields` give a connector, each one left out as it is in `base`. */
function lookParams(fields: Record<string, unknown>, base: ConnectorLook): ConnectorLook {
  const given = (name: keyof ConnectorLook) => fields[name] !== undefined;
  return {
    style: given('style') ? oneOf(fields, 'style', CONNECTOR_STYLES) : base.style,
    startEnd: given('startEnd') ? oneOf(fields, 'startEnd', CONNECTOR_LINE_ENDS) : base.startEnd,
    endEnd: given('endEnd') ? oneOf(fields, 'endEnd', CONNECTOR_LINE_ENDS) : base.endEnd,
    dashed: optionalBooleanParam(fields, 'dashed') ?? base.dashed,
    color: given('color') ? colorParam(fields) : base.color,
    label: given('label') ? labelParam(fields, 'label') : base.label,
    startLabel: given('startLabel') ? labelParam(fields, 'startLabel') : base.startLabel,
    endLabel: given('endLabel') ? labelParam(fields, 'endLabel') : base.endLabel,
  };
}

/** A look's columns, in the order the statements below name them. */
const lookColumns = (look: ConnectorLook) =>
  [look.style, look.startEnd, look.endEnd, look.dashed ? 1 : 0, look.color, look.label, look.startLabel, look.endLabel] as const;

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
    `INSERT INTO connectors (id, from_type, from_id, from_side, to_type, to_id, to_side,
     style, start_end, end_end, dashed, color, label, start_label, end_label, points)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE connectors SET style = ?, start_end = ?, end_end = ?, dashed = ?, color = ?, label = ?, start_label = ?, end_label = ?, points = ?,
     from_type = ?, from_id = ?, from_side = ?, to_type = ?, to_id = ?, to_side = ?,
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
        ...lookColumns(lookParams(fields, DEFAULT_CONNECTOR_LOOK)),
        JSON.stringify(given('points') ? pointsParam(fields, 'points') : []),
      );
      return announce(get(id));
    },
    'connector.update': (params) => {
      const fields = paramsObject(params);
      const connector = get(stringParam(fields, 'id'));
      const given = (name: string) => fields[name] !== undefined;
      // An end moved onto another object joins it, on the side given; a side alone moves it round its own.
      const [from, to] = (['from', 'to'] as const).map((name) => {
        const end = given(name) ? endParam(fields, name) : connector[name];
        return given(`${name}Side`) ? { ...end, side: oneOf(fields, `${name}Side`, CONNECTOR_SIDES) } : end;
      }) as [ConnectorEnd, ConnectorEnd];
      if (from.type === to.type && from.id === to.id) throw invalidParams('a connector can not join an object to itself');
      if (given('from')) checkEndExists(from);
      if (given('to')) checkEndExists(to);
      update.run(
        ...lookColumns(lookParams(fields, connector)),
        JSON.stringify(given('points') ? pointsParam(fields, 'points') : connector.points),
        from.type,
        from.id,
        from.side,
        to.type,
        to.id,
        to.side,
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
