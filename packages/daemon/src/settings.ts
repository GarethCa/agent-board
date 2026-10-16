import { isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { invalidParams, oneOf, paramsObject, stringParam } from './params.ts';
import { COMPACT_WINDOW_RANGE, HELD_PAYLOAD_STORAGE, type DaemonMethods, type DaemonSettings } from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';

type SettingsMethods = Pick<DaemonMethods, Extract<keyof DaemonMethods, `settings.${string}`>>;

/** Each setting until it is changed. */
const DEFAULT_SETTINGS: DaemonSettings = { heldPayloads: 'copy', claudePath: '', codexPath: '', compactWindow: 0 };

export interface SettingsHost {
  get(): DaemonSettings;
  handlers<Context>(): RpcHandlers<SettingsMethods, Context>;
}

/**
 * The daemon's settings, one JSON value per key in `settings`, which it reads and acts on. `changed` hears of
 * each change, with the settings as they were.
 */
export function createSettings(db: DatabaseSync, changed: (now: DaemonSettings, was: DaemonSettings) => void): SettingsHost {
  const select = db.prepare('SELECT key, value FROM settings');
  const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value');

  const get = (): DaemonSettings => {
    const settings = { ...DEFAULT_SETTINGS };
    for (const { key, value } of select.all() as { key: string; value: string }[]) {
      if (key === 'heldPayloads' && HELD_PAYLOAD_STORAGE.includes(JSON.parse(value))) settings.heldPayloads = JSON.parse(value);
      if (key === 'compactWindow' && isCompactWindow(JSON.parse(value))) settings.compactWindow = JSON.parse(value);
      if ((key === 'claudePath' || key === 'codexPath') && typeof JSON.parse(value) === 'string') settings[key] = JSON.parse(value);
    }
    return settings;
  };

  return {
    get,
    handlers: () => ({
      'settings.get': () => get(),
      'settings.set': (params) => {
        const fields = paramsObject(params);
        const was = get();
        if (fields.heldPayloads !== undefined) upsert.run('heldPayloads', JSON.stringify(oneOf(fields, 'heldPayloads', HELD_PAYLOAD_STORAGE)));
        for (const key of ['claudePath', 'codexPath'] as const) {
          if (fields[key] !== undefined) upsert.run(key, JSON.stringify(harnessPathParam(fields, key)));
        }
        if (fields.compactWindow !== undefined) upsert.run('compactWindow', JSON.stringify(compactWindowParam(fields)));
        const now = get();
        changed(now, was);
        return now;
      },
    }),
  };
}

/** A harness path from Settings: absolute, or empty to look for the harness instead. */
function harnessPathParam(fields: Record<string, unknown>, name: string): string {
  const path = stringParam(fields, name).trim();
  if (path !== '' && !isAbsolute(path)) throw invalidParams(`${name} must be an absolute path, or empty`);
  return path;
}

function isCompactWindow(value: unknown): value is number {
  return value === 0 || (Number.isInteger(value) && (value as number) >= COMPACT_WINDOW_RANGE.min && (value as number) <= COMPACT_WINDOW_RANGE.max);
}

/** A compact window from Settings: 0 for off, or a whole number of tokens within `COMPACT_WINDOW_RANGE`. */
function compactWindowParam(fields: Record<string, unknown>): number {
  const value = fields.compactWindow;
  if (!isCompactWindow(value)) {
    throw invalidParams(`compactWindow must be 0 (off), or a whole number from ${COMPACT_WINDOW_RANGE.min} to ${COMPACT_WINDOW_RANGE.max}`);
  }
  return value;
}
