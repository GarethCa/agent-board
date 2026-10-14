import type { DatabaseSync } from 'node:sqlite';
import { invalidParams, paramsObject, stringParam } from './params.ts';
import type { DaemonMethods } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';

/** Longest key, in characters. */
const MAX_KEY_LENGTH = 64;
/** Largest value, as JSON, in bytes. */
const MAX_VALUE_BYTES = 64 * 1024;

type ViewMethods = Pick<DaemonMethods, Extract<keyof DaemonMethods, `view.${string}`>>;

/**
 * The `view.*` handlers: how the app last left the board (its viewport, its session windows), one JSON value
 * per key in `view_state`, so the board looks the same after a restart. The daemon never reads the values.
 */
export function viewStateHandlers<Context>(db: DatabaseSync): RpcHandlers<ViewMethods, Context> {
  const select = db.prepare('SELECT value FROM view_state WHERE key = ?');
  const upsert = db.prepare('INSERT INTO view_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');
  const remove = db.prepare('DELETE FROM view_state WHERE key = ?');

  const keyParam = (params: Record<string, unknown>): string => {
    const key = stringParam(params, 'key');
    if (key === '' || key.length > MAX_KEY_LENGTH) throw invalidParams(`key must be 1 to ${MAX_KEY_LENGTH} characters`);
    return key;
  };

  return {
    'view.get': (raw) => {
      const row = select.get(keyParam(paramsObject(raw))) as { value: string } | undefined;
      return row === undefined ? null : (JSON.parse(row.value) as unknown);
    },
    'view.set': (raw) => {
      const params = paramsObject(raw);
      const key = keyParam(params);
      if (!('value' in params)) throw invalidParams('value is required: null forgets the key');
      if (params.value === null) {
        remove.run(key);
        return null;
      }
      const value = JSON.stringify(params.value);
      if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw invalidParams(`${key} is over 64 KiB as JSON`);
      upsert.run(key, value);
      return null;
    },
  };
}
