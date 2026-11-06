import { isAbsolute } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { invalidParams, oneOf, optionalBooleanParam, paramsObject, stringParam } from './params.ts';
import {
  ARRANGE_SPACINGS,
  COMPACT_WINDOW_RANGE,
  DEFAULT_ARRANGE_SPACING,
  EFFORTS,
  HARNESS_EFFORTS,
  HELD_PAYLOAD_STORAGE,
  NEEDS_YOU_SHOWS,
  type DaemonMethods,
  type DaemonSettings,
  type Effort,
  type Harness,
} from './protocol.ts';
import type { RpcHandlers } from './rpc.ts';

type SettingsMethods = Pick<DaemonMethods, Extract<keyof DaemonMethods, `settings.${string}`>>;

/** Each setting until it is changed. */
const DEFAULT_SETTINGS: DaemonSettings = {
  heldPayloads: 'copy',
  claudePath: '',
  codexPath: '',
  compactWindow: 0,
  clickableLinks: true,
  needsYouShows: 'explicit',
  notifications: true,
  notifyInFront: false,
  arrangeSpacing: DEFAULT_ARRANGE_SPACING,
  keepWebLogins: true,
  defaultEffort: null,
  roleEfforts: {},
};

/** The settings that are switches. */
const SWITCHES = ['clickableLinks', 'notifications', 'notifyInFront', 'keepWebLogins'] as const;

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
      if (key === 'needsYouShows' && NEEDS_YOU_SHOWS.includes(JSON.parse(value))) settings.needsYouShows = JSON.parse(value);
      if (key === 'arrangeSpacing' && ARRANGE_SPACINGS.includes(JSON.parse(value))) settings.arrangeSpacing = JSON.parse(value);
      for (const name of SWITCHES) if (key === name && typeof JSON.parse(value) === 'boolean') settings[name] = JSON.parse(value);
      if (key === 'defaultEffort' && EFFORTS.includes(JSON.parse(value))) settings.defaultEffort = JSON.parse(value);
      if (key === 'roleEfforts') settings.roleEfforts = savedRoleEfforts(JSON.parse(value));
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
        const efforts = fields.defaultEffort === undefined ? undefined : defaultEffortParam(fields);
        const roleEfforts = fields.roleEfforts === undefined ? undefined : roleEffortsParam(fields);
        if (efforts !== undefined) upsert.run('defaultEffort', JSON.stringify(efforts));
        if (roleEfforts !== undefined) upsert.run('roleEfforts', JSON.stringify(roleEfforts));
        if (fields.heldPayloads !== undefined) upsert.run('heldPayloads', JSON.stringify(oneOf(fields, 'heldPayloads', HELD_PAYLOAD_STORAGE)));
        for (const key of ['claudePath', 'codexPath'] as const) {
          if (fields[key] !== undefined) upsert.run(key, JSON.stringify(harnessPathParam(fields, key)));
        }
        if (fields.compactWindow !== undefined) upsert.run('compactWindow', JSON.stringify(compactWindowParam(fields)));
        if (fields.needsYouShows !== undefined) upsert.run('needsYouShows', JSON.stringify(oneOf(fields, 'needsYouShows', NEEDS_YOU_SHOWS)));
        if (fields.arrangeSpacing !== undefined) upsert.run('arrangeSpacing', JSON.stringify(oneOf(fields, 'arrangeSpacing', ARRANGE_SPACINGS)));
        for (const name of SWITCHES) {
          const on = optionalBooleanParam(fields, name);
          if (on !== undefined) upsert.run(name, JSON.stringify(on));
        }
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

/**
 * The reasoning effort a new `harness` agent in role `role` (a built-in role, or a custom one's name) starts at when it
 * is not asked for one: its role's in Settings, else every new agent's; null for the harness's own. One the harness
 * doesn't take (Codex has no `max`) is the highest it does.
 */
export function defaultEffort(settings: Pick<DaemonSettings, 'defaultEffort' | 'roleEfforts'>, harness: Harness, role: string | null): Effort | null {
  const wanted = (role === null ? undefined : settings.roleEfforts[roleKey(role)]) ?? settings.defaultEffort;
  if (wanted === null) return null;
  const takes = HARNESS_EFFORTS[harness];
  return takes.includes(wanted) ? wanted : takes.at(-1)!;
}

/**
 * The name a role's effort is kept under: matched in ASCII case only, as role templates are, and a follow-up reviewer's
 * under the reviewers'.
 */
function roleKey(role: string): string {
  const key = role.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return key === 'follow-up-reviewer' ? 'reviewer' : key;
}

/** Every new agent's reasoning effort from Settings: a level, or null for the harness's own. */
function defaultEffortParam(fields: Record<string, unknown>): Effort | null {
  const value = fields.defaultEffort;
  if (value !== null && !EFFORTS.includes(value as Effort)) throw invalidParams(`defaultEffort must be one of ${EFFORTS.join(', ')}, or null`);
  return value as Effort | null;
}

/** Each role's reasoning effort from Settings, by the role's name: a role left out takes every new agent's. */
function roleEffortsParam(fields: Record<string, unknown>): Record<string, Effort> {
  const value = fields.roleEfforts;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidParams('roleEfforts must be an object of role names to efforts');
  const efforts: Record<string, Effort> = {};
  for (const [role, effort] of Object.entries(value)) {
    if (role.trim() === '') throw invalidParams('roleEfforts takes a role by its name');
    if (!EFFORTS.includes(effort as Effort)) throw invalidParams(`roleEfforts.${role} must be one of ${EFFORTS.join(', ')}`);
    efforts[roleKey(role)] = effort as Effort;
  }
  return efforts;
}

/** The role efforts saved, leaving out any that are not a level. */
function savedRoleEfforts(value: unknown): Record<string, Effort> {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, effort]) => EFFORTS.includes(effort as Effort))
      .map(([role, effort]) => [roleKey(role), effort]),
  ) as Record<string, Effort>;
}
